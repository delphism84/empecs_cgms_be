import express from 'express';
import User from '../../models/User.js';
import Eq from '../../models/Eq.js';
import DeviceUnit from '../../models/DeviceUnit.js';
import EqHistory from '../../models/EqHistory.js';
import GlucosePoint from '../../models/GlucosePoint.js';
import Event from '../../models/Event.js';
import Sensor from '../../models/Sensor.js';
import Alarm from '../../models/Alarm.js';
import AppSetting from '../../models/AppSetting.js';
import Notice from '../../models/Notice.js';
import AuditLog from '../../models/AuditLog.js';
import LoginLog from '../../models/LoginLog.js';
import AdminUser from '../../models/AdminUser.js';
import { requireAdmin, requirePerm } from '../../admin/auth.js';
import { audit, diff, snapshot } from '../../admin/audit.js';
import { getSettings, updateSettings, validityMs, SETTING_DEFAULTS } from '../../lib/settingsStore.js';
import { invalidateUserAuth } from '../../lib/userAuth.js';
import {
  escapeRegex,
  isId,
  oid,
  paging,
  parsePeriod,
  userLabel,
  userSearchQuery,
  beginCsv,
  csvLine,
  kstString,
  fail,
} from './common.js';

const router = express.Router();
router.use(requireAdmin);

// ── 동기화 이상 감시 ─────────────────────────────────────────────────────────

/**
 * 센서는 사용 중(유효기간 내)인데 서버 업로드가 끊긴 회원.
 * 토큰 만료처럼 앱 화면에는 아무 표시 없이 업로드만 멈추는 상황을 어드민에서 찾기 위한 목록이다.
 * hint:
 *  - never_uploaded : 등록 후 한 번도 업로드 없음
 *  - app_silent     : 서버에 인증된 요청 자체가 없음(앱 종료·토큰 만료 가능성)
 *  - upload_stalled : 앱은 서버와 통신 중인데 혈당만 안 올라옴(센서 연결·수신 문제 가능성)
 */
export async function computeSyncGaps({ hours } = {}) {
  const settings = await getSettings();
  const now = Date.now();
  const gapH = Math.max(1, Number(hours) || settings.syncGapHours);
  const cutoff = new Date(now - validityMs(settings));
  const units = await DeviceUnit.find({ blocked: { $ne: true }, startAt: { $gt: cutoff }, ownerId: { $ne: null } })
    .select('serial startAt ownerId bleMac')
    .lean();
  const ownerIds = [...new Set(units.map((u) => String(u.ownerId)))];
  const users = await User.find({ _id: { $in: ownerIds } })
    .select('email firstName lastName name status lastUploadAt lastSeenAt lastLoginAt countryCode')
    .lean();
  const userBy = new Map(users.map((u) => [u._id.toString(), u]));
  const items = [];
  for (const unit of units) {
    const u = userBy.get(String(unit.ownerId));
    if (!u || u.status === 'deleted') continue;
    const startMs = new Date(unit.startAt).getTime();
    const lastUp = u.lastUploadAt ? new Date(u.lastUploadAt).getTime() : null;
    // 등록 이전의 업로드는 이 센서의 것이 아니다.
    const ref = lastUp && lastUp >= startMs ? lastUp : startMs;
    const gapMs = now - ref;
    if (gapMs < gapH * 3600000) continue;
    const seen = u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : null;
    let hint = 'upload_stalled';
    if (!seen || now - seen >= gapH * 3600000) hint = 'app_silent';
    else if (!lastUp || lastUp < startMs) hint = 'never_uploaded';
    items.push({
      serial: unit.serial,
      startAt: unit.startAt,
      endAt: new Date(startMs + validityMs(settings)),
      userId: u._id.toString(),
      userEmail: u.email,
      userLabel: userLabel(u),
      userStatus: u.status || 'active',
      lastUploadAt: u.lastUploadAt || null,
      lastSeenAt: u.lastSeenAt || null,
      lastLoginAt: u.lastLoginAt || null,
      gapHours: Math.round((gapMs / 3600000) * 10) / 10,
      hint,
    });
  }
  items.sort((a, b) => b.gapHours - a.gapHours);
  return { items, total: items.length, activeSensors: units.length, thresholdHours: gapH, serverTime: new Date(now).toISOString() };
}

router.get('/monitor/sync', requirePerm('monitor.read'), async (req, res) => {
  try {
    return res.json(await computeSyncGaps({ hours: req.query.hours }));
  } catch (e) {
    return fail(res, 'admin/monitor/sync', e);
  }
});

// ── 데이터 관리 ──────────────────────────────────────────────────────────────

async function buildDataQuery(query) {
  const q = {};
  const period = parsePeriod(query);
  if (period) q.time = period;
  const sn = String(query.sn || '').trim();
  if (sn) q.eqsn = query.exactSn === 'true' ? sn.toUpperCase() : new RegExp(escapeRegex(sn), 'i');

  let macUserIds = null;
  const mac = String(query.mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (mac) {
    const eqs = await Eq.find({ bleMac: mac }).select('userId').lean();
    macUserIds = [...new Set(eqs.map((e) => e.userId?.toString()).filter(Boolean))];
    if (!macUserIds.length) return null;
  }
  const direct = isId(String(query.userId || '')) ? String(query.userId) : null;
  if (direct) {
    if (macUserIds && !macUserIds.includes(direct)) return null;
    q.userId = oid(direct);
  } else if (String(query.user || '').trim()) {
    const users = await User.find(userSearchQuery(query.user)).select('_id').limit(2000).lean();
    let ids = users.map((u) => u._id.toString());
    if (macUserIds) ids = ids.filter((id) => macUserIds.includes(id));
    if (!ids.length) return null;
    q.userId = { $in: ids.map(oid) };
  } else if (macUserIds) {
    q.userId = { $in: macUserIds.map(oid) };
  }
  return q;
}

router.get('/data', requirePerm('data.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paging(req);
    const q = await buildDataQuery(req.query);
    if (!q) return res.json({ items: [], total: 0, page, limit });
    const [total, rows] = await Promise.all([
      GlucosePoint.countDocuments(q),
      GlucosePoint.find(q).sort({ time: -1 }).skip(skip).limit(limit).populate('userId', 'email firstName lastName name').lean(),
    ]);
    const items = rows.map((r) => ({
      id: r._id.toString(),
      eqsn: r.eqsn || '—',
      value: r.value,
      time: r.time,
      trid: r.trid ?? null,
      uploadedAt: r.createdAt || null,
      userId: r.userId?._id?.toString() || null,
      userEmail: r.userId?.email || '—',
      userLabel: userLabel(r.userId),
    }));
    return res.json({ items, total, page, limit });
  } catch (e) {
    return fail(res, 'admin/data', e);
  }
});

router.get('/data/export.csv', requirePerm('data.read', 'data.export'), async (req, res) => {
  try {
    const q = await buildDataQuery(req.query);
    // 조건 없는 전체 내보내기는 막는다(수백만 건이 될 수 있다).
    if (q && !q.userId && !q.eqsn && !q.time) return res.status(400).json({ error: 'filter_required' });
    const MAX = 200000;
    beginCsv(res, `cgms-glucose-${new Date().toISOString().slice(0, 10)}.csv`, [
      'time_kst', 'time_utc', 'value_mg_dl', 'sn', 'user_email', 'trid', 'uploaded_kst',
    ]);
    let n = 0;
    if (q) {
      const cursor = GlucosePoint.find(q).sort({ time: 1 }).limit(MAX).populate('userId', 'email').lean().cursor();
      for await (const r of cursor) {
        res.write(csvLine([kstString(r.time), new Date(r.time).toISOString(), r.value, r.eqsn || '', r.userId?.email || '', r.trid ?? '', kstString(r.createdAt)]));
        n += 1;
      }
    }
    await audit(req, { action: 'data.export', targetType: 'glucose', note: JSON.stringify(req.query).slice(0, 500), after: { rows: n, capped: n >= MAX } });
    return res.end();
  } catch (e) {
    if (!res.headersSent) return fail(res, 'admin/data/export', e);
    return res.end();
  }
});

/**
 * 혈당 데이터 삭제(복구 불가). 회원 1명을 반드시 지정하고, confirm 에 'DELETE' 를 보내야 한다.
 * body: { userId, sn?, from?, to?, confirm:'DELETE', dryRun? }
 */
router.post('/data/delete', requirePerm('data.delete'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!isId(String(b.userId || ''))) return res.status(400).json({ error: 'userId_required' });
    const q = { userId: oid(String(b.userId)) };
    const period = parsePeriod(b);
    if (period) q.time = period;
    if (b.sn) q.eqsn = String(b.sn).trim().toUpperCase();
    const count = await GlucosePoint.countDocuments(q);
    if (b.dryRun === true) return res.json({ ok: true, dryRun: true, count });
    if (b.confirm !== 'DELETE') return res.status(400).json({ error: 'confirm_required' });
    const r = await GlucosePoint.deleteMany(q);
    const u = await User.findById(b.userId).select('email').lean();
    await audit(req, { action: 'data.delete', targetType: 'user', targetId: b.userId, targetLabel: u?.email || '', after: { deleted: r.deletedCount || 0, sn: b.sn || '', from: b.from || '', to: b.to || '' } });
    return res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (e) {
    return fail(res, 'admin/data/delete', e);
  }
});

// ── 공지사항 ────────────────────────────────────────────────────────────────

function serializeNotice(n) {
  return {
    id: n._id.toString(), title: n.title, body: n.body || '', language: n.language || '', pinned: !!n.pinned, active: n.active !== false,
    publishAt: n.publishAt || null, expireAt: n.expireAt || null, createdBy: n.createdBy || '', updatedBy: n.updatedBy || '',
    createdAt: n.createdAt, updatedAt: n.updatedAt,
  };
}

function noticeFields(body) {
  const out = {};
  if (body.title !== undefined) {
    const t = String(body.title || '').trim();
    if (!t) return { error: 'title_required' };
    out.title = t.slice(0, 200);
  }
  if (body.body !== undefined) out.body = String(body.body || '').slice(0, 20000);
  if (body.language !== undefined) out.language = String(body.language || '').trim().toLowerCase().slice(0, 8);
  if (body.pinned !== undefined) out.pinned = body.pinned === true;
  if (body.active !== undefined) out.active = body.active === true;
  for (const k of ['publishAt', 'expireAt']) {
    if (body[k] === undefined) continue;
    if (!body[k]) { out[k] = k === 'publishAt' ? new Date() : null; continue; }
    const d = new Date(body[k]);
    if (Number.isNaN(d.getTime())) return { error: `invalid_${k}` };
    out[k] = d;
  }
  return { out };
}

router.get('/notices', requirePerm('notices.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paging(req);
    const q = {};
    if (req.query.active === 'true') q.active = true;
    if (req.query.active === 'false') q.active = false;
    const text = String(req.query.q || '').trim();
    if (text) q.title = new RegExp(escapeRegex(text), 'i');
    const [total, rows] = await Promise.all([
      Notice.countDocuments(q),
      Notice.find(q).sort({ pinned: -1, publishAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return res.json({ items: rows.map(serializeNotice), total, page, limit });
  } catch (e) {
    return fail(res, 'admin/notices', e);
  }
});

router.post('/notices', requirePerm('notices.write'), async (req, res) => {
  try {
    const f = noticeFields({ title: '', ...req.body });
    if (f.error) return res.status(400).json({ error: f.error });
    const n = await Notice.create({ ...f.out, createdBy: req.admin.username, updatedBy: req.admin.username });
    await audit(req, { action: 'notice.create', targetType: 'notice', targetId: n._id, targetLabel: n.title });
    return res.status(201).json({ ok: true, notice: serializeNotice(n) });
  } catch (e) {
    return fail(res, 'admin/notices POST', e);
  }
});

router.patch('/notices/:id', requirePerm('notices.write'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const n = await Notice.findById(req.params.id);
    if (!n) return res.status(404).json({ error: 'not_found' });
    const f = noticeFields(req.body || {});
    if (f.error) return res.status(400).json({ error: f.error });
    const before = snapshot(n);
    Object.assign(n, f.out, { updatedBy: req.admin.username });
    await n.save();
    await audit(req, { action: 'notice.update', targetType: 'notice', targetId: n._id, targetLabel: n.title, ...diff(before, n) });
    return res.json({ ok: true, notice: serializeNotice(n) });
  } catch (e) {
    return fail(res, 'admin/notices PATCH', e);
  }
});

router.delete('/notices/:id', requirePerm('notices.write'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const n = await Notice.findByIdAndDelete(req.params.id);
    if (!n) return res.status(404).json({ error: 'not_found' });
    await audit(req, { action: 'notice.delete', targetType: 'notice', targetId: n._id, targetLabel: n.title });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/notices DELETE', e);
  }
});

// ── 시스템 설정 ─────────────────────────────────────────────────────────────

router.get('/settings', requirePerm('dashboard.read'), async (_req, res) => {
  try {
    return res.json({ settings: await getSettings({ fresh: true }), defaults: SETTING_DEFAULTS });
  } catch (e) {
    return fail(res, 'admin/settings', e);
  }
});

router.put('/settings', requirePerm('settings.manage'), async (req, res) => {
  try {
    const patch = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : req.body || {};
    const { before, after } = await updateSettings(patch, req.admin.username);
    await audit(req, { action: 'settings.update', targetType: 'settings', targetId: 'global', ...diff(before, after) });
    return res.json({ ok: true, settings: after });
  } catch (e) {
    return fail(res, 'admin/settings PUT', e);
  }
});

// ── 감사 로그·로그인 이력 ────────────────────────────────────────────────────

router.get('/audit-logs', requirePerm('audit.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paging(req);
    const q = {};
    const period = parsePeriod(req.query);
    if (period) q.at = period;
    if (req.query.action) q.action = new RegExp(`^${escapeRegex(String(req.query.action))}`, 'i');
    if (req.query.actor) q.actorName = new RegExp(escapeRegex(String(req.query.actor)), 'i');
    if (req.query.targetType) q.targetType = String(req.query.targetType);
    if (req.query.target) {
      const re = new RegExp(escapeRegex(String(req.query.target)), 'i');
      q.$or = [{ targetId: re }, { targetLabel: re }];
    }
    const [total, rows, actions] = await Promise.all([
      AuditLog.countDocuments(q),
      AuditLog.find(q).sort({ at: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.distinct('action'),
    ]);
    return res.json({
      items: rows.map((r) => ({ id: r._id.toString(), ...r, _id: undefined })),
      total, page, limit, actions: actions.sort(),
    });
  } catch (e) {
    return fail(res, 'admin/audit-logs', e);
  }
});

router.get('/login-logs', requirePerm('audit.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paging(req);
    const q = {};
    const period = parsePeriod(req.query);
    if (period) q.at = period;
    if (['admin', 'user'].includes(String(req.query.kind))) q.kind = String(req.query.kind);
    if (req.query.success === 'true') q.success = true;
    if (req.query.success === 'false') q.success = false;
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q)), 'i');
      q.$or = [{ identifier: re }, { ip: re }];
    }
    const [total, rows] = await Promise.all([
      LoginLog.countDocuments(q),
      LoginLog.find(q).sort({ at: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return res.json({ items: rows.map((r) => ({ id: r._id.toString(), ...r, _id: undefined })), total, page, limit });
  } catch (e) {
    return fail(res, 'admin/login-logs', e);
  }
});

// ── 시스템 초기화 ────────────────────────────────────────────────────────────

/**
 * 회원·센서 등록·혈당·이벤트·알람·앱 설정 전부 삭제(복구 불가).
 * 관리자 계정·감사 로그·시스템 설정·센서 재고(SN 대장)는 남는다.
 * 본인 비밀번호와 확인 문구 'RESET ALL DATA' 가 모두 필요하다.
 */
router.post('/system/reset', requirePerm('system.reset'), async (req, res) => {
  try {
    const me = await AdminUser.findById(req.admin.id);
    if (!me || !(await me.verifyPassword(req.body?.password))) return res.status(401).json({ error: 'invalid_password' });
    if (req.body?.confirm !== 'RESET ALL DATA') return res.status(400).json({ error: 'confirm_required' });
    const [users, devices, glucose, events, sensors, alarms, settings] = await Promise.all([
      User.deleteMany({}), Eq.deleteMany({}), GlucosePoint.deleteMany({}), Event.deleteMany({}),
      Sensor.deleteMany({}), Alarm.deleteMany({}), AppSetting.deleteMany({}),
    ]);
    await Promise.all([
      DeviceUnit.updateMany({}, { $set: { startAt: null, ownerId: null } }),
      DeviceUnit.deleteMany({ source: 'app', verified: false }),
      EqHistory.deleteMany({}),
    ]);
    invalidateUserAuth();
    const deleted = {
      users: users.deletedCount || 0, devices: devices.deletedCount || 0, glucose: glucose.deletedCount || 0,
      events: events.deletedCount || 0, sensors: sensors.deletedCount || 0, alarms: alarms.deletedCount || 0, settings: settings.deletedCount || 0,
    };
    await audit(req, { action: 'system.reset', targetType: 'system', after: deleted });
    console.log('[admin/system/reset] wiped by', req.admin.username, deleted);
    return res.json({ ok: true, deleted });
  } catch (e) {
    return fail(res, 'admin/system/reset', e);
  }
});

export default router;

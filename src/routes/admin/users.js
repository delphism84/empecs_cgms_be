import express from 'express';
import User from '../../models/User.js';
import Eq from '../../models/Eq.js';
import DeviceUnit from '../../models/DeviceUnit.js';
import GlucosePoint from '../../models/GlucosePoint.js';
import Event from '../../models/Event.js';
import Sensor from '../../models/Sensor.js';
import Alarm from '../../models/Alarm.js';
import AppSetting from '../../models/AppSetting.js';
import LoginLog from '../../models/LoginLog.js';
import { requireAdmin, requirePerm } from '../../admin/auth.js';
import { audit, diff } from '../../admin/audit.js';
import { invalidateUserAuth } from '../../lib/userAuth.js';
import { getSettings } from '../../lib/settingsStore.js';
import { unitStatus, unitTimes, clearUnitRegistration, recordEqHistory } from '../../lib/deviceRegistry.js';
import {
  escapeRegex,
  isId,
  oid,
  paging,
  sorting,
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

function normalizeMac(raw) {
  return typeof raw === 'string' ? raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase() : '';
}

export function serializeUser(u) {
  return {
    id: u._id.toString(),
    email: u.email,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    name: u.name || '',
    label: userLabel(u),
    dateOfBirth: u.dateOfBirth || '',
    gender: u.gender || '',
    unit: u.unit || 'mg/dL',
    countryCode: u.countryCode || '',
    language: u.language || '',
    provider: u.provider || 'local',
    providerId: u.providerId || '',
    hasPassword: !!u.passwordHash,
    status: u.status || 'active',
    suspendedReason: u.suspendedReason || '',
    suspendedAt: u.suspendedAt || null,
    deletedAt: u.deletedAt || null,
    lastLoginAt: u.lastLoginAt || null,
    lastSeenAt: u.lastSeenAt || null,
    lastUploadAt: u.lastUploadAt || null,
    adminNote: u.adminNote || '',
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** 목록·내보내기 공용 조건. */
async function buildUserQuery(query) {
  const clauses = [];
  const period = parsePeriod(query);
  if (period) clauses.push({ createdAt: period });

  const sn = String(query.sn || '').trim();
  const mac = normalizeMac(query.mac);
  if (sn || mac) {
    const eqQ = {};
    if (sn) eqQ.serial = new RegExp(escapeRegex(sn), 'i');
    if (mac) eqQ.bleMac = mac;
    const eqs = await Eq.find(eqQ).select('userId').limit(5000).lean();
    const ids = [...new Set(eqs.map((e) => e.userId?.toString()).filter(Boolean))];
    if (ids.length === 0) return null;
    clauses.push({ _id: { $in: ids.map(oid) } });
  }
  const text = String(query.user || query.q || '').trim();
  if (text) clauses.push(isId(text) ? { _id: oid(text) } : userSearchQuery(text));

  const status = String(query.status || '').trim();
  if (status === 'active') clauses.push({ $or: [{ status: 'active' }, { status: { $exists: false } }] });
  else if (status === 'suspended' || status === 'deleted') clauses.push({ status });
  else clauses.push({ status: { $ne: 'deleted' } }); // 기본: 탈퇴 처리된 회원은 숨김

  const provider = String(query.provider || '').trim();
  if (provider === 'local') clauses.push({ provider: null });
  else if (['google', 'kakao', 'apple'].includes(provider)) clauses.push({ provider });

  const country = String(query.country || '').trim();
  if (country) clauses.push({ countryCode: new RegExp(`^${escapeRegex(country)}$`, 'i') });

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

const USER_SORTS = ['createdAt', 'email', 'lastLoginAt', 'lastSeenAt', 'lastUploadAt'];

router.get('/users', requirePerm('users.read'), async (req, res) => {
  try {
    const { page, limit, skip } = paging(req);
    const q = await buildUserQuery(req.query);
    if (!q) return res.json({ items: [], total: 0, page, limit });
    const [total, rows] = await Promise.all([
      User.countDocuments(q),
      User.find(q).sort(sorting(req, USER_SORTS, { createdAt: -1 })).skip(skip).limit(limit).lean(),
    ]);
    const ids = rows.map((r) => r._id);
    const counts = await Eq.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]);
    const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
    const items = rows.map((r) => ({
      id: r._id.toString(),
      email: r.email,
      name: userLabel(r),
      provider: r.provider || 'local',
      countryCode: r.countryCode || '',
      status: r.status || 'active',
      deviceCount: countBy.get(String(r._id)) || 0,
      lastLoginAt: r.lastLoginAt || null,
      lastSeenAt: r.lastSeenAt || null,
      lastUploadAt: r.lastUploadAt || null,
      createdAt: r.createdAt,
    }));
    return res.json({ items, total, page, limit });
  } catch (e) {
    return fail(res, 'admin/users', e);
  }
});

router.get('/users/export.csv', requirePerm('users.read', 'data.export'), async (req, res) => {
  try {
    const q = await buildUserQuery(req.query);
    beginCsv(res, `cgms-users-${new Date().toISOString().slice(0, 10)}.csv`, [
      'id', 'email', 'name', 'provider', 'country', 'status', 'created_kst', 'last_login_kst', 'last_upload_kst',
    ]);
    if (q) {
      const cursor = User.find(q).sort({ createdAt: -1 }).limit(100000).lean().cursor();
      for await (const u of cursor) {
        res.write(
          csvLine([
            u._id.toString(), u.email, userLabel(u), u.provider || 'local', u.countryCode || '', u.status || 'active',
            kstString(u.createdAt), kstString(u.lastLoginAt), kstString(u.lastUploadAt),
          ])
        );
      }
    }
    await audit(req, { action: 'users.export', targetType: 'user', note: JSON.stringify(req.query).slice(0, 500) });
    return res.end();
  } catch (e) {
    if (!res.headersSent) return fail(res, 'admin/users/export', e);
    console.error('[admin/users/export]', e?.message || e);
    return res.end();
  }
});

router.get('/users/:id', requirePerm('users.read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id).lean();
    if (!u) return res.status(404).json({ error: 'not_found' });
    return res.json(serializeUser(u));
  } catch (e) {
    return fail(res, 'admin/users/:id', e);
  }
});

/** 회원 상세 한 화면: 프로필 + 센서 + 데이터 요약 + 알람 + 앱 설정 + 최근 로그인. */
router.get('/users/:id/overview', requirePerm('users.read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const id = oid(req.params.id);
    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ error: 'not_found' });
    const settings = await getSettings();
    const now = Date.now();
    const since14 = new Date(now - 14 * 86400000);

    const [eqs, alarms, appSetting, sensors, logins, totalPoints, firstPoint, lastPoint, eventCount, recent] =
      await Promise.all([
        Eq.find({ $or: [{ userId: id }, { createdBy: id }, { updatedBy: id }] }).sort({ startAt: -1 }).lean(),
        Alarm.find({ userId: id }).lean(),
        AppSetting.findOne({ userId: id }).lean(),
        Sensor.find({ userId: id }).sort({ createdAt: -1 }).lean(),
        LoginLog.find({ kind: 'user', subjectId: id.toString() }).sort({ at: -1 }).limit(20).lean(),
        GlucosePoint.countDocuments({ userId: id }),
        GlucosePoint.findOne({ userId: id }).sort({ time: 1 }).select('time').lean(),
        GlucosePoint.findOne({ userId: id }).sort({ time: -1 }).select('time value eqsn').lean(),
        Event.countDocuments({ userId: id }),
        GlucosePoint.find({ userId: id, time: { $gte: since14 } }).select('value').lean(),
      ]);

    const units = await DeviceUnit.find({ serial: { $in: eqs.map((e) => e.serial) } }).lean();
    const unitBy = new Map(units.map((x) => [x.serial, x]));
    const devices = eqs.map((e) => {
      const unit = unitBy.get(e.serial) || { startAt: e.startAt, blocked: false, stage: 'shipped' };
      const t = unitTimes({ startAt: e.startAt }, now, settings);
      return {
        id: e._id.toString(),
        serial: e.serial,
        bleMac: e.bleMac || '',
        startAt: e.startAt,
        endAt: t.endAt,
        remainingMs: t.remainingMs,
        status: unitStatus({ ...unit, startAt: e.startAt }, now, settings),
        verified: unitBy.get(e.serial)?.verified ?? false,
        lotCode: unitBy.get(e.serial)?.lotCode || '',
      };
    });

    const th = { veryLow: 54, low: 70, high: 180 };
    for (const a of alarms) {
      if (a.threshold == null) continue;
      if (a.type === 'low') th.low = a.threshold;
      if (a.type === 'high') th.high = a.threshold;
    }
    let sum = 0, low = 0, inRange = 0, high = 0, min = null, max = null;
    for (const p of recent) {
      const v = Number(p.value);
      if (!Number.isFinite(v)) continue;
      sum += v;
      if (v < th.low) low += 1; else if (v > th.high) high += 1; else inRange += 1;
      min = min == null ? v : Math.min(min, v);
      max = max == null ? v : Math.max(max, v);
    }
    const n = low + inRange + high;

    return res.json({
      user: serializeUser(u),
      devices,
      sensors: sensors.map((s) => ({ id: s._id.toString(), name: s.name, serial: s.serial || '', isActive: s.isActive !== false, createdAt: s.createdAt })),
      alarms: alarms.map((a) => ({
        type: a.type, enabled: a.enabled !== false, threshold: a.threshold ?? null,
        repeatMin: a.repeatMin ?? null, sound: a.sound !== false, vibrate: a.vibrate !== false,
        quietFrom: a.quietFrom || '', quietTo: a.quietTo || '',
      })),
      appSetting: appSetting
        ? { unit: appSetting.unit, notifications: appSetting.notifications, darkMode: appSetting.darkMode, updatedAt: appSetting.updatedAt }
        : null,
      data: {
        totalPoints,
        eventCount,
        firstAt: firstPoint?.time || null,
        lastAt: lastPoint?.time || null,
        lastValue: lastPoint?.value ?? null,
        lastEqsn: lastPoint?.eqsn || '',
      },
      stats14d: {
        points: n,
        avg: n ? Math.round((sum / n) * 10) / 10 : null,
        min, max,
        lowPct: n ? Math.round((low * 1000) / n) / 10 : null,
        inRangePct: n ? Math.round((inRange * 1000) / n) / 10 : null,
        highPct: n ? Math.round((high * 1000) / n) / 10 : null,
        thresholds: th,
      },
      logins: logins.map((l) => ({ at: l.at, success: l.success, reason: l.reason || '', method: l.method || '', ip: l.ip || '' })),
      serverTime: new Date(now).toISOString(),
    });
  } catch (e) {
    return fail(res, 'admin/users/:id/overview', e);
  }
});

/** 혈당 그래프용. 구간이 길면 버킷 평균으로 줄여 최대 maxPoints 개만 보낸다. */
router.get('/users/:id/glucose', requirePerm('users.read', 'data.read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const id = oid(req.params.id);
    const period = parsePeriod(req.query) || { $gte: new Date(Date.now() - 86400000) };
    const from = period.$gte || new Date(0);
    const to = period.$lte || new Date();
    const maxPoints = Math.min(3000, Math.max(100, Number(req.query.maxPoints) || 1200));
    const q = { userId: id, time: { $gte: from, $lte: to } };
    const eqsn = String(req.query.eqsn || '').trim().toUpperCase();
    if (eqsn) q.eqsn = eqsn;
    const total = await GlucosePoint.countDocuments(q);
    let points;
    if (total <= maxPoints) {
      const rows = await GlucosePoint.find(q).sort({ time: 1 }).select('time value').lean();
      points = rows.map((r) => ({ t: new Date(r.time).getTime(), v: r.value }));
    } else {
      const spanMs = Math.max(1, to.getTime() - from.getTime());
      const bucketMs = Math.max(60000, Math.ceil(spanMs / maxPoints / 60000) * 60000);
      const rows = await GlucosePoint.aggregate([
        { $match: q },
        { $group: { _id: { $subtract: [{ $toLong: '$time' }, { $mod: [{ $toLong: '$time' }, bucketMs] }] }, v: { $avg: '$value' }, lo: { $min: '$value' }, hi: { $max: '$value' } } },
        { $sort: { _id: 1 } },
      ]);
      points = rows.map((r) => ({ t: r._id, v: Math.round(r.v * 10) / 10, lo: r.lo, hi: r.hi }));
    }
    return res.json({ points, total, downsampled: total > maxPoints, from, to });
  } catch (e) {
    return fail(res, 'admin/users/:id/glucose', e);
  }
});

router.get('/users/:id/events', requirePerm('users.read', 'data.read'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const { page, limit, skip } = paging(req);
    const q = { userId: oid(req.params.id) };
    const period = parsePeriod(req.query);
    if (period) q.time = period;
    const [total, rows] = await Promise.all([
      Event.countDocuments(q),
      Event.find(q).sort({ time: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return res.json({
      items: rows.map((r) => ({ id: r._id.toString(), type: r.type, time: r.time, memo: r.memo || '', eqsn: r.eqsn || '' })),
      total, page, limit,
    });
  } catch (e) {
    return fail(res, 'admin/users/:id/events', e);
  }
});

router.patch('/users/:id', requirePerm('users.write'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    const before = serializeUser(u.toObject());
    const body = req.body || {};

    if (body.email !== undefined) {
      const next = String(body.email).trim().toLowerCase();
      if (!next) return res.status(400).json({ error: 'email_required' });
      const dup = await User.findOne({ email: next, _id: { $ne: u._id } }).select('_id').lean();
      if (dup) return res.status(409).json({ error: 'email_taken' });
      u.email = next;
    }
    for (const k of ['firstName', 'lastName', 'name', 'countryCode', 'language', 'adminNote']) {
      if (body[k] !== undefined) u[k] = body[k] == null ? '' : String(body[k]).slice(0, k === 'adminNote' ? 2000 : 100);
    }
    if (body.dateOfBirth !== undefined) {
      const d = String(body.dateOfBirth || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'invalid_dateOfBirth' });
      u.dateOfBirth = d;
    }
    if (body.gender !== undefined) {
      const g = String(body.gender || '');
      if (g && !['male', 'female'].includes(g)) return res.status(400).json({ error: 'invalid_gender' });
      u.gender = g;
    }
    if (body.unit !== undefined) {
      if (!['mg/dL', 'mmol'].includes(String(body.unit))) return res.status(400).json({ error: 'invalid_unit' });
      u.unit = String(body.unit);
    }
    await u.save();
    const after = serializeUser(u.toObject());
    await audit(req, { action: 'user.update', targetType: 'user', targetId: u._id, targetLabel: u.email, ...diff(before, after) });
    return res.json({ ok: true, user: after });
  } catch (e) {
    return fail(res, 'admin/users/:id PATCH', e);
  }
});

/** 기존 비밀번호 없이 새 비밀번호 설정. 기존 세션은 모두 로그아웃된다. */
router.post('/users/:id/password', requirePerm('users.support'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password_min_8' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    u.passwordHash = await User.hashPassword(password);
    u.tokenVersion = (u.tokenVersion || 0) + 1;
    await u.save();
    invalidateUserAuth(u._id);
    await audit(req, { action: 'user.password_reset', targetType: 'user', targetId: u._id, targetLabel: u.email });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/users/:id/password', e);
  }
});

router.post('/users/:id/force-logout', requirePerm('users.support'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findByIdAndUpdate(req.params.id, { $inc: { tokenVersion: 1 } }, { new: true });
    if (!u) return res.status(404).json({ error: 'not_found' });
    invalidateUserAuth(u._id);
    await audit(req, { action: 'user.force_logout', targetType: 'user', targetId: u._id, targetLabel: u.email });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/users/:id/force-logout', e);
  }
});

router.post('/users/:id/suspend', requirePerm('users.write'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.status === 'deleted') return res.status(409).json({ error: 'user_deleted' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    u.status = 'suspended';
    u.suspendedReason = reason;
    u.suspendedAt = new Date();
    await u.save();
    invalidateUserAuth(u._id);
    await audit(req, { action: 'user.suspend', targetType: 'user', targetId: u._id, targetLabel: u.email, note: reason });
    return res.json({ ok: true, user: serializeUser(u.toObject()) });
  } catch (e) {
    return fail(res, 'admin/users/:id/suspend', e);
  }
});

router.post('/users/:id/unsuspend', requirePerm('users.write'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.status !== 'suspended') return res.status(409).json({ error: 'not_suspended' });
    u.status = 'active';
    u.suspendedReason = '';
    u.suspendedAt = undefined;
    await u.save();
    invalidateUserAuth(u._id);
    await audit(req, { action: 'user.unsuspend', targetType: 'user', targetId: u._id, targetLabel: u.email });
    return res.json({ ok: true, user: serializeUser(u.toObject()) });
  } catch (e) {
    return fail(res, 'admin/users/:id/unsuspend', e);
  }
});

/** 탈퇴 처리(soft)된 회원 복구. */
router.post('/users/:id/restore', requirePerm('users.delete'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.status !== 'deleted') return res.status(409).json({ error: 'not_deleted' });
    u.status = 'active';
    u.deletedAt = undefined;
    await u.save();
    invalidateUserAuth(u._id);
    await audit(req, { action: 'user.restore', targetType: 'user', targetId: u._id, targetLabel: u.email });
    return res.json({ ok: true, user: serializeUser(u.toObject()) });
  } catch (e) {
    return fail(res, 'admin/users/:id/restore', e);
  }
});

/**
 * 탈퇴 처리.
 * - mode=soft(기본): 로그인 차단 + 세션 종료. 데이터는 남는다(복구 가능).
 * - mode=purge: 회원과 혈당·이벤트·알람·설정을 모두 삭제하고 센서 등록을 해제한다(복구 불가).
 *   확인용으로 회원 이메일을 confirm 에 그대로 보내야 한다.
 */
router.delete('/users/:id', requirePerm('users.delete'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    const mode = String(req.body?.mode || req.query.mode || 'soft');

    if (mode !== 'purge') {
      u.status = 'deleted';
      u.deletedAt = new Date();
      u.tokenVersion = (u.tokenVersion || 0) + 1;
      await u.save();
      invalidateUserAuth(u._id);
      await audit(req, { action: 'user.delete_soft', targetType: 'user', targetId: u._id, targetLabel: u.email });
      return res.json({ ok: true, mode: 'soft' });
    }

    if (String(req.body?.confirm || '').trim().toLowerCase() !== String(u.email).toLowerCase()) {
      return res.status(400).json({ error: 'confirm_mismatch' });
    }
    const id = u._id;
    const eqs = await Eq.find({ $or: [{ userId: id }, { createdBy: id }, { updatedBy: id }] }).lean();
    for (const e of eqs) {
      await recordEqHistory({
        serial: e.serial, action: 'release', prevUserId: e.userId, prevStartAt: e.startAt,
        byKind: 'admin', byId: req.admin.id, byName: req.admin.username, note: 'user purged',
      });
      await clearUnitRegistration(e.serial);
    }
    const [glucose, events, alarms, sensors, settings, eqDel] = await Promise.all([
      GlucosePoint.deleteMany({ userId: id }),
      Event.deleteMany({ userId: id }),
      Alarm.deleteMany({ userId: id }),
      Sensor.deleteMany({ userId: id }),
      AppSetting.deleteMany({ userId: id }),
      Eq.deleteMany({ _id: { $in: eqs.map((e) => e._id) } }),
    ]);
    await u.deleteOne();
    invalidateUserAuth(id);
    const deleted = {
      glucose: glucose.deletedCount || 0, events: events.deletedCount || 0, alarms: alarms.deletedCount || 0,
      sensors: sensors.deletedCount || 0, settings: settings.deletedCount || 0, devicesReleased: eqDel.deletedCount || 0,
    };
    await audit(req, { action: 'user.delete_purge', targetType: 'user', targetId: id, targetLabel: u.email, after: deleted });
    return res.json({ ok: true, mode: 'purge', deleted });
  } catch (e) {
    return fail(res, 'admin/users/:id DELETE', e);
  }
});

export default router;

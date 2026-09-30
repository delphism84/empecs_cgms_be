import express from 'express';
import User from '../../models/User.js';
import Eq from '../../models/Eq.js';
import DeviceUnit from '../../models/DeviceUnit.js';
import Lot from '../../models/Lot.js';
import EqHistory from '../../models/EqHistory.js';
import GlucosePoint from '../../models/GlucosePoint.js';
import { requireAdmin, requirePerm } from '../../admin/auth.js';
import { audit, diff, snapshot } from '../../admin/audit.js';
import { getSettings, validityMs } from '../../lib/settingsStore.js';
import { normalizeBleMac } from '../../lib/eqNormalize.js';
import {
  parseSerial,
  composeSerial,
  buildQrPayload,
  unitStatus,
  unitTimes,
  syncUnitFromEq,
  clearUnitRegistration,
  recordEqHistory,
} from '../../lib/deviceRegistry.js';
import { listDevicesEndingSoon } from '../../services/devicesEndingSoon.js';
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

const by = (req) => ({ byKind: 'admin', byId: req.admin.id, byName: req.admin.username });

function serializeUnit(u, owner, settings, now = Date.now()) {
  const t = unitTimes(u, now, settings);
  return {
    id: u._id.toString(),
    serial: u.serial,
    bleMac: u.bleMac || '',
    model: u.model || '',
    yearCode: u.yearCode || '',
    year: settings.yearCodes?.[u.yearCode] ?? null,
    sample: !!u.sample,
    seq: u.seq ?? null,
    formatOk: u.formatOk !== false,
    lotCode: u.lotCode || '',
    manufacturedAt: u.manufacturedAt || null,
    stage: u.stage || 'stock',
    shippedAt: u.shippedAt || null,
    shippedTo: u.shippedTo || '',
    blocked: !!u.blocked,
    blockedReason: u.blockedReason || '',
    blockedAt: u.blockedAt || null,
    source: u.source || 'admin',
    verified: u.verified !== false,
    note: u.note || '',
    status: unitStatus(u, now, settings),
    startAt: u.startAt || null,
    endAt: t.endAt,
    remainingMs: t.remainingMs,
    registeredAt: u.registeredAt || null,
    owner: owner ? { id: owner._id.toString(), email: owner.email, label: userLabel(owner) } : null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** 상태 필터 → Mongo 조건. 상태 우선순위는 lib/deviceRegistry.unitStatus 와 같다. */
function statusClause(status, settings, now = Date.now()) {
  const cutoff = new Date(now - validityMs(settings));
  const notBlocked = { blocked: { $ne: true } };
  switch (status) {
    case 'blocked':
      return { blocked: true };
    case 'active':
      return { ...notBlocked, startAt: { $gt: cutoff } };
    case 'expired':
      return { ...notBlocked, startAt: { $ne: null, $lte: cutoff } };
    case 'ending':
      return {
        ...notBlocked,
        startAt: { $gt: cutoff, $lte: new Date(cutoff.getTime() + settings.endingSoonHours * 3600000) },
      };
    case 'registered':
      return { startAt: { $ne: null } };
    case 'stock':
      return { ...notBlocked, startAt: null, stage: { $ne: 'shipped' } };
    case 'shipped':
      return { ...notBlocked, startAt: null, stage: 'shipped' };
    default:
      return null;
  }
}

async function buildUnitQuery(query, settings) {
  const clauses = [];
  const period = parsePeriod(query);
  if (period) clauses.push({ createdAt: period });
  const sn = String(query.sn || query.q || '').trim();
  if (sn) clauses.push({ serial: new RegExp(escapeRegex(sn), 'i') });
  const mac = String(query.mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (mac) clauses.push({ bleMac: new RegExp(`^${mac}`) });
  const lot = String(query.lot || '').trim().toUpperCase();
  if (lot === '-') clauses.push({ lotCode: '' });
  else if (lot) clauses.push({ lotCode: lot });
  const source = String(query.source || '').trim();
  if (['admin', 'import', 'app'].includes(source)) clauses.push({ source });
  if (query.verified === 'true') clauses.push({ verified: { $ne: false } });
  if (query.verified === 'false') clauses.push({ verified: false });
  if (query.formatOk === 'false') clauses.push({ formatOk: false });
  const st = statusClause(String(query.status || ''), settings);
  if (st) clauses.push(st);
  const user = String(query.user || '').trim();
  if (user) {
    const users = await User.find(isId(user) ? { _id: oid(user) } : userSearchQuery(user)).select('_id').limit(2000).lean();
    if (users.length === 0) return null;
    clauses.push({ ownerId: { $in: users.map((u) => u._id) } });
  }
  return clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };
}

async function ownersFor(units) {
  const ids = [...new Set(units.map((u) => u.ownerId?.toString()).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('email firstName lastName name').lean();
  return new Map(users.map((u) => [u._id.toString(), u]));
}

const UNIT_SORTS = ['serial', 'createdAt', 'updatedAt', 'startAt', 'lotCode'];

router.get('/devices', requirePerm('devices.read'), async (req, res) => {
  try {
    const settings = await getSettings();
    const { page, limit, skip } = paging(req);
    const q = await buildUnitQuery(req.query, settings);
    if (!q) return res.json({ items: [], total: 0, page, limit });
    const [total, rows] = await Promise.all([
      DeviceUnit.countDocuments(q),
      DeviceUnit.find(q).sort(sorting(req, UNIT_SORTS, { updatedAt: -1 })).skip(skip).limit(limit).lean(),
    ]);
    const owners = await ownersFor(rows);
    const now = Date.now();
    return res.json({
      items: rows.map((u) => serializeUnit(u, owners.get(String(u.ownerId)), settings, now)),
      total,
      page,
      limit,
      validityDays: settings.eqValidityDays,
    });
  } catch (e) {
    return fail(res, 'admin/devices', e);
  }
});

router.get('/devices/summary', requirePerm('devices.read'), async (_req, res) => {
  try {
    const settings = await getSettings();
    const keys = ['stock', 'shipped', 'active', 'ending', 'expired', 'blocked'];
    const counts = await Promise.all(keys.map((k) => DeviceUnit.countDocuments(statusClause(k, settings))));
    const [total, unverified, formatBad] = await Promise.all([
      DeviceUnit.countDocuments({}),
      DeviceUnit.countDocuments({ verified: false }),
      DeviceUnit.countDocuments({ formatOk: false }),
    ]);
    return res.json({
      total,
      ...Object.fromEntries(keys.map((k, i) => [k, counts[i]])),
      unverified,
      formatBad,
      validityDays: settings.eqValidityDays,
      snPolicy: settings.snPolicy,
    });
  } catch (e) {
    return fail(res, 'admin/devices/summary', e);
  }
});

router.get('/devices/ending-soon', requirePerm('devices.read'), async (_req, res) => {
  try {
    return res.json(await listDevicesEndingSoon());
  } catch (e) {
    return fail(res, 'admin/devices/ending-soon', e);
  }
});

router.get('/devices/export.csv', requirePerm('devices.read', 'data.export'), async (req, res) => {
  try {
    const settings = await getSettings();
    const q = await buildUnitQuery(req.query, settings);
    beginCsv(res, `cgms-devices-${new Date().toISOString().slice(0, 10)}.csv`, [
      'serial', 'ble_mac', 'model', 'lot', 'status', 'verified', 'source', 'owner_email', 'start_kst', 'end_kst', 'created_kst', 'qr_payload',
    ]);
    if (q) {
      const rows = await DeviceUnit.find(q).sort({ serial: 1 }).limit(100000).lean();
      const owners = await ownersFor(rows);
      const now = Date.now();
      for (const u of rows) {
        const t = unitTimes(u, now, settings);
        res.write(
          csvLine([
            u.serial, u.bleMac || '', u.model || '', u.lotCode || '', unitStatus(u, now, settings),
            u.verified !== false ? 'Y' : 'N', u.source || '', owners.get(String(u.ownerId))?.email || '',
            kstString(u.startAt), kstString(t.endAt), kstString(u.createdAt), buildQrPayload(u, settings) || '',
          ])
        );
      }
    }
    await audit(req, { action: 'devices.export', targetType: 'device', note: JSON.stringify(req.query).slice(0, 500) });
    return res.end();
  } catch (e) {
    if (!res.headersSent) return fail(res, 'admin/devices/export', e);
    return res.end();
  }
});

/** QR 라벨 출력용: 앱이 읽는 문자열을 그대로 돌려준다. serials=a,b,c 또는 lot=코드. */
router.get('/devices/qr', requirePerm('devices.read'), async (req, res) => {
  try {
    const settings = await getSettings();
    const serials = String(req.query.serials || '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 1000);
    const lot = String(req.query.lot || '').trim().toUpperCase();
    if (!serials.length && !lot) return res.status(400).json({ error: 'serials_or_lot_required' });
    const q = serials.length ? { serial: { $in: serials } } : { lotCode: lot };
    const rows = await DeviceUnit.find(q).sort({ serial: 1 }).limit(1000).lean();
    return res.json({
      items: rows.map((u) => ({
        serial: u.serial,
        bleMac: u.bleMac || '',
        lotCode: u.lotCode || '',
        payload: buildQrPayload(u, settings),
        /** MAC 이 없으면 SN 단독(앱 구형식) — BLE 자동 연결에는 MAC 이 필요하다. */
        hasMac: !!(u.bleMac && u.bleMac.length === 12),
      })),
      missing: serials.filter((s) => !rows.some((r) => r.serial === s)),
      format: `${settings.qrAdvName};0x${settings.qrManufacturerId}<MAC12>;0x<SN>`,
    });
  } catch (e) {
    return fail(res, 'admin/devices/qr', e);
  }
});

// ── 등록 ────────────────────────────────────────────────────────────────────

/** 재고 1건 준비(검증만). 문제가 있으면 { error } */
function prepareUnit(row, settings, defaults = {}) {
  const parsed = parseSerial(row.serial, settings);
  if (!parsed.serial) return { error: 'serial_required' };
  if (parsed.serial.length > 40) return { error: 'serial_too_long' };
  let bleMac;
  if (row.bleMac != null && String(row.bleMac).trim() !== '') {
    bleMac = normalizeBleMac(String(row.bleMac));
    if (!bleMac) return { error: 'invalid_bleMac' };
  }
  let manufacturedAt;
  const m = row.manufacturedAt ?? defaults.manufacturedAt;
  if (m != null && String(m).trim() !== '') {
    manufacturedAt = new Date(m);
    if (Number.isNaN(manufacturedAt.getTime())) return { error: 'invalid_manufacturedAt' };
  }
  return {
    doc: {
      serial: parsed.serial,
      bleMac,
      model: parsed.model,
      yearCode: parsed.yearCode,
      sample: parsed.sample,
      seq: parsed.seq ?? undefined,
      formatOk: parsed.formatOk,
      lotCode: String(row.lotCode ?? defaults.lotCode ?? '').trim().toUpperCase(),
      manufacturedAt,
      note: String(row.note ?? '').slice(0, 500),
    },
  };
}

async function ensureLot(code, req) {
  if (!code) return;
  if (await Lot.exists({ code })) return;
  await Lot.create({ code, createdBy: req.admin.username });
}

/**
 * 재고 반영. 이미 있는 SN 은:
 * - 앱이 먼저 등록한 미확인 행이면 "확인됨"으로 올리고 로트·MAC 을 채운다(upgraded)
 * - 이미 확인된 행이면 건드리지 않는다(skipped)
 */
async function upsertUnit(doc, source, req) {
  const existing = await DeviceUnit.findOne({ serial: doc.serial });
  if (!existing) {
    const created = await DeviceUnit.create({ ...doc, source, verified: true, stage: 'stock', createdBy: req.admin.username });
    // 재고 등록 전에 이미 앱에서 등록돼 있었을 수 있다.
    const eq = await Eq.findOne({ serial: doc.serial }).lean();
    if (eq) await syncUnitFromEq(eq);
    return { result: 'created', unit: created };
  }
  if (existing.verified === false) {
    existing.verified = true;
    if (doc.lotCode) existing.lotCode = doc.lotCode;
    if (doc.bleMac && !existing.bleMac) existing.bleMac = doc.bleMac;
    if (doc.manufacturedAt) existing.manufacturedAt = doc.manufacturedAt;
    if (doc.note) existing.note = doc.note;
    await existing.save();
    return { result: 'upgraded', unit: existing };
  }
  return { result: 'skipped', unit: existing };
}

router.post('/devices', requirePerm('devices.write'), async (req, res) => {
  try {
    const settings = await getSettings();
    const p = prepareUnit(req.body || {}, settings);
    if (p.error) return res.status(400).json({ error: p.error });
    if (req.body?.strict === true && !p.doc.formatOk) return res.status(400).json({ error: 'serial_format' });
    await ensureLot(p.doc.lotCode, req);
    const r = await upsertUnit(p.doc, 'admin', req);
    if (r.result === 'skipped') return res.status(409).json({ error: 'serial_exists' });
    await audit(req, { action: 'device.create', targetType: 'device', targetId: r.unit.serial, targetLabel: r.unit.serial, after: snapshot(p.doc) });
    return res.status(201).json({ ok: true, result: r.result, serial: r.unit.serial });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ error: 'bleMac_conflict' });
    return fail(res, 'admin/devices POST', e);
  }
});

/**
 * 일괄 등록(CSV 를 FE 가 파싱해 rows 로 보낸다). dryRun=true 면 검증 결과만 돌려준다.
 * body: { rows:[{serial,bleMac?,lotCode?,manufacturedAt?,note?}], lotCode?, manufacturedAt?, dryRun? }
 */
router.post('/devices/import', requirePerm('devices.write'), async (req, res) => {
  try {
    const settings = await getSettings();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'rows_required' });
    if (rows.length > 5000) return res.status(400).json({ error: 'too_many_rows', max: 5000 });
    const defaults = {
      lotCode: String(req.body?.lotCode || '').trim().toUpperCase(),
      manufacturedAt: req.body?.manufacturedAt,
    };
    const dryRun = req.body?.dryRun === true;
    const seenSerial = new Set();
    const seenMac = new Set();
    const results = [];
    const prepared = [];
    rows.forEach((row, index) => {
      const p = prepareUnit(row || {}, settings, defaults);
      if (p.error) return results.push({ index, serial: String(row?.serial || ''), result: 'error', error: p.error });
      if (seenSerial.has(p.doc.serial)) return results.push({ index, serial: p.doc.serial, result: 'error', error: 'duplicate_in_file' });
      if (p.doc.bleMac && seenMac.has(p.doc.bleMac)) return results.push({ index, serial: p.doc.serial, result: 'error', error: 'duplicate_mac_in_file' });
      seenSerial.add(p.doc.serial);
      if (p.doc.bleMac) seenMac.add(p.doc.bleMac);
      prepared.push({ index, doc: p.doc });
    });

    const existing = await DeviceUnit.find({ serial: { $in: prepared.map((p) => p.doc.serial) } }).select('serial verified bleMac').lean();
    const existBy = new Map(existing.map((u) => [u.serial, u]));
    const macs = prepared.map((p) => p.doc.bleMac).filter(Boolean);
    const macOwners = macs.length ? await DeviceUnit.find({ bleMac: { $in: macs } }).select('serial bleMac').lean() : [];
    const macBy = new Map(macOwners.map((u) => [u.bleMac, u.serial]));

    for (const p of prepared) {
      const ex = existBy.get(p.doc.serial);
      const macHolder = p.doc.bleMac ? macBy.get(p.doc.bleMac) : null;
      if (macHolder && macHolder !== p.doc.serial) {
        results.push({ index: p.index, serial: p.doc.serial, result: 'error', error: 'bleMac_conflict', conflictWith: macHolder });
        continue;
      }
      const planned = !ex ? 'created' : ex.verified === false ? 'upgraded' : 'skipped';
      if (dryRun) {
        results.push({ index: p.index, serial: p.doc.serial, result: planned, formatOk: p.doc.formatOk });
        continue;
      }
      try {
        const r = await upsertUnit(p.doc, 'import', req);
        results.push({ index: p.index, serial: p.doc.serial, result: r.result, formatOk: p.doc.formatOk });
      } catch (e) {
        results.push({ index: p.index, serial: p.doc.serial, result: 'error', error: e?.code === 11000 ? 'bleMac_conflict' : 'save_failed' });
      }
    }
    results.sort((a, b) => a.index - b.index);
    const summary = { total: rows.length, created: 0, upgraded: 0, skipped: 0, error: 0, formatWarnings: 0 };
    for (const r of results) {
      summary[r.result] += 1;
      if (r.formatOk === false) summary.formatWarnings += 1;
    }
    if (!dryRun) {
      const lots = [...new Set(prepared.map((p) => p.doc.lotCode).filter(Boolean))];
      for (const code of lots) await ensureLot(code, req);
      await audit(req, { action: 'devices.import', targetType: 'device', targetLabel: defaults.lotCode || '', after: summary });
    }
    return res.json({ ok: true, dryRun, summary, results: results.slice(0, 5000) });
  } catch (e) {
    return fail(res, 'admin/devices/import', e);
  }
});

/**
 * SN 범위 생성. MAC 은 생산 후에 알 수 있으므로 비워 두고, 나중에 가져오기로 채운다.
 * body: { model:'C21', yearCode:'Z', sample:false, from:101, count:50, lotCode?, dryRun? }
 */
router.post('/devices/generate', requirePerm('devices.write'), async (req, res) => {
  try {
    const settings = await getSettings();
    const model = String(req.body?.model || '').trim().toUpperCase();
    const yearCode = String(req.body?.yearCode || '').trim().toUpperCase();
    const sample = req.body?.sample === true;
    const from = Math.round(Number(req.body?.from));
    const count = Math.round(Number(req.body?.count));
    if (!/^C\d{2}$/.test(model)) return res.status(400).json({ error: 'invalid_model' });
    if (!/^[A-Z]$/.test(yearCode)) return res.status(400).json({ error: 'invalid_yearCode' });
    if (!Number.isFinite(from) || from < 0 || !Number.isFinite(count) || count < 1 || count > 2000) {
      return res.status(400).json({ error: 'invalid_range', maxCount: 2000 });
    }
    if (from + count - 1 > 99999) return res.status(400).json({ error: 'seq_overflow' });
    const lotCode = String(req.body?.lotCode || '').trim().toUpperCase();
    const serials = Array.from({ length: count }, (_, i) => composeSerial({ model, yearCode, sample, seq: from + i }));
    const bad = serials.find((s) => !parseSerial(s, settings).formatOk);
    if (bad) return res.status(400).json({ error: 'pattern_mismatch', example: bad });
    const existing = await DeviceUnit.find({ serial: { $in: serials } }).select('serial').lean();
    const exists = new Set(existing.map((u) => u.serial));
    const fresh = serials.filter((s) => !exists.has(s));
    if (req.body?.dryRun === true) {
      return res.json({ ok: true, dryRun: true, first: serials[0], last: serials[serials.length - 1], willCreate: fresh.length, alreadyExists: exists.size });
    }
    await ensureLot(lotCode, req);
    if (fresh.length) {
      await DeviceUnit.insertMany(
        fresh.map((serial) => {
          const p = parseSerial(serial, settings);
          return { serial, model: p.model, yearCode: p.yearCode, sample: p.sample, seq: p.seq, formatOk: true, lotCode, source: 'admin', verified: true, stage: 'stock', createdBy: req.admin.username };
        }),
        { ordered: false }
      );
    }
    await audit(req, { action: 'devices.generate', targetType: 'device', targetLabel: `${serials[0]}~${serials[serials.length - 1]}`, after: { created: fresh.length, alreadyExists: exists.size, lotCode } });
    return res.json({ ok: true, first: serials[0], last: serials[serials.length - 1], created: fresh.length, alreadyExists: exists.size });
  } catch (e) {
    return fail(res, 'admin/devices/generate', e);
  }
});

/** 여러 SN 에 같은 조치. action: ship | stock | verify | setLot | block | unblock */
router.post('/devices/bulk', requirePerm('devices.write'), async (req, res) => {
  try {
    const serials = (Array.isArray(req.body?.serials) ? req.body.serials : []).map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 5000);
    const action = String(req.body?.action || '');
    if (!serials.length) return res.status(400).json({ error: 'serials_required' });
    let set;
    if (action === 'ship') set = { stage: 'shipped', shippedAt: new Date(), shippedTo: String(req.body?.shippedTo || '').slice(0, 200) };
    else if (action === 'stock') set = { stage: 'stock' };
    else if (action === 'verify') set = { verified: true };
    else if (action === 'setLot') {
      const lotCode = String(req.body?.lotCode || '').trim().toUpperCase();
      await ensureLot(lotCode, req);
      set = { lotCode };
    } else if (action === 'block') set = { blocked: true, blockedAt: new Date(), blockedReason: String(req.body?.reason || '').slice(0, 500) };
    else if (action === 'unblock') set = { blocked: false, blockedReason: '' };
    else return res.status(400).json({ error: 'invalid_action' });
    const r = await DeviceUnit.updateMany({ serial: { $in: serials } }, { $set: set });
    if (action === 'block' || action === 'unblock') {
      for (const serial of serials) await recordEqHistory({ serial, action, ...by(req), note: set.blockedReason || '' });
    }
    await audit(req, { action: `devices.bulk_${action}`, targetType: 'device', targetLabel: `${serials.length} units`, after: { ...set, matched: r.matchedCount, serials: serials.slice(0, 50) } });
    return res.json({ ok: true, matched: r.matchedCount, modified: r.modifiedCount });
  } catch (e) {
    return fail(res, 'admin/devices/bulk', e);
  }
});

// ── 상세·조치 ────────────────────────────────────────────────────────────────

/** :key = SN, 재고 id, 또는 (예전 화면 호환) Eq id */
async function findUnit(key) {
  const k = String(key || '').trim();
  if (isId(k)) {
    const byId = await DeviceUnit.findById(k);
    if (byId) return byId;
    const eq = await Eq.findById(k).lean();
    if (eq) return (await DeviceUnit.findOne({ serial: eq.serial })) || syncUnitFromEq(eq);
  }
  return DeviceUnit.findOne({ serial: k.toUpperCase() });
}

router.get('/devices/:key', requirePerm('devices.read'), async (req, res) => {
  try {
    const settings = await getSettings();
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const u = unit.toObject();
    const [eq, owner, history, points, first, last] = await Promise.all([
      Eq.findOne({ serial: u.serial }).lean(),
      u.ownerId ? User.findById(u.ownerId).lean() : null,
      EqHistory.find({ serial: u.serial }).sort({ at: -1 }).limit(100).lean(),
      GlucosePoint.countDocuments({ eqsn: u.serial }),
      GlucosePoint.findOne({ eqsn: u.serial }).sort({ time: 1 }).select('time').lean(),
      GlucosePoint.findOne({ eqsn: u.serial }).sort({ time: -1 }).select('time value').lean(),
    ]);
    const userIds = [...new Set(history.flatMap((h) => [h.userId, h.prevUserId]).filter(Boolean).map(String))];
    const hUsers = userIds.length ? await User.find({ _id: { $in: userIds } }).select('email').lean() : [];
    const emailBy = new Map(hUsers.map((x) => [x._id.toString(), x.email]));
    const detail = serializeUnit(u, owner, settings);
    return res.json({
      ...detail,
      qrPayload: buildQrPayload(u, settings),
      validityDays: settings.eqValidityDays,
      eqId: eq?._id?.toString() || null,
      // 예전 화면(종료 예정 모달)이 쓰던 필드
      user: owner
        ? {
            id: owner._id.toString(), email: owner.email, name: userLabel(owner), firstName: owner.firstName || '', lastName: owner.lastName || '',
            provider: owner.provider || 'local', countryCode: owner.countryCode || '', unit: owner.unit || 'mg/dL', language: owner.language || '',
            dateOfBirth: owner.dateOfBirth || '', gender: owner.gender || '', createdAt: owner.createdAt, updatedAt: owner.updatedAt,
          }
        : null,
      remainingSec: detail.remainingMs == null ? null : Math.max(0, Math.floor(detail.remainingMs / 1000)),
      data: { points, firstAt: first?.time || null, lastAt: last?.time || null, lastValue: last?.value ?? null },
      history: history.map((h) => ({
        at: h.at, action: h.action, startAt: h.startAt || null, prevStartAt: h.prevStartAt || null,
        userEmail: h.userId ? emailBy.get(String(h.userId)) || '' : '',
        prevUserEmail: h.prevUserId ? emailBy.get(String(h.prevUserId)) || '' : '',
        byKind: h.byKind, byName: h.byName || '', note: h.note || '',
      })),
      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    return fail(res, 'admin/devices/:key', e);
  }
});

router.patch('/devices/:key', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const before = snapshot(unit);
    const b = req.body || {};
    if (b.bleMac !== undefined) {
      if (b.bleMac === null || String(b.bleMac).trim() === '') unit.bleMac = undefined;
      else {
        const mac = normalizeBleMac(String(b.bleMac));
        if (!mac) return res.status(400).json({ error: 'invalid_bleMac' });
        unit.bleMac = mac;
      }
    }
    if (b.lotCode !== undefined) {
      unit.lotCode = String(b.lotCode || '').trim().toUpperCase();
      await ensureLot(unit.lotCode, req);
    }
    if (b.stage !== undefined) {
      if (!['stock', 'shipped'].includes(b.stage)) return res.status(400).json({ error: 'invalid_stage' });
      if (b.stage === 'shipped' && unit.stage !== 'shipped') unit.shippedAt = new Date();
      unit.stage = b.stage;
    }
    if (b.shippedTo !== undefined) unit.shippedTo = String(b.shippedTo || '').slice(0, 200);
    if (b.note !== undefined) unit.note = String(b.note || '').slice(0, 500);
    if (b.verified !== undefined) unit.verified = b.verified === true;
    if (b.manufacturedAt !== undefined) {
      if (!b.manufacturedAt) unit.manufacturedAt = undefined;
      else {
        const d = new Date(b.manufacturedAt);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid_manufacturedAt' });
        unit.manufacturedAt = d;
      }
    }
    await unit.save();
    // 앱 등록 기록(Eq)의 MAC 도 맞춘다 — resolve 가 MAC 으로도 찾기 때문.
    if (b.bleMac !== undefined) {
      await Eq.updateOne({ serial: unit.serial }, unit.bleMac ? { $set: { bleMac: unit.bleMac } } : { $unset: { bleMac: 1 } }).catch(() => {});
    }
    await audit(req, { action: 'device.update', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, ...diff(before, unit) });
    return res.json({ ok: true });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ error: 'bleMac_conflict' });
    return fail(res, 'admin/devices/:key PATCH', e);
  }
});

router.post('/devices/:key/block', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    unit.blocked = true;
    unit.blockedReason = reason;
    unit.blockedAt = new Date();
    await unit.save();
    await recordEqHistory({ serial: unit.serial, action: 'block', ...by(req), note: reason });
    await audit(req, { action: 'device.block', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, note: reason });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key/block', e);
  }
});

router.post('/devices/:key/unblock', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    unit.blocked = false;
    unit.blockedReason = '';
    await unit.save();
    await recordEqHistory({ serial: unit.serial, action: 'unblock', ...by(req) });
    await audit(req, { action: 'device.unblock', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key/unblock', e);
  }
});

/**
 * 소유권 해제: 앱 등록 기록(Eq)을 지운다. 재고·이력·혈당 데이터는 그대로 남는다.
 * 앱은 "다른 계정 소유" 403 에 막히지 않고 다시 등록할 수 있게 된다.
 */
router.post('/devices/:key/release', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const eq = await Eq.findOne({ serial: unit.serial });
    if (!eq) return res.status(409).json({ error: 'not_registered' });
    await recordEqHistory({ serial: unit.serial, action: 'release', prevUserId: eq.userId, prevStartAt: eq.startAt, ...by(req), note: String(req.body?.note || '').slice(0, 300) });
    await eq.deleteOne();
    await clearUnitRegistration(unit.serial);
    await audit(req, { action: 'device.release', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, before: { userId: String(eq.userId || ''), startAt: eq.startAt } });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key/release', e);
  }
});

/** 소유권 이전: 다른 회원에게 넘긴다. 소유 판정에 쓰이는 세 필드를 모두 바꿔야 이전 소유자가 빠진다. */
router.post('/devices/:key/transfer', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const target = String(req.body?.userId || '').trim();
    const user = isId(target) ? await User.findById(target) : await User.findOne({ email: target.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const eq = await Eq.findOne({ serial: unit.serial });
    if (!eq) return res.status(409).json({ error: 'not_registered' });
    const prevUserId = eq.userId;
    eq.userId = user._id;
    eq.createdBy = user._id;
    eq.updatedBy = user._id;
    await eq.save();
    await syncUnitFromEq(eq);
    await recordEqHistory({ serial: unit.serial, action: 'transfer', userId: user._id, startAt: eq.startAt, prevUserId, prevStartAt: eq.startAt, ...by(req) });
    await audit(req, { action: 'device.transfer', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, before: { userId: String(prevUserId || '') }, after: { userId: user._id.toString(), email: user.email } });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key/transfer', e);
  }
});

/** 시작시각 정정(만료 시각이 따라 바뀐다). */
router.post('/devices/:key/start', requirePerm('devices.write'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    const start = new Date(req.body?.startAt);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'invalid_startAt' });
    if (start.getTime() > Date.now() + 5 * 60000) return res.status(400).json({ error: 'startAt_in_future' });
    const eq = await Eq.findOne({ serial: unit.serial });
    if (!eq) return res.status(409).json({ error: 'not_registered' });
    const prevStartAt = eq.startAt;
    eq.startAt = start;
    await eq.save();
    await syncUnitFromEq(eq);
    await recordEqHistory({ serial: unit.serial, action: 'start_fix', userId: eq.userId, startAt: start, prevStartAt, ...by(req), note: String(req.body?.note || '').slice(0, 300) });
    await audit(req, { action: 'device.start_fix', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, before: { startAt: prevStartAt }, after: { startAt: start } });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key/start', e);
  }
});

/** 재고 삭제. 앱에 등록된 SN 은 먼저 소유권을 해제해야 한다. 혈당 데이터는 지우지 않는다. */
router.delete('/devices/:key', requirePerm('devices.delete'), async (req, res) => {
  try {
    const unit = await findUnit(req.params.key);
    if (!unit) return res.status(404).json({ error: 'not_found' });
    if (await Eq.exists({ serial: unit.serial })) return res.status(409).json({ error: 'registered_release_first' });
    await unit.deleteOne();
    await audit(req, { action: 'device.delete', targetType: 'device', targetId: unit.serial, targetLabel: unit.serial, before: snapshot(unit) });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/devices/:key DELETE', e);
  }
});

// ── 로트 ────────────────────────────────────────────────────────────────────

router.get('/lots', requirePerm('devices.read'), async (_req, res) => {
  try {
    const settings = await getSettings();
    const cutoff = new Date(Date.now() - validityMs(settings));
    const [lots, agg] = await Promise.all([
      Lot.find({}).sort({ createdAt: -1 }).lean(),
      DeviceUnit.aggregate([
        {
          $group: {
            _id: '$lotCode',
            total: { $sum: 1 },
            registered: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$startAt', null] }, null] }, 1, 0] } },
            active: { $sum: { $cond: [{ $gt: ['$startAt', cutoff] }, 1, 0] } },
            blocked: { $sum: { $cond: [{ $eq: ['$blocked', true] }, 1, 0] } },
            shipped: { $sum: { $cond: [{ $eq: ['$stage', 'shipped'] }, 1, 0] } },
            noMac: { $sum: { $cond: [{ $ifNull: ['$bleMac', false] }, 0, 1] } },
          },
        },
      ]),
    ]);
    const stat = new Map(agg.map((a) => [a._id || '', a]));
    const empty = { total: 0, registered: 0, active: 0, blocked: 0, shipped: 0, noMac: 0 };
    const items = lots.map((l) => ({
      code: l.code, model: l.model || '', manufacturedAt: l.manufacturedAt || null, note: l.note || '', createdAt: l.createdAt,
      ...(({ _id, ...rest }) => rest)(stat.get(l.code) || empty),
    }));
    const none = stat.get('');
    return res.json({ items, unassigned: none ? (({ _id, ...rest }) => rest)(none) : empty });
  } catch (e) {
    return fail(res, 'admin/lots', e);
  }
});

router.post('/lots', requirePerm('devices.write'), async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,39}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
    if (await Lot.exists({ code })) return res.status(409).json({ error: 'code_exists' });
    let manufacturedAt;
    if (req.body?.manufacturedAt) {
      manufacturedAt = new Date(req.body.manufacturedAt);
      if (Number.isNaN(manufacturedAt.getTime())) return res.status(400).json({ error: 'invalid_manufacturedAt' });
    }
    const lot = await Lot.create({
      code, model: String(req.body?.model || '').trim().toUpperCase().slice(0, 20), manufacturedAt,
      note: String(req.body?.note || '').slice(0, 500), createdBy: req.admin.username,
    });
    await audit(req, { action: 'lot.create', targetType: 'lot', targetId: code, targetLabel: code, after: snapshot(lot) });
    return res.status(201).json({ ok: true, code });
  } catch (e) {
    return fail(res, 'admin/lots POST', e);
  }
});

router.patch('/lots/:code', requirePerm('devices.write'), async (req, res) => {
  try {
    const lot = await Lot.findOne({ code: String(req.params.code).toUpperCase() });
    if (!lot) return res.status(404).json({ error: 'not_found' });
    const before = snapshot(lot);
    if (req.body?.model !== undefined) lot.model = String(req.body.model || '').trim().toUpperCase().slice(0, 20);
    if (req.body?.note !== undefined) lot.note = String(req.body.note || '').slice(0, 500);
    if (req.body?.manufacturedAt !== undefined) {
      if (!req.body.manufacturedAt) lot.manufacturedAt = undefined;
      else {
        const d = new Date(req.body.manufacturedAt);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'invalid_manufacturedAt' });
        lot.manufacturedAt = d;
      }
    }
    await lot.save();
    await audit(req, { action: 'lot.update', targetType: 'lot', targetId: lot.code, targetLabel: lot.code, ...diff(before, lot) });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/lots PATCH', e);
  }
});

router.delete('/lots/:code', requirePerm('devices.delete'), async (req, res) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const lot = await Lot.findOne({ code });
    if (!lot) return res.status(404).json({ error: 'not_found' });
    const n = await DeviceUnit.countDocuments({ lotCode: code });
    if (n > 0) return res.status(409).json({ error: 'lot_not_empty', units: n });
    await lot.deleteOne();
    await audit(req, { action: 'lot.delete', targetType: 'lot', targetId: code, targetLabel: code });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/lots DELETE', e);
  }
});

export default router;

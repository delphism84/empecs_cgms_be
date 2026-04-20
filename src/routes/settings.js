import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import Sensor from '../models/Sensor.js';
import Alarm from '../models/Alarm.js';
import AppSetting from '../models/AppSetting.js';
import Eq from '../models/Eq.js';
import { normalizeBleMac, normalizeSerialQuery, userOwnsEq } from '../lib/eqNormalize.js';

const router = express.Router();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.sub;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// sensors
router.get('/sensors', auth, async (req, res) => {
  const list = await Sensor.find({ userId: req.userId }).sort({ createdAt: -1 });
  return res.json(list);
});
router.post('/sensors', auth, async (req, res) => {
  const { name, serial, isActive, offset, scale } = req.body || {};
  const s = await Sensor.create({ userId: req.userId, name, serial, isActive, offset, scale });
  return res.json(s);
});
router.put('/sensors/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { name, serial, isActive, offset, scale } = req.body || {};
  const s = await Sensor.findOneAndUpdate({ _id: id, userId: req.userId }, { name, serial, isActive, offset, scale }, { new: true });
  if (!s) return res.status(404).json({ error: 'not_found' });
  return res.json(s);
});
router.delete('/sensors/:id', auth, async (req, res) => {
  const { id } = req.params;
  await Sensor.deleteOne({ _id: id, userId: req.userId });
  return res.json({ ok: true });
});

// alarms
router.get('/alarms', auth, async (req, res) => {
  const list = await Alarm.find({ userId: req.userId }).sort({ createdAt: -1 });
  return res.json(list);
});
router.post('/alarms', auth, async (req, res) => {
  try {
    const { type, enabled, threshold, quietFrom, quietTo, sound, vibrate, repeatMin, overrideDnd } = req.body || {};
    const a = await Alarm.create({ userId: req.userId, type, enabled, threshold, quietFrom, quietTo, sound, vibrate, repeatMin, overrideDnd });
    return res.json(a);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_alarm' });
  }
});
router.put('/alarms/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, enabled, threshold, quietFrom, quietTo, sound, vibrate, repeatMin, overrideDnd } = req.body || {};
    const a = await Alarm.findOneAndUpdate(
      { _id: id, userId: req.userId },
      { type, enabled, threshold, quietFrom, quietTo, sound, vibrate, repeatMin, overrideDnd },
      { new: true, runValidators: true }
    );
    if (!a) return res.status(404).json({ error: 'not_found' });
    return res.json(a);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_alarm' });
  }
});
router.delete('/alarms/:id', auth, async (req, res) => {
  const { id } = req.params;
  await Alarm.deleteOne({ _id: id, userId: req.userId });
  return res.json({ ok: true });
});

// app settings (single doc per user)
router.get('/app', auth, async (req, res) => {
  const s = await AppSetting.findOne({ userId: req.userId });
  return res.json(s || {});
});
router.put('/app', auth, async (req, res) => {
  const { unit, notifications, darkMode, preferences } = req.body || {};
  const set = {};
  if (unit !== undefined) set.unit = unit;
  if (notifications !== undefined) set.notifications = notifications;
  if (darkMode !== undefined) set.darkMode = darkMode;
  if (preferences !== undefined) set.preferences = preferences;
  const s = await AppSetting.findOneAndUpdate(
    { userId: req.userId },
    { $set: set, $setOnInsert: { userId: req.userId } },
    { new: true, upsert: true }
  );
  return res.json(s);
});

// eq list (device registry): manage start date per serial
// NB: /eq-list/resolve must be registered before /eq-list/:serial
router.get('/eq-list/resolve', auth, async (req, res) => {
  const hasSerialParam = req.query.serial !== undefined && String(req.query.serial).trim() !== '';
  const hasMacParam = req.query.bleMac !== undefined && String(req.query.bleMac).trim() !== '';
  if (!hasSerialParam && !hasMacParam) {
    return res.status(400).json({ error: 'serial_or_bleMac_required' });
  }
  const serialQ = hasSerialParam ? normalizeSerialQuery(req.query.serial) : null;
  const bleMacQ = hasMacParam ? normalizeBleMac(req.query.bleMac) : null;
  if (hasSerialParam && !serialQ) return res.status(400).json({ error: 'invalid_serial' });
  if (hasMacParam && !bleMacQ) return res.status(400).json({ error: 'invalid_bleMac' });
  if (!serialQ && !bleMacQ) return res.status(400).json({ error: 'serial_or_bleMac_required' });

  const userId = req.userId;
  /** @type {Array<{ doc: Record<string, unknown> & { _id: { toString(): string } }; matchedBy: 'serial' | 'bleMac' }>} */
  const candidates = [];

  if (serialQ) {
    const bySerial = await Eq.findOne({ serial: serialQ }).lean();
    if (bySerial && userOwnsEq(bySerial, userId)) candidates.push({ doc: bySerial, matchedBy: 'serial' });
  }
  if (bleMacQ) {
    const byMac = await Eq.findOne({ bleMac: bleMacQ }).lean();
    if (byMac && userOwnsEq(byMac, userId)) {
      const dup = candidates.some((c) => c.doc._id.toString() === byMac._id.toString());
      if (!dup) candidates.push({ doc: byMac, matchedBy: 'bleMac' });
    }
  }

  let chosen = candidates.find((c) => c.matchedBy === 'serial') || candidates[0];
  if (serialQ && bleMacQ && candidates.length > 1) {
    const serialCand = candidates.find((c) => c.matchedBy === 'serial');
    if (serialCand) chosen = serialCand;
  }

  if (!chosen) return res.status(404).json({ error: 'not_found' });

  const doc = chosen.doc;
  const EQ_VALIDITY_DAYS = Math.max(1, Math.min(90, Number(process.env.EQ_VALIDITY_DAYS || 14)));
  const startMs = new Date(doc.startAt).getTime();
  const endMs = startMs + EQ_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
  const remainingMinutes = Math.max(0, Math.floor((endMs - Date.now()) / 60000));

  return res.json({
    matchedBy: chosen.matchedBy,
    serial: doc.serial,
    bleMac: doc.bleMac ?? null,
    startAt: new Date(doc.startAt).toISOString(),
    remainingMinutes,
    _id: doc._id?.toString?.(),
  });
});

router.get('/eq-list/:serial', auth, async (req, res) => {
  const { serial } = req.params;
  const doc = await Eq.findOne({ serial: serial.toUpperCase() }).lean();
  return res.json(doc || {});
});

router.post('/eq-list', auth, async (req, res) => {
  try {
    const { serial, startAt, bleMac: bleMacRaw } = req.body || {};
    if (!serial || typeof serial !== 'string' || serial.trim().length === 0) {
      return res.status(400).json({ error: 'invalid_serial' });
    }
    const sn = serial.toUpperCase().trim();
    const start = startAt ? new Date(startAt) : new Date();
    const macNorm = bleMacRaw != null && String(bleMacRaw).trim() !== '' ? normalizeBleMac(bleMacRaw) : null;
    if (bleMacRaw != null && String(bleMacRaw).trim() !== '' && !macNorm) {
      return res.status(400).json({ error: 'invalid_bleMac' });
    }
    const set = { updatedBy: req.userId, userId: req.userId };
    if (macNorm) set.bleMac = macNorm;
    const updated = await Eq.findOneAndUpdate(
      { serial: sn },
      { $setOnInsert: { startAt: start, createdBy: req.userId }, $set: set },
      { new: true, upsert: true }
    );
    return res.json(updated);
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'bleMac_conflict' });
    return res.status(400).json({ error: 'eq_upsert_failed' });
  }
});

export default router;



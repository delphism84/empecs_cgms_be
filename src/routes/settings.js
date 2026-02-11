import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import Sensor from '../models/Sensor.js';
import Alarm from '../models/Alarm.js';
import AppSetting from '../models/AppSetting.js';
import Eq from '../models/Eq.js';

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
router.get('/eq-list/:serial', auth, async (req, res) => {
  const { serial } = req.params;
  const doc = await Eq.findOne({ serial: serial.toUpperCase() }).lean();
  return res.json(doc || {});
});

router.post('/eq-list', auth, async (req, res) => {
  try {
    const { serial, startAt } = req.body || {};
    if (!serial || typeof serial !== 'string' || serial.trim().length === 0) {
      return res.status(400).json({ error: 'invalid_serial' });
    }
    const sn = serial.toUpperCase().trim();
    const start = startAt ? new Date(startAt) : new Date();
    const updated = await Eq.findOneAndUpdate(
      { serial: sn },
      { $setOnInsert: { startAt: start, createdBy: req.userId }, $set: { updatedBy: req.userId } },
      { new: true, upsert: true }
    );
    return res.json(updated);
  } catch (e) {
    return res.status(400).json({ error: 'eq_upsert_failed' });
  }
});

export default router;



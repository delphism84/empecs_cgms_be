import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import Event from '../models/Event.js';
import GlucosePoint from '../models/GlucosePoint.js';

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

// glucose points
router.get('/glucose', auth, async (req, res) => {
  const { from, to, fromTrid, limit = 2000, compact, eqsn } = req.query;
  const q = { userId: req.userId };
  if (eqsn) q.eqsn = String(eqsn).toUpperCase();
  if (fromTrid) {
    q.trid = { $gt: Number(fromTrid) };
  } else if (from || to) {
    q.time = {};
    if (from) q.time.$gte = new Date(from);
    if (to) q.time.$lte = new Date(to);
  }
  const sort = fromTrid ? { trid: 1 } : { time: -1 };
  const items = await GlucosePoint.find(q).sort(sort).limit(Number(limit));
  if (compact === '1' || compact === 'true') {
    const t = []; const v = []; const tr = [];
    for (const it of items) {
      t.push(it.time.getTime());
      v.push(it.value);
      tr.push(it.trid ?? null);
    }
    return res.json({ t, v, tr });
  }
  return res.json(items);
});

router.post('/glucose', auth, async (req, res) => {
  const { time, value, trid, eqsn } = req.body || {};
  const item = await GlucosePoint.create({ userId: req.userId, eqsn: (eqsn ? String(eqsn).toUpperCase() : undefined), time: new Date(time), value, trid });
  return res.json(item);
});

// batch ingest (compact arrays)
router.post('/glucose/batch', auth, async (req, res) => {
  try {
    const body = req.body || {};
    let docs = [];
    if (Array.isArray(body.records)) {
      // verbose mode: [{time, value, trid}]
      docs = body.records.map((r) => ({
        userId: req.userId,
        eqsn: (r.eqsn ? String(r.eqsn).toUpperCase() : (body.eqsn ? String(body.eqsn).toUpperCase() : undefined)),
        time: new Date(r.time),
        value: r.value,
        trid: r.trid ?? undefined,
      }));
    } else if (Array.isArray(body.t) && Array.isArray(body.v)) {
      const t = body.t; const v = body.v; const tr = Array.isArray(body.tr) ? body.tr : [];
      const n = Math.min(t.length, v.length);
      for (let i = 0; i < n; i++) {
        docs.push({
          userId: req.userId,
          eqsn: (body.eqsn ? String(body.eqsn).toUpperCase() : undefined),
          time: new Date(Number(t[i])),
          value: Number(v[i]),
          trid: (tr[i] !== undefined && tr[i] !== null) ? Number(tr[i]) : undefined,
        });
      }
    }
    if (!docs.length) return res.status(400).json({ ok: false, error: 'empty' });
    // ignore duplicate trid per unique index by doing ordered:false
    const result = await GlucosePoint.insertMany(docs, { ordered: false });
    return res.json({ ok: true, count: result.length });
  } catch (e) {
    return res.json({ ok: true, count: 0 });
  }
});

// developer: clear all glucose points for current user
router.delete('/glucose/clear', auth, async (req, res) => {
  try {
    await GlucosePoint.deleteMany({ userId: req.userId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

// developer: seed 1 day of glucose points at 1-minute interval ending at now
router.post('/glucose/seed-day', auth, async (req, res) => {
  try {
    const now = Date.now();
  const docs = [];
  const minutes = 24 * 60; // 1440
  let last = 110; // start in-range
  let trid = 1;
  for (let i = minutes - 1; i >= 0; i--) {
    const t = new Date(now - (minutes - 1 - i) * 60000);
    // random walk: 50..230, per-step delta 1..3 with bounce
    const step = 1 + Math.floor(Math.random() * 3); // 1..3
    const dir = Math.random() < 0.5 ? -1 : 1; // up/down
    let v = last + dir * step;
    if (v < 50) v = 50 + step; // lower bounce
    if (v > 230) v = 230 - step; // upper bounce
    // daily spec-out at noon (i == 720): force out-of-range (<50 or >230)
    if (i === 720) {
      v = Math.random() < 0.5 ? (40 + Math.random() * 10) : (231 + Math.random() * 15);
    }
    last = v;
    docs.push({ userId: req.userId, time: t, value: Math.round(v), trid });
    trid = (trid % 65535) + 1;
  }
    if (docs.length > 0) await GlucosePoint.insertMany(docs, { ordered: false });
    return res.json({ ok: true, count: docs.length });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

// developer: seed N days of glucose points at 1-minute interval ending at now
router.post('/glucose/seed-days', auth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(14, Number(req.body?.days ?? 3))); // clamp 1..14 days
    const now = Date.now();
  const totalMinutes = days * 24 * 60;
  const docs = [];
  let last = 110; // start in-range
  let trid = 1;
  for (let i = totalMinutes - 1; i >= 0; i--) {
    const t = new Date(now - (totalMinutes - 1 - i) * 60000);
    // random walk: 50..230, per-step delta 1..3 with bounce
    const step = 1 + Math.floor(Math.random() * 3); // 1..3
    const dir = Math.random() < 0.5 ? -1 : 1; // up/down
    let v = last + dir * step;
    if (v < 50) v = 50 + step;
    if (v > 230) v = 230 - step;
    // daily spec-out: once per every 24h block at minute 720
    const mod = i % (24 * 60);
    if (mod === 720) {
      v = Math.random() < 0.5 ? (40 + Math.random() * 10) : (231 + Math.random() * 15);
    }
    last = v;
    docs.push({ userId: req.userId, time: t, value: Math.round(v), trid });
    trid = (trid % 65535) + 1;
  }
    if (docs.length > 0) await GlucosePoint.insertMany(docs, { ordered: false });
    return res.json({ ok: true, count: docs.length, days });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

// events
router.get('/events', auth, async (req, res) => {
  const { from, to, limit = 1000, compact, eqsn } = req.query;
  const q = { userId: req.userId };
  if (eqsn) q.eqsn = String(eqsn).toUpperCase();
  if (from || to) {
    q.time = {};
    if (from) q.time.$gte = new Date(from);
    if (to) q.time.$lte = new Date(to);
  }
  const items = await Event.find(q).sort({ time: -1 }).limit(Number(limit));
  if (compact === '1' || compact === 'true') {
    // compress to arrays: time(ms), type(short string), memo(optional), id
    const t = []; const ty = []; const m = []; const id = [];
    for (const it of items) {
      t.push(it.time.getTime());
      ty.push(it.type || 'memo');
      m.push(it.memo ?? null);
      id.push(it._id?.toString?.() ?? null);
    }
    return res.json({ t, ty, m, id });
  }
  return res.json(items);
});

router.post('/events', auth, async (req, res) => {
  const { type, time, memo, eqsn } = req.body || {};
  try {
    const item = await Event.create({ userId: req.userId, eqsn: (eqsn ? String(eqsn).toUpperCase() : undefined), type, time: new Date(time), memo });
    return res.json(item);
  } catch (e) {
    return res.status(400).json({ error: 'invalid_event' });
  }
});

// developer: clear all events for current user (must be BEFORE :id route)
router.delete('/events/clear', auth, async (req, res) => {
  try {
    await Event.deleteMany({ userId: req.userId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

router.delete('/events/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    await Event.deleteOne({ _id: id, userId: req.userId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false });
  }
});

export default router;



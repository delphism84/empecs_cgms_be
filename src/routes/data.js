import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import Event from '../models/Event.js';
import GlucosePoint from '../models/GlucosePoint.js';

const router = express.Router();

const GLUCOSE_BATCH_MAX = 500;
const EVENTS_BATCH_MAX = 200;
const EVENT_TYPES = new Set(['bloodGlucose', 'exercise', 'insulin', 'memo', 'meal', 'medication']);

function logSync(route, req, startedAt, extra = {}) {
  const ms = Date.now() - startedAt;
  console.log(`[sync] ${route} userId=${req.userId} durationMs=${ms}`, extra);
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'no_token', message: 'Authorization Bearer token required' });
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.sub;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'invalid_token', message: 'JWT invalid or expired' });
  }
}

// glucose points
router.get('/glucose', auth, async (req, res) => {
  try {
    const { from, to, fromTrid, limit = 2000, compact, eqsn } = req.query;
    const q = { userId: req.userId };
    if (eqsn) q.eqsn = String(eqsn).toUpperCase();
    if (fromTrid) {
      q.trid = { $gt: Number(fromTrid) };
    } else if (from || to) {
      q.time = {};
      if (from) {
        const d0 = new Date(from);
        if (Number.isNaN(d0.getTime())) {
          return res.status(400).json({ error: 'invalid_query', message: 'Invalid from date' });
        }
        q.time.$gte = d0;
      }
      if (to) {
        const d1 = new Date(to);
        if (Number.isNaN(d1.getTime())) {
          return res.status(400).json({ error: 'invalid_query', message: 'Invalid to date' });
        }
        q.time.$lte = d1;
      }
    }
    const lim = Math.max(1, Math.min(20000, Number(limit) || 2000));
    const sort = fromTrid ? { trid: 1 } : { time: -1 };
    const items = await GlucosePoint.find(q).sort(sort).limit(lim);
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
  } catch (e) {
    console.error('[GET /glucose]', e?.message || e);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Failed to load glucose data',
    });
  }
});

router.post('/glucose', auth, async (req, res) => {
  const { time, value, trid, eqsn } = req.body || {};
  const item = await GlucosePoint.create({ userId: req.userId, eqsn: (eqsn ? String(eqsn).toUpperCase() : undefined), time: new Date(time), value, trid });
  return res.json(item);
});

// batch ingest (compact arrays) — 멱등 upsert: trid 있으면 (userId+trid), 없으면 (userId+time+eqsn)
router.post('/glucose/batch', auth, async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = req.body || {};
    let docs = [];
    if (Array.isArray(body.records)) {
      // verbose mode: [{time, value, trid}]
      docs = body.records.map((r) => ({
        userId: req.userId,
        eqsn: (r.eqsn ? String(r.eqsn).toUpperCase() : (body.eqsn ? String(body.eqsn).toUpperCase() : undefined)),
        time: new Date(r.time),
        value: Number(r.value),
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
    if (!docs.length) {
      return res.status(400).json({
        ok: false,
        error: 'empty',
        message: 'No glucose rows in body (use records[] or t[]/v[])',
      });
    }
    if (docs.length > GLUCOSE_BATCH_MAX) {
      return res.status(400).json({
        ok: false,
        error: 'batch_too_large',
        message: `Maximum ${GLUCOSE_BATCH_MAX} points per request`,
        count: docs.length,
      });
    }
    const bad = [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (Number.isNaN(d.time.getTime())) bad.push({ index: i, reason: 'invalid_time' });
      if (!Number.isFinite(d.value)) bad.push({ index: i, reason: 'invalid_value' });
    }
    if (bad.length) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_rows',
        message: 'One or more rows have invalid time or value',
        details: bad.slice(0, 20),
      });
    }

    const uid = req.userId;
    const ops = docs.map((d) => {
      const eqsnNorm = d.eqsn !== undefined && d.eqsn !== null && d.eqsn !== '' ? d.eqsn : null;
      const hasTrid = d.trid !== undefined && d.trid !== null && Number.isFinite(Number(d.trid));
      const setDoc = {
        userId: uid,
        time: d.time,
        value: d.value,
      };
      if (eqsnNorm != null) setDoc.eqsn = eqsnNorm;
      if (hasTrid) setDoc.trid = Number(d.trid);
      if (hasTrid) {
        return {
          updateOne: {
            filter: { userId: uid, trid: Number(d.trid) },
            update: { $set: setDoc },
            upsert: true,
          },
        };
      }
      return {
        updateOne: {
          filter: { userId: uid, time: d.time, eqsn: eqsnNorm },
          update: { $set: setDoc },
          upsert: true,
        },
      };
    });

    const result = await GlucosePoint.bulkWrite(ops, { ordered: false });
    const upserted = result.upsertedCount ?? 0;
    const modified = result.modifiedCount ?? 0;
    const matched = result.matchedCount ?? 0;
    logSync('POST /data/glucose/batch', req, startedAt, {
      rows: docs.length,
      upserted,
      modified,
      matched,
    });
    return res.json({
      ok: true,
      count: docs.length,
      upserted,
      modified,
      matched,
    });
  } catch (e) {
    console.error('[POST /glucose/batch]', e?.message || e);
    return res.status(500).json({
      ok: false,
      error: 'batch_failed',
      message: e?.message || 'Glucose batch write failed',
    });
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
    return res.status(400).json({
      error: 'invalid_event',
      message: e?.message || 'Validation failed (type/time enum or shape)',
    });
  }
});

// 배치 이벤트 업로드 (오프라인 복귀 시 왕복 축소용). 전원 검증 후 한 번에 삽입 — 부분 삽입 없음.
router.post('/events/batch', auth, async (req, res) => {
  const startedAt = Date.now();
  const raw = req.body?.events ?? req.body?.items;
  if (!Array.isArray(raw)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_body',
      message: 'Expected JSON array body.events (or items)',
    });
  }
  if (raw.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty', message: 'events array is empty' });
  }
  if (raw.length > EVENTS_BATCH_MAX) {
    return res.status(400).json({
      ok: false,
      error: 'batch_too_large',
      message: `Maximum ${EVENTS_BATCH_MAX} events per request`,
      count: raw.length,
    });
  }

  const docs = [];
  const validationErrors = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] || {};
    const { type, time, memo, eqsn } = row;
    if (!EVENT_TYPES.has(type)) {
      validationErrors.push({ index: i, error: 'invalid_type' });
      continue;
    }
    const t = new Date(time);
    if (Number.isNaN(t.getTime())) {
      validationErrors.push({ index: i, error: 'invalid_time' });
      continue;
    }
    docs.push({
      userId: req.userId,
      eqsn: eqsn ? String(eqsn).toUpperCase() : undefined,
      type,
      time: t,
      memo,
    });
  }

  if (validationErrors.length) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_events',
      message: 'One or more events have invalid type or time',
      details: validationErrors.slice(0, 50),
    });
  }

  try {
    const inserted = await Event.insertMany(docs, { ordered: false });
    logSync('POST /data/events/batch', req, startedAt, { count: inserted.length });
    return res.status(200).json({ ok: true, count: inserted.length, items: inserted });
  } catch (e) {
    console.error('[POST /events/batch]', e?.message || e);
    return res.status(400).json({
      ok: false,
      error: 'invalid_event',
      message: e?.message || 'One or more events failed validation (e.g. type enum)',
    });
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
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({
      error: 'invalid_id',
      message: 'Event id must be a Mongo ObjectId string',
    });
  }
  try {
    await Event.deleteOne({ _id: id, userId: req.userId });
    // 멱등: 이미 삭제됐거나 해당 사용자에게 없어도 200 (FE는 200만 성공 처리)
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[DELETE /events/:id]', e?.message || e);
    return res.status(500).json({
      error: 'delete_failed',
      message: e?.message || 'Failed to delete event',
    });
  }
});

export default router;



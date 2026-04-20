import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import User from '../models/User.js';
import Eq from '../models/Eq.js';
import GlucosePoint from '../models/GlucosePoint.js';

const router = express.Router();

function adminCreds() {
  return {
    username: process.env.ADMIN_USERNAME || config.admin?.username || 'admin',
    password: process.env.ADMIN_PASSWORD || config.admin?.password || 'Empecs!@34',
  };
}

function signAdminToken() {
  return jwt.sign({ role: 'admin', sub: 'admin' }, config.jwtSecret, { expiresIn: '8h' });
}

export function requireAdmin(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'no_token' });
  try {
    const payload = jwt.verify(h.slice(7), config.jwtSecret);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    req.admin = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMac(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const c = adminCreds();
  if (!username || !password || username !== c.username || password !== c.password) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  return res.json({ token: signAdminToken() });
});

/** @param {import('express').Request} req */
function parsePeriod(req) {
  const { from, to } = req.query;
  const range = {};
  if (from) {
    const d = new Date(String(from));
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (to) {
    const d = new Date(String(to));
    if (!Number.isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      range.$lte = d;
    }
  }
  return Object.keys(range).length ? range : null;
}

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [totalUsers, totalDevices, totalDataPoints] = await Promise.all([
      User.countDocuments(),
      Eq.countDocuments(),
      GlucosePoint.countDocuments(),
    ]);

    const days = 14;
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const usersByDay = await User.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, c: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const glucoseByDay = await GlucosePoint.aggregate([
      { $match: { time: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$time' } }, c: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const perUser = await Eq.aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }]);
    const pieBuckets = { '1대': 0, '2–3대': 0, '4대 이상': 0 };
    for (const row of perUser) {
      const n = row.n || 0;
      if (n <= 1) pieBuckets['1대'] += 1;
      else if (n <= 3) pieBuckets['2–3대'] += 1;
      else pieBuckets['4대 이상'] += 1;
    }
    const pieDevices = Object.entries(pieBuckets).map(([name, value]) => ({ name, value }));

    const dateLabels = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dateLabels.push(d.toISOString().slice(0, 10));
    }

    const userMap = Object.fromEntries(usersByDay.map((x) => [x._id, x.c]));
    const glucMap = Object.fromEntries(glucoseByDay.map((x) => [x._id, x.c]));
    const lineUsers = dateLabels.map((day) => ({ day, count: userMap[day] || 0 }));
    const barGlucose = dateLabels.map((day) => ({ day, count: glucMap[day] || 0 }));

    return res.json({
      totals: { users: totalUsers, devices: totalDevices, dataPoints: totalDataPoints },
      lineUsers,
      barGlucose,
      pieDevices,
    });
  } catch (e) {
    console.error('[admin/stats]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { user, sn, mac, page = '1', limit = '50' } = req.query;
    const period = parsePeriod(req);

    let candidateIds = null;
    if ((sn && String(sn).trim()) || (mac && String(mac).trim())) {
      const eqQ = {};
      if (sn && String(sn).trim()) eqQ.serial = new RegExp(escapeRegex(String(sn).trim()), 'i');
      if (mac && String(mac).trim()) {
        const hex = normalizeMac(mac);
        if (hex) eqQ.bleMac = hex;
      }
      const eqs = await Eq.find(eqQ).select('userId').lean();
      candidateIds = [...new Set(eqs.map((e) => e.userId?.toString()).filter(Boolean))];
      if (candidateIds.length === 0) {
        return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
      }
    }

    const clauses = [];
    if (period) clauses.push({ createdAt: period });
    if (candidateIds) {
      clauses.push({ _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
    if (user && String(user).trim()) {
      const re = new RegExp(escapeRegex(String(user).trim()), 'i');
      clauses.push({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { name: re }] });
    }
    const q = clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0] : { $and: clauses };

    const p = Math.max(1, Number(page) || 1);
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const [total, rows] = await Promise.all([
      User.countDocuments(q),
      User.find(q)
        .sort({ createdAt: -1 })
        .skip((p - 1) * lim)
        .limit(lim)
        .select('email firstName lastName name provider createdAt')
        .lean(),
    ]);

    const items = rows.map((r) => ({
      id: r._id.toString(),
      email: r.email,
      name: r.name || [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
      provider: r.provider || 'local',
      createdAt: r.createdAt,
    }));

    return res.json({ items, total, page: p, limit: lim });
  } catch (e) {
    console.error('[admin/users]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/devices', requireAdmin, async (req, res) => {
  try {
    const { user, sn, mac, page = '1', limit = '50' } = req.query;
    const period = parsePeriod(req);
    const q = {};
    if (period) q.createdAt = period;
    if (sn && String(sn).trim()) q.serial = new RegExp(escapeRegex(String(sn).trim()), 'i');
    if (mac && String(mac).trim()) {
      const hex = normalizeMac(mac);
      if (hex) q.bleMac = hex;
    }

    if (user && String(user).trim()) {
      const re = new RegExp(escapeRegex(String(user).trim()), 'i');
      const users = await User.find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { name: re }] })
        .select('_id')
        .lean();
      const uids = users.map((u) => u._id);
      if (uids.length === 0) return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
      q.userId = { $in: uids };
    }

    const p = Math.max(1, Number(page) || 1);
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const [total, rows] = await Promise.all([
      Eq.countDocuments(q),
      Eq.find(q)
        .sort({ updatedAt: -1 })
        .skip((p - 1) * lim)
        .limit(lim)
        .populate('userId', 'email firstName lastName name')
        .lean(),
    ]);

    const items = rows.map((r) => {
      const u = r.userId;
      return {
        id: r._id.toString(),
        serial: r.serial,
        bleMac: r.bleMac || '—',
        userEmail: u?.email || '—',
        userLabel: u ? (u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : '—',
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });

    return res.json({ items, total, page: p, limit: lim });
  } catch (e) {
    console.error('[admin/devices]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/data', requireAdmin, async (req, res) => {
  try {
    const { user, sn, mac, page = '1', limit = '50' } = req.query;
    const period = parsePeriod(req);
    const q = {};
    if (period) q.time = period;

    if (sn && String(sn).trim()) q.eqsn = new RegExp(escapeRegex(String(sn).trim()), 'i');

    let userIdsFromMac = null;
    if (mac && String(mac).trim()) {
      const hex = normalizeMac(mac);
      if (hex) {
        const eqs = await Eq.find({ bleMac: hex }).select('userId').lean();
        userIdsFromMac = [...new Set(eqs.map((e) => e.userId?.toString()).filter(Boolean))];
        if (userIdsFromMac.length === 0) {
          return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
        }
      }
    }

    if (user && String(user).trim()) {
      const re = new RegExp(escapeRegex(String(user).trim()), 'i');
      const users = await User.find({ $or: [{ email: re }, { firstName: re }, { lastName: re }, { name: re }] })
        .select('_id')
        .lean();
      let uids = users.map((u) => u._id);
      if (userIdsFromMac) {
        const set = new Set(userIdsFromMac);
        uids = uids.filter((id) => set.has(id.toString()));
      }
      if (uids.length === 0) return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
      q.userId = { $in: uids };
    } else if (userIdsFromMac) {
      q.userId = { $in: userIdsFromMac.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const p = Math.max(1, Number(page) || 1);
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const [total, rows] = await Promise.all([
      GlucosePoint.countDocuments(q),
      GlucosePoint.find(q)
        .sort({ time: -1 })
        .skip((p - 1) * lim)
        .limit(lim)
        .populate('userId', 'email firstName lastName name')
        .lean(),
    ]);

    const items = rows.map((r) => {
      const u = r.userId;
      return {
        id: r._id.toString(),
        eqsn: r.eqsn || '—',
        value: r.value,
        time: r.time,
        trid: r.trid,
        userEmail: u?.email || '—',
        userLabel: u ? (u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : '—',
      };
    });

    return res.json({ items, total, page: p, limit: lim });
  } catch (e) {
    console.error('[admin/data]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;

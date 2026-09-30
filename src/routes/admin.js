import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import User from '../models/User.js';
import Eq from '../models/Eq.js';
import GlucosePoint from '../models/GlucosePoint.js';
import Event from '../models/Event.js';
import Sensor from '../models/Sensor.js';
import Alarm from '../models/Alarm.js';
import AppSetting from '../models/AppSetting.js';
import { getDeviceDetail, listDevicesEndingSoon } from '../services/devicesEndingSoon.js';

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

function serializeUserDoc(r) {
  if (!r) return null;
  const u = r.toObject ? r.toObject() : r;
  return {
    id: u._id.toString(),
    email: u.email,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    name: u.name || '',
    dateOfBirth: u.dateOfBirth || '',
    gender: u.gender || '',
    unit: u.unit || 'mg/dL',
    countryCode: u.countryCode || '',
    language: u.language || '',
    provider: u.provider || null,
    providerId: u.providerId || '',
    hasPassword: !!u.passwordHash,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
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

    // --- 기기별 활성률·수집 간격 (최근 24시간) ---
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const DAY_MINUTES = 24 * 60;
    const recentPoints = await GlucosePoint.find({ time: { $gte: since24h } })
      .select('eqsn userId time value')
      .sort({ time: 1 })
      .lean();

    const byDevice = new Map();
    const allUserIds = new Set();
    for (const p of recentPoints) {
      const sn = p.eqsn ? String(p.eqsn).toUpperCase() : '—';
      if (!byDevice.has(sn)) byDevice.set(sn, { eqsn: sn, userId: p.userId, times: [], values: [] });
      const b = byDevice.get(sn);
      b.times.push(new Date(p.time).getTime());
      b.values.push({ time: p.time, value: p.value, userId: p.userId });
      if (p.userId) {
        b.userId = p.userId;
        allUserIds.add(String(p.userId));
      }
    }

    const deviceUsers = await User.find({ _id: { $in: [...allUserIds] } })
      .select('email firstName lastName name unit')
      .lean();
    const userInfo = new Map(
      deviceUsers.map((u) => [
        String(u._id),
        {
          email: u.email || '—',
          label: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—',
          unit: u.unit || 'mg/dL',
        },
      ])
    );

    const devicesLive = [];
    let intervalSum = 0;
    let intervalCount = 0;
    for (const d of byDevice.values()) {
      const minuteSet = new Set(d.times.map((t) => Math.floor(t / 60000)));
      const activityPct = Math.min(100, Math.round((minuteSet.size / DAY_MINUTES) * 1000) / 10);
      const gaps = [];
      for (let i = 1; i < d.times.length; i += 1) {
        const gap = (d.times[i] - d.times[i - 1]) / 1000;
        if (gap > 0 && gap <= 30 * 60) gaps.push(gap); // 30분 초과 공백은 평균에서 제외
      }
      const avgIntervalSec = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
      if (avgIntervalSec != null) {
        intervalSum += avgIntervalSec;
        intervalCount += 1;
      }
      const ui = d.userId ? userInfo.get(String(d.userId)) : null;
      devicesLive.push({
        eqsn: d.eqsn,
        userEmail: ui?.email || '—',
        userLabel: ui?.label || '—',
        activityPct,
        avgIntervalSec: avgIntervalSec != null ? Math.round(avgIntervalSec * 10) / 10 : null,
        points24h: d.times.length,
        lastAt: d.times.length ? new Date(d.times[d.times.length - 1]).toISOString() : null,
      });
    }
    devicesLive.sort((a, b) => b.activityPct - a.activityPct || a.eqsn.localeCompare(b.eqsn));

    // --- 최근 알람성 수치 (임계 초과/미만 혈당, 사용자 알람 설정 우선) ---
    const alarmRows = await Alarm.find({ enabled: { $ne: false } }).lean();
    const alarmByUser = new Map();
    for (const a of alarmRows) {
      const key = String(a.userId);
      if (!alarmByUser.has(key)) alarmByUser.set(key, {});
      alarmByUser.get(key)[a.type] = a;
    }
    const defaultTh = { very_low: 54, low: 70, high: 180 };
    const recentAlarms = [];
    // 최근 포인트부터 스캔 (시간 역순)
    const newestFirst = [...recentPoints].sort((a, b) => new Date(b.time) - new Date(a.time));
    for (const p of newestFirst) {
      if (p.value == null || Number.isNaN(Number(p.value))) continue;
      const v = Number(p.value);
      const uid = p.userId ? String(p.userId) : '';
      const cfg = alarmByUser.get(uid) || {};
      const thVL = cfg.very_low?.threshold ?? defaultTh.very_low;
      const thL = cfg.low?.threshold ?? defaultTh.low;
      const thH = cfg.high?.threshold ?? defaultTh.high;
      let type = null;
      let threshold = null;
      if ((!cfg.very_low || cfg.very_low.enabled !== false) && v <= thVL) {
        type = 'very_low';
        threshold = thVL;
      } else if ((!cfg.low || cfg.low.enabled !== false) && v <= thL) {
        type = 'low';
        threshold = thL;
      } else if ((!cfg.high || cfg.high.enabled !== false) && v >= thH) {
        type = 'high';
        threshold = thH;
      }
      if (!type) continue;
      const ui = uid ? userInfo.get(uid) : null;
      recentAlarms.push({
        time: p.time,
        eqsn: p.eqsn ? String(p.eqsn).toUpperCase() : '—',
        userEmail: ui?.email || '—',
        userLabel: ui?.label || '—',
        type,
        threshold,
        value: v,
        unit: ui?.unit || 'mg/dL',
      });
      if (recentAlarms.length >= 20) break;
    }

    return res.json({
      totals: { users: totalUsers, devices: totalDevices, dataPoints: totalDataPoints },
      lineUsers,
      barGlucose,
      pieDevices,
      devicesLive,
      devicesLiveSummary: {
        count: devicesLive.length,
        avgActivityPct:
          devicesLive.length === 0
            ? 0
            : Math.round((devicesLive.reduce((s, d) => s + d.activityPct, 0) / devicesLive.length) * 10) / 10,
        avgIntervalSec: intervalCount ? Math.round((intervalSum / intervalCount) * 10) / 10 : null,
      },
      recentAlarms,
    });
  } catch (e) {
    console.error('[admin/stats]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** ISO country code 정규화 (빈값/미상 → UNKNOWN) */
function normalizeCountryCode(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase();
  if (!s || s === 'NULL' || s === 'UNDEFINED') return 'UNKNOWN';
  return s.slice(0, 8);
}

/**
 * 전세계(국가별) 현황
 * 이용자·활성(최근 7일 혈당)·기기·혈당건수
 */
router.get('/stats/world', requireAdmin, async (req, res) => {
  try {
    const activeSince = new Date();
    activeSince.setDate(activeSince.getDate() - 7);

    const users = await User.find({})
      .select('_id countryCode createdAt')
      .lean();

    const byCode = new Map();
    const ensure = (code) => {
      if (!byCode.has(code)) {
        byCode.set(code, {
          countryCode: code,
          userIds: [],
          users: 0,
          activeUsers: 0,
          devices: 0,
          dataPoints: 0,
        });
      }
      return byCode.get(code);
    };

    for (const u of users) {
      const code = normalizeCountryCode(u.countryCode);
      const bucket = ensure(code);
      bucket.userIds.push(u._id);
      bucket.users += 1;
    }

    const activeRows = await GlucosePoint.aggregate([
      { $match: { time: { $gte: activeSince } } },
      { $group: { _id: '$userId' } },
    ]);
    const activeSet = new Set(activeRows.map((r) => String(r._id)));

    for (const bucket of byCode.values()) {
      bucket.activeUsers = bucket.userIds.filter((id) => activeSet.has(String(id))).length;
    }

    const deviceRows = await Eq.aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }]);
    const deviceByUser = new Map(deviceRows.map((r) => [String(r._id), r.n || 0]));

    const glucoseRows = await GlucosePoint.aggregate([{ $group: { _id: '$userId', n: { $sum: 1 } } }]);
    const glucoseByUser = new Map(glucoseRows.map((r) => [String(r._id), r.n || 0]));

    for (const bucket of byCode.values()) {
      let devices = 0;
      let dataPoints = 0;
      for (const id of bucket.userIds) {
        const key = String(id);
        devices += deviceByUser.get(key) || 0;
        dataPoints += glucoseByUser.get(key) || 0;
      }
      bucket.devices = devices;
      bucket.dataPoints = dataPoints;
      delete bucket.userIds;
    }

    const regions = [...byCode.values()].sort((a, b) => b.users - a.users || a.countryCode.localeCompare(b.countryCode));
    const totals = regions.reduce(
      (acc, r) => {
        acc.users += r.users;
        acc.activeUsers += r.activeUsers;
        acc.devices += r.devices;
        acc.dataPoints += r.dataPoints;
        return acc;
      },
      { users: 0, activeUsers: 0, devices: 0, dataPoints: 0 }
    );

    return res.json({ regions, totals });
  } catch (e) {
    console.error('[admin/stats/world]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** 국가별 사용자 리스팅 (모달용) */
router.get('/stats/world/:countryCode/users', requireAdmin, async (req, res) => {
  try {
    const code = normalizeCountryCode(req.params.countryCode);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const q =
      code === 'UNKNOWN'
        ? {
            $or: [
              { countryCode: { $exists: false } },
              { countryCode: null },
              { countryCode: '' },
              { countryCode: /^\s*$/ },
            ],
          }
        : { countryCode: new RegExp(`^${escapeRegex(code)}$`, 'i') };

    const [total, rows] = await Promise.all([
      User.countDocuments(q),
      User.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('email firstName lastName name provider countryCode createdAt')
        .lean(),
    ]);

    const items = rows.map((r) => ({
      id: r._id.toString(),
      email: r.email,
      name: r.name || [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
      provider: r.provider || 'local',
      countryCode: normalizeCountryCode(r.countryCode),
      createdAt: r.createdAt,
    }));

    return res.json({ countryCode: code, items, total, page, limit });
  } catch (e) {
    console.error('[admin/stats/world/:countryCode/users]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ error: 'not_found' });
    return res.json(serializeUserDoc(u));
  } catch (e) {
    console.error('[admin/users/:id GET]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid_id' });
    const u = await User.findById(id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};

    if (body.email !== undefined) {
      const next = String(body.email).trim().toLowerCase();
      if (!next) return res.status(400).json({ error: 'email_required' });
      const dup = await User.findOne({ email: next, _id: { $ne: u._id } }).select('_id').lean();
      if (dup) return res.status(409).json({ error: 'email_taken' });
      u.email = next;
    }
    const optStr = (k) => {
      if (body[k] === undefined) return;
      u[k] = body[k] === null || body[k] === '' ? '' : String(body[k]);
    };
    optStr('firstName');
    optStr('lastName');
    optStr('name');
    optStr('dateOfBirth');
    optStr('gender');
    optStr('countryCode');
    optStr('language');
    if (body.unit !== undefined) {
      const unit = String(body.unit);
      if (unit === 'mg/dL' || unit === 'mmol') u.unit = unit;
      else return res.status(400).json({ error: 'invalid_unit' });
    }
    if (body.providerId !== undefined) {
      u.providerId = body.providerId === null || body.providerId === '' ? undefined : String(body.providerId);
    }
    if (body.provider !== undefined) {
      const p = body.provider;
      if (p === null || p === '') u.provider = null;
      else if (['google', 'kakao', 'apple'].includes(String(p))) u.provider = String(p);
      else return res.status(400).json({ error: 'invalid_provider' });
    }

    await u.save();
    const fresh = await User.findById(u._id).lean();
    return res.json({ ok: true, user: serializeUserDoc(fresh) });
  } catch (e) {
    console.error('[admin/users/:id PATCH]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** 관리자 전용: 기존 비밀번호 없이 새 비밀번호 설정(로컬·소셜 계정 모두 가능) */
router.post('/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid_id' });
    const password = req.body?.password;
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password_min_8' });
    }
    const u = await User.findById(id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    u.passwordHash = await User.hashPassword(password);
    await u.save();
    return res.json({ ok: true });
  } catch (e) {
    console.error('[admin/users/:id/password]', e);
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

router.get('/devices/ending-soon', requireAdmin, async (_req, res) => {
  try {
    const data = await listDevicesEndingSoon();
    return res.json(data);
  } catch (e) {
    console.error('[admin/devices/ending-soon]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/devices/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'invalid_id' });
    const detail = await getDeviceDetail(id);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    return res.json(detail);
  } catch (e) {
    console.error('[admin/devices/:id]', e);
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

/**
 * 시스템 전체 데이터 초기화 (관리자 비밀번호 재확인 필수)
 * Body: { "password": "<admin password>" }
 * 사용자·기기·혈당·이벤트·센서·알람·앱설정 전부 삭제 후 시드 계정(empecs/admin) 재생성
 */
router.post('/system/reset', requireAdmin, async (req, res) => {
  try {
    const password = req.body?.password;
    const c = adminCreds();
    if (!password || typeof password !== 'string' || password !== c.password) {
      return res.status(401).json({ error: 'invalid_password' });
    }

    const [users, devices, glucose, events, sensors, alarms, settings] = await Promise.all([
      User.deleteMany({}),
      Eq.deleteMany({}),
      GlucosePoint.deleteMany({}),
      Event.deleteMany({}),
      Sensor.deleteMany({}),
      Alarm.deleteMany({}),
      AppSetting.deleteMany({}),
    ]);

    const passwordHash = await User.hashPassword('admin');
    await User.create({ email: 'empecs', passwordHash, name: 'EMPECS Admin' });

    const deleted = {
      users: users.deletedCount || 0,
      devices: devices.deletedCount || 0,
      glucose: glucose.deletedCount || 0,
      events: events.deletedCount || 0,
      sensors: sensors.deletedCount || 0,
      alarms: alarms.deletedCount || 0,
      settings: settings.deletedCount || 0,
    };
    console.log('[admin/system/reset] wiped', deleted);
    return res.json({ ok: true, deleted, seededUser: 'empecs' });
  } catch (e) {
    console.error('[admin/system/reset]', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/data', requireAdmin, async (req, res) => {
  try {
    const { user, sn, mac, page = '1', limit = '50', userId: userIdParam } = req.query;
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

    const directUserId =
      userIdParam && mongoose.Types.ObjectId.isValid(String(userIdParam))
        ? new mongoose.Types.ObjectId(String(userIdParam))
        : null;

    if (directUserId) {
      q.userId = directUserId;
      if (userIdsFromMac && !userIdsFromMac.includes(directUserId.toString())) {
        return res.json({ items: [], total: 0, page: Number(page), limit: Number(limit) });
      }
    } else if (user && String(user).trim()) {
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

import express from 'express';
import User from '../../models/User.js';
import Eq from '../../models/Eq.js';
import DeviceUnit from '../../models/DeviceUnit.js';
import GlucosePoint from '../../models/GlucosePoint.js';
import Alarm from '../../models/Alarm.js';
import { requireAdmin, requirePerm } from '../../admin/auth.js';
import { getSettings, validityMs } from '../../lib/settingsStore.js';
import { computeSyncGaps } from './ops.js';
import { escapeRegex } from './common.js';

// 대시보드 통계. 기존 admin.js 의 /stats, /stats/world 를 옮기고 센서·동기화 요약을 더했다.
const router = express.Router();
router.use(requireAdmin);

router.get('/stats', requirePerm('dashboard.read'), async (req, res) => {
  try {
    const [totalUsers, totalDevices, totalDataPoints] = await Promise.all([
      User.countDocuments(),
      Eq.countDocuments(),
      GlucosePoint.estimatedDocumentCount(),
    ]);

    const days = 14;
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    const usersByDay = await User.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Seoul' } }, c: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const glucoseByDay = await GlucosePoint.aggregate([
      { $match: { time: { $gte: start } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$time', timezone: 'Asia/Seoul' } }, c: { $sum: 1 } } },
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
      // 한국시간 날짜 라벨(집계 버킷과 같은 기준)
      dateLabels.push(new Date(Date.now() - i * 86400000 + 9 * 3600000).toISOString().slice(0, 10));
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

    const settings = await getSettings();
    const cutoff = new Date(Date.now() - validityMs(settings));
    const endingEdge = new Date(cutoff.getTime() + settings.endingSoonHours * 3600000);
    const live = { blocked: { $ne: true } };
    const [sActive, sEnding, sExpired, sBlocked, sStock, sUnverified, suspendedUsers, newUsersToday, syncGaps] = await Promise.all([
      DeviceUnit.countDocuments({ ...live, startAt: { $gt: cutoff } }),
      DeviceUnit.countDocuments({ ...live, startAt: { $gt: cutoff, $lte: endingEdge } }),
      DeviceUnit.countDocuments({ ...live, startAt: { $ne: null, $lte: cutoff } }),
      DeviceUnit.countDocuments({ blocked: true }),
      DeviceUnit.countDocuments({ ...live, startAt: null }),
      DeviceUnit.countDocuments({ verified: false }),
      User.countDocuments({ status: 'suspended' }),
      User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
      computeSyncGaps().then((r) => r.total).catch(() => null),
    ]);

    return res.json({
      sensors: { active: sActive, endingSoon: sEnding, expired: sExpired, blocked: sBlocked, inStock: sStock, unverified: sUnverified, validityDays: settings.eqValidityDays },
      users: { suspended: suspendedUsers, new24h: newUsersToday },
      syncGaps,
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
router.get('/stats/world', requirePerm('dashboard.read'), async (req, res) => {
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
router.get('/stats/world/:countryCode/users', requirePerm('dashboard.read'), async (req, res) => {
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

export default router;

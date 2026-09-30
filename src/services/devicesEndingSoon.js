import Eq from '../models/Eq.js';
import { getSettings, validityMs } from '../lib/settingsStore.js';

// 유효기간·임박 기준은 시스템 설정(eqValidityDays, endingSoonHours)을 따른다.
// 예전에는 여기 15일, resolve 14일, 앱 16일로 서로 달랐다.

/**
 * 종료 예정 기기 목록 (잔여 ≤ 1일, 잔여 짧은 순)
 * @param {{ now?: Date }} [opts]
 */
export async function listDevicesEndingSoon(opts = {}) {
  const settings = await getSettings();
  const SENSOR_VALIDITY_MS = validityMs(settings);
  const ENDING_SOON_WINDOW_MS = settings.endingSoonHours * 60 * 60 * 1000;
  const now = opts.now ? new Date(opts.now) : new Date();
  const nowMs = now.getTime();

  // startAt 이 (now - 15d) ~ (now - 15d + 1d] 이면 종료가 1일 이내
  // endAt = startAt + 15d ∈ (now, now+1d]  ⇔  startAt ∈ (now-15d, now-15d+1d]
  const startMin = new Date(nowMs - SENSOR_VALIDITY_MS);
  const startMax = new Date(nowMs - SENSOR_VALIDITY_MS + ENDING_SOON_WINDOW_MS);

  const rows = await Eq.find({
    startAt: { $gt: startMin, $lte: startMax },
  })
    .populate('userId', 'email firstName lastName name provider countryCode unit createdAt')
    .lean();

  const items = rows
    .map((r) => {
      const startAt = r.startAt ? new Date(r.startAt) : null;
      if (!startAt || Number.isNaN(startAt.getTime())) return null;
      const endAt = new Date(startAt.getTime() + SENSOR_VALIDITY_MS);
      const remainingMs = endAt.getTime() - nowMs;
      if (remainingMs <= 0 || remainingMs > ENDING_SOON_WINDOW_MS) return null;
      const u = r.userId;
      return {
        id: r._id.toString(),
        serial: r.serial,
        bleMac: r.bleMac || '',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        remainingMs,
        remainingSec: Math.max(0, Math.floor(remainingMs / 1000)),
        userId: u?._id?.toString() || (r.userId ? String(r.userId) : null),
        userEmail: u?.email || '—',
        userLabel: u
          ? u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—'
          : '—',
        userProvider: u?.provider || 'local',
        userCountryCode: u?.countryCode || '',
        userUnit: u?.unit || 'mg/dL',
        userCreatedAt: u?.createdAt || null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        serverTime: now.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.remainingMs - b.remainingMs);

  return {
    items,
    total: items.length,
    validityDays: settings.eqValidityDays,
    windowHours: settings.endingSoonHours,
    serverTime: now.toISOString(),
  };
}

export async function getDeviceDetail(id) {
  const r = await Eq.findById(id)
    .populate('userId', 'email firstName lastName name provider countryCode unit language dateOfBirth gender createdAt updatedAt')
    .lean();
  if (!r) return null;
  const settings = await getSettings();
  const SENSOR_VALIDITY_MS = validityMs(settings);
  const now = new Date();
  const startAt = r.startAt ? new Date(r.startAt) : null;
  const endAt = startAt ? new Date(startAt.getTime() + SENSOR_VALIDITY_MS) : null;
  const remainingMs = endAt ? endAt.getTime() - now.getTime() : null;
  const u = r.userId;
  return {
    id: r._id.toString(),
    serial: r.serial,
    bleMac: r.bleMac || '',
    startAt: startAt?.toISOString() || null,
    endAt: endAt?.toISOString() || null,
    remainingMs,
    remainingSec: remainingMs == null ? null : Math.max(0, Math.floor(remainingMs / 1000)),
    validityDays: settings.eqValidityDays,
    user: u
      ? {
          id: u._id.toString(),
          email: u.email,
          name: u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || '',
          firstName: u.firstName || '',
          lastName: u.lastName || '',
          provider: u.provider || 'local',
          countryCode: u.countryCode || '',
          unit: u.unit || 'mg/dL',
          language: u.language || '',
          dateOfBirth: u.dateOfBirth || '',
          gender: u.gender || '',
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    serverTime: now.toISOString(),
  };
}

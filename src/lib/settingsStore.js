import SystemSetting from '../models/SystemSetting.js';

/**
 * 시스템 설정(관리자 화면에서 변경). 기본값은 앱(cgms_app)과 맞춘다.
 *
 * 센서 유효기간은 예전에 서버 곳곳에 다른 값으로 박혀 있었다
 * (resolve 14일, 종료 예정 15일, 앱 16일). 이제 eqValidityDays 하나만 쓴다.
 */
export const SETTING_DEFAULTS = Object.freeze({
  eqValidityDays: 16,
  endingSoonHours: 24,
  /** 'flag' = 재고에 없는 SN 도 등록 허용하고 표시만, 'block' = 등록 거절 */
  snPolicy: 'flag',
  /** 앱 QR 파서(qr_sn_parser.dart)와 같은 SN 형식: C21 + 연도코드 + S(샘플) + 5자리 */
  snPattern: '^(C\\d{2})([A-Z])(S?)(\\d{5})$',
  /** 연도 코드 → 연도. 제조사 규격이 확정되면 여기만 고친다. */
  yearCodes: { Z: 2025 },
  qrAdvName: 'empecsCGM',
  qrManufacturerId: 'FFFF',
  /** 센서 사용 중인데 이 시간 이상 업로드가 없으면 "동기화 이상" */
  syncGapHours: 6,
  adminSessionHours: 8,
  adminIpEnforce: false,
  adminIpAllowlist: [],
});

const TTL_MS = 15_000;
let cache = null;
let cachedAt = 0;

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** 저장 전 검증·정규화. 모르는 키는 버린다. */
export function sanitizeSettings(input, base = SETTING_DEFAULTS) {
  const out = { ...base };
  const src = input && typeof input === 'object' ? input : {};
  if (src.eqValidityDays !== undefined) out.eqValidityDays = clampInt(src.eqValidityDays, 1, 90, base.eqValidityDays);
  if (src.endingSoonHours !== undefined) out.endingSoonHours = clampInt(src.endingSoonHours, 1, 240, base.endingSoonHours);
  if (src.snPolicy !== undefined) out.snPolicy = src.snPolicy === 'block' ? 'block' : 'flag';
  if (src.snPattern !== undefined) {
    const p = String(src.snPattern || '').trim();
    try {
      // eslint-disable-next-line no-new
      new RegExp(p);
      if (p) out.snPattern = p;
    } catch (_) {
      /* 잘못된 정규식은 무시하고 기존 값 유지 */
    }
  }
  if (src.yearCodes !== undefined && src.yearCodes && typeof src.yearCodes === 'object') {
    const yc = {};
    for (const [k, v] of Object.entries(src.yearCodes)) {
      const key = String(k).trim().toUpperCase();
      const year = clampInt(v, 2000, 2100, NaN);
      if (/^[A-Z]$/.test(key) && Number.isFinite(year)) yc[key] = year;
    }
    out.yearCodes = yc;
  }
  if (src.qrAdvName !== undefined) out.qrAdvName = String(src.qrAdvName || '').trim().slice(0, 32) || base.qrAdvName;
  if (src.qrManufacturerId !== undefined) {
    const m = String(src.qrManufacturerId || '').replace(/^0x/i, '').toUpperCase();
    if (/^[0-9A-F]{4}$/.test(m)) out.qrManufacturerId = m;
  }
  if (src.syncGapHours !== undefined) out.syncGapHours = clampInt(src.syncGapHours, 1, 720, base.syncGapHours);
  if (src.adminSessionHours !== undefined) out.adminSessionHours = clampInt(src.adminSessionHours, 1, 72, base.adminSessionHours);
  if (src.adminIpEnforce !== undefined) out.adminIpEnforce = src.adminIpEnforce === true;
  if (src.adminIpAllowlist !== undefined && Array.isArray(src.adminIpAllowlist)) {
    out.adminIpAllowlist = [...new Set(src.adminIpAllowlist.map((s) => String(s).trim()).filter(Boolean))].slice(0, 200);
  }
  return out;
}

export async function getSettings({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache && now - cachedAt < TTL_MS) return cache;
  let stored = {};
  try {
    const doc = await SystemSetting.findById('global').lean();
    stored = doc?.values || {};
  } catch (_) {
    if (cache) return cache;
  }
  const merged = sanitizeSettings(stored, SETTING_DEFAULTS);
  // 운영 환경변수가 명시돼 있으면 유효기간은 그 값을 우선한다(기존 배포 호환).
  if (stored.eqValidityDays === undefined && process.env.EQ_VALIDITY_DAYS) {
    merged.eqValidityDays = clampInt(process.env.EQ_VALIDITY_DAYS, 1, 90, merged.eqValidityDays);
  }
  cache = Object.freeze(merged);
  cachedAt = now;
  return cache;
}

/** 요청 처리 중 동기 접근용(캐시가 없으면 기본값). */
export function settingsSnapshot() {
  return cache || SETTING_DEFAULTS;
}

export async function updateSettings(patch, updatedBy) {
  const current = await getSettings({ fresh: true });
  const next = sanitizeSettings(patch, current);
  await SystemSetting.findByIdAndUpdate(
    'global',
    { $set: { values: next, updatedBy: updatedBy || '' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cache = Object.freeze(next);
  cachedAt = Date.now();
  return { before: current, after: cache };
}

export function validityMs(settings = settingsSnapshot()) {
  return settings.eqValidityDays * 24 * 60 * 60 * 1000;
}

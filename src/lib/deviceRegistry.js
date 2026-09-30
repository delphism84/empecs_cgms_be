import Eq from '../models/Eq.js';
import DeviceUnit from '../models/DeviceUnit.js';
import EqHistory from '../models/EqHistory.js';
import { getSettings, settingsSnapshot, validityMs } from './settingsStore.js';
import { normalizeBleMac } from './eqNormalize.js';

/**
 * SN 구조 분해. 형식은 앱의 QR 파서와 같다: C21 + 연도코드 + S(샘플, 선택) + 5자리.
 * 형식이 다르면 formatOk=false 로 돌려준다(거절 여부는 호출부가 정한다).
 */
export function parseSerial(raw, settings = settingsSnapshot()) {
  const serial = String(raw || '').trim().toUpperCase();
  let re;
  try {
    re = new RegExp(settings.snPattern);
  } catch (_) {
    re = /^(C\d{2})([A-Z])(S?)(\d{5})$/;
  }
  const m = re.exec(serial);
  if (!m) return { serial, formatOk: false, model: '', yearCode: '', sample: false, seq: null, year: null };
  const yearCode = m[2] || '';
  return {
    serial,
    formatOk: true,
    model: m[1] || '',
    yearCode,
    sample: (m[3] || '') !== '',
    seq: m[4] != null ? Number(m[4]) : null,
    year: settings.yearCodes?.[yearCode] ?? null,
  };
}

/** SN 조립(범위 생성용). */
export function composeSerial({ model, yearCode, sample, seq }) {
  return `${String(model).toUpperCase()}${String(yearCode).toUpperCase()}${sample ? 'S' : ''}${String(seq).padStart(5, '0')}`;
}

/**
 * 앱이 읽는 QR 문자열: `<ADV 이름>;0x<제조자ID><MAC 12자리>;0x<SN>`.
 * MAC 을 모르면 앱의 구형식(SN 단독)으로 만든다.
 */
export function buildQrPayload(unit, settings = settingsSnapshot()) {
  const serial = String(unit?.serial || '').toUpperCase();
  if (!serial) return null;
  const mac = normalizeBleMac(unit?.bleMac || '');
  if (mac && mac.length === 12) {
    return `${settings.qrAdvName};0x${settings.qrManufacturerId}${mac};0x${serial}`;
  }
  return serial;
}

/** 화면에 보여줄 상태. 차단 > 사용중/만료(등록됨) > 출고 > 재고. */
export function unitStatus(unit, now = Date.now(), settings = settingsSnapshot()) {
  if (unit.blocked) return 'blocked';
  if (unit.startAt) {
    const end = new Date(unit.startAt).getTime() + validityMs(settings);
    return end > now ? 'active' : 'expired';
  }
  return unit.stage === 'shipped' ? 'shipped' : 'stock';
}

export function unitTimes(unit, now = Date.now(), settings = settingsSnapshot()) {
  if (!unit.startAt) return { endAt: null, remainingMs: null };
  const endMs = new Date(unit.startAt).getTime() + validityMs(settings);
  return { endAt: new Date(endMs), remainingMs: endMs - now };
}

/** Eq 의 등록 상태를 재고 행에 복제한다. 재고에 없으면 미확인(source='app') 행을 만든다. */
export async function syncUnitFromEq(eq) {
  if (!eq?.serial) return null;
  const serial = String(eq.serial).toUpperCase();
  const parsed = parseSerial(serial);
  const set = {
    startAt: eq.startAt || null,
    ownerId: eq.userId || null,
  };
  if (eq.bleMac) set.bleMac = eq.bleMac;
  const onInsert = {
    serial,
    source: 'app',
    verified: false,
    stage: 'shipped',
    model: parsed.model,
    yearCode: parsed.yearCode,
    sample: parsed.sample,
    seq: parsed.seq ?? undefined,
    formatOk: parsed.formatOk,
    registeredAt: eq.createdAt || new Date(),
  };
  try {
    return await DeviceUnit.findOneAndUpdate(
      { serial },
      { $set: set, $setOnInsert: onInsert },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    // 다른 재고 행이 같은 MAC 을 갖고 있으면(11000) MAC 없이 다시 시도 — 등록 자체는 막지 않는다.
    if (e?.code === 11000 && set.bleMac) {
      delete set.bleMac;
      return DeviceUnit.findOneAndUpdate(
        { serial },
        { $set: set, $setOnInsert: onInsert },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    }
    throw e;
  }
}

/** 등록 해제(Eq 삭제) 후 재고 행의 복제 필드를 비운다. */
export async function clearUnitRegistration(serial) {
  return DeviceUnit.findOneAndUpdate(
    { serial: String(serial).toUpperCase() },
    { $set: { startAt: null, ownerId: null } },
    { new: true }
  );
}

export async function recordEqHistory(entry) {
  try {
    await EqHistory.create({ ...entry, serial: String(entry.serial).toUpperCase() });
  } catch (e) {
    console.error('[eq-history]', e?.message || e);
  }
}

/**
 * 앱 등록 전 검사. 통과하면 null, 거절이면 { status, body }.
 * - 차단된 SN 은 정책과 무관하게 거절
 * - snPolicy='block' 이면 재고로 확인되지 않은 SN 거절
 */
export async function checkRegistrationAllowed(serial) {
  const settings = await getSettings();
  const unit = await DeviceUnit.findOne({ serial: String(serial).toUpperCase() }).lean();
  if (unit?.blocked) {
    return { status: 403, body: { error: 'device_blocked', message: 'This sensor has been blocked' } };
  }
  if (settings.snPolicy === 'block' && (!unit || !unit.verified)) {
    return { status: 403, body: { error: 'sn_not_registered', message: 'This serial is not in the device inventory' } };
  }
  return null;
}

/** 기동 시 1회: 기존 Eq 전부를 재고에 반영(없던 행은 미확인으로 생성). */
export async function backfillUnits() {
  await getSettings({ fresh: true });
  const eqs = await Eq.find({}).select('serial bleMac startAt userId createdAt').lean();
  let created = 0;
  let updated = 0;
  for (const eq of eqs) {
    const existed = await DeviceUnit.exists({ serial: String(eq.serial).toUpperCase() });
    await syncUnitFromEq(eq);
    if (existed) updated += 1;
    else created += 1;
  }
  // Eq 가 사라졌는데 복제 필드가 남은 재고 행 정리
  const serials = new Set(eqs.map((e) => String(e.serial).toUpperCase()));
  const stale = await DeviceUnit.find({ startAt: { $ne: null } }).select('serial').lean();
  const orphan = stale.filter((u) => !serials.has(u.serial)).map((u) => u.serial);
  if (orphan.length) {
    await DeviceUnit.updateMany({ serial: { $in: orphan } }, { $set: { startAt: null, ownerId: null } });
  }
  return { eqs: eqs.length, created, updated, cleared: orphan.length };
}

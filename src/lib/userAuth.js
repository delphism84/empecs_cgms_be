import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import User from '../models/User.js';

/**
 * 회원 API 공용 인증 미들웨어.
 *
 * 예전에는 data.js·settings.js·auth.js 에 같은 코드가 복사돼 있었고 서명만 확인했다.
 * 그래서 정지·탈퇴한 회원이나 강제 로그아웃된 토큰도 만료 전까지 그대로 통과했다.
 * 여기서 계정 상태와 tokenVersion 을 함께 확인한다(짧은 캐시로 요청마다 DB 를 치지 않는다).
 */
const CACHE_TTL_MS = 30_000;
const SEEN_THROTTLE_MS = 5 * 60_000;
const UPLOAD_THROTTLE_MS = 60_000;

const stateCache = new Map(); // userId -> { status, tv, at }
const lastSeenWrite = new Map();
const lastUploadWrite = new Map();

export function invalidateUserAuth(userId) {
  if (userId) stateCache.delete(String(userId));
  else stateCache.clear();
}

async function loadState(userId) {
  const key = String(userId);
  const hit = stateCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit;
  const u = await User.findById(key).select('status tokenVersion').lean();
  const state = u
    ? { found: true, status: u.status || 'active', tv: u.tokenVersion || 0, at: now }
    : { found: false, status: 'deleted', tv: 0, at: now };
  stateCache.set(key, state);
  if (stateCache.size > 20000) stateCache.clear();
  return state;
}

function touch(map, field, userId, throttleMs) {
  const key = String(userId);
  const now = Date.now();
  if (now - (map.get(key) || 0) < throttleMs) return;
  map.set(key, now);
  if (map.size > 50000) map.clear();
  User.updateOne({ _id: key }, { $set: { [field]: new Date(now) } }).catch(() => {});
}

/** 혈당 업로드 성공 시 호출 — 관리자 "동기화 이상" 감시의 기준 시각. */
export function touchUpload(userId) {
  touch(lastUploadWrite, 'lastUploadAt', userId, UPLOAD_THROTTLE_MS);
}

/**
 * 토큰 검증 결과. 성공이면 { ok:true, userId, payload }.
 * 실패 사유: no_token | invalid_token(만료·위조·강제 로그아웃·탈퇴) | account_suspended
 */
export async function verifyUserToken(authorization) {
  const h = authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'no_token', message: 'Authorization Bearer token required' };
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (_) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'JWT invalid or expired' };
  }
  if (!payload?.sub || !mongoose.isValidObjectId(payload.sub)) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'Not a user token' };
  }
  const state = await loadState(payload.sub);
  if (!state.found || state.status === 'deleted') {
    return { ok: false, status: 401, error: 'invalid_token', message: 'Account no longer exists' };
  }
  if ((payload.tv || 0) < state.tv) {
    return { ok: false, status: 401, error: 'invalid_token', message: 'Session revoked' };
  }
  if (state.status === 'suspended') {
    // 403: 앱이 재로그인 루프에 빠지지 않게 401 과 구분한다.
    return { ok: false, status: 403, error: 'account_suspended', message: 'This account is suspended' };
  }
  return { ok: true, userId: payload.sub, payload };
}

export async function userAuth(req, res, next) {
  try {
    const r = await verifyUserToken(req.headers.authorization);
    if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
    req.userId = r.userId;
    touch(lastSeenWrite, 'lastSeenAt', r.userId, SEEN_THROTTLE_MS);
    return next();
  } catch (e) {
    console.error('[userAuth]', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

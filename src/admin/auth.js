import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import AdminUser, { ADMIN_ROLES } from '../models/AdminUser.js';
import LoginLog from '../models/LoginLog.js';
import { getSettings } from '../lib/settingsStore.js';

/**
 * 관리자 인증·권한.
 *
 * 예전 방식의 문제: 환경변수의 공용 계정 1개, 평문 비교, 시도 제한 없음,
 * 회원 토큰과 같은 서명 키(회원 키가 새면 관리자 토큰도 위조 가능).
 * 이제 계정은 DB(bcrypt), 서명 키는 분리, 역할별 권한, 로그인 시도 제한·기록을 둔다.
 */

/** 회원 토큰과 다른 키. ADMIN_JWT_SECRET 이 없으면 회원 키에서 파생해 별도 키를 만든다. */
export const adminJwtSecret =
  process.env.ADMIN_JWT_SECRET ||
  crypto.createHmac('sha256', String(config.jwtSecret)).update('cgms-admin-token-v1').digest('hex');

export const PERMISSIONS = [
  'dashboard.read',
  'users.read',
  'users.write',
  'users.support',
  'users.delete',
  'devices.read',
  'devices.write',
  'devices.delete',
  'data.read',
  'data.export',
  'data.delete',
  'monitor.read',
  'notices.read',
  'notices.write',
  'audit.read',
  'admins.manage',
  'settings.manage',
  'system.reset',
];

const READ_ALL = ['dashboard.read', 'users.read', 'devices.read', 'data.read', 'monitor.read', 'notices.read'];

export const ROLE_PERMS = {
  superadmin: PERMISSIONS,
  operator: [
    ...READ_ALL,
    'users.write',
    'users.support',
    'devices.write',
    'devices.delete',
    'data.export',
    'notices.write',
    'audit.read',
  ],
  cs: [...READ_ALL, 'users.support'],
  viewer: READ_ALL,
};

export function permsForRole(role) {
  return ROLE_PERMS[role] || [];
}

export function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xf || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  return String(raw).replace(/^::ffff:/, '');
}

// ── 로그인 시도 제한(메모리): 같은 IP+아이디로 10분에 10회 실패하면 10분 잠금 ─────────────
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 10;
const fails = new Map(); // key -> number[] (실패 시각)

function failKey(ip, username) {
  return `${ip}|${String(username || '').toLowerCase()}`;
}
function recentFails(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  fails.set(key, arr);
  if (fails.size > 5000) fails.clear();
  return arr;
}

export async function logLogin({ kind, subjectId, identifier, success, reason, method, req }) {
  try {
    await LoginLog.create({
      kind,
      subjectId: subjectId ? String(subjectId) : undefined,
      identifier: String(identifier || '').slice(0, 200),
      success,
      reason,
      method,
      ip: req ? clientIp(req) : undefined,
      userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 300) : undefined,
    });
  } catch (e) {
    console.error('[login-log]', e?.message || e);
  }
}

export async function signAdminToken(admin) {
  const settings = await getSettings();
  return jwt.sign(
    { typ: 'admin', sub: admin._id.toString(), role: admin.role, tv: admin.tokenVersion || 0 },
    adminJwtSecret,
    { expiresIn: `${settings.adminSessionHours}h` }
  );
}

export function serializeAdmin(a) {
  return {
    id: a._id.toString(),
    username: a.username,
    name: a.name || '',
    role: a.role,
    status: a.status,
    mustChangePassword: !!a.mustChangePassword,
    permissions: permsForRole(a.role),
    lastLoginAt: a.lastLoginAt || null,
    lastLoginIp: a.lastLoginIp || '',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** POST /api/admin/login */
export async function loginHandler(req, res) {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = req.body?.password;
  const ip = clientIp(req);
  const key = failKey(ip, username);
  try {
    if (recentFails(key).length >= FAIL_MAX) {
      await logLogin({ kind: 'admin', identifier: username, success: false, reason: 'rate_limited', req });
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many failed attempts. Try again later.' });
    }
    const fail = async (reason, subjectId) => {
      recentFails(key).push(Date.now());
      await logLogin({ kind: 'admin', subjectId, identifier: username, success: false, reason, req });
      return res.status(401).json({ error: 'invalid_credentials' });
    };
    if (!username || typeof password !== 'string' || !password) return fail('missing');
    const admin = await AdminUser.findOne({ username });
    if (!admin) return fail('unknown_user');
    if (admin.status !== 'active') return fail('disabled', admin._id);
    if (!(await admin.verifyPassword(password))) return fail('bad_password', admin._id);

    const settings = await getSettings();
    if (settings.adminIpEnforce && !ipAllowed(ip, settings.adminIpAllowlist)) {
      await logLogin({ kind: 'admin', subjectId: admin._id, identifier: username, success: false, reason: 'ip_not_allowed', req });
      return res.status(403).json({ error: 'ip_not_allowed' });
    }

    fails.delete(key);
    admin.lastLoginAt = new Date();
    admin.lastLoginIp = ip;
    await admin.save();
    adminCache.delete(admin._id.toString());
    await logLogin({ kind: 'admin', subjectId: admin._id, identifier: username, success: true, req });
    return res.json({ token: await signAdminToken(admin), admin: serializeAdmin(admin) });
  } catch (e) {
    console.error('[admin/login]', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

/** 허용목록 항목: 정확한 IP 또는 'a.b.c.' 같은 접두사. 로컬 루프백은 항상 허용. */
export function ipAllowed(ip, list) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return true;
  return (list || []).some((entry) => {
    const e = String(entry).trim();
    if (!e) return false;
    return e.endsWith('.') || e.endsWith(':') ? ip.startsWith(e) : ip === e;
  });
}

// ── 요청 인증 ────────────────────────────────────────────────────────────────
const ADMIN_CACHE_TTL_MS = 10_000;
const adminCache = new Map();

export function invalidateAdminCache(id) {
  if (id) adminCache.delete(String(id));
  else adminCache.clear();
}

async function loadAdmin(id) {
  const key = String(id);
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_TTL_MS) return hit.doc;
  const doc = mongoose.isValidObjectId(key) ? await AdminUser.findById(key).lean() : null;
  adminCache.set(key, { doc, at: Date.now() });
  return doc;
}

/** Bearer 토큰 검증 → { ok, admin } 또는 { ok:false, status, error }. 웹소켓 업그레이드에서도 쓴다. */
export async function verifyAdminToken(token, ip) {
  if (!token) return { ok: false, status: 401, error: 'no_token' };
  let payload;
  try {
    payload = jwt.verify(token, adminJwtSecret);
  } catch (_) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (payload?.typ !== 'admin') return { ok: false, status: 401, error: 'invalid_token' };
  const admin = await loadAdmin(payload.sub);
  if (!admin || admin.status !== 'active') return { ok: false, status: 401, error: 'invalid_token' };
  if ((payload.tv || 0) < (admin.tokenVersion || 0)) return { ok: false, status: 401, error: 'invalid_token' };
  const settings = await getSettings();
  if (settings.adminIpEnforce && ip && !ipAllowed(ip, settings.adminIpAllowlist)) {
    return { ok: false, status: 403, error: 'ip_not_allowed' };
  }
  return {
    ok: true,
    admin: {
      id: admin._id.toString(),
      username: admin.username,
      name: admin.name || admin.username,
      role: admin.role,
      perms: new Set(permsForRole(admin.role)),
      mustChangePassword: !!admin.mustChangePassword,
    },
  };
}

export async function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const r = await verifyAdminToken(h.startsWith('Bearer ') ? h.slice(7) : null, clientIp(req));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    req.admin = r.admin;
    return next();
  } catch (e) {
    console.error('[requireAdmin]', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

/** 권한 검사. 비밀번호 변경이 강제된 계정은 변경 전까지 다른 작업을 할 수 없다. */
export function requirePerm(...perms) {
  return (req, res, next) => {
    const a = req.admin;
    if (!a) return res.status(401).json({ error: 'no_token' });
    if (a.mustChangePassword) return res.status(403).json({ error: 'password_change_required' });
    if (!perms.every((p) => a.perms.has(p))) return res.status(403).json({ error: 'forbidden', required: perms });
    return next();
  };
}

/**
 * 관리자 계정이 하나도 없으면 최초 최고관리자를 만든다.
 * 비밀번호는 ADMIN_PASSWORD(또는 config.json)에서만 가져온다 — 코드에 기본값을 두지 않는다.
 * 값이 없으면 무작위 비밀번호를 만들어 서버 로그에 1회 출력한다. 어느 쪽이든 첫 로그인 때 변경을 요구한다.
 */
export async function seedInitialAdmin() {
  if ((await AdminUser.countDocuments()) > 0) return null;
  const username = String(process.env.ADMIN_USERNAME || config.admin?.username || 'admin').trim().toLowerCase();
  let password = process.env.ADMIN_PASSWORD || config.admin?.password || '';
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    generated = true;
  }
  await AdminUser.create({
    username,
    passwordHash: await AdminUser.hashPassword(password),
    name: 'Super Admin',
    role: 'superadmin',
    mustChangePassword: true,
    createdBy: 'system',
  });
  if (generated) {
    console.log(`[admin] initial superadmin "${username}" created. One-time password: ${password}`);
  } else {
    console.log(`[admin] initial superadmin "${username}" created from configured ADMIN_PASSWORD (must be changed at first login)`);
  }
  return username;
}

export { ADMIN_ROLES };

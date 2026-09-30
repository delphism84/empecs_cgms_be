import express from 'express';
import AdminUser, { ADMIN_ROLES } from '../../models/AdminUser.js';
import {
  requireAdmin,
  requirePerm,
  loginHandler,
  signAdminToken,
  serializeAdmin,
  invalidateAdminCache,
  PERMISSIONS,
  ROLE_PERMS,
} from '../../admin/auth.js';
import { audit } from '../../admin/audit.js';
import { isId, fail } from './common.js';

const router = express.Router();

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** 비밀번호 규칙: 10자 이상, 영문·숫자 포함. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'password_min_10';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'password_needs_letter_and_digit';
  return null;
}

router.post('/login', loginHandler);

router.get('/me', requireAdmin, async (req, res) => {
  try {
    const a = await AdminUser.findById(req.admin.id);
    if (!a) return res.status(401).json({ error: 'invalid_token' });
    return res.json({ admin: serializeAdmin(a) });
  } catch (e) {
    return fail(res, 'admin/me', e);
  }
});

/** 세션 연장: 사용 중인 관리자의 토큰을 새로 발급한다. */
router.post('/refresh', requireAdmin, async (req, res) => {
  try {
    const a = await AdminUser.findById(req.admin.id);
    if (!a || a.status !== 'active') return res.status(401).json({ error: 'invalid_token' });
    return res.json({ token: await signAdminToken(a), admin: serializeAdmin(a) });
  } catch (e) {
    return fail(res, 'admin/refresh', e);
  }
});

/** 본인 비밀번호 변경. 성공하면 기존 토큰은 무효가 되고 새 토큰을 돌려준다. */
router.post('/me/password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const a = await AdminUser.findById(req.admin.id);
    if (!a) return res.status(401).json({ error: 'invalid_token' });
    if (!(await a.verifyPassword(currentPassword))) return res.status(401).json({ error: 'invalid_password' });
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (await a.verifyPassword(newPassword)) return res.status(400).json({ error: 'password_same_as_old' });
    a.passwordHash = await AdminUser.hashPassword(newPassword);
    a.mustChangePassword = false;
    a.tokenVersion = (a.tokenVersion || 0) + 1;
    await a.save();
    invalidateAdminCache(a._id);
    await audit(req, { action: 'admin.password_change', targetType: 'admin', targetId: a._id, targetLabel: a.username });
    return res.json({ ok: true, token: await signAdminToken(a), admin: serializeAdmin(a) });
  } catch (e) {
    return fail(res, 'admin/me/password', e);
  }
});

router.get('/roles', requireAdmin, (_req, res) => {
  res.json({ roles: ADMIN_ROLES, permissions: PERMISSIONS, rolePerms: ROLE_PERMS });
});

// ── 관리자 계정 관리 (최고관리자) ─────────────────────────────────────────────
router.get('/admins', requireAdmin, requirePerm('admins.manage'), async (_req, res) => {
  try {
    const rows = await AdminUser.find({}).sort({ createdAt: 1 });
    return res.json({ items: rows.map(serializeAdmin), total: rows.length });
  } catch (e) {
    return fail(res, 'admin/admins', e);
  }
});

router.post('/admins', requireAdmin, requirePerm('admins.manage'), async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const role = String(req.body?.role || 'viewer');
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
    if (!ADMIN_ROLES.includes(role)) return res.status(400).json({ error: 'invalid_role' });
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ error: problem });
    if (await AdminUser.exists({ username })) return res.status(409).json({ error: 'username_taken' });
    const a = await AdminUser.create({
      username,
      passwordHash: await AdminUser.hashPassword(req.body.password),
      name: String(req.body?.name || '').trim().slice(0, 60),
      role,
      mustChangePassword: true,
      createdBy: req.admin.username,
    });
    await audit(req, { action: 'admin.create', targetType: 'admin', targetId: a._id, targetLabel: username, after: { username, role } });
    return res.status(201).json({ ok: true, admin: serializeAdmin(a) });
  } catch (e) {
    return fail(res, 'admin/admins POST', e);
  }
});

async function activeSuperadminCount(excludeId) {
  return AdminUser.countDocuments({ role: 'superadmin', status: 'active', _id: { $ne: excludeId } });
}

router.patch('/admins/:id', requireAdmin, requirePerm('admins.manage'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    const a = await AdminUser.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'not_found' });
    const before = { name: a.name, role: a.role, status: a.status };
    const body = req.body || {};
    if (body.name !== undefined) a.name = String(body.name).trim().slice(0, 60);
    if (body.role !== undefined) {
      if (!ADMIN_ROLES.includes(body.role)) return res.status(400).json({ error: 'invalid_role' });
      a.role = body.role;
    }
    if (body.status !== undefined) {
      if (!['active', 'disabled'].includes(body.status)) return res.status(400).json({ error: 'invalid_status' });
      a.status = body.status;
    }
    // 마지막 최고관리자를 강등·비활성화하면 아무도 계정을 관리할 수 없게 된다.
    const losesSuper = before.role === 'superadmin' && (a.role !== 'superadmin' || a.status !== 'active');
    if (losesSuper && (await activeSuperadminCount(a._id)) === 0) {
      return res.status(409).json({ error: 'last_superadmin' });
    }
    if (body.password !== undefined && body.password !== '') {
      const problem = passwordProblem(body.password);
      if (problem) return res.status(400).json({ error: problem });
      a.passwordHash = await AdminUser.hashPassword(body.password);
      a.mustChangePassword = true;
      a.tokenVersion = (a.tokenVersion || 0) + 1;
    }
    if (a.status !== before.status || a.role !== before.role) a.tokenVersion = (a.tokenVersion || 0) + 1;
    await a.save();
    invalidateAdminCache(a._id);
    await audit(req, {
      action: 'admin.update',
      targetType: 'admin',
      targetId: a._id,
      targetLabel: a.username,
      before,
      after: { name: a.name, role: a.role, status: a.status, passwordReset: !!body.password },
    });
    return res.json({ ok: true, admin: serializeAdmin(a) });
  } catch (e) {
    return fail(res, 'admin/admins PATCH', e);
  }
});

router.delete('/admins/:id', requireAdmin, requirePerm('admins.manage'), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
    if (req.params.id === req.admin.id) return res.status(409).json({ error: 'cannot_delete_self' });
    const a = await AdminUser.findById(req.params.id);
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (a.role === 'superadmin' && a.status === 'active' && (await activeSuperadminCount(a._id)) === 0) {
      return res.status(409).json({ error: 'last_superadmin' });
    }
    await a.deleteOne();
    invalidateAdminCache(a._id);
    await audit(req, { action: 'admin.delete', targetType: 'admin', targetId: a._id, targetLabel: a.username, before: { role: a.role } });
    return res.json({ ok: true });
  } catch (e) {
    return fail(res, 'admin/admins DELETE', e);
  }
});

export default router;

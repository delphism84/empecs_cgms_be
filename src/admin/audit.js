import AuditLog from '../models/AuditLog.js';
import { clientIp } from './auth.js';

const SENSITIVE = new Set(['passwordHash', 'password', 'token', '__v']);

/** 감사 기록에 넣을 값 정리: 민감 필드 제거, 큰 문서는 잘라낸다. */
export function snapshot(doc) {
  if (doc == null) return undefined;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  if (typeof o !== 'object') return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (SENSITIVE.has(k)) continue;
    out[k] = v && typeof v === 'object' && typeof v.toString === 'function' && v._bsontype ? v.toString() : v;
  }
  try {
    const s = JSON.stringify(out);
    return s.length > 8000 ? { _truncated: true, preview: s.slice(0, 8000) } : JSON.parse(s);
  } catch (_) {
    return { _unserializable: true };
  }
}

/** 변경된 필드만 남긴 before/after. */
export function diff(before, after) {
  const b = snapshot(before) || {};
  const a = snapshot(after) || {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const db = {};
  const da = {};
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      db[k] = b[k];
      da[k] = a[k];
    }
  }
  return { before: db, after: da };
}

/**
 * 관리자 작업 기록. 실패해도 본 작업은 막지 않는다(로그만 남김).
 * @param {import('express').Request} req
 */
export async function audit(req, entry) {
  try {
    const a = req.admin || {};
    await AuditLog.create({
      actorId: a.id || '',
      actorName: a.username || '',
      actorRole: a.role || '',
      action: entry.action,
      targetType: entry.targetType || '',
      targetId: entry.targetId != null ? String(entry.targetId) : '',
      targetLabel: entry.targetLabel || '',
      before: entry.before,
      after: entry.after,
      note: entry.note || '',
      ip: clientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      success: entry.success !== false,
    });
  } catch (e) {
    console.error('[audit]', e?.message || e);
  }
}

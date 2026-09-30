import mongoose from 'mongoose';

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isId(v) {
  return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
}

export function oid(v) {
  return new mongoose.Types.ObjectId(String(v));
}

/** page(1부터)·limit(최대 200). */
export function paging(req, { defLimit = 50, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/** sort=field:asc|desc — 허용 목록에 있는 필드만. */
export function sorting(req, allowed, def) {
  const raw = String(req.query.sort || '').trim();
  const [field, dir] = raw.split(':');
  if (field && allowed.includes(field)) return { [field]: dir === 'asc' ? 1 : -1 };
  return def;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * from/to 기간. 'YYYY-MM-DD' 는 **한국시간 하루**(00:00~23:59:59.999)로 해석한다.
 * 예전 코드는 from 을 UTC 자정, to 를 서버 로컬 23:59 로 섞어 써서 경계일이 하루씩 어긋났다.
 * 그 외 형식(ISO 일시)은 그대로 쓴다.
 */
export function parsePeriod(query) {
  const range = {};
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = query.from ? String(query.from).trim() : '';
  const to = query.to ? String(query.to).trim() : '';
  if (from) {
    const d = day.test(from) ? new Date(Date.parse(`${from}T00:00:00.000Z`) - KST_OFFSET_MS) : new Date(from);
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (to) {
    const d = day.test(to) ? new Date(Date.parse(`${to}T23:59:59.999Z`) - KST_OFFSET_MS) : new Date(to);
    if (!Number.isNaN(d.getTime())) range.$lte = d;
  }
  return Object.keys(range).length ? range : null;
}

export function userLabel(u) {
  if (!u) return '—';
  return u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '—';
}

export function userSearchQuery(text) {
  const re = new RegExp(escapeRegex(String(text).trim()), 'i');
  return { $or: [{ email: re }, { firstName: re }, { lastName: re }, { name: re }] };
}

function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // 수식 주입 방지: 엑셀이 수식으로 해석하는 문자로 시작하면 작은따옴표를 붙인다.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** 엑셀에서 바로 열리도록 UTF-8 BOM 을 붙여 CSV 를 내려준다. */
export function beginCsv(res, filename, header) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.write('﻿');
  res.write(csvLine(header));
}

export function kstString(d) {
  if (!d) return '';
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + KST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

export function fail(res, tag, e) {
  console.error(`[${tag}]`, e?.message || e);
  return res.status(500).json({ error: 'internal_error' });
}

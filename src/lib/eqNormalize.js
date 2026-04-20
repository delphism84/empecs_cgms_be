/** @param {unknown} raw */
export function normalizeSerialQuery(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length ? t.toUpperCase() : null;
}

/** FE: uppercase hex, no colons. BE also accepts colons/dashes/spaces. */
export function normalizeBleMac(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.replace(/[:\-\s]/g, '').toUpperCase();
  if (!s || !/^[0-9A-F]+$/.test(s) || s.length % 2 !== 0) return null;
  if (s.length < 6 || s.length > 16) return null;
  return s;
}

/** Legacy rows may lack userId; treat createdBy/updatedBy as ownership. */
export function userOwnsEq(doc, userId) {
  const uid = userId.toString();
  if (doc.userId && doc.userId.toString() === uid) return true;
  if (doc.createdBy && doc.createdBy.toString() === uid) return true;
  if (doc.updatedBy && doc.updatedBy.toString() === uid) return true;
  return false;
}

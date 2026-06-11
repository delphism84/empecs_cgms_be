#!/usr/bin/env node
import crypto from 'crypto';
/**
 * EMPECS CGMS — 전체 자동 검수 (Node)
 * - health → 회원가입(고유 이메일) → 로그인 → /me
 * - 설정(app, sensor, alarm), EQ 등록·resolve
 * - 에뮬레이션: seed-day / seed-days, glucose batch, 이벤트
 * - 데이터 누적 전후 카운트 검증
 *
 * 사용:
 *   node scripts/qa-e2e-full.js [BASE_URL]
 *   QA_BASE_URL=https://empecsuser.lunarsystem.co.kr node scripts/qa-e2e-full.js
 *
 * BASE는 스킴 포함 (끝 슬래시 없음). Flutter Web과 동일하게 /api 가 BE로 프록시되는 호스트를 권장.
 */

const BASE_RAW = process.argv[2] || process.env.QA_BASE_URL || 'http://127.0.0.1:63101';
const BASE = BASE_RAW.replace(/\/$/, '');

const stamp = Date.now();
const QA_EMAIL = `qa_e2e_${stamp}@qa.empecs.local`;
const QA_PASSWORD = 'QaE2eTest!8chars';
const QA_SERIAL = `QA${stamp}`.slice(0, 24);
/** Eq.bleMac은 DB 전역 유일 — 매 실행 랜덤 12 hex */
const QA_BLE_MAC = crypto.randomBytes(6).toString('hex').toUpperCase();

let failures = 0;
function fail(msg) {
  console.error(`\n✗ FAIL: ${msg}`);
  failures += 1;
}

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

async function req(method, path, body, token, query) {
  const q =
    query && Object.keys(query).length
      ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}`
      : '';
  const url = `${BASE}${path}${q}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(120000),
  };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body && (method === 'POST' || method === 'PUT' || method === 'DELETE')) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  let data;
  if (ct.includes('application/json')) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { _raw: text.slice(0, 200) };
    }
  } else {
    data = { _nonJson: true, length: text.length, preview: text.slice(0, 80) };
  }
  return { status: res.status, ok: res.ok, data };
}

function assert(name, cond, detail = '') {
  if (cond) {
    pass(`${name}${detail ? `: ${detail}` : ''}`);
  } else {
    fail(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  EMPECS CGMS  QA E2E (Node)                               ║
╚═══════════════════════════════════════════════════════════╝
Base URL: ${BASE}
Test user: ${QA_EMAIL}
`);

  // ---- 1. Health ----
  const h = await req('GET', '/api/health');
  assert('GET /api/health', h.ok && h.data?.ok === true, `status=${h.status}`);
  if (!h.ok) {
    console.log('\n연결 실패 — Docker·nginx·BASE_URL 확인.');
    process.exit(1);
  }

  // ---- 2. Register ----
  const regBody = {
    email: QA_EMAIL,
    password: QA_PASSWORD,
    firstName: 'QA',
    lastName: 'E2E',
    dateOfBirth: '1990-01-15',
    gender: 'male',
    unit: 'mg/dL',
    agreeTerms: true,
  };
  const reg = await req('POST', '/api/auth/register', regBody);
  let token;
  if (reg.ok && reg.data?.token) {
    token = reg.data.token;
    pass(`POST /api/auth/register (201) ${QA_EMAIL}`);
  } else if (reg.status === 409) {
    const lg = await req('POST', '/api/auth/login', { email: QA_EMAIL, password: QA_PASSWORD });
    assert('POST /api/auth/login (after conflict)', lg.ok && lg.data?.token, JSON.stringify(lg.data));
    token = lg.data.token;
  } else {
    fail(`register: ${reg.status} ${JSON.stringify(reg.data)}`);
    process.exit(1);
  }

  // ---- 3. Me ----
  const me = await req('GET', '/api/auth/me', null, token);
  assert('GET /api/auth/me', me.ok && me.data?.user?.email === QA_EMAIL.toLowerCase());

  // ---- 4. Login again (별도 검증) ----
  const login2 = await req('POST', '/api/auth/login', { email: QA_EMAIL, password: QA_PASSWORD });
  assert('POST /api/auth/login', login2.ok && !!login2.data?.token);
  token = login2.data.token;

  // ---- 5. App settings ----
  const appPut = await req('PUT', '/api/settings/app', { unit: 'mg/dL', notifications: true, darkMode: false }, token);
  assert('PUT /api/settings/app', appPut.ok);
  const appGet = await req('GET', '/api/settings/app', null, token);
  assert('GET /api/settings/app', appGet.ok);

  // ---- 6. Sensor + Alarm ----
  const sens = await req('POST', '/api/settings/sensors', { name: 'QA Sensor', serial: QA_SERIAL, isActive: true }, token);
  assert('POST /api/settings/sensors', sens.ok && sens.data?._id, sens.status);
  const sensorId = sens.data?._id;

  const al = await req(
    'POST',
    '/api/settings/alarms',
    { type: 'low', enabled: true, threshold: 70, sound: true, vibrate: true },
    token
  );
  assert('POST /api/settings/alarms', al.ok && al.data?._id);

  // ---- 7. EQ 등록 + resolve ----
  const eqPost = await req(
    'POST',
    '/api/settings/eq-list',
    { serial: QA_SERIAL, bleMac: QA_BLE_MAC, startAt: new Date().toISOString() },
    token
  );
  assert('POST /api/settings/eq-list', eqPost.ok);

  const resSerial = await req('GET', '/api/settings/eq-list/resolve', null, token, { serial: QA_SERIAL });
  assert('GET /api/settings/eq-list/resolve?serial=', resSerial.ok && resSerial.data?.serial === QA_SERIAL.toUpperCase());

  const macColon = QA_BLE_MAC.replace(/(..)(?!$)/g, '$1:');
  const resMac = await req('GET', '/api/settings/eq-list/resolve', null, token, { bleMac: macColon });
  assert('GET /api/settings/eq-list/resolve?bleMac=', resMac.ok && resMac.data?.matchedBy);

  // ---- 8. 초기 데이터 카운트 ----
  const gl0 = await req('GET', '/api/data/glucose', null, token, { limit: 5000 });
  const n0 = Array.isArray(gl0.data) ? gl0.data.length : 0;

  // ---- 9. 에뮬레이션 seed-day ----
  const seed1 = await req('POST', '/api/data/glucose/seed-day', {}, token);
  assert('POST /api/data/glucose/seed-day (에뮬 1일)', seed1.ok && (seed1.data?.count >= 1000 || seed1.data?.ok));

  const gl1 = await req('GET', '/api/data/glucose', null, token, { limit: 5000 });
  const n1 = Array.isArray(gl1.data) ? gl1.data.length : 0;
  assert(`데이터 누적 (glucose ${n0} → ${n1})`, n1 > n0, `delta=${n1 - n0}`);

  // ---- 10. seed-days ----
  const seed2 = await req('POST', '/api/data/glucose/seed-days', { days: 2 }, token);
  assert('POST /api/data/glucose/seed-days', seed2.ok && seed2.data?.days === 2);

  const gl2 = await req('GET', '/api/data/glucose', null, token, { limit: 8000 });
  const n2 = Array.isArray(gl2.data) ? gl2.data.length : 0;
  assert(`데이터 누적 (seed-days 후 ${n2} points)`, n2 > n1);

  // ---- 11. batch glucose ----
  const t = Date.now();
  const batch = await req('POST', '/api/data/glucose/batch', {
    eqsn: QA_SERIAL,
    t: [t, t + 60000],
    v: [100, 101],
  }, token);
  assert('POST /api/data/glucose/batch', batch.ok && (batch.data?.count >= 1 || batch.data?.ok));

  // ---- 12. 이벤트 ----
  const ev0 = await req('GET', '/api/data/events', null, token, { limit: 100 });
  const evCount0 = Array.isArray(ev0.data) ? ev0.data.length : 0;
  const evPost = await req(
    'POST',
    '/api/data/events',
    { type: 'meal', time: new Date().toISOString(), memo: 'QA E2E' },
    token
  );
  assert('POST /api/data/events', evPost.ok);
  const ev1 = await req('GET', '/api/data/events', null, token, { limit: 100 });
  const evCount1 = Array.isArray(ev1.data) ? ev1.data.length : 0;
  assert(`이벤트 누적 (${evCount0} → ${evCount1})`, evCount1 >= evCount0 + 1);

  // ---- 13. 문서 엔드포인트 (선택) ----
  const doc = await req('GET', '/api/docs', null, null);
  assert('GET /api/docs', doc.ok && doc.status === 200, 'Markdown API 문서');

  // ---- 14. 정리(선택) ----
  if (sensorId) {
    await req('DELETE', `/api/settings/sensors/${sensorId}`, null, token);
  }

  console.log(`
═══════════════════════════════════════════════════════════
  결과: ${failures === 0 ? '전체 통과 ✓' : `실패 ${failures}건`}
═══════════════════════════════════════════════════════════
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

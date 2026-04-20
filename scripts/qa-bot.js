#!/usr/bin/env node
/**
 * EMPECS CGMS BE - QA Bot
 * API 테스트: health, auth/login, auth/social, data, settings 엔드포인트
 * 사용: node scripts/qa-bot.js [BASE_URL]
 * 기본: http://127.0.0.1:40100 (docker) / http://127.0.0.1:58002 (로컬) / http://127.0.0.1:63101 (프로덕션)
 */

const BASE = process.argv[2] || 'http://127.0.0.1:40100';
const CRED = { email: 'empecs', password: 'admin' };

async function req(method, path, body, token) {
  const url = `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body && (method === 'POST' || method === 'PUT')) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, data: json };
}

function ok(name, r) {
  const s = r.ok ? '✓' : '✗';
  const preview = JSON.stringify(r.data).slice(0, 120);
  console.log(`  ${s} ${name}: ${r.status} ${preview}${preview.length >= 120 ? '...' : ''}`);
}

async function main() {
  console.log(`\n=== EMPECS CGMS QA Bot ===\nBase: ${BASE}\n`);

  // 1. Health
  const h = await req('GET', '/api/health');
  ok('GET /api/health', h);
  if (!h.ok) {
    console.log('\n서버 연결 실패. docker compose up 확인.');
    process.exit(1);
  }

  // 2. Login
  const login = await req('POST', '/api/auth/login', CRED);
  ok('POST /api/auth/login', login);
  if (!login.ok || !login.data?.token) {
    console.log('\n로그인 실패. 시드 계정 empecs/admin 확인.');
    process.exit(1);
  }
  const token = login.data.token;

  // 3. Data (glucose, events)
  const gl = await req('GET', '/api/data/glucose?limit=5', null, token);
  ok('GET /api/data/glucose', gl);

  const glCompact = await req('GET', '/api/data/glucose?limit=3&compact=1', null, token);
  ok('GET /api/data/glucose?compact=1', glCompact);

  const ev = await req('GET', '/api/data/events?limit=5', null, token);
  ok('GET /api/data/events', ev);

  const postGl = await req('POST', '/api/data/glucose', {
    time: new Date().toISOString(),
    value: 120,
  }, token);
  ok('POST /api/data/glucose', postGl);

  const postEv = await req('POST', '/api/data/events', {
    type: 'meal',
    time: new Date().toISOString(),
    memo: 'QA test meal',
  }, token);
  ok('POST /api/data/events', postEv);

  // 4. Settings
  const sensors = await req('GET', '/api/settings/sensors', null, token);
  ok('GET /api/settings/sensors', sensors);

  const alarms = await req('GET', '/api/settings/alarms', null, token);
  ok('GET /api/settings/alarms', alarms);

  const app = await req('GET', '/api/settings/app', null, token);
  ok('GET /api/settings/app', app);

  // 5. No token
  const noToken = await req('GET', '/api/data/glucose');
  ok('GET /api/data/glucose (no token)', noToken);
  if (noToken.status === 401) console.log('    (예상: 401 unauthorized)');

  // 6. 소셜 로그인 API 검증 (토큰 없이 호출 시 적절한 에러 반환 확인)
  console.log('\n--- 소셜 로그인 API ---');
  const verifyNoProvider = await req('POST', '/api/auth/social/verify', {});
  ok('POST /api/auth/social/verify (no provider)', verifyNoProvider);
  const verifyBadPayload = await req('POST', '/api/auth/social/verify', { provider: 'google' });
  ok('POST /api/auth/social/verify (google, no idToken)', verifyBadPayload);

  console.log('\n=== QA 완료 ===\n');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

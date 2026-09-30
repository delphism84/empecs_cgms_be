/**
 * 로컬 개발용 BE: 메모리 MongoDB 로 띄우고 화면 확인용 데이터를 채운다(프로세스 종료 시 사라짐).
 *   node scripts/dev-server.mjs            # http://127.0.0.1:58113
 * 어드민 FE: API_PROXY_TARGET=http://127.0.0.1:58113 npm run dev
 * 로컬 전용 관리자 계정은 기동 로그에 출력된다. 운영 서버와는 무관하다.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 58113);
const BASE = `http://127.0.0.1:${PORT}`;
const INIT_PW = 'local-dev-init-01';
const ADMIN_PW = process.env.DEV_ADMIN_PASSWORD || 'local-dev-admin-01';
const USER_PW = 'local-user-pass-01';

const server = spawn(process.execPath, ['src/index.js'], {
  cwd: root,
  env: { ...process.env, MONGO_MEMORY: '1', PORT: String(PORT), HOST: '127.0.0.1', JWT_SECRET: 'local-dev-user-secret', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: INIT_PW },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => { server.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));

async function api(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 본문 없음 */ }
  if (res.status >= 400) console.warn(`[seed] ${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json || {};
}

async function waitUp() {
  for (let i = 0; i < 600; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* 기동 중 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

async function uploadGlucose(token, eqsn, hours, { base = 120, amp = 45, stepMin = 5 } = {}) {
  const n = Math.floor((hours * 60) / stepMin);
  const start = Date.now() - n * stepMin * 60000;
  let t = []; let v = []; let tr = [];
  for (let i = 0; i < n; i += 1) {
    t.push(start + i * stepMin * 60000);
    v.push(Math.round(base + amp * Math.sin(i / 17) + 18 * Math.sin(i / 5)));
    tr.push(i + 1);
    if (t.length === 500 || i === n - 1) {
      await api('POST', '/api/data/glucose/batch', { token, body: { t, v, tr, eqsn } });
      t = []; v = []; tr = [];
    }
  }
}

async function seed() {
  // 관리자
  let r = await api('POST', '/api/admin/login', { body: { username: 'admin', password: INIT_PW } });
  r = await api('POST', '/api/admin/me/password', { token: r.token, body: { currentPassword: INIT_PW, newPassword: ADMIN_PW } });
  const SA = r.token;
  for (const [username, role, name] of [['operator1', 'operator', '운영 담당'], ['cs1', 'cs', 'CS 담당'], ['viewer1', 'viewer', '조회 전용']]) {
    await api('POST', '/api/admin/admins', { token: SA, body: { username, role, name, password: `${username}-init-0001` } });
  }

  // 재고: 로트 A(MAC 있음) 30개, 로트 B(MAC 없음) 20개
  const rows = Array.from({ length: 30 }, (_, i) => ({
    serial: `C21Z${String(101 + i).padStart(5, '0')}`,
    bleMac: `04AC4411${(0x1100 + i).toString(16).toUpperCase().padStart(4, '0')}`,
  }));
  await api('POST', '/api/admin/lots', { token: SA, body: { code: 'LOT-2609A', model: 'C21', manufacturedAt: '2026-09-01', note: '9월 1차 생산분' } });
  await api('POST', '/api/admin/devices/import', { token: SA, body: { rows, lotCode: 'LOT-2609A', manufacturedAt: '2026-09-01' } });
  await api('POST', '/api/admin/devices/generate', { token: SA, body: { model: 'C21', yearCode: 'Z', from: 200, count: 20, lotCode: 'LOT-2609B' } });
  await api('POST', '/api/admin/devices/bulk', { token: SA, body: { serials: rows.slice(0, 15).map((x) => x.serial), action: 'ship', shippedTo: '서울 대리점' } });

  // 회원
  const people = [
    ['kim.minji', '민지', '김', 'KR', 'ko'], ['lee.junho', '준호', '이', 'KR', 'ko'], ['park.seoyeon', '서연', '박', 'KR', 'ko'],
    ['choi.dohyun', '도현', '최', 'KR', 'ko'], ['jung.haeun', '하은', '정', 'KR', 'ko'], ['kang.jiwoo', '지우', '강', 'KR', 'ko'],
    ['yoon.sumin', '수민', '윤', 'KR', 'ko'], ['han.yejun', '예준', '한', 'KR', 'ko'], ['john.smith', 'John', 'Smith', 'US', 'en'],
    ['emma.brown', 'Emma', 'Brown', 'GB', 'en'], ['sato.yuki', 'Yuki', 'Sato', 'JP', 'ja'], ['nguyen.an', 'An', 'Nguyen', 'VN', 'vi'],
  ];
  const users = [];
  for (const [id, firstName, lastName, countryCode, language] of people) {
    const email = `${id}@example.com`;
    const j = await api('POST', '/api/auth/register', {
      body: { email, password: USER_PW, firstName, lastName, dateOfBirth: '1985-04-12', gender: 'female', countryCode, language, agreeTerms: true },
    });
    users.push({ email, token: j.token, id: String(j.user?.id || '').replace(/^usr_/, '') });
  }
  const reg = (u, i) => api('POST', '/api/settings/eq-list', { token: u.token, body: { serial: rows[i].serial, bleMac: rows[i].bleMac } });
  const startFix = (sn, h) => api('POST', `/api/admin/devices/${sn}/start`, { token: SA, body: { startAt: hoursAgo(h), note: 'dev seed' } });

  // 센서 상태별
  await reg(users[0], 0); await startFix(rows[0].serial, 48); await uploadGlucose(users[0].token, rows[0].serial, 48);
  await reg(users[1], 1); await startFix(rows[1].serial, 16 * 24 - 10); await uploadGlucose(users[1].token, rows[1].serial, 30, { base: 150, amp: 60 });
  await reg(users[2], 2); await startFix(rows[2].serial, 17 * 24); await uploadGlucose(users[2].token, rows[2].serial, 6, { base: 95, amp: 25 });
  await reg(users[3], 3); await startFix(rows[3].serial, 5 * 24); await uploadGlucose(users[3].token, rows[3].serial, 72, { base: 110, amp: 55 });
  await reg(users[4], 4); await startFix(rows[4].serial, 10);   // 업로드 없음 → 동기화 이상
  await reg(users[5], 5); await startFix(rows[5].serial, 30);   // 업로드 없음 → 동기화 이상
  await reg(users[6], 6); await startFix(rows[6].serial, 16 * 24 - 3); await uploadGlucose(users[6].token, rows[6].serial, 12);
  await reg(users[8], 7); await startFix(rows[7].serial, 24); await uploadGlucose(users[8].token, rows[7].serial, 24, { base: 135, amp: 35 });
  await api('POST', `/api/admin/devices/${rows[8].serial}/block`, { token: SA, body: { reason: '리콜 대상 (dev seed)' } });
  // 재고에 없는 SN 을 앱이 등록 → 미확인
  await api('POST', '/api/settings/eq-list', { token: users[9].token, body: { serial: 'C21Z09999', bleMac: '04AC4411FFFF' } });
  await api('POST', '/api/settings/eq-list', { token: users[10].token, body: { serial: 'UNKNOWN-SN-01' } });
  await uploadGlucose(users[9].token, 'C21Z09999', 8, { base: 100, amp: 20 });

  // 이벤트·알람
  for (const [type, h, memo] of [['meal', 3, '점심'], ['exercise', 5, '산책 30분'], ['insulin', 8, '속효성 4단위'], ['memo', 20, '컨디션 저조']]) {
    await api('POST', '/api/data/events', { token: users[0].token, body: { type, time: hoursAgo(h), memo, eqsn: rows[0].serial } });
  }
  await api('POST', '/api/settings/alarms', { token: users[0].token, body: { type: 'low', threshold: 75, enabled: true, repeatMin: 5 } });
  await api('POST', '/api/settings/alarms', { token: users[0].token, body: { type: 'high', threshold: 200, enabled: true, repeatMin: 10 } });

  // 회원 상태
  await api('POST', `/api/admin/users/${users[7].id}/suspend`, { token: SA, body: { reason: '결제 분쟁 확인 중 (dev seed)' } });
  await api('DELETE', `/api/admin/users/${users[11].id}`, { token: SA, body: { mode: 'soft' } });
  await api('PATCH', `/api/admin/users/${users[0].id}`, { token: SA, body: { adminNote: '09/28 문의: 업로드 지연. 재로그인 안내함.' } });

  // 공지
  await api('POST', '/api/admin/notices', { token: SA, body: { title: '서버 점검 안내 (10/5 02:00~04:00)', body: '점검 시간 동안 데이터 동기화가 지연될 수 있습니다.\n측정값은 앱에 저장되며 점검 후 자동으로 전송됩니다.', pinned: true, language: 'ko' } });
  await api('POST', '/api/admin/notices', { token: SA, body: { title: 'App update 1.0.1', body: 'Sign-in now stays active while you use the app.', language: 'en' } });

  console.log(`\n[dev] seeded. BE: ${BASE}\n[dev] local admin login → username: admin  password: ${ADMIN_PW}\n[dev] (operator1 / cs1 / viewer1 은 초기 비밀번호 "<아이디>-init-0001", 첫 로그인 시 변경)\n`);
}

waitUp().then(seed).catch((e) => { console.error('[dev] seed failed', e); });

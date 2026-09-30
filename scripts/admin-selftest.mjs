/**
 * 관리자 API 자체 점검 — 메모리 MongoDB 로 BE 를 띄워 전 기능을 실제 HTTP 로 확인한다.
 *   node scripts/admin-selftest.mjs
 * 운영 서버에는 아무 요청도 보내지 않는다(127.0.0.1 전용, DB 는 프로세스 종료 시 사라짐).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SELFTEST_PORT || 58112);
const BASE = `http://127.0.0.1:${PORT}`;
const INIT_PW = 'selftest-init-0001';
const NEW_PW = 'selftest-next-0002';

let pass = 0;
const failed = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { failed.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

async function api(method, p, { token, body, raw } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    // text() 는 BOM 을 떼어 버리므로 바이트로 확인한다.
    const buf = Buffer.from(await res.arrayBuffer());
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    return { status: res.status, bom, text: buf.subarray(bom ? 3 : 0).toString('utf8'), headers: res.headers };
  }
  let json = null;
  try { json = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, json };
}

const server = spawn(process.execPath, ['src/index.js'], {
  cwd: root,
  env: { ...process.env, MONGO_MEMORY: '1', PORT: String(PORT), HOST: '127.0.0.1', JWT_SECRET: 'selftest-user-secret', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: INIT_PW, EQ_VALIDITY_DAYS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

async function waitUp() {
  for (let i = 0; i < 600; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* 아직 기동 중 */ }
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode != null) throw new Error(`server exited:\n${log.slice(-2000)}`);
  }
  throw new Error('server did not start');
}

async function registerUser(email) {
  const r = await api('POST', '/api/auth/register', {
    body: { email, password: 'user-pass-1234', firstName: 'Q', lastName: 'A', dateOfBirth: '1990-01-01', agreeTerms: true },
  });
  return { token: r.json?.token, id: r.json?.user?.id?.replace(/^usr_/, ''), status: r.status };
}

try {
  await waitUp();
  console.log('[1] 관리자 인증');
  let r = await api('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong-password' } });
  check('틀린 비밀번호 401', r.status === 401);
  r = await api('POST', '/api/admin/login', { body: { username: 'admin', password: INIT_PW } });
  check('로그인 성공 + 비밀번호 변경 요구', r.status === 200 && r.json.admin.mustChangePassword === true);
  const firstToken = r.json.token;
  r = await api('GET', '/api/admin/users', { token: firstToken });
  check('변경 전에는 다른 작업 차단(403)', r.status === 403 && r.json.error === 'password_change_required');
  r = await api('POST', '/api/admin/me/password', { token: firstToken, body: { currentPassword: INIT_PW, newPassword: 'short' } });
  check('약한 비밀번호 거절', r.status === 400);
  r = await api('POST', '/api/admin/me/password', { token: firstToken, body: { currentPassword: INIT_PW, newPassword: NEW_PW } });
  check('비밀번호 변경', r.status === 200 && !!r.json.token);
  const SA = r.json.token;
  r = await api('GET', '/api/admin/me', { token: firstToken });
  check('변경 후 이전 토큰 무효', r.status === 401);
  r = await api('GET', '/api/settings/app', { token: SA });
  check('관리자 토큰으로 회원 API 접근 불가', r.status === 401);

  console.log('[2] 관리자 계정·권한');
  r = await api('POST', '/api/admin/admins', { token: SA, body: { username: 'viewer1', password: 'viewer-pass-0001', role: 'viewer', name: 'V' } });
  check('조회전용 계정 생성', r.status === 201);
  r = await api('POST', '/api/admin/login', { body: { username: 'viewer1', password: 'viewer-pass-0001' } });
  r = await api('POST', '/api/admin/me/password', { token: r.json.token, body: { currentPassword: 'viewer-pass-0001', newPassword: 'viewer-pass-0002' } });
  const VIEW = r.json.token;
  r = await api('GET', '/api/admin/users', { token: VIEW });
  check('조회전용: 회원 목록 가능', r.status === 200);
  r = await api('POST', '/api/admin/devices', { token: VIEW, body: { serial: 'C21Z00999' } });
  check('조회전용: 기기 등록 불가(403)', r.status === 403);
  r = await api('GET', '/api/admin/admins', { token: VIEW });
  check('조회전용: 관리자 관리 불가(403)', r.status === 403);
  const me = (await api('GET', '/api/admin/me', { token: SA })).json.admin;
  r = await api('PATCH', `/api/admin/admins/${me.id}`, { token: SA, body: { role: 'viewer' } });
  check('마지막 최고관리자 강등 차단', r.status === 409 && r.json.error === 'last_superadmin');

  console.log('[3] 앱 등록 → 재고 반영');
  const u1 = await registerUser('selftest1@example.com');
  const u2 = await registerUser('selftest2@example.com');
  check('회원 가입 2명', u1.status === 201 && u2.status === 201);
  r = await api('POST', '/api/settings/eq-list', { token: u1.token, body: { serial: 'c21z00101', bleMac: '04:AC:44:11:11:01' } });
  check('앱 센서 등록', r.status === 200 && r.json.serial === 'C21Z00101');
  r = await api('GET', '/api/settings/eq-list/resolve?serial=C21Z00101', { token: u1.token });
  check('유효기간 16일 기준 잔여시간', r.status === 200 && Math.abs(r.json.remainingMinutes - 16 * 1440) <= 2, `got ${r.json?.remainingMinutes}`);
  r = await api('GET', '/api/settings/eq-list/C21Z00101', { token: u2.token });
  check('남의 센서 행은 조회 불가', r.status === 200 && !r.json.serial);
  r = await api('GET', '/api/admin/devices?sn=C21Z00101', { token: SA });
  const d0 = r.json.items[0];
  check('재고에 미확인(앱 등록)으로 표시', d0 && d0.verified === false && d0.source === 'app' && d0.status === 'active' && d0.owner?.email === 'selftest1@example.com');

  console.log('[4] 재고 등록·가져오기·QR');
  const rows = [
    { serial: 'C21Z00101' }, { serial: 'C21Z00102', bleMac: '04AC44111102' }, { serial: 'BADFORMAT1' },
    { serial: 'C21Z00102' }, { serial: 'C21Z00103', bleMac: 'zz' },
  ];
  r = await api('POST', '/api/admin/devices/import', { token: SA, body: { rows, lotCode: 'lot-a', dryRun: true } });
  check('가져오기 미리보기', r.status === 200 && r.json.dryRun && r.json.summary.created === 2 && r.json.summary.upgraded === 1 && r.json.summary.error === 2, JSON.stringify(r.json?.summary));
  r = await api('POST', '/api/admin/devices/import', { token: SA, body: { rows, lotCode: 'lot-a' } });
  check('가져오기 실행', r.status === 200 && r.json.summary.created === 2 && r.json.summary.upgraded === 1 && r.json.summary.formatWarnings === 1);
  r = await api('GET', '/api/admin/devices?sn=C21Z00101', { token: SA });
  check('앱 등록 SN 이 확인됨으로 승격 + 로트 지정', r.json.items[0].verified === true && r.json.items[0].lotCode === 'LOT-A');
  r = await api('POST', '/api/admin/devices/generate', { token: SA, body: { model: 'C21', yearCode: 'Z', from: 200, count: 5, lotCode: 'LOT-B' } });
  check('SN 범위 생성', r.status === 200 && r.json.created === 5 && r.json.first === 'C21Z00200' && r.json.last === 'C21Z00204');
  r = await api('GET', '/api/admin/devices/qr?serials=C21Z00102,C21Z00200', { token: SA });
  const qr = Object.fromEntries(r.json.items.map((x) => [x.serial, x.payload]));
  check('QR 문자열(앱 형식)', qr.C21Z00102 === 'empecsCGM;0xFFFF04AC44111102;0xC21Z00102' && qr.C21Z00200 === 'C21Z00200', JSON.stringify(qr));
  r = await api('GET', '/api/admin/lots', { token: SA });
  const lotA = r.json.items.find((l) => l.code === 'LOT-A');
  check('로트 집계', lotA && lotA.total === 3 && lotA.registered === 1 && r.json.items.find((l) => l.code === 'LOT-B').total === 5, JSON.stringify(lotA));
  r = await api('GET', '/api/admin/devices/summary', { token: SA });
  check('상태 요약', r.json.active === 1 && r.json.stock === 7 && r.json.formatBad === 1, JSON.stringify(r.json));

  console.log('[5] 차단·정책·소유권');
  await api('POST', '/api/admin/devices/C21Z00102/block', { token: SA, body: { reason: 'recall' } });
  r = await api('POST', '/api/settings/eq-list', { token: u2.token, body: { serial: 'C21Z00102' } });
  check('차단된 SN 등록 거절', r.status === 403 && r.json.error === 'device_blocked');
  await api('POST', '/api/admin/devices/C21Z00102/unblock', { token: SA });
  await api('PUT', '/api/admin/settings', { token: SA, body: { snPolicy: 'block' } });
  r = await api('POST', '/api/settings/eq-list', { token: u2.token, body: { serial: 'C21Z77777' } });
  check('정책=차단: 재고에 없는 SN 거절', r.status === 403 && r.json.error === 'sn_not_registered');
  r = await api('POST', '/api/settings/eq-list', { token: u2.token, body: { serial: 'C21Z00102' } });
  check('정책=차단: 재고에 있는 SN 은 등록', r.status === 200);
  await api('PUT', '/api/admin/settings', { token: SA, body: { snPolicy: 'flag' } });
  r = await api('POST', '/api/settings/eq-list', { token: u2.token, body: { serial: 'C21Z00101' } });
  check('다른 계정 소유 SN 은 403', r.status === 403 && r.json.error === 'forbidden');
  r = await api('POST', '/api/admin/devices/C21Z00101/release', { token: SA, body: { note: 'selftest' } });
  check('소유권 해제', r.status === 200);
  r = await api('POST', '/api/settings/eq-list', { token: u2.token, body: { serial: 'C21Z00101' } });
  check('해제 후 다른 계정이 등록 가능', r.status === 200);
  r = await api('POST', '/api/admin/devices/C21Z00101/transfer', { token: SA, body: { userId: 'selftest1@example.com' } });
  check('소유권 이전', r.status === 200);
  r = await api('GET', '/api/settings/eq-list/resolve?serial=C21Z00101', { token: u2.token });
  check('이전 후 이전 소유자는 조회 불가', r.status === 404);
  const threeH = new Date(Date.now() - 3 * 3600000).toISOString();
  r = await api('POST', '/api/admin/devices/C21Z00101/start', { token: SA, body: { startAt: threeH } });
  check('시작시각 정정', r.status === 200);
  r = await api('GET', '/api/admin/devices/C21Z00101', { token: SA });
  const acts = r.json.history.map((h) => h.action);
  check('등록 이력', ['register', 'release', 'transfer', 'start_fix'].every((a) => acts.includes(a)) && r.json.owner.email === 'selftest1@example.com', acts.join(','));
  r = await api('DELETE', '/api/admin/devices/C21Z00101', { token: SA });
  check('등록된 SN 삭제는 거절', r.status === 409);
  r = await api('DELETE', '/api/admin/devices/C21Z00204', { token: SA });
  check('미등록 재고 삭제', r.status === 200);

  console.log('[6] 데이터·회원 상세');
  const t0 = Date.now() - 2 * 3600000;
  r = await api('POST', '/api/data/glucose', { token: u1.token, body: { time: new Date(t0).toISOString(), value: 65, trid: 1, eqsn: 'C21Z00101' } });
  await api('POST', '/api/data/glucose', { token: u1.token, body: { time: new Date(t0).toISOString(), value: 65, trid: 1, eqsn: 'C21Z00101' } });
  const tt = []; const vv = []; const tr = [];
  for (let i = 1; i <= 20; i += 1) { tt.push(t0 + i * 300000); vv.push(100 + i * 5); tr.push(1 + i); }
  r = await api('POST', '/api/data/glucose/batch', { token: u1.token, body: { t: tt, v: vv, tr, eqsn: 'C21Z00101' } });
  check('배치 업로드', r.status === 200 && r.json.upserted === 20);
  r = await api('POST', '/api/data/glucose', { token: u1.token, body: { time: 'not-a-date', value: 1 } });
  check('잘못된 시각은 400', r.status === 400);
  r = await api('GET', `/api/admin/users/${u1.id}/overview`, { token: SA });
  check('회원 상세: 단건 재전송 중복 없음(21건)', r.status === 200 && r.json.data.totalPoints === 21, `points=${r.json?.data?.totalPoints}`);
  check('회원 상세: 센서·통계', r.json.devices.length === 1 && r.json.stats14d.points === 21 && r.json.user.lastUploadAt);
  r = await api('GET', `/api/admin/users/${u1.id}/glucose?from=${new Date(t0 - 60000).toISOString()}&to=${new Date().toISOString()}`, { token: SA });
  check('혈당 그래프 데이터', r.status === 200 && r.json.points.length === 21);
  r = await api('GET', `/api/admin/data/export.csv?userId=${u1.id}`, { token: SA, raw: true });
  check('CSV 내보내기(BOM·헤더·행)', r.status === 200 && r.bom && r.text.trim().split('\r\n').length === 22);
  r = await api('GET', '/api/admin/data/export.csv', { token: SA, raw: true });
  check('조건 없는 전체 내보내기 거절', r.status === 400);
  r = await api('GET', '/api/admin/data/export.csv?userId=' + u1.id, { token: VIEW, raw: true });
  check('조회전용은 내보내기 불가', r.status === 403);
  r = await api('POST', '/api/admin/data/delete', { token: SA, body: { userId: u1.id, dryRun: true } });
  check('삭제 미리보기', r.json.count === 21);
  r = await api('POST', '/api/admin/data/delete', { token: SA, body: { userId: u1.id } });
  check('확인 문구 없으면 삭제 거절', r.status === 400);

  console.log('[7] 동기화 감시');
  r = await api('GET', '/api/admin/monitor/sync?hours=1', { token: SA });
  const gap = r.json.items.find((x) => x.serial === 'C21Z00102');
  check('업로드 없는 사용 중 센서 감지', r.status === 200 && r.json.activeSensors === 2 && !r.json.items.some((x) => x.serial === 'C21Z00101'), JSON.stringify(r.json.items.map((x) => x.serial)));
  check('1시간 이내 등록은 아직 정상', !gap);

  console.log('[8] 회원 정지·강제 로그아웃·탈퇴');
  r = await api('POST', `/api/admin/users/${u2.id}/suspend`, { token: SA, body: { reason: 'test' } });
  check('정지', r.status === 200);
  r = await api('GET', '/api/settings/app', { token: u2.token });
  check('정지 회원 API 403', r.status === 403 && r.json.error === 'account_suspended');
  r = await api('POST', '/api/auth/login', { body: { email: 'selftest2@example.com', password: 'user-pass-1234' } });
  check('정지 회원 로그인 403', r.status === 403);
  r = await api('POST', '/api/auth/refresh', { token: u2.token });
  check('정지 회원 토큰 연장 불가', r.status === 403);
  await api('POST', `/api/admin/users/${u2.id}/unsuspend`, { token: SA });
  r = await api('GET', '/api/settings/app', { token: u2.token });
  check('해제 후 정상', r.status === 200);
  await api('POST', `/api/admin/users/${u2.id}/force-logout`, { token: SA });
  r = await api('GET', '/api/settings/app', { token: u2.token });
  check('강제 로그아웃: 기존 토큰 401', r.status === 401);
  r = await api('POST', '/api/auth/login', { body: { email: 'selftest2@example.com', password: 'user-pass-1234' } });
  check('다시 로그인하면 정상', r.status === 200 && (await api('GET', '/api/settings/app', { token: r.json.token })).status === 200);
  r = await api('DELETE', `/api/admin/users/${u2.id}`, { token: SA, body: { mode: 'soft' } });
  check('탈퇴 처리(soft)', r.status === 200);
  r = await api('POST', '/api/auth/login', { body: { email: 'selftest2@example.com', password: 'user-pass-1234' } });
  check('탈퇴 회원 로그인 불가', r.status === 401);
  r = await api('DELETE', `/api/admin/users/${u2.id}`, { token: SA, body: { mode: 'purge', confirm: 'wrong' } });
  check('완전 삭제는 이메일 확인 필요', r.status === 400);
  r = await api('DELETE', `/api/admin/users/${u2.id}`, { token: SA, body: { mode: 'purge', confirm: 'selftest2@example.com' } });
  check('완전 삭제 + 센서 등록 해제', r.status === 200 && r.json.deleted.devicesReleased === 1);
  r = await api('GET', '/api/admin/devices?sn=C21Z00102', { token: SA });
  check('삭제된 회원의 센서는 재고로 남음', r.json.items[0].owner === null && r.json.items[0].status === 'stock');

  console.log('[9] 공지·설정·기록');
  r = await api('POST', '/api/admin/notices', { token: SA, body: { title: '점검 안내', body: '내용', pinned: true } });
  check('공지 등록', r.status === 201);
  r = await api('GET', '/api/notices');
  check('앱용 공개 공지 목록', r.status === 200 && r.json.items.length === 1 && r.json.items[0].title === '점검 안내');
  r = await api('PUT', '/api/admin/settings', { token: SA, body: { eqValidityDays: 10 } });
  r = await api('GET', '/api/settings/eq-list/resolve?serial=C21Z00101', { token: u1.token });
  check('유효기간 설정 변경이 앱 응답에 반영', Math.abs(r.json.remainingMinutes - (10 * 1440 - 180)) <= 3, `got ${r.json?.remainingMinutes}`);
  r = await api('PUT', '/api/admin/settings', { token: VIEW, body: { eqValidityDays: 1 } });
  check('조회전용은 설정 변경 불가', r.status === 403);
  r = await api('GET', '/api/admin/audit-logs?limit=200', { token: SA });
  const actions = new Set(r.json.items.map((x) => x.action));
  check('감사 로그 기록', ['device.release', 'device.transfer', 'user.suspend', 'user.delete_purge', 'settings.update', 'devices.import', 'data.export'].every((a) => actions.has(a)), [...actions].join(','));
  check('감사 로그에 작업자 기록', r.json.items.every((x) => x.actorName === 'admin' || x.actorName === 'viewer1'));
  r = await api('GET', '/api/admin/login-logs?kind=admin&success=false', { token: SA });
  check('로그인 실패 기록', r.json.total >= 1);
  r = await api('GET', '/api/admin/stats', { token: SA });
  check('대시보드 통계', r.status === 200 && r.json.sensors && typeof r.json.sensors.active === 'number');
  r = await api('POST', '/api/admin/system/reset', { token: SA, body: { password: NEW_PW } });
  check('초기화는 확인 문구 필요', r.status === 400);

  console.log('[10] 로그인 시도 제한');
  let last = 0;
  for (let i = 0; i < 11; i += 1) last = (await api('POST', '/api/admin/login', { body: { username: 'viewer1', password: 'nope-nope-nope' } })).status;
  check('10회 실패 후 429', last === 429);
} catch (e) {
  failed.push(`exception: ${e?.message || e}`);
  console.error(e);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(failed.map((f) => ` - ${f}`).join('\n'));
  if (process.env.SELFTEST_LOG) console.log(log.slice(-4000));
  process.exit(1);
}

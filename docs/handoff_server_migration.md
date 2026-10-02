# EMPECS CGMS 서버 이전 핸드오프 — 2026-10-02

현재 운영 서버(`lunarserver`)에서 CGMS 를 새 서버로 옮기기 위한 인수인계 문서.
아래 내용은 2026-10-02 에 운영 서버를 직접 조회해 확인한 값이다. **이 저장소는 공개 저장소이므로 비밀값은 키 이름만 적는다.**

## 1. 한눈에 보기

| 도메인 | 용도 | 호스트 nginx | 컨테이너 | 포트(호스트) |
|---|---|---|---|---|
| `empecs.lunarsystem.co.kr` `/api/`, `/api/admin/ws/`, `/logintest*.html`, `/auth/callback` | 앱·어드민 API | `/etc/nginx/sites-enabled/empecs` | `empecs-cgms-be` (Node/Express) | 127.0.0.1:63101 → 58002 |
| `empecs.lunarsystem.co.kr` `/` | 관리자 콘솔 | 〃 | `empecs-cgms-admin-fe` (Next.js) | 127.0.0.1:63103 → 3000 |
| `empecsuser.lunarsystem.co.kr` | 앱 웹 빌드(QA, BLE 제외) | `/etc/nginx/sites-enabled/empecsuser` | `empecs-cgms-app-fe` (Flutter web + nginx) | 127.0.0.1:63104 → 80 |
| (외부 노출) | DB | — | `empecs-cgms-mongodb` (mongo 7.0.28) | **0.0.0.0:47011** → 27017 |

- 컨테이너 4개 모두 `cgms_be/docker-compose.yml` 하나로 관리한다(서비스: `mongo`, `be`, `fe`, `cgms-app-fe`).
- **모바일 앱과 어드민은 서버 IP 를 쓰지 않는다.** 앱 기본 API 는 `https://empecs.lunarsystem.co.kr`(`lib/core/utils/debug_config.dart`), 어드민은 같은 호스트의 `/api`. BE·FE 코드와 compose·.env 에도 서버 IP 리터럴은 없다(확인함).
  → **DNS A 레코드만 새 서버로 바꾸면 앱 재배포 없이 이전된다.**
- OAuth(Google·Kakao·Apple) 콜백도 도메인 기준(`BASE_URL`)이라 도메인이 같으면 각 콘솔 설정을 바꿀 필요가 없다.

## 2. 소스와 배치 경로

compose 가 `../cgms_admin_fe`, `../cgms_app_fe` 를 빌드하므로 **세 저장소를 같은 부모 폴더 아래 형제로** 둬야 한다.

| 경로(현 서버) | 저장소 | 브랜치 · 커밋(10-02) | 비고 |
|---|---|---|---|
| `/lunar/empecs/cgms/cgms_be` | `github.com/delphism84/empecs_cgms_be` (공개) | main · 이 문서 커밋 | compose·nginx 사본·문서 |
| `/lunar/empecs/cgms/cgms_admin_fe` | `github.com/delphism84/ln_admin_fe_ref` (공개) | main · `7074dcf` | 관리자 콘솔 |
| `/lunar/empecs/cgms/cgms_app_fe` | `github.com/delphism84/-empecs_cgms_fe_app` | **master** · `e09edc5`(2026-06-11) | 웹 QA 빌드용. 모바일 최신 작업은 `feature/req260716-sensor-expiry` 브랜치에 있고 master 에 병합되지 않았다 — 웹 QA 를 최신으로 하려면 병합 여부부터 정할 것 |

세 체크아웃 모두 10-02 기준 미커밋 변경 없음(git 과 서버가 일치).

이전 대상 아님:
- `/lunar/empecs` 자체가 `glucose_manager_web` 저장소의 작업 트리다(미커밋 186건). CGMS 런타임과 무관.
- `/lunar/empecs/cgms/cgms_be_qabot` — 빈 폴더.

## 3. 비밀값 (`cgms_be/.env`)

compose 는 비밀값을 이 파일에서만 읽고, 없으면 기동을 거부한다(`${VAR:?}`). **git 이 아니라 `scp` 로 옮기고 권한 600 유지.**

| 키 | 용도 |
|---|---|
| `JWT_SECRET` | 회원 토큰 서명(바꾸면 모든 회원이 재로그인해야 함 — **그대로 옮길 것**) |
| `ADMIN_JWT_SECRET` | (선택, 현재 없음) 관리자 토큰 서명 키. 없으면 `JWT_SECRET` 에서 파생 |
| `MONGO_ROOT_PASSWORD`, `MONGO_URI` | Mongo root 비밀번호와 BE 접속 문자열 |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | 관리자 계정이 **하나도 없을 때만** 최초 최고관리자 생성에 쓰임. DB 를 옮기면 기존 관리자 계정이 그대로 따라온다 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KAKAO_REST_API_KEY`, `APPLE_CLIENT_ID` | 소셜 로그인 |
| `HOST`, `PORT`, `BASE_URL` | BE 바인딩·OAuth 콜백 기준 주소 |

형식 예시는 `.env.example`.

## 4. 데이터

| 항목 | 위치(현 서버) | 크기 | 옮기는 법 |
|---|---|---|---|
| MongoDB `empecs_cgms` | bind mount `cgms_be/data/mongo` | 504 MB | `mongodump`/`mongorestore` 권장(아래 5-4) |
| BE 접근 로그 | `cgms_be/data/logs` | 76 KB | 필요 시 복사 |
| TLS 인증서 | `/etc/letsencrypt/live/empecs.lunarsystem.co.kr`, `.../empecsuser.lunarsystem.co.kr` | — | 새 서버에서 재발급 권장(5-6). 만료: empecs 2026-11-09, empecsuser 2026-11-16 |

관리자 계정·감사 로그·시스템 설정·센서 재고(SN)·로트·공지는 모두 이 DB 안에 있다.

## 5. 이전 절차

### 5-1. 새 서버 준비
- Docker + Docker Compose v2, nginx, certbot. 현 서버: Ubuntu 25.10 / Docker 28.2 / Compose 2.37.
- 방화벽: 80, 443 만 열면 된다(앱·어드민은 모두 nginx 경유).
- **주의: Docker 가 publish 한 포트는 ufw 를 우회한다.** 현 서버의 Mongo 47011 은 ufw 목록에 없지만 외부에서 열려 있다.

### 5-2. 소스 배치
```bash
mkdir -p /lunar/empecs/cgms && cd /lunar/empecs/cgms
git clone https://github.com/delphism84/empecs_cgms_be.git cgms_be
git clone https://github.com/delphism84/ln_admin_fe_ref.git cgms_admin_fe
git clone -b master git@github.com:delphism84/-empecs_cgms_fe_app.git cgms_app_fe
```

### 5-3. 비밀값
```bash
# 현 서버에서
scp /lunar/empecs/cgms/cgms_be/.env <새서버>:/lunar/empecs/cgms/cgms_be/.env
# 새 서버에서
chmod 600 /lunar/empecs/cgms/cgms_be/.env
```
**권장(이번 이전 때 같이)**: Mongo 는 새로 초기화되므로 `MONGO_ROOT_PASSWORD` 를 새 값으로 바꾸고 `MONGO_URI` 도 맞춘다(비밀번호는 URL 인코딩).
현재 값은 이 공개 저장소의 과거 커밋에 노출돼 있다. 그리고 외부 접속이 필요 없으면 compose 의 Mongo 포트를 `"127.0.0.1:47011:27017"` 로 바꾼다.

### 5-4. DB 이전 (쓰기 멈춤 → 덤프 → 복원)
```bash
# [현 서버] 쓰기 중지: 앱 업로드를 막기 위해 BE 를 내린다(앱은 측정값을 폰에 쌓아 두고 나중에 올린다)
cd /lunar/empecs/cgms/cgms_be && docker compose stop be
docker exec empecs-cgms-mongodb sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db empecs_cgms --archive --gzip' > /root/empecs_cgms_migrate.archive.gz
scp /root/empecs_cgms_migrate.archive.gz <새서버>:/root/

# [새 서버] Mongo 만 먼저 띄워 복원
cd /lunar/empecs/cgms/cgms_be && docker compose up -d mongo
docker exec -i empecs-cgms-mongodb sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --gzip --archive' < /root/empecs_cgms_migrate.archive.gz
```
`mongo` 서비스의 root 계정은 **빈 `data/mongo` 로 처음 기동할 때만** `.env` 값으로 만들어진다. 비밀번호를 바꾸려면 빈 폴더 상태에서 첫 기동해야 한다.

### 5-5. 빌드·기동
```bash
cd /lunar/empecs/cgms/cgms_be
docker compose build be fe cgms-app-fe     # app-fe 는 Flutter 이미지로 웹 빌드라 수 분 걸린다
docker compose up -d be fe cgms-app-fe
docker ps --filter name=empecs-cgms         # 바로 확인할 것: 4개 모두 Up 이어야 한다
docker logs empecs-cgms-be | grep -E '^\[(mongo|startup|admin|server)\]'
curl -s http://127.0.0.1:63101/api/health  # {"ok":true}
```
기동 로그의 `[startup] device registry synced` 는 센서 재고 동기화, `[admin] initial superadmin` 은 관리자 계정이 없을 때만 나온다(DB 를 옮겼으면 나오지 않아야 정상).

### 5-6. nginx · TLS
- 설정은 이 저장소 `nginx/` 에 있다. 운영 파일(`sites-enabled/empecs`, `sites-enabled/empecsuser`)과 **주석만 다르고 동작은 같다**(10-02 diff 확인).
  `empecs` 는 웹소켓 경로 `/api/admin/ws/`(종료 예정 기기 실시간)를 반드시 포함해야 한다.
- 순서: 인증서 없이 80 만 열린 설정으로 nginx 기동 → DNS 전환 → `certbot certonly --webroot -w /var/www/html -d empecs.lunarsystem.co.kr` (empecsuser 도 동일, `nginx/empecsuser.lunarsystem.co.kr.http-only.conf` 참고) → 443 설정 활성화.
  DNS 전환 전에 인증서가 필요하면 현 서버의 `/etc/letsencrypt` 를 통째로 옮겨도 된다.

### 5-7. DNS 전환
- `empecs`, `empecsuser` 두 레코드. 전환 하루 전에 TTL 을 짧게(예: 300초) 낮춰 두면 되돌리기도 빠르다.
- 전환 직후 한동안 두 서버로 요청이 나뉠 수 있다. 현 서버 BE 를 5-4 에서 이미 내렸으므로 현 서버로 간 앱 업로드는 실패하고, 앱이 폰에 보관했다가 새 서버로 다시 올린다(앱의 업로드 큐·재시도 동작).

### 5-8. 검증 체크리스트
- [ ] `https://empecs.lunarsystem.co.kr/api/health` → `{"ok":true}`
- [ ] 어드민 `/login` → 기존 관리자 계정으로 로그인, 대시보드 수치가 이전 서버와 같다
- [ ] [기기 관리 > 종료 예정] 상단에 "실시간" 표시(웹소켓 경로 확인)
- [ ] 앱(260929a 이상)으로 로그인 → 혈당 업로드 → 어드민 [데이터 관리]에 새 행이 보인다
- [ ] 소셜 로그인 1건(콜백 도메인 확인)
- [ ] `https://empecsuser.lunarsystem.co.kr` 웹 QA 화면 표시
- [ ] 외부에서 Mongo 포트 접속 불가(127.0.0.1 바인딩으로 바꿨다면)
- [ ] 로컬 점검(새 서버에서 node 만 있으면 됨): `cd cgms_be && npm ci && npm run test:admin` → 70 passed

### 5-9. 되돌리기
DNS 를 현 서버로 되돌리고 현 서버에서 `docker compose start be`. 이전 중 새 서버에 쌓인 데이터가 있으면 그 구간만 덤프해 현 서버에 복원한다.

## 6. 운영 메모 (이전 후에도 유효)

- **배포**: `git pull` → `docker compose build be fe` → `docker compose up -d be fe` → **즉시 `docker ps` 확인**. 2026-09-30 배포 때 컨테이너 이름 충돌로 `up` 이 중단돼 BE 가 1분간 내려갔다(자세한 기록: `docs/task_260930_admin_console.md`).
- **401 반복 금지**: 만료 토큰 요청이 몰리면 서버 보안 서비스(CrowdSec)가 요청 IP 를 통째로 차단한 적이 있다(2026-09-29, 사무실 IP 4시간). 새 서버에 CrowdSec·fail2ban 을 둔다면 사무실 IP 화이트리스트를 검토할 것. 앱 260929a 부터는 401 을 받으면 같은 토큰으로 다시 요청하지 않는다.
- **운영 중 확인은 컨테이너 안에서**: `docker exec -i -w /app empecs-cgms-be node --input-type=module` 로 127.0.0.1:58002 에 요청하면 nginx·보안 서비스를 거치지 않는다.
- **관리자 계정**: DB 계정(역할 4종). 2026-09-30 첫 로그인·비밀번호 변경 완료. 비밀번호를 잊으면 다른 최고관리자가 [시스템 > 관리자 계정]에서 재설정한다(재설정된 계정은 첫 로그인 때 변경 강제).
- **센서 유효기간·SN 정책·QR 형식**은 코드가 아니라 DB 설정이다([시스템 > 설정]) — DB 와 함께 이전된다.
- 로컬 개발: `npm run dev:memory`(메모리 DB + 시드 데이터), `npm run test:admin`. 어드민 FE 는 `API_PROXY_TARGET` 으로 로컬 BE 에 붙인다.

## 7. 현 서버 정리 대상 (이전 완료 후)

- 컨테이너 4개와 `cgms_be/data/mongo`(덤프 보관 후 삭제)
- 롤백용 이미지 `cgms_be-be:pre260930`, 백업 폴더 `/root/backup/cgms_260930`, `/root/backup/cgms_be_260929`
- nginx `sites-enabled/empecs`, `sites-enabled/empecsuser`, 인증서(`certbot delete --cert-name …`)
- Mongo 47011 외부 노출(이전 전이라도 닫는 것을 권장)

## 8. 열린 이슈

| 항목 | 상태 |
|---|---|
| Mongo root 비밀번호가 공개 저장소 과거 커밋에 노출 + 47011 외부 개방 | 미조치 — 이전 때 교체·닫기 권장(5-3) |
| 미등록 SN 정책 | "표시만". 출고분을 재고로 모두 등록한 뒤 "차단"으로 전환 |
| SN 형식·연도 코드(Z=2025) | 앱 QR 파서 기준. 제조사 규격 확인 필요 |
| 모바일 앱 최신 작업 | `feature/req260716-sensor-expiry`(APK 260929a) — master 미병합, 웹 QA(`empecsuser`)는 master 빌드 |
| QR 라벨 인쇄 레이아웃 | 실제 인쇄 미리보기로 확인 안 함 |

관련 문서: `docs/admin_api.md`(관리자 API), `docs/api.md`(앱 API), `docs/task_260929_token_refresh.md`, `docs/task_260930_admin_console.md`(배포·롤백 기록).

# 서버 작업: 로그인 자동 연장(슬라이딩 세션) — 2026-09-29

## 배경

- **고객 요구**: 한 번 로그인하면 로그인이 풀리지 않기를 원함.
  현재 사용자 JWT 는 **7일 고정**이고 갱신 수단이 없어, 7일 뒤 앱의 모든 업로드가 401 이 되고 데이터가 서버에 올라가지 않았다.
- **사고(2026-09-29 11:36 KST)**: 만료 토큰으로 앱이 `settings/eq-list` → `settings/app` → `auth/login` → `data/glucose` 를
  계속 재시도했고, CrowdSec 이 "39초에 401 8회"를 무차별 대입으로 판단해 사무실 공인 IP 를 4시간 차단했다(웹·SSH·ping 전부).
  앱 쪽은 이미 수정됨: 401 을 받은 토큰으로는 더 이상 요청하지 않고 재로그인을 안내, 업로드 재시도는 30초→최대 5분 백오프.

## 이번 커밋이 바꾸는 것

| 파일 | 내용 |
|---|---|
| `src/config.js` | `jwtExpiresIn` 추가 — `JWT_EXPIRES_IN` 환경변수(없으면 `config.json` 의 `JwtExpiresIn`, 기본 `30d`) |
| `src/routes/auth.js` | `sign()` 이 `config.jwtExpiresIn` 사용. `POST /api/auth/refresh` 추가 |
| `docs/api.md` | 리비전 `2026-09-29`, 엔드포인트·만료 설명·변경 이력 |

`POST /api/auth/refresh`: `Authorization: Bearer <만료 전 토큰>` → `200 { ok, token, expiresAt }`.
만료·위조·관리자 토큰 → `401 invalid_token`, 삭제된 계정 → `401 user_not_found`, 헤더 없음 → `401 no_token`.

로컬 검증(express + User 스텁, 2026-09-29):

```
valid 7d token  200 ok -> new token sub_ok=true ttl=30d
no token        401 no_token
expired token   401 invalid_token
forged secret   401 invalid_token
deleted user    401 user_not_found
admin token     401 invalid_token
```

**앱 연동 계약**: 앱은 토큰 발급(iat) 후 24시간이 지나면 refresh 를 호출해 교체한다. 엔드포인트가 아직 없으면(404) 24시간 뒤 다시 시도하므로
**서버 배포 순서와 무관**하게 앱을 먼저 배포해도 된다. 기존 7일 토큰도 만료 전이면 refresh 로 30일 토큰이 된다(이미 만료된 토큰은 1회 재로그인 필요).

## ⚠ 배포 전 확인 — 운영 컨테이너가 git HEAD 와 다르다

2026-09-29 확인(`/lunar/empecs/cgms/cgms_be`, 컨테이너 `empecs-cgms-be`, 이미지 생성 2026-05-03):

1. **`src/routes/auth.js`·`data.js`·`settings.js` 는 운영이 HEAD(`f62657f`, 2026-06-11)보다 이전 버전이다.**
   HEAD 에는 커밋만 되고 **배포되지 않은** 변경이 있다. 예:
   - `POST /api/settings/eq-list`: 운영은 `startAt` 을 **최초 생성 시에만** 기록(`$setOnInsert`), HEAD 는 **매번 갱신**
     + 다른 계정 소유 serial 이면 `403 forbidden`. (`api.md` 2026-05-04 리비전은 HEAD 동작을 설명 — 문서와 운영이 불일치)
   - `GET /api/data/glucose`: HEAD 는 try/catch·날짜 검증·`limit` 클램프 추가
   - `GET /api/settings/app`: HEAD 는 lean 조회(온라인 프로브 경량화)
   - 401/400/404 응답에 `message` 필드 추가
2. **`src/index.js`·`src/routes/admin.js`·`package.json`·`src/services/`·`src/ws/` 는 서버에서 직접 수정된 미커밋 상태(2026-07-30)이며 운영에 반영돼 있다.**
   이번 커밋은 이 파일들을 건드리지 않으므로 `git pull` 은 충돌 없이 fast-forward 된다.

따라서 **"pull → 이미지 재빌드"는 이번 변경 + 위 1번의 미배포 변경을 함께 운영에 올린다.** 아래 둘 중 하나를 선택.

### 옵션 1 — 이번 변경만 적용(최소 변경)

운영 `config.js` 는 HEAD 와 동일하고, 운영 `auth.js` 와 HEAD 의 차이는 `email_exists` 응답에 `message` 추가 1건뿐이다.
두 파일만 컨테이너에 넣고 재시작한다.

```bash
cd /lunar/empecs/cgms/cgms_be
git pull --ff-only
mkdir -p /root/backup/cgms_be_260929
docker cp empecs-cgms-be:/app/src/routes/auth.js /root/backup/cgms_be_260929/auth.js
docker cp empecs-cgms-be:/app/src/config.js      /root/backup/cgms_be_260929/config.js
docker cp src/routes/auth.js empecs-cgms-be:/app/src/routes/auth.js
docker cp src/config.js      empecs-cgms-be:/app/src/config.js
docker restart empecs-cgms-be
```

- `docker cp` 변경은 다음 이미지 재빌드 때 git 내용으로 대체된다(이번 커밋이 git 에 있으므로 유지됨).
- 롤백: 백업 두 파일을 같은 방식으로 되돌리고 `docker restart empecs-cgms-be`.

### 옵션 2 — HEAD 전체 배포

```bash
cd /lunar/empecs/cgms/cgms_be
git pull --ff-only
docker compose build be && docker compose up -d be
```

- 위 1번의 미배포 변경(특히 `eq-list` 동작 변경)이 함께 운영에 올라간다. 앱(cgms_app)은 `eq-list` 매번 갱신 동작을 전제로 한 코드가 있어
  문서상으로는 HEAD 쪽이 맞지만, 운영에서 한 번도 돌려본 적 없는 코드이므로 배포 후 센서 등록·혈당 조회를 확인할 것.
- 롤백: `git checkout f62657f -- src/routes/auth.js src/config.js docs/api.md` 후 재빌드(또는 직전 이미지로 재기동).

## 배포 후 확인

```bash
curl -s https://empecs.lunarsystem.co.kr/api/health                                  # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://empecs.lunarsystem.co.kr/api/auth/refresh   # 401 (엔드포인트 존재)
```

- 정상 경로: QA 계정으로 로그인해 받은 토큰으로 refresh → `200`, 새 토큰의 `exp - iat` 가 30일인지 확인.
- **401 을 연달아 만들지 말 것** — CrowdSec 이 39초에 401 8회를 넘으면 요청 IP 를 차단한다.

## 권장(선택)

- CrowdSec: 사무실 공인 IP 를 화이트리스트에 넣거나, `/api/data`·`/api/settings` 의 401 을 로그인 무차별 대입 시나리오에서 제외.
  앱은 이제 401 반복을 하지 않지만, 한 IP 를 여러 기기가 공유하는 환경에서는 여전히 오탐 가능성이 있다.
- 장기 세션 보강: 비밀번호 변경·관리자 강제 변경 시 기존 토큰을 무효화하려면 `User.tokenVersion` 을 두고 JWT 에 `tv` 를 넣어
  인증 미들웨어(현재 `data.js`·`settings.js`·`auth.js /me` 에 복사된 3곳)와 refresh 에서 비교. 이번 커밋에는 포함하지 않았다.
- 서버의 미커밋 로컬 수정(2번)은 커밋해 두어야 다음 배포 때 git 기준으로 재현 가능하다.

## 배포 기록 (2026-09-29, 완료)

1. **04:00 UTC — 옵션 1 적용**: `auth.js`·`config.js` 를 컨테이너에 반영 후 재시작. 운영 컨테이너 안에서 QA 계정으로
   refresh `200`(새 토큰 30일)·토큰 없음 `401`·만료 토큰 `401` 확인. 기존 파일 백업: `/root/backup/cgms_be_260929/`.
2. **04:07 UTC — 옵션 2(전체 재빌드)로 전환**(개발 서버라 재빌드 허용). 운영이 이제 **HEAD + 서버 로컬 수정**과 일치한다.
   - 재빌드가 안 되던 원인: `package-lock.json` 이 `package.json` 과 불일치(`gcp-metadata` 누락 + 서버에서 추가한 `ws`).
     2026-05-03 이후 이미지를 다시 만들 수 없어 파일을 `docker cp` 로 넣어 온 것으로 보인다.
     `node:20-alpine` 에서 `npm install --package-lock-only` 로 lock 만 재생성(주요 버전은 운영 설치본과 동일:
     ws 8.21.1 · jsonwebtoken 9.0.3 · mongoose 8.23.0 · express 4.22.1). 이전 lock 백업: `/root/backup/cgms_be_260929/package-lock.json`.
   - 재빌드 후 컨테이너 `src` == 서버 작업트리 확인. 컨테이너 안 점검(QA 계정): `auth/me`·`settings/app`·`data/glucose`·
     `settings/alarms` `200`, `POST eq-list` 2회 시 `startAt` 갱신됨(HEAD 동작), `resolve` `200`, `refresh` `200`(30일),
     관리자 `stats` `200`. 점검용 serial 은 삭제.
3. **롤백**: 이전 이미지를 `cgms_be-be:pre260929` 로 태그해 둠.

```bash
cd /lunar/empecs/cgms/cgms_be
docker tag cgms_be-be:pre260929 cgms_be-be:latest && docker compose up -d --no-build be
```

**남은 일(서버 소유자)**: 서버의 미커밋 수정(`src/index.js`·`src/routes/admin.js`·`src/services/`·`src/ws/`·`package.json`(ws)·
재생성한 `package-lock.json`·nginx 설정)을 커밋해야 다음 배포를 git 으로 재현할 수 있다. 다른 사람의 작업이라 이번에 커밋하지 않았다.

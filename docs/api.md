# EMPECS CGMS Backend — HTTP API (FE 연동용)

> 이 문서는 EMPECS CGMS 백엔드(`empecs/cgms/cgms_be`) Express API를 프론트엔드에서 호출할 때의 계약을 정리합니다.  
> 라우트·응답 형식이 바뀔 때마다 아래 **문서 리비전**을 올리고 변경 요약을 적어 주세요.

| 항목 | 값 |
|------|-----|
| 문서 리비전 | `2026-05-11` |
| 공개 URL (프로덕션) | 통합 명세: `/api/docs` · `/api/docs/api.md` — FE 협의 메모: `/api/docs/api_rev_260504.md` — EQ 상세: `/api/docs/api_rev_260417a.md` (호스트 `https://empecs.lunarsystem.co.kr` 또는 동일 스택의 `/api` 프록시) |
| 구현 기준 | `src/index.js`, `src/routes/*.js`, `src/lib/eqNormalize.js` |
| FE 협의 메모 | [api_rev_260504.md](./api_rev_260504.md) (혈당·EQ·인증 UX·에러 본문) |
| FE 요청 원문 (EQ) | [api_rev_260417a.md](./api_rev_260417a.md) (`resolve` + `bleMac`) |
| 소셜 로그인 설정 | [social_login_setup_guide.md](./social_login_setup_guide.md) |

FE에서는 위 URL로 `fetch` 하거나 링크하면 됩니다. 응답 `Content-Type`은 `text/markdown; charset=utf-8` 입니다.

---

## 공통

### Base URL

- 배포 환경: 서버의 `BASE_URL` / `config.json`의 `OAuth.BaseUrl` 등과 동일한 호스트에서 `/api/...` 로 제공됩니다. (로컬은 `config.js` 기본 포트 `58002` 등 환경에 따름)
- 모든 API 경로는 아래처럼 **`/api` 접두사**를 사용합니다.

### 요청

- **Content-Type**: `application/json` (본문이 있는 `POST` / `PUT` / `PATCH`)
- **인증이 필요한 엔드포인트**: 헤더에 JWT 전달

```http
Authorization: Bearer <access_token>
```

- JWT 페이로드: `{ sub: <mongo User _id 문자열>, email }`, 만료 **7일** (`src/routes/auth.js`의 `sign()`).

### 응답 형식

- 대부분 **JSON**. 성공 시 라우트별 객체 또는 배열.
- 인증 실패 시 흔한 형태:

```json
{ "error": "no_token" }
```

```json
{ "error": "invalid_token" }
```

가능한 `error` 문자열 예: `no_token`, `invalid_token`, `user_not_found`, `not_found`, `invalid_email`, `invalid_credentials`, `oauth_not_configured`, … (각 엔드포인트 설명 참고)

### CORS

- 서버에서 `cors()` 전역 적용 (`src/index.js`).

---

## 엔드포인트 목록

| Method | Path | 인증 |
|--------|------|------|
| GET | `/api/health` | 불필요 |
| GET | `/api/docs` | 불필요 (본 문서 Markdown) |
| GET | `/api/docs/api.md` | 불필요 (동일 본문) |
| GET | `/api/docs/api_rev_260417a.md` | 불필요 (EQ resolve FE 요청 원문) |
| GET | `/api/docs/api_rev_260504.md` | 불필요 (FE 협의 메모: 혈당·EQ·인증) |
| POST | `/api/auth/register` | 불필요 |
| POST | `/api/auth/login` | 불필요 |
| GET | `/api/auth/google/callback` | 불필요 (브라우저 리다이렉트) |
| GET | `/api/auth/kakao/callback` | 불필요 (브라우저 리다이렉트) |
| POST | `/api/auth/social/verify` | 불필요 |
| GET | `/api/auth/me` | Bearer |
| GET | `/api/data/glucose` | Bearer |
| POST | `/api/data/glucose` | Bearer |
| POST | `/api/data/glucose/batch` | Bearer |
| POST | `/api/data/events/batch` | Bearer |
| DELETE | `/api/data/glucose/clear` | Bearer (개발용) |
| POST | `/api/data/glucose/seed-day` | Bearer (개발용) |
| POST | `/api/data/glucose/seed-days` | Bearer (개발용) |
| GET | `/api/data/events` | Bearer |
| POST | `/api/data/events` | Bearer |
| DELETE | `/api/data/events/clear` | Bearer (개발용) |
| DELETE | `/api/data/events/:id` | Bearer |
| GET | `/api/settings/sensors` | Bearer |
| POST | `/api/settings/sensors` | Bearer |
| PUT | `/api/settings/sensors/:id` | Bearer |
| DELETE | `/api/settings/sensors/:id` | Bearer |
| GET | `/api/settings/alarms` | Bearer |
| POST | `/api/settings/alarms` | Bearer |
| PUT | `/api/settings/alarms/:id` | Bearer |
| DELETE | `/api/settings/alarms/:id` | Bearer |
| GET | `/api/settings/app` | Bearer |
| PUT | `/api/settings/app` | Bearer |
| GET | `/api/settings/eq-list/resolve` | Bearer |
| GET | `/api/settings/eq-list/:serial` | Bearer |
| POST | `/api/settings/eq-list` | Bearer |
| POST | `/api/admin/login` | 불필요 (관리자 패널) |
| GET | `/api/admin/stats` | 관리자 JWT |
| GET | `/api/admin/users` | 관리자 JWT |
| GET | `/api/admin/users/:id` | 관리자 JWT |
| PATCH | `/api/admin/users/:id` | 관리자 JWT |
| POST | `/api/admin/users/:id/password` | 관리자 JWT |
| GET | `/api/admin/devices` | 관리자 JWT |
| GET | `/api/admin/data` | 관리자 JWT |

---

## 관리자 API (`/api/admin`)

> 웹 관리자(EMPECS CGMS Admin FE) 전용. JWT 페이로드에 `role: "admin"` 이 포함되며, 일반 사용자 JWT와 구분됩니다.  
> 기본 계정은 `config.json`의 `Admin` 또는 환경변수 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 로 설정합니다 (기본값 `admin` / `Empecs!@34`).

### `POST /api/admin/login`

**Body**: `{ "username": "admin", "password": "..." }`

**응답 200**: `{ "token": "<jwt>" }`

**401**: `{ "error": "invalid_credentials" }`

### `GET /api/admin/stats`

**Headers**: `Authorization: Bearer <admin jwt>`

**응답 200**: 총 회원·등록 기기(EQ)·혈당 포인트 수, 최근 14일 일별 신규 회원·혈당 건수, 사용자당 기기 대수 분포(파이용).

### `GET /api/admin/users` · `GET /api/admin/devices` · `GET /api/admin/data`

공통 **Query**: `user`(이메일·이름 부분 일치), `sn`(시리얼 / EQ S/N), `mac`(BLE MAC, 콜론 유무 무관), `from`·`to`(ISO 날짜 `YYYY-MM-DD`, 각각 생성일 또는 측정 시각 구간), `page`, `limit`(최대 200).

**`GET /api/admin/data`** 에만 **`userId`**(Mongo ObjectId 문자열): 지정 시 해당 사용자만 조회(`user` 텍스트 검색과 동시 사용하지 않음). 관리자 화면에서 특정 회원의 혈당만 볼 때 사용.

### `GET /api/admin/users/:id`

**응답 200**: 회원 한 명의 편집 가능 필드(비밀번호 해시 제외). `hasPassword`, `provider`, `providerId`, `createdAt`, `updatedAt` 포함.

### `PATCH /api/admin/users/:id`

**Body**(일부만 보내도 됨): `email`, `firstName`, `lastName`, `name`, `dateOfBirth`, `gender`, `unit`(`mg/dL`|`mmol`), `countryCode`, `language`, `provider`(null 또는 `google`|`kakao`|`apple`), `providerId`.  
`email` 변경 시 다른 사용자와 중복이면 **409** `{ "error": "email_taken" }`.

### `POST /api/admin/users/:id/password`

관리자가 **기존 비밀번호 없이** 새 비밀번호를 설정합니다.

**Body**: `{ "password": "<8자 이상>" }`  
**400**: `{ "error": "password_min_8" }` 등.

---

## 1. 시스템

### `GET /api/docs` · `GET /api/docs/api.md`

프론트엔드·툴에서 참조하는 **API 문서 원본**(이 파일). 인증 없음.

**응답 200**: `Content-Type: text/markdown; charset=utf-8`, 본 저장소 `docs/api.md`와 동일 본문.

**`GET /api/docs/api_rev_260417a.md`**: EQ `resolve` / `bleMac` FE 요청 원문 Markdown.

**`GET /api/docs/api_rev_260504.md`**: 앱(FE) 기준 협의 메모(혈당 GET 에러 본문, EQ 업서트 멱등, register 409 등).

**응답 404**: 배포 이미지에 해당 파일이 없을 때 `text/plain` 메시지.

---

### `GET /api/health`

서버 생존 확인.

**응답 200**

```json
{ "ok": true }
```

---

## 2. 인증 (`/api/auth`)

### 사용자 ID 표기

- API 응답의 사용자 id는 `usr_<Mongo ObjectId>` 형태로 내려가는 경우가 있습니다 (`toUserId()`).

---

### `POST /api/auth/register`

이메일·비밀번호 회원가입.

**Body (JSON)**

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `email` | string | ✓ | 이메일 형식 |
| `password` | string | ✓ | 최소 8자 |
| `firstName` | string | ✓ | |
| `lastName` | string | ✓ | |
| `dateOfBirth` | string | ✓ | `YYYY-MM-DD` |
| `gender` | string | | `"male"` \| `"female"` (그 외는 저장 시 생략 처리) |
| `unit` | string | | `"mmol"`이면 `mmol`, 아니면 `mg/dL` |
| `countryCode` | string | | |
| `language` | string | | |
| `agreeTerms` | boolean | ✓ | 반드시 `true` |

**응답 201**

```json
{
  "ok": true,
  "token": "<jwt>",
  "user": {
    "id": "usr_...",
    "email": "...",
    "firstName": "...",
    "lastName": "..."
  }
}
```

**오류**

- `400` `invalid_email`, `password_too_short`
- `422` `validation_failed` + `fields: string[]`
- `409` `email_exists` + `message` (예: `"This email is already registered"`, [api_rev_260504.md](./api_rev_260504.md))
- `500` `internal_error`

---

### `POST /api/auth/login`

**Body**

| 필드 | 타입 | 필수 |
|------|------|------|
| `email` | string | ✓ |
| `password` | string | ✓ |

**응답 200**

```json
{ "token": "<jwt>" }
```

> 참고: 성공 시 **`ok` 필드는 없음**. FE는 `token` 존재 여부로 처리.

첫 로그인 시 최근 7일 구간에 혈당 포인트가 부족하면 **목(mock) 혈당·이벤트 데이터가 자동 생성**될 수 있습니다.

**오류**

- `401` `invalid_credentials`
- `500` `internal_error`

---

### `GET /api/auth/google/callback`

Google OAuth **authorization code** 콜백. 서버가 설정된 `BASE_URL` 기준으로 리다이렉트 URI를 잡습니다.

**Query**

- `code`: OAuth 코드 (없으면 에러 리다이렉트)

**동작**

- 성공: `302` → `{BASE_URL}/auth/callback#token=<jwt>`
- 실패: `302` → `{BASE_URL}/login?error=<message>`  
  예: `oauth_not_configured`, `missing_code`, `google_auth_failed`, …

---

### `GET /api/auth/kakao/callback`

Kakao OAuth 코드 콜백. 리다이렉트 규칙은 Google과 동일 (`/auth/callback#token=` 또는 `/login?error=`).

---

### `POST /api/auth/social/verify`

네이티브/클라이언트 측에서 받은 토큰으로 로그인(회원 자동 생성 포함).

**Body**

| 필드 | 타입 | 조건 |
|------|------|------|
| `provider` | string | 필수. `"google"` \| `"kakao"` \| `"apple"` |
| `idToken` | string | `google` 또는 `apple`일 때 사용 |
| `accessToken` | string | `kakao`일 때 사용 |
| `name` | string | `apple` 등에서 이름이 토큰에 없을 때 보조로 전달 가능 |

**응답 200**

```json
{ "ok": true, "token": "<jwt>" }
```

**오류**

- `400` `provider_required`, `invalid_provider_or_token`
- `401` `invalid_token` (카카오 사용자 조회 실패 등)
- `503` `oauth_not_configured`
- `500` `internal_error`

---

### `GET /api/auth/me`

현재 Bearer 토큰의 사용자 문서 조회. `passwordHash`, `passwordOrg`는 제외.

**응답 200**

```json
{
  "ok": true,
  "user": {
    "id": "usr_...",
    "_id": "...",
    "email": "...",
    "firstName": "...",
    "lastName": "...",
    "dateOfBirth": "...",
    "gender": "...",
    "unit": "mg/dL",
    "provider": null,
    "providerId": "...",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

(Mongoose `lean()` + spread이므로 필드는 스키마와 DB 상태에 따름.)

**오류**

- `401` `no_token` | `invalid_token` | `user_not_found`

---

## 3. 데이터 (`/api/data`)

공통 쿼리/필터:

- `eqsn` (optional): 기기 시리얼, 서버에서 **대문자 정규화**되어 필터에 사용.

---

### `GET /api/data/glucose`

**Query**

| 파라미터 | 설명 |
|----------|------|
| `from`, `to` | ISO 날짜 문자열 → `time` 범위 (`$gte` / `$lte`). `fromTrid` 미사용 시 적용. |
| `fromTrid` | 설정 시 `trid > fromTrid` 조건으로 조회, 정렬 `trid` 오름차순. |
| `limit` | 기본 `2000`, 서버에서 **1~20000** 으로 클램프 |
| `compact` | `1` 또는 `true` 이면 압축 배열 응답 |
| `eqsn` | 해당 시리얼만 |

**응답 200 (기본)**

`GlucosePoint` 문서 배열. 주요 필드:

| 필드 | 타입 |
|------|------|
| `_id` | ObjectId |
| `userId` | ObjectId |
| `eqsn` | string? |
| `time` | ISO 날짜 |
| `value` | number |
| `trid` | number? |
| `createdAt` / `updatedAt` | ISO 날짜 |

**응답 200 (`compact=true`)**

```json
{
  "t": [1713312000000, ...],
  "v": [120, ...],
  "tr": [1, ...]
}
```

- `t`: 시각(ms), `v`: 값, `tr`: 트랜잭션 id (없으면 `null`)

**오류 (비-200)**

| 상태 | 본문 예시 | 설명 |
|------|-----------|------|
| **400** | `{ "error": "invalid_query", "message": "Invalid from date" }` | `from` / `to` 가 파싱 불가능한 값 |
| **401** | `{ "error": "no_token" \| "invalid_token", "message": "…" }` | Bearer 없음·JWT 무효/만료 |
| **500** | `{ "error": "internal_error", "message": "Failed to load glucose data" }` | DB 등 서버 예외 (로그에 상세) |

기간 내 데이터가 없으면 **200** + 빈 배열(또는 `compact` 시 빈 `t`/`v`/`tr`) — [api_rev_260504.md](./api_rev_260504.md) 와 동일.

---

### `POST /api/data/glucose`

단건 저장.

**Body**

| 필드 | 타입 |
|------|------|
| `time` | 날짜로 파싱 가능한 값 |
| `value` | number |
| `trid` | number (optional) |
| `eqsn` | string (optional) |

**응답 200**: 생성된 문서 JSON.

---

### `POST /api/data/glucose/batch`

대량 반영(업서트). 앱 오프라인 복귀 시 연속 호출·재전송에 대비해 **멱등**하게 동작합니다.

- **한 요청 최대 500포인트**. 초과 시 **400** `{ "ok": false, "error": "batch_too_large", "message": "...", "count": N }`
- **키 규칙**: 행에 `trid`(숫자)가 있으면 `(userId, trid)` 기준으로 업서트. 없으면 `(userId, time, eqsn)` 기준(`eqsn` 없음은 저장 시 필드 생략·필터는 null 규칙으로 매칭).

**Body — 방식 A**: `records` 배열

```json
{
  "eqsn": "ABC123",
  "records": [
    { "time": "2025-01-01T00:00:00.000Z", "value": 100, "trid": 1, "eqsn": "ABC123" }
  ]
}
```

**Body — 방식 B**: 컴팩트 배열

```json
{
  "eqsn": "ABC123",
  "t": [1713312000000],
  "v": [100],
  "tr": [1]
}
```

- `tr` 생략 시 해당 인덱스는 `trid` 없이 저장(업서트 키는 `time`+`eqsn`).

**응답 200**

```json
{ "ok": true, "count": <요청 행 수>, "upserted": <n>, "modified": <n>, "matched": <n> }
```

- 레코드가 비어 있으면 **400** `{ "ok": false, "error": "empty", "message": "..." }`
- `time`/`value`가 잘못된 행이 있으면 **400** `{ "ok": false, "error": "invalid_rows", "details": [...] }`
- 서버 오류 시 **500** `{ "ok": false, "error": "batch_failed", "message": "..." }`

**관측**: 동기화 구간에서 서버 콘솔에 `[sync] POST /data/glucose/batch userId=... durationMs=... { rows, upserted, modified, matched }` 로그가 남습니다.

---

### `DELETE /api/data/glucose/clear`

현재 사용자의 모든 혈당 포인트 삭제 (**개발/디버그용**).

**응답 200** `{ "ok": true }`

---

### `POST /api/data/glucose/seed-day`

현재 시각 기준 **1일치** 1분 간격 목 데이터 생성 (**개발용**).

**응답 200** `{ "ok": true, "count": 1440 }` (근사)

---

### `POST /api/data/glucose/seed-days`

**Body**

| 필드 | 기본 | 설명 |
|------|------|------|
| `days` | 3 | 1~14로 클램프 |

**응답 200** `{ "ok": true, "count": <number>, "days": <number> }`

---

### `GET /api/data/events`

**Query**

| 파라미터 | 설명 |
|----------|------|
| `from`, `to` | `time` 범위 |
| `limit` | 기본 `1000` |
| `compact` | `1` \| `true` |
| `eqsn` | 시리얼 필터 |

**응답 200 (기본)**: `Event` 문서 배열.

`type` enum: `bloodGlucose` | `exercise` | `insulin` | `memo` | `meal` | `medication`

**응답 200 (`compact=true`)**

```json
{
  "t": [1713312000000],
  "ty": ["meal"],
  "m": ["Breakfast"],
  "id": ["..."]
}
```

---

### `POST /api/data/events`

**Body**

| 필드 | 타입 |
|------|------|
| `type` | string (enum 위와 동일) |
| `time` | 날짜 |
| `memo` | string (optional) |
| `eqsn` | string (optional) |

**응답 200**: 생성 문서. **400** `{ "error": "invalid_event", "message": "..." }`

---

### `POST /api/data/events/batch`

오프라인 적재 후 온라인 복귀 시 **HTTP 왕복을 줄이기 위한 배치 업로드**. 기존 단건 `POST /api/data/events`와 동일 필드·enum을 배열로 보냅니다.

**Body**

```json
{
  "events": [
    { "type": "meal", "time": "2026-01-01T12:00:00.000Z", "memo": "...", "eqsn": "ABC123" }
  ]
}
```

- `events` 대신 **`items`** 키도 동일 형식으로 허용.
- **한 요청 최대 200건**. 초과 시 **400** `{ "ok": false, "error": "batch_too_large", ... }`
- 요청 전체에 대해 **type·time 사전 검증** 후 삽입합니다. 하나라도 잘못되면 **400** `{ "ok": false, "error": "invalid_events", "details": [{ "index", "error" }, ...] }` (전부 거절).
- 스키마 검증 실패 시 **400** `{ "ok": false, "error": "invalid_event", "message": "..." }`

**응답 200**: `{ "ok": true, "count": <삽입 건수>, "items": [ ...문서 ] }`

**정책**: 배치는 **단건 연속 POST와 동일하게 전부 성공 시에만 200**으로 보는 편이 클라이언트 재시도 모델과 맞습니다. 위 검증·삽입 단계에서 실패하면 모두 400입니다.

**관측**: `[sync] POST /data/events/batch userId=... durationMs=... { count }`

---

### `DELETE /api/data/events/clear`

현재 사용자 이벤트 전부 삭제 (**개발용**).

---

### `DELETE /api/data/events/:id`

Mongo ObjectId 문자열(`24` hex) 기준 삭제 시도. **멱등**: 해당 사용자에게 문서가 없거나 이미 삭제된 경우에도 **200** `{ "ok": true }` (앱 outbox·재시도 정리용). 잘못된 id 형식은 **400** `{ "error": "invalid_id", "message": "..." }`.

---

## 4. 설정 (`/api/settings`)

### Sensor

스키마 요약: `name` (필수), `serial`, `isActive`, `offset`, `scale`, `timestamps`.

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/settings/sensors` | 목록 (최신순) |
| POST | `/api/settings/sensors` | 생성 |
| PUT | `/api/settings/sensors/:id` | 수정 |
| DELETE | `/api/settings/sensors/:id` | 삭제 |

**PUT** 실패: **404** `{ "error": "not_found" }`

---

### Alarm

`type` enum: `very_low` | `low` | `high` | `rate` | `system`

필드: `enabled`, `threshold`, `quietFrom`, `quietTo` (예: `"22:00"`), `sound`, `vibrate`, `repeatMin`, `overrideDnd`, …

| Method | Path |
|--------|------|
| GET | `/api/settings/alarms` |
| POST | `/api/settings/alarms` |
| PUT | `/api/settings/alarms/:id` |
| DELETE | `/api/settings/alarms/:id` |

**POST/PUT** 검증 실패: **400** `{ "error": "invalid_alarm" }`

---

### App 설정 (사용자당 단일 문서)

### `GET /api/settings/app`

앱 **온라인 헬스체크**에도 사용됩니다. DB에서는 `userId` 인덱스로 단건 조회·lean·필드 제한만 수행합니다. 통상 **수백 ms ~ 1~2s 이내**가 목표이며, 1.5s 초과 시 서버에 경고 로그를 남깁니다.

문서 없으면 **빈 객체 `{}`** 반환.

스키마 기본값 참고: `unit` (`mg/dL` | `mmol/L`), `notifications`, `darkMode`, `preferences` (객체)

**HTTP**: 인증 실패 시 **401** `{ "error": "no_token" | "invalid_token", "message": "..." }` (앱은 비200을 오프라인으로 분류할 수 있음).

---

### `PUT /api/settings/app`

**Body** (부분 갱신 — 보낸 필드만 반영)

| 필드 | 설명 |
|------|------|
| `unit` | `mg/dL` \| `mmol/L` |
| `notifications` | boolean |
| `darkMode` | boolean |
| `preferences` | arbitrary object |

**응답 200**: 갱신/생성 후 문서 전체.

> 참고: 회원가입 시 사용자 `unit`은 `mg/dL`/`mmol` 이고, 앱 설정 모델은 `mmol/L` 표기를 씁니다. FE에서 단위 UI 일관성 확인 권장.

---

### 장비 등록 (`Eq`)

모바일 앱이 **시리얼** 또는 **BLE MAC**으로 기기를 재연결할 때 세션 시작 시각을 복구하기 위한 API입니다. 상세 요구는 [api_rev_260417a.md](./api_rev_260417a.md) 와 동일 계약입니다.

**소유권:** `resolve`는 JWT 사용자가 등록한 행만 반환합니다. 기존 문서는 `userId` 또는 `createdBy` / `updatedBy` 로 소유를 판별합니다(레거시 호환).

**BLE MAC 정규화:** 콜론·하이픈·공백 제거 후 대문자 16진, 짝수 길이(6~16 hex 자리). FE 권장: 구분자 없는 대문자(예: `A1B2C3D4E5F6`).

**남은 시간:** `remainingMinutes` 는 `startAt` 기준 **`EQ_VALIDITY_DAYS`**(환경변수, 기본 `14`, 1~90으로 클램프)일 후 만료라고 가정해 계산합니다. 제품 정책이 다르면 FE가 `startAt` 으로 단독 계산해도 됩니다.

---

### `GET /api/settings/eq-list/resolve`

**Query** — 둘 중 **하나 이상** 필수(빈 문자열은 미제공과 동일하게 취급하지 않음: 잘못된 값이면 400).

| 파라미터 | 설명 |
|----------|------|
| `serial` | 장비 시리얼(trim 후 대문자 저장 형식과 비교) |
| `bleMac` | BLE 주소(FE·BE 정규화 규칙 위와 동일) |

**매칭:** 저장된 `serial` **또는** `bleMac` 이 쿼리와 일치(OR). 둘 다 해당하고 서로 다른 후보가 있으면 **`serial` 매칭 우선**.

**응답 200**

```json
{
  "matchedBy": "serial",
  "serial": "ABC123",
  "bleMac": "A1B2C3D4E5F6",
  "startAt": "2026-04-10T12:00:00.000Z",
  "remainingMinutes": 12345,
  "_id": "..."
}
```

- `matchedBy`: `"serial"` \| `"bleMac"`
- `bleMac`: 저장값 없으면 `null`

**오류**

- **400** `serial_or_bleMac_required` — 둘 다 없음  
- **400** `invalid_serial` / `invalid_bleMac` — 파라미터는 넘겼으나 정규화 실패  
- **401** 인증 실패  
- **404** `not_found` — 소유한 행 없음(FE는 `serial` 을 넘긴 경우 `GET .../eq-list/:serial` 로 폴백 가능)

---

### `GET /api/settings/eq-list/:serial`

`serial`은 대소문자 무관 조회(내부적으로 대문자 키 사용). 없으면 `{}`.

> 전역 `serial` 키 기준이라 소유권 필터는 없음. 재연결 시 권장 흐름은 **`resolve` 우선**.

---

### `POST /api/settings/eq-list`

**Body**

| 필드 | 설명 |
|------|------|
| `serial` | 필수, 비어 있으면 400 |
| `startAt` | 생략 시 `new Date()` |
| `bleMac` | 선택. 알면 전달 권장(재설치 후 MAC만으로 복구). 형식 오류 시 400 |

**동작**: `serial` 대문자로 upsert. 매 요청마다 **`startAt`**(생략 시 현재 시각)·`userId`·`updatedBy` 를 갱신해 **동일 serial 반복 POST 멱등**(중복 에러 없음, [api_rev_260504.md](./api_rev_260504.md)). 신규 행에는 `createdBy` 가 `$setOnInsert` 로만 설정. `bleMac` 을 보낸 경우에만 해당 필드 갱신(미전송 시 기존 MAC 유지).

**오류**: **400** `invalid_serial` \| `invalid_startAt` \| `invalid_bleMac` \| `eq_upsert_failed` (각 `message` 문자열 포함 가능) · **403** `forbidden` (이미 **다른 계정**이 소유한 `serial`) · **409** `bleMac_conflict` (다른 시리얼 행이 이미 같은 `bleMac` 사용)

---

## 5. 로컬 개발 참고

- 메모리 Mongo 모드: `MONGO_MEMORY=1` 등 (`src/index.js`).
- 시드 계정: 이메일 `empecs` / 비밀번호 `admin` 이 없으면 생성될 수 있음 (`seedDefaultUser`).

---

## 변경 이력 (Changelog)

| 리비전 | 변경 요약 |
|--------|-----------|
| `2026-05-04` | [api_rev_260504.md](./api_rev_260504.md) 반영: `GET /api/docs/api_rev_260504.md` 서빙, `GET /api/data/glucose` JSON 오류·날짜 검증·`limit` 클램프, `POST /eq-list` 매번 `startAt` 갱신·타인 `serial` 403·409 `message`, register `email_exists` 에 `message` |
| `2026-04-17a` | `GET /api/settings/eq-list/resolve`, Eq `bleMac`/`userId`, `POST /eq-list` 에 `bleMac` ([api_rev_260417a.md](./api_rev_260417a.md)) |
| `2026-04-17` | `GET /api/docs`, `GET /api/docs/api.md` 로 본 문서 공개 서빙 (nginx `/api/` → BE) |
| `2026-04-17` | 최초 정리: `auth`, `data`, `settings`, `health` 전 엔드포인트 |

*(이 표를 갱신하면서 API 버전을 추적하세요.)*

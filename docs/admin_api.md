# 관리자 API (`/api/admin`) — 2026-09-30

어드민 FE 연동용 계약. 앱(회원) API 는 [api.md](./api.md).

## 공통

- 인증: `Authorization: Bearer <admin token>` (`POST /login` 으로 발급, 기본 8시간, `POST /refresh` 로 연장)
- 오류 본문: `{ "error": "<code>" }` (+ 필요 시 부가 필드). 상태코드: 400 입력 오류 · 401 미인증/토큰 무효 · 403 권한 없음 · 404 없음 · 409 충돌 · 429 시도 초과 · 500
  - `401 invalid_token` → FE 는 로그아웃 후 로그인 화면으로
  - `403 password_change_required` → 비밀번호 변경 화면으로
  - `403 forbidden` (`required: [권한]`) → 권한 없음 안내
- 목록 응답: `{ items, total, page, limit }`. 쿼리 `page`(1부터) · `limit`(기본 50, 최대 200) · `sort=field:asc|desc`
- 기간: `from`/`to`. `YYYY-MM-DD` 는 **한국시간 하루**로 해석. ISO 일시도 가능
- 시각은 모두 ISO(UTC) 문자열. 화면 표시는 FE 가 한국시간으로 변환
- CSV: UTF-8 BOM, `Content-Disposition: attachment`. fetch + blob 으로 받는다(토큰 헤더 필요)

## 역할과 권한

| 역할 | 권한 |
|---|---|
| `superadmin` | 전부 |
| `operator` | 조회 전부 + `users.write` `users.support` `devices.write` `devices.delete` `data.export` `notices.write` `audit.read` |
| `cs` | 조회 전부 + `users.support` |
| `viewer` | 조회 전부 |

조회 전부 = `dashboard.read` `users.read` `devices.read` `data.read` `monitor.read` `notices.read`.
그 외: `users.delete` `data.delete` `admins.manage` `settings.manage` `system.reset` 은 최고관리자만.

## 계정

| Method | Path | 권한 | 요청 → 응답 |
|---|---|---|---|
| POST | `/login` | - | `{username,password}` → `{token, admin}`. 401 `invalid_credentials` · 429 `too_many_attempts` · 403 `ip_not_allowed` |
| GET | `/me` | 로그인 | → `{admin}` |
| POST | `/refresh` | 로그인 | → `{token, admin}` |
| POST | `/me/password` | 로그인 | `{currentPassword,newPassword}` → `{ok, token, admin}`. 400 `password_min_10` `password_needs_letter_and_digit` `password_same_as_old` · 401 `invalid_password` |
| GET | `/roles` | 로그인 | → `{roles[], permissions[], rolePerms{}}` |
| GET | `/admins` | admins.manage | → `{items: admin[], total}` |
| POST | `/admins` | admins.manage | `{username,password,role,name?}` → 201 `{ok, admin}`. 400 `invalid_username` `invalid_role` · 409 `username_taken` |
| PATCH | `/admins/:id` | admins.manage | `{name?,role?,status?('active'\|'disabled'),password?}` → `{ok, admin}`. 409 `last_superadmin` |
| DELETE | `/admins/:id` | admins.manage | → `{ok}`. 409 `cannot_delete_self` `last_superadmin` |

`admin`: `{id, username, name, role, status, mustChangePassword, permissions[], lastLoginAt, lastLoginIp, createdAt, updatedAt}`

## 대시보드

- `GET /stats` (dashboard.read) →
  `{ sensors:{active,endingSoon,expired,blocked,inStock,unverified,validityDays}, users:{suspended,new24h}, syncGaps, totals:{users,devices,dataPoints}, lineUsers:[{day,count}], barGlucose:[{day,count}], pieDevices:[{name,value}], devicesLive:[{eqsn,userEmail,userLabel,activityPct,avgIntervalSec,points24h,lastAt}], devicesLiveSummary:{count,avgActivityPct,avgIntervalSec}, recentAlarms:[{time,eqsn,userEmail,userLabel,type,threshold,value,unit}] }`
- `GET /stats/world` → `{ regions:[{countryCode,users,activeUsers,devices,dataPoints}], totals }`
- `GET /stats/world/:countryCode/users?page&limit` → `{countryCode, items:[{id,email,name,provider,countryCode,createdAt}], total, page, limit}`

## 회원

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/users` | users.read | 쿼리: `user`(이메일·이름·id) `sn` `mac` `status`(active\|suspended\|deleted, 기본은 탈퇴 제외) `provider`(local\|google\|kakao\|apple) `country` `from` `to` `sort`(createdAt\|email\|lastLoginAt\|lastSeenAt\|lastUploadAt) |
| GET | `/users/export.csv` | users.read + data.export | 같은 필터 |
| GET | `/users/:id` | users.read | → `user` |
| GET | `/users/:id/overview` | users.read | 상세 한 화면(아래) |
| GET | `/users/:id/glucose` | users.read + data.read | 쿼리 `from` `to` `eqsn?` `maxPoints?`(기본 1200) → `{points:[{t(ms),v,lo?,hi?}], total, downsampled, from, to}` |
| GET | `/users/:id/events` | users.read + data.read | → `{items:[{id,type,time,memo,eqsn}], total, page, limit}` |
| PATCH | `/users/:id` | users.write | `{email?,firstName?,lastName?,name?,dateOfBirth?,gender?,unit?,countryCode?,language?,adminNote?}` → `{ok,user}`. 409 `email_taken` |
| POST | `/users/:id/password` | users.support | `{password}`(8자 이상) → `{ok}`. 기존 세션 로그아웃 |
| POST | `/users/:id/force-logout` | users.support | → `{ok}` |
| POST | `/users/:id/suspend` | users.write | `{reason?}` → `{ok,user}` |
| POST | `/users/:id/unsuspend` | users.write | → `{ok,user}`. 409 `not_suspended` |
| POST | `/users/:id/restore` | users.delete | 탈퇴(soft) 복구 → `{ok,user}` |
| DELETE | `/users/:id` | users.delete | body `{mode:'soft'}` → `{ok,mode}` / `{mode:'purge', confirm:'<회원 이메일>'}` → `{ok,mode,deleted:{glucose,events,alarms,sensors,settings,devicesReleased}}`. 400 `confirm_mismatch` |

목록 item: `{id,email,name,provider,countryCode,status,deviceCount,lastLoginAt,lastSeenAt,lastUploadAt,createdAt}`

`user`: `{id,email,firstName,lastName,name,label,dateOfBirth,gender,unit,countryCode,language,provider,providerId,hasPassword,status,suspendedReason,suspendedAt,deletedAt,lastLoginAt,lastSeenAt,lastUploadAt,adminNote,createdAt,updatedAt}`

`overview`:
```
{ user,
  devices:[{id,serial,bleMac,startAt,endAt,remainingMs,status,verified,lotCode}],
  sensors:[{id,name,serial,isActive,createdAt}],
  alarms:[{type,enabled,threshold,repeatMin,sound,vibrate,quietFrom,quietTo}],
  appSetting:{unit,notifications,darkMode,updatedAt}|null,
  data:{totalPoints,eventCount,firstAt,lastAt,lastValue,lastEqsn},
  stats14d:{points,avg,min,max,lowPct,inRangePct,highPct,thresholds:{veryLow,low,high}},
  logins:[{at,success,reason,method,ip}],
  serverTime }
```

## 기기 · SN · QR

상태(`status`): `stock`(재고) · `shipped`(출고) · `active`(사용 중) · `expired`(만료) · `blocked`(차단).
`active/expired` 는 앱 등록 시작시각 + 유효기간(설정 `eqValidityDays`)으로 계산.

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/devices` | devices.read | 쿼리: `sn` `mac`(앞부분 일치) `user` `status`(stock\|shipped\|active\|ending\|expired\|blocked\|registered) `verified`(true\|false) `formatOk=false` `lot`(코드, `-`=미지정) `source`(admin\|import\|app) `from` `to` `sort`(serial\|createdAt\|updatedAt\|startAt\|lotCode). 응답에 `validityDays` 포함 |
| GET | `/devices/summary` | devices.read | → `{total,stock,shipped,active,ending,expired,blocked,unverified,formatBad,validityDays,snPolicy}` |
| GET | `/devices/ending-soon` | devices.read | → `{items:[{id,serial,bleMac,startAt,endAt,remainingMs,remainingSec,userId,userEmail,userLabel,userProvider,userCountryCode,userUnit,userCreatedAt,createdAt,updatedAt,serverTime}], total, validityDays, windowHours, serverTime}` |
| GET | `/devices/export.csv` | devices.read + data.export | 같은 필터 |
| GET | `/devices/qr` | devices.read | `serials=a,b,c`(최대 1000) 또는 `lot=코드` → `{items:[{serial,bleMac,lotCode,payload,hasMac}], missing[], format}` |
| POST | `/devices` | devices.write | `{serial,bleMac?,lotCode?,manufacturedAt?,note?,strict?}` → 201 `{ok,result:'created'\|'upgraded',serial}`. 409 `serial_exists` `bleMac_conflict` · 400 `serial_format`(strict) `invalid_bleMac` |
| POST | `/devices/import` | devices.write | `{rows:[{serial,bleMac?,lotCode?,manufacturedAt?,note?}], lotCode?, manufacturedAt?, dryRun?}`(최대 5000행) → `{ok,dryRun,summary:{total,created,upgraded,skipped,error,formatWarnings},results:[{index,serial,result,error?,formatOk?,conflictWith?}]}` |
| POST | `/devices/generate` | devices.write | `{model:'C21',yearCode:'Z',sample?,from,count(≤2000),lotCode?,dryRun?}` → `{ok,first,last,created,alreadyExists}` (dryRun: `willCreate`) |
| POST | `/devices/bulk` | devices.write | `{serials[],action:'ship'\|'stock'\|'verify'\|'setLot'\|'block'\|'unblock', shippedTo?, lotCode?, reason?}` → `{ok,matched,modified}` |
| GET | `/devices/:key` | devices.read | `:key` = SN 또는 id. 상세(아래) |
| PATCH | `/devices/:key` | devices.write | `{bleMac?,lotCode?,stage?('stock'\|'shipped'),shippedTo?,note?,verified?,manufacturedAt?}` → `{ok}` |
| POST | `/devices/:key/block` | devices.write | `{reason?}` — 앱 등록을 거절(`403 device_blocked`). 이미 올라오는 데이터는 막지 않음 |
| POST | `/devices/:key/unblock` | devices.write | |
| POST | `/devices/:key/release` | devices.write | 소유권 해제(앱 등록 기록 삭제, 재고·이력·혈당은 유지). 409 `not_registered` |
| POST | `/devices/:key/transfer` | devices.write | `{userId}`(id 또는 이메일). 404 `user_not_found` · 409 `not_registered` |
| POST | `/devices/:key/start` | devices.write | `{startAt, note?}` 시작시각 정정. 400 `startAt_in_future` |
| DELETE | `/devices/:key` | devices.delete | 재고 삭제. 409 `registered_release_first` |
| GET | `/lots` | devices.read | → `{items:[{code,model,manufacturedAt,note,createdAt,total,registered,active,blocked,shipped,noMac}], unassigned:{total,...}}` |
| POST | `/lots` | devices.write | `{code,model?,manufacturedAt?,note?}` → 201. 409 `code_exists` |
| PATCH | `/lots/:code` | devices.write | `{model?,manufacturedAt?,note?}` |
| DELETE | `/lots/:code` | devices.delete | 409 `lot_not_empty` |

목록 item / 상세 공통: `{id,serial,bleMac,model,yearCode,year,sample,seq,formatOk,lotCode,manufacturedAt,stage,shippedAt,shippedTo,blocked,blockedReason,blockedAt,source,verified,note,status,startAt,endAt,remainingMs,registeredAt,owner:{id,email,label}|null,createdAt,updatedAt}`

상세 추가: `{qrPayload, validityDays, eqId, user:{...}|null, remainingSec, data:{points,firstAt,lastAt,lastValue}, history:[{at,action,startAt,prevStartAt,userEmail,prevUserEmail,byKind,byName,note}], serverTime}`
`history.action`: `register` `reregister` `release` `transfer` `start_fix` `block` `unblock` `rejected`

QR 문자열(앱이 읽는 형식): `<ADV 이름>;0x<제조자ID><MAC 12자리>;0x<SN>` — 예 `empecsCGM;0xFFFF04AC44111102;0xC21Z00102`. MAC 이 없으면 SN 단독(앱 구형식, BLE 자동 연결 불가).

웹소켓: `wss://<host>/api/admin/ws/devices-ending?token=<admin token>` — 1초마다 `{type:'devices_ending_soon', ...ending-soon 응답}`.

## 운영

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/monitor/sync` | monitor.read | `hours?` → `{items:[{serial,startAt,endAt,userId,userEmail,userLabel,userStatus,lastUploadAt,lastSeenAt,lastLoginAt,gapHours,hint}], total, activeSensors, thresholdHours, serverTime}`. `hint`: `app_silent`(앱이 서버와 통신 자체가 없음 — 앱 종료·로그인 만료) · `never_uploaded`(등록 후 업로드 없음) · `upload_stalled`(통신은 되는데 혈당만 안 올라옴) |
| GET | `/data` | data.read | 쿼리 `user` `userId` `sn` `exactSn=true` `mac` `from` `to` → item `{id,eqsn,value,time,trid,uploadedAt,userId,userEmail,userLabel}` |
| GET | `/data/export.csv` | data.read + data.export | 필터 필수(400 `filter_required`), 최대 20만 행 |
| POST | `/data/delete` | data.delete | `{userId, sn?, from?, to?, dryRun?}` → `{ok,dryRun,count}` / `{…, confirm:'DELETE'}` → `{ok,deleted}` |
| GET | `/notices` | notices.read | 쿼리 `q` `active` → item `{id,title,body,language,pinned,active,publishAt,expireAt,createdBy,updatedBy,createdAt,updatedAt}` |
| POST | `/notices` | notices.write | `{title,body?,language?,pinned?,active?,publishAt?,expireAt?}` → 201 `{ok,notice}` |
| PATCH | `/notices/:id` | notices.write | |
| DELETE | `/notices/:id` | notices.write | |
| GET | `/settings` | dashboard.read | → `{settings, defaults}` |
| PUT | `/settings` | settings.manage | 바꿀 키만 → `{ok,settings}` |
| GET | `/audit-logs` | audit.read | 쿼리 `action`(앞부분) `actor` `targetType` `target` `from` `to` → `{items:[{id,at,actorName,actorRole,action,targetType,targetId,targetLabel,before,after,note,ip,success}], total, page, limit, actions[]}` |
| GET | `/login-logs` | audit.read | 쿼리 `kind`(admin\|user) `success`(true\|false) `q` `from` `to` → item `{id,at,kind,identifier,success,reason,method,ip,userAgent}` |
| POST | `/system/reset` | system.reset | `{password:<본인 비밀번호>, confirm:'RESET ALL DATA'}` → `{ok,deleted}` |

`settings`: `{eqValidityDays(1~90), endingSoonHours, snPolicy('flag'|'block'), snPattern, yearCodes:{Z:2025,…}, qrAdvName, qrManufacturerId, syncGapHours, adminSessionHours, adminIpEnforce, adminIpAllowlist[]}`

앱용 공개 공지: `GET /api/notices?lang=ko` → `{items:[{id,title,body,language,pinned,publishAt}]}`

## 앱(회원) API 에 생긴 변화

- 정지된 회원: 모든 인증 API `403 account_suspended`, 로그인도 403
- 강제 로그아웃·탈퇴: `401 invalid_token`
- `POST /api/settings/eq-list`: 차단된 SN `403 device_blocked`, 정책이 차단이고 재고에 없는 SN `403 sn_not_registered`
- `GET /api/settings/eq-list/:serial`: 본인 소유가 아니면 `{}`
- `GET /api/settings/eq-list/resolve` 의 `remainingMinutes`: 설정 유효기간(기본 16일) 기준
- `POST /api/data/glucose`: `(userId, eqsn, time)` 기준 멱등, 잘못된 값은 400

# 어드민 확장 배포 기록 — 2026-09-30

games_card 통합어드민(admin-ui)의 셸·메뉴·공통 부품 구조를 참고해 CGMS 어드민을 확장했다.
API 계약은 [admin_api.md](./admin_api.md), FE 는 `ln_admin_fe_ref` 저장소.

## 무엇이 바뀌었나

| 영역 | 내용 |
|---|---|
| 관리자 | DB 계정(bcrypt)·역할 4종(최고관리자/운영자/CS/조회전용)·권한, 회원 토큰과 분리된 서명 키, 로그인 시도 제한(10분 10회)·이력, 최초·재설정 계정은 첫 로그인 때 비밀번호 변경 강제, 감사 로그(변경 전/후) |
| 회원 | 정지·강제 로그아웃·탈퇴(복구 가능)·완전 삭제, 상세(센서·혈당 그래프·이벤트·알람·로그인 이력), CSV 내보내기 |
| 기기·SN·QR | SN 재고(로트·CSV 가져오기·범위 생성), 상태(재고/출고/사용 중/만료/차단), QR 문자열(앱 형식), 차단, 소유권 해제·이전, 시작시각 정정, 등록 이력, 재고에 없는 SN 정책(표시만/차단) |
| 운영 | 동기화 이상 감시(센서 사용 중인데 업로드가 끊긴 회원), 데이터 내보내기·삭제, 공지(앱용 `GET /api/notices`), 시스템 설정 |
| 앱 API | 공용 인증 미들웨어(정지·탈퇴·강제 로그아웃 반영), 센서 유효기간 설정 1곳(기본 16일 — 예전엔 resolve 14일·종료 예정 15일), 단건 혈당 POST 멱등, `eq-list/:serial` 본인 소유만 |
| 보안 정리 | 가입 시 저장하던 비밀번호 평문 사본 삭제(기동 시 기존 값도 제거), 고정 비밀번호 기본 회원 자동 생성 제거, 코드·compose·문서·스크립트의 기본 자격증명 제거 |

## 배포 (2026-09-30 07:50 UTC 경)

1. 백업: `/root/backup/cgms_260930/` — `empecs_cgms.archive.gz`(mongodump), `env.before`, `docker-compose.before.yml`. 이미지 태그 `cgms_be-be:pre260930`, `empecs-cgms-be-fe:pre260930`.
2. compose 에 적혀 있던 비밀값을 서버 `.env` 로 이전(`MONGO_ROOT_PASSWORD`, `MONGO_URI`, `ADMIN_PASSWORD` — 값은 그대로). `.env.example` 참고.
3. `git pull` (BE `d989d6d`, FE `7074dcf`) → `docker compose build be fe` → `docker compose up -d be fe`.
   - 기존 어드민 FE 컨테이너가 compose 밖에서 만들어진 것이라 이름이 충돌해 `up` 이 중단됐고, 그 사이 BE 가 약 1분간 내려가 있었다(502).
     BE 를 다시 올린 뒤 옛 FE 컨테이너는 `empecs-cgms-admin-fe-old260930` 으로 이름을 바꿔 정지해 두었다(재시작 정책 no).
     이제 FE 도 compose 가 관리한다(이미지 `cgms_be-fe`).
4. 기동 로그: 평문 비밀번호 사본 제거 1명 · 최초 최고관리자 `admin` 생성 · 재고 동기화(eq 1 → 재고 1, 미확인).
5. 컨테이너 안 점검: 기존 형식 회원 토큰으로 `settings/app`·`auth/me`·`data/glucose`·`auth/refresh` 200, 관리자 API 무토큰 401,
   예전 공용 관리자 토큰 401, 새 관리자 토큰은 비밀번호 변경 전 `/users` 403(`password_change_required`).
   로컬에서는 `npm run test:admin`(메모리 DB, 70개 항목) 통과.

## 첫 로그인

`https://empecs.lunarsystem.co.kr/login` → 아이디 `admin` + **기존 관리자 비밀번호** → 비밀번호 변경 화면이 먼저 나온다(10자 이상, 영문+숫자).
변경 후 [시스템 > 관리자 계정]에서 담당자별 계정을 만들어 쓴다.

## 롤백

```bash
cd /lunar/empecs/cgms/cgms_be
docker tag cgms_be-be:pre260930 cgms_be-be:latest && docker compose up -d --no-build be
docker compose stop fe && docker rm empecs-cgms-admin-fe
docker rename empecs-cgms-admin-fe-old260930 empecs-cgms-admin-fe && docker start empecs-cgms-admin-fe
# DB 를 되돌려야 할 때만:
# docker exec -i empecs-cgms-mongodb sh -c 'mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --drop --gzip --archive' < /root/backup/cgms_260930/empecs_cgms.archive.gz
```

## 남은 일 (결정 필요)

- **비밀번호 교체**: 관리자·Mongo root 비밀번호가 이 공개 저장소의 과거 커밋에 남아 있다. 관리자 비밀번호는 첫 로그인 때 바뀌지만,
  **Mongo root 비밀번호는 그대로이고 포트 47011 이 외부(0.0.0.0)에 열려 있다.** 비밀번호를 바꾸고(`db.changeUserPassword` + `.env` 의 `MONGO_ROOT_PASSWORD`·`MONGO_URI`),
  외부 접속이 필요 없으면 compose 의 포트를 `127.0.0.1:47011:27017` 로 바꿀 것.
- 미등록 SN 정책은 "표시만"이다. 출고분을 모두 재고로 등록한 뒤 [시스템 > 설정]에서 "차단"으로 바꾼다.
- SN 형식·연도 코드(Z=2025)는 앱 QR 파서 기준이다. 제조사 규격과 다르면 [시스템 > 설정]에서 고친다.
- 안정화 후 정리: `docker rm empecs-cgms-admin-fe-old260930`, `docker rmi cgms_be-be:pre260929 cgms_be-be:pre260930 empecs-cgms-be-fe:pre260930`.

# 자동 검수 (QA) — Node E2E + HTTPS

## 전제

- 백엔드·DB·사용자 Flutter Web Docker 스택이 동작 (`empecs/cgms/cgms_be/docker-compose.yml`).
- **`https://empecsuser.lunarsystem.co.kr`** 에서 `/` → Flutter Web(`63104`), `/api/` → BE(`63101`).
- 회원가입(로컬 계정) Mongo 인덱스는 `User` 모델의 `syncIndexes()`로 보정됨.

## Node 전체 E2E

로그인·**회원가입(매 실행 고유 이메일)**·`/me`·앱/센서/알람 설정·**EQ 등록·resolve**·**seed-day / seed-days**(에뮬)·glucose batch·이벤트·문서 URL까지 검증합니다.

```bash
cd empecs/cgms/cgms_be

# 로컬 BE 직접
npm run qa:e2e:local

# 사용자 Web 도메인 (TLS, nginx /api 프록시)
npm run qa:e2e:empecsuser

# 운영 API 호스트 직접
npm run qa:e2e:prod

# 임의 URL
node scripts/qa-e2e-full.js https://example.com
# 또는
QA_BASE_URL=https://empecsuser.lunarsystem.co.kr node scripts/qa-e2e-full.js
```

종료 코드 `0`: 전부 통과, `0` 아님: 실패 건 있음.

## 경량 스모크 (기존)

```bash
npm run qa:local
```

## Admin FE 프록시 (`63103` → 동일 스택 BE)

Next.js가 `/api/*` 를 `be:58002` 로 넘기는지·관리자 조회 API가 동작하는지 한 번에 보려면:

```bash
npm run qa:admin
# 또는
node scripts/qa-bot.js http://127.0.0.1:63103 --admin
```

관리자 계정은 docker-compose 의 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 와 맞추거나, `QA_ADMIN_USERNAME` / `QA_ADMIN_PASSWORD` 로 덮어씁니다.

## Flutter (선택)

동일 API를 Dart에서 한 번만 찌를 때:

```bash
cd ../cgms_app_fe
flutter test test/qa_backend_smoke_test.dart --dart-define=QA_BASE=https://empecsuser.lunarsystem.co.kr
```

실기 **BLE·권한**은 이 테스트로 대체되지 않습니다. Node E2E와 브라우저 QA로 API·UI 흐름을 줄이고, BLE만 단말에서 확인하는 구성이 맞습니다.

## 인증서 (`empecsuser`)

최초:

```bash
# HTTP vhost + 인증서 (레포 nginx/*.conf 참고)
sudo certbot certonly --webroot -w /var/www/html -d empecsuser.lunarsystem.co.kr
sudo cp nginx/empecsuser.lunarsystem.co.kr.conf /etc/nginx/sites-available/empecsuser
sudo nginx -t && sudo systemctl reload nginx
```

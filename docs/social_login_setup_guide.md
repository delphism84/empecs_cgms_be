# EMPECS CGMS 소셜 로그인 세팅 가이드

> empecs.lunarsystem.co.kr 도메인 기준

---

# 1. 고객이 할 일 (소셜 사이트 콘솔 설정)

> **고객 전달용 HTML**: `docs/customer_social_setup.html` — URL 복사·붙여넣기 가능한 가이드 (고객에게 제공)

## 1-1. Google Cloud Console
- [ ] [Google Cloud Console](https://console.cloud.google.com/) 접속
- [ ] OAuth 동의 화면 설정 (앱 이름, 로고, 이메일 등)
- [ ] **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
- [ ] Application type: **Web application** 선택
- [ ] **Authorized redirect URIs** 추가:
  ```
  https://empecs.lunarsystem.co.kr/api/auth/google/callback
  ```
- [ ] **Authorized JavaScript origins** 추가:
  ```
  https://empecs.lunarsystem.co.kr
  ```
- [ ] **Client ID**, **Client Secret** 생성 후 → 서버 담당에게 전달

---

## 1-2. Kakao Developers
- [ ] [내 애플리케이션](https://developers.kakao.com/console/app)에서 앱 생성/선택
- [ ] **앱 키** → **REST API 키** 확인
- [ ] **플랫폼** → **Web** 등록 → **Redirect URI** 추가:
  ```
  https://empecs.lunarsystem.co.kr/api/auth/kakao/callback
  ```
- [ ] **동의항목** → 이메일, 프로필 등 필요한 항목 활성화
- [ ] **REST API 키** (및 Client Secret 사용 시) → 서버 담당에게 전달

---

## 1-3. Apple (Sign in with Apple)
- [ ] Apple Developer 계정 필요
- [ ] Services ID: `com.empecs.cg21.web` 등록
- [ ] **Redirect URL** 추가:
  ```
  https://empecs.lunarsystem.co.kr/auth/callback
  ```
- [ ] **Key ID**, **Team ID**, **.p8 Private Key** → 서버 담당에게 전달 (필요 시)

---

# 2. FE 개발자가 할 일

## 2-1. 접속 정보

| 항목 | 값 |
|------|-----|
| **서비스 URL** | `https://empecs.lunarsystem.co.kr` |
| **API Base URL** | `https://empecs.lunarsystem.co.kr/api` |
| **FE 포트** | `63100` (내부, nginx 뒤) |
| **BE 포트** | `63101` (내부) |

---

## 2-2. API 엔드포인트

| 용도 | Method | URL |
|------|--------|-----|
| 이메일 로그인 | POST | `/api/auth/login` |
| 이메일 회원가입 | POST | `/api/auth/register` |
| 프로필 조회 | GET | `/api/auth/me` (Header: `Authorization: Bearer <JWT>`) |
| 소셜 토큰 검증 | POST | `/api/auth/social/verify` |

---

## 2-3. 소셜 로그인 방식별 구현

### 방식 A: 리다이렉트 (BE 콜백)

- 사용자가 OAuth 사이트로 이동 → 로그인 후 **BE 콜백**으로 돌아옴
- BE가 JWT 발급 후 **리다이렉트**로 FE에 전달

**콜백 URL** (고객이 소셜 콘솔에 등록한 값):

| Provider | 콜백 URL |
|----------|----------|
| Google | `https://empecs.lunarsystem.co.kr/api/auth/google/callback` |
| Kakao | `https://empecs.lunarsystem.co.kr/api/auth/kakao/callback` |

**성공 시 BE 리다이렉트 대상**:
```
https://empecs.lunarsystem.co.kr/auth/callback#token=<JWT>
```
→ FE `/auth/callback` 페이지에서 `window.location.hash`로 token 추출

**실패 시**:
```
https://empecs.lunarsystem.co.kr/login?error=<에러메시지>
```

**로그인 시작 URL** (FE에서 이 주소로 이동):

| Provider | URL (CLIENT_ID / REST_API_KEY는 서버에서 전달받음) |
|----------|---------------------------------------------------|
| Google | `https://accounts.google.com/o/oauth2/v2/auth?client_id=<CLIENT_ID>&redirect_uri=https://empecs.lunarsystem.co.kr/api/auth/google/callback&response_type=code&scope=openid%20email%20profile` |
| Kakao | `https://kauth.kakao.com/oauth/authorize?client_id=<REST_API_KEY>&redirect_uri=https://empecs.lunarsystem.co.kr/api/auth/kakao/callback&response_type=code` |

---

### 방식 B: id_token / access_token 직접 검증 (SPA/모바일)

- FE에서 OAuth SDK로 **id_token** 또는 **access_token** 획득
- BE `POST /api/auth/social/verify`로 전달 → JWT 수신

| Provider | Body |
|----------|------|
| Google | `{ "provider": "google", "idToken": "..." }` |
| Kakao | `{ "provider": "kakao", "accessToken": "..." }` |
| Apple | `{ "provider": "apple", "idToken": "...", "name": "..." }` (name은 선택) |

---

## 2-4. FE에서 할 작업 체크리스트

- [ ] `/auth/callback` 페이지 구현 (리다이렉트 방식 사용 시)
  - `window.location.hash`에서 token 파싱
  - localStorage 등에 저장 후 앱 홈으로 이동
- [ ] `Authorization: Bearer <token>` 헤더로 API 호출
- [ ] 로그인 버튼 클릭 시 → 위 방식 A 또는 B에 맞게 구현
- [ ] Google/Kakao/Apple 클라이언트 ID·키는 서버/고객에게 전달받아 사용

---

## 2-5. 테스트 페이지

- **종합 테스트**: `https://empecs.lunarsystem.co.kr/logintest.html` (GSI, 팝업, 리다이렉트)
- **리다이렉트 전용**: `https://empecs.lunarsystem.co.kr/logintest-redirect.html` (`redirectURI: /auth/callback` 사용)

---

# 부록 (서버 담당)

## 서버에 필요한 키
| 환경변수 | 필수 | 비고 |
|----------|------|------|
| `BASE_URL` | ✅ | `https://empecs.lunarsystem.co.kr` |
| `JWT_SECRET` | ✅ | JWT 서명용 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 사용 시 | 고객 전달 |
| `KAKAO_REST_API_KEY` | Kakao 사용 시 | 고객 전달 |
| `APPLE_CLIENT_ID` | Apple 사용 시 | `com.empecs.cg21.web` |

## 포트
- empecs: **63100**(FE), **63101**(BE)
- 기존 서비스(LNSMS, lnteletranslate) 포트와 충돌 없음

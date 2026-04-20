# 추가 작업 정리 — 클라이언트 vs 서버

> 참고: OAuth·메일 계정 비밀번호 등 민감값은 `docs/cgms info.csv`에만 두고, 저장소에는 커밋하지 않는 것을 권장합니다.

---

## 1. 앱·클라이언트에서 할 일 (Flutter / Android / iOS)

### Google 로그인
- [ ] **Google Cloud Console**에서 Android 패키지명(`com.helpcare.app` 등 실제 `applicationId`)과 서명 SHA-1/256이 **Android OAuth 클라이언트**에 등록되어 있는지 확인.
- [ ] iOS에서 Web 클라이언트만으로 이슈가 있으면 **iOS 클라이언트 ID**(`cgms info.csv` 참고)를 Xcode / `GoogleService-Info.plist` 등에 맞게 적용.
- [ ] 리디렉트 URL `https://empecs.lunarsystem.co.kr/api/auth/google/callback`이 웹 클라이언트 설정과 일치하는지 확인.

### Kakao 로그인
- [ ] Kakao Developers에서 **Android 패키지명·키 해시**, **iOS 번들 ID**가 앱과 일치하는지 등록.
- [ ] 카카오톡 미설치 시 **카카오계정 로그인** 등 동선이 필요하면 `loginWithKakaoAccount()` 폴백 검토.

### Apple 로그인
- [ ] Apple Developer: **Services ID** `com.empecs.cg21.web`, **Key ID** `3HYL2QZKWS`, **Bundle ID** `com.empecs.cg21` (`cgms info.csv`)와 **Xcode `PRODUCT_BUNDLE_IDENTIFIER`** 정합성 확인.  
  - 현재 앱이 `com.helpcare.app`이면 콘솔·앱 ID를 맞추거나, 번들 ID를 CG21 스펙에 맞게 변경하는 결정 필요.
- [ ] Sign in with Apple capability 활성화, 필요 시 **서버용** `.p8` 키·Team ID 연동은 서버 담당과 공유.

### 빌드·품질
- [ ] Gradle 경고: Kotlin **2.1.0+** 업그레이드 (`android/settings.gradle` / `build.gradle`의 KGP).
- [ ] Release 서명: 현재 `signingConfig signingConfigs.debug` 사용 시 **스토어용 keystore**로 교체 검토.

### 기타 UX·연동
- [ ] 소셜 로그인 성공 후 **백엔드 JWT 발급·연동**이 없다면, 서버 작업과 함께 앱에서 토큰 교환 플로우 정의.

---

## 2. 서버에서 할 일 (백엔드 / 인프라)

### 인증·계정
- [ ] **Google / Apple / Kakao** ID 토큰(또는 authorization code) **검증 API** 구현 또는 연동.  
  - Google: Web 클라이언트 ID 기준 토큰 검증.  
  - Kakao: REST API 키 등으로 사용자 정보 조회·검증 (`cgms info.csv` — 키는 환경변수로만 보관).  
  - Apple: JWT 검증 + Services ID·Bundle ID 일치.
- [ ] 소셜 검증 후 **자체 JWT 발급** 및 기존 `User` 스키마와 매핑(이메일·provider·sub).
- [ ] (선택) **`GET /api/auth/me`** 등: 토큰으로 프로필 조회 → 앱 설정 화면 사용자 카드 갱신에 활용.

### 메일 (메일플러그 — `cgms info.csv`)
- [ ] SMTP 연동: `mtp.mailplug.co.kr:465` SSL, 계정·발신자 `secure.cg21@empecs.com`, 표시 이름 `EMPECS Medical`.
- [ ] **배포 서버 공인 IP** 메일플러그 **화이트리스트** 필요 여부 확인 및 등록.
- [ ] **SPF / DKIM / DMARC** 도메인 DNS 설정(메일플러그 가이드·담당자 문의).
- [ ] **발송 한도**(일 500건 등) 모니터링 및 알림·큐잉 정책.

### 보안·운영
- [ ] OAuth **클라이언트 시크릿·REST API 키·어드민 키**는 서버 환경변수만 사용, 코드/CSV 커밋 금지 권장.
- [ ] 프로덕션 **JWT 시크릿**·DB URL 등 `config` 분리.

### CORS·콜백
- [ ] 웹 Google 콜백 `https://empecs.lunarsystem.co.kr/api/auth/google/callback` 라우트가 실제 배포 도메인과 동작하는지 확인.
- [ ] Nginx·SSL 설정: `scripts/setup-ssl.sh`, `scripts/setup-nginx.sh` 실행 (empecs 전용)

---

## 3. 공통·협의 필요

| 항목 | 비고 |
|------|------|
| Bundle ID / applicationId | `com.empecs.cg21` vs `com.helpcare.app` 통일 여부 |
| 소셜 로그인 후 세션 정책 | 앱 전용 JWT 만료·갱신 |
| 비밀번호 재설정 등 | 메일 발송 플로우와 연계 |

---

*최종 수정: 클라이언트 소셜 키 반영 기준으로 정리. 필요 시 항목을 이슈/태스크로 쪼개서 관리하세요.*

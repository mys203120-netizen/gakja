# Google·카카오 가입 및 로그인

> 현행 계약·검증 갱신: 2026-10-14. [문서 적용 순서](document-authority.md)와 [서비스 PRD v2.2](../확정안/4.%20서비스_PRD_v2.2.md)를 따른다. [개선·검증 요약](learning-remediation.md)과 [후속 QA](../.local/learning-remediation-2026-10-14/report.md)·[화면 보고서](../.local/learning-remediation-2026-10-14/report.html)에 실제 API/저장값·학교 등록·같은 질문의 학습 연결 검증을 기록했다. 아래 이전 테스트와 화면은 당시 범위로 보존한다. 실제 OAuth·Live/STT·장기 회상·88교 전 학과 콘텐츠 품질·운영 보안은 후속 인수 게이트이며, 이번 결과가 모든 기능이나 실제 학습 효과의 완료를 뜻하지 않는다.

## 2026-10-14 가입 후 학교·일정 등록

신규 로컬 OAuth와 Supabase OAuth 계정은 `/schools/new?onboarding=1`로 이동한다. 검증된 공급사 ID로 학생 역할을 생성하며 기존 권한·중지 상태와 개인 기록을 덮어쓰지 않는다. 외부 공급사 동의·콜백의 실계정 왕복 검증은 별도 게이트다.

학교 → 그 학교의 공시 학과 → 지원 전형을 고르면 저장된 공개 면접 일정이 자동 조회된다. 기본 지원 학년도는 2027이며 수시 면접 날짜는 2026년이다. 학생은 출처·확인일·전형 일치와 개인 시간 미확정을 확인한 뒤 등록한다. 면접 미실시·날짜 미정·미공개·전형 확인 필요도 서로 다른 저장 상태로 완료할 수 있다. 없는 날짜나 개인 배정 시각을 생성하지 않는다.

등록 완료에서 첫 공통 질문 준비·캘린더·학교 안내로 이어진다. 생기부가 없는 계정에 개인 경험을 복제하지 않는다. 일정 조회와 확인 fingerprint는 [면접 일정](admission-calendar.md), 선택 검증은 [학교 학습](school-learning.md)에 따른다.

`DANEOBANG-main.zip`의 첫 로그인 시 가입하는 구조, 흰 Google 버튼과 노란 카카오 버튼, 아이콘, 서버 인가 코드 교환 흐름을 현재 Next.js·PostgreSQL 인증 구조에 맞게 반영했다. 원본 저장소의 환경 파일·키·기존 사용자 데이터는 읽거나 가져오지 않았다.

## 화면과 실제 동작

- `/login`: Google·카카오 연결과 기존 이메일 로그인. `/signup`: 소셜 가입 진입 화면.
- 처음 연결한 검증된 소셜 계정은 서버가 `student` 계정으로 생성한다. 클라이언트나 공급사 프로필에 적힌 역할은 사용하지 않는다.
- 동일 공급사 ID는 같은 계정으로 로그인한다. 기존 `role`, `active`, 이메일, 이름을 로그인 시 덮어쓰지 않는다. 중지된 계정은 로그인이나 재가입으로 활성화하지 않는다.
- 신규 소셜 가입은 `/schools/new?onboarding=1`로 이동한다. 학교·학과·전형·일정 확인을 마치고 첫 공통 질문으로 연결한다. 개인 학습 자료가 없으면 실제 빈 상태를 유지하며 테스트 학생 자료를 복제하지 않는다.
- 기존 계정은 안전한 앱 내부 `next` 경로로 돌아간다. 관리자는 `/admin`으로 이동한다. 외부 주소·관리자 주소·인증 API·경로 우회는 학생 이동 경로에서 제외한다.
- 공급사 연결이 설정되지 않은 현재 로컬 환경에서는 버튼을 눌렀을 때 이메일 로그인 안내를 보여준다. OAuth 성공을 시뮬레이션하지 않는다.

## 로컬 PostgreSQL 모드

`AUTH_MODE=local`을 유지하고 실제 공급사 앱에 아래 환경 항목을 설정한다. 모두 서버 전용이다. `.env.example`에 이름만 추가했으며 기존 `.env.local` 비밀 값은 변경하지 않았다.

| 공급사 | 환경 변수 | 공급사에 등록할 Redirect URI |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `http://localhost:3100/api/auth/callback/google` |
| 카카오 | `KAKAO_CLIENT_ID`, 선택 `KAKAO_CLIENT_SECRET`, 선택 `KAKAO_SCOPE` | `http://localhost:3100/api/auth/callback/kakao` |

서비스 주소를 바꾸면 `NEXT_PUBLIC_APP_URL`과 공급사 Redirect URI를 같은 실제 주소로 변경해야 한다. 배포에서 로컬 인증을 사용하려면 기존 `ALLOW_LOCAL_AUTH=true` 조건이 적용된다.

카카오 앱의 동의 항목에 이메일 제공이 활성화되어 있어야 신규 가입할 수 있다. `KAKAO_SCOPE`는 공급사 콘솔에서 허용된 항목만 요청한다. 비즈 앱 및 권한 상태에 따라 `account_email` 설정이 필요하다. 이메일이 없거나 공급사가 소유 확인을 하지 않은 신규 계정은 가입을 진행하지 않고 이메일 동의 안내를 보여준다. 내부 가짜 이메일 계정을 만들지 않는다.

Google은 인가 코드+S256 PKCE, 카카오는 서버 인가 코드 교환을 사용한다. 공급사 사용자 API에서 받은 ID를 `social_identities`에 저장하며 액세스 토큰·리프레시 토큰은 DB에 저장하지 않는다. 이후 앱 로그인은 기존 HttpOnly `gakja_session`을 사용한다.

## Supabase 모드

1. 기존 `AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, Supabase PostgreSQL 연결을 설정한다.
2. Supabase 대시보드에서 Google·카카오 공급사를 활성화하고 실제 클라이언트 값을 입력한다. 키를 브라우저 환경 변수에 넣지 않는다.
3. 공급사 앱의 Redirect URI는 `https://<project-ref>.supabase.co/auth/v1/callback`이다.
4. Supabase의 Redirect URL 허용 목록에 실제 앱 주소의 `/auth/callback**`를 등록한다. 현재 로컬 예: `http://localhost:3100/auth/callback**`.
5. 앱 서버에 연결 상태를 `SUPABASE_GOOGLE_ENABLED=true`, `SUPABASE_KAKAO_ENABLED=true`로 명시한다. 기본값은 둘 다 `false`다.

이 모드에서는 기존 `@supabase/ssr` 서버 클라이언트의 PKCE 세션을 사용한다. `/auth/callback?flow=...`에서 단발 흐름을 확인하고 코드 교환 후 `getUser()`로 인증된 사용자를 다시 확인한다. Supabase 사용자 UUID 그대로 PostgreSQL 프로필을 생성하며 기존 같은 UUID의 배정 계정과 권한을 보존한다. 기존 초대·비밀번호 재설정 콜백은 유지한다.

## 상태·권한 보호

- 32바이트 무작위 state와 별도의 32바이트 브라우저 비밀. 비밀은 HttpOnly·SameSite=Lax 쿠키이며 운영 환경에서는 Secure다.
- DB에는 두 값의 SHA-256 해시와 공급사·인증 모드·안전한 복귀 경로·10분 만료를 저장한다. Google PKCE verifier는 서버 전용 테이블에만 저장한다.
- state·브라우저·공급사·기한을 모두 검사한 `DELETE RETURNING`으로 콜백을 한 번만 소비한다. 다른 브라우저, 공급사, 만료, 재사용 콜백은 거절한다.
- 설정된 공급사의 연결 시작은 서버 인스턴스당 IP 기준 10분에 20회로 제한한다. 분산 배포에서는 공통 저장소를 쓰는 요청 제한을 추가해야 한다.
- 앱 DB는 이메일이 같다는 이유로 다른 UUID의 이메일 계정·초대 계정·관리자·중지 계정에 소셜 ID를 자동으로 붙이지 않는다. 기존 계정으로 로그인하도록 안내한다. 기존 계정 연결 기능은 별도 인증된 연결 절차가 필요하다. Supabase 자체의 검증된 이메일 계정 연결 정책은 Supabase가 처리하며, 앱은 `getUser()`로 확인된 동일 UUID의 기존 프로필만 받아들여 기존 역할·활성 상태를 보존한다.
- 두 신규 테이블은 RLS를 켜고 브라우저 읽기·쓰기 정책을 만들지 않았다. 서버 DB 연결만 사용한다.
- 프로필, 소셜 ID, 생성 감사 기록을 한 트랜잭션으로 저장하고 ID와 이메일을 잠가 중복 생성을 막는다.

## 검증 및 한계

`node --conditions=react-server --import tsx tests/social-auth.mts`: **47개 검증 통과**. 합성 공급사 응답과 격리된 임시 계정으로 신규 학생 생성, 기존 관리자 유지, 중지 계정 보존, 이메일 충돌, 검증되지 않은 이메일, Google PKCE, 카카오 소유 확인, Supabase ID, 안전한 복귀 경로, 실제 로컬 API의 state·기한·공급사·브라우저·재사용, 신규 빈 자료 소유권을 확인한다. 테스트 계정과 시도는 완료 후 정확한 생성 ID로 삭제한다. 실제 외부 OAuth 요청은 0회다.

실제 공급사 자격 증명과 콘솔 설정이 제공되지 않아 Google·카카오 사용자 동의→실제 callback의 전체 연결은 아직 실계정으로 검증할 수 없다. 제공사 API 부분은 합성 응답 검증, state와 사용자 소유권 부분은 실제 로컬 DB/API 검증을 거쳤다.

로컬 OAuth 계정을 Supabase로 옮기는 경우에도 이메일 자동 병합은 하지 않는다. 기존 사용자 데이터와 공급사 ID를 확인한 서버 측 계정 이전 절차가 필요하다.

공식 확인 자료: [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server), [카카오 로그인 REST API](https://developers.kakao.com/docs/en/kakaologin/rest-api), [Supabase Google](https://supabase.com/docs/guides/auth/social-login/auth-google), [Supabase 카카오](https://supabase.com/docs/guides/auth/social-login/auth-kakao).

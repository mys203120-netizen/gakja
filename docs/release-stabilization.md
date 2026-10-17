# 출시 안정화: 접근 정책·비공개 업로드·재현 검사

## 적용 순서

1. 대상 DB를 백업하고 `202610180001_document_originals.sql`까지 마이그레이션을 적용한다. 기존 마이그레이션 파일은 수정하지 않았다. 앱 배포 전에 적용한다. 로컬 PostgreSQL에는 Auth/Storage 부분이 자동으로 생략된다.
2. Supabase 환경은 `AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_MEDIA_BUCKET=student-media`와 서버 전용 `SUPABASE_SERVICE_ROLE_KEY`를 설정한다. 공개 변수는 **빌드 시점**에도 필요하다. 사용자 브라우저에는 service-role 키를 제공하지 않는다. 다른 이름의 버킷은 자동으로 허용하지 않는다.
3. 앱을 빌드·배포한다. 이미 열려 있던 이전 화면은 새로고침해야 한다. Supabase 모드에서 예전 multipart 파일 업로드 API는 415로 거절한다. 로컬 인증 모드에서는 기존 PostgreSQL 녹화 저장과 로컬 첨부 저장을 유지한다.
4. 실제 학생 두 계정으로 아래 운영 검사를 수행한다. 이 문서의 로컬 검증 결과를 호스팅 환경 검증으로 해석하지 않는다.

## 접근과 파일 보존

- 기존 소유권/발행 상태 정책에 `AS RESTRICTIVE` 활성 계정 조건을 AND로 추가했다. `profiles`는 자기 자신을 다시 조회하지 않고 `active`를 직접 검사하여 RLS 재귀를 피한다. 다른 public RLS 테이블은 현재 `profiles.active`를 조회한다. 새 RLS 테이블을 추가할 때도 활성 계정 조건을 넣어야 한다.
- Storage의 `student-media`, `student-chat-files`, `content-imports` 접근도 활성 계정 조건을 따른다. JWT 안의 오래된 active 값이나 사용자 편집 가능한 metadata에 의존하지 않는다.
- 녹화 파일은 브라우저의 Supabase 세션으로 업로드한다. `/api/uploads`는 소유한 현재 질문과 동의 또는 관리자 배정·제작 건을 확인하고 30분 유효한 임의 경로만 발급한다. 발급은 계정당 시간당 60회로 제한한다. 서명된 업로드 토큰을 발급하지 않아 비활성화 이후 새 Storage 업로드도 정책으로 막힌다.
- 브라우저는 녹화와 새 직접 업로드 파일을 덮어쓰거나 삭제·재업로드할 수 없다. 업로드 완료 처리는 서버에 저장된 경로만 사용하며, 실제 Storage 크기·MIME와 다운로드한 바이트의 파일 시그니처를 검사한다. 퀴즈는 10MiB, 면접 녹화/별도 분석 음성은 각각 20MiB, 채팅 첨부는 각각 15MiB·최대 3개, 가이드북은 HTML 한 개·5MiB다. 동의·질문·지원 맥락과 generation은 완료 시 재확인한다. 면접 본 녹화와 분석 음성 행은 하나의 DB 트랜잭션으로 저장된다.
- 파일 본문은 Vercel 요청/응답을 통과하지 않는다. 재생은 인증·소유권 확인 후 60초 서명 URL로 리다이렉트한다. **이미 발급된 읽기 URL은 계정 비활성화 후에도 최대 60초 유효할 수 있다.** 새 URL 발급과 인증 기반 Storage 요청은 차단된다. 이미 내려받은 파일 자체를 회수하는 기능은 아니다.
- 질문 TTS는 작은 서버 생성 음성으로 DB에 저장한다. 학생에게 임의 Storage 업로드 권한을 다시 열지 않는다.
- 연결 실패 시 사용자가 다시 저장할 수 있고, 서버 완료 처리는 기존 digest 중복 방지를 유지한다. 현재 업로드는 전체 파일 재시도 방식이며 TUS 이어올리기는 구현하지 않았다.

## 만료된 미연결 파일 정리

`node scripts/cleanup-recording-uploads.mjs`는 기본적으로 dry-run이다. 만료 후 24시간 이상 지난 요청 100개씩 검사하며, `media_assets`, `quiz_recordings`, `chat_attachments`가 참조하는 파일은 보존한다. `--apply`는 서버 전용 `SUPABASE_SERVICE_ROLE_KEY`를 사용해 미연결 파일만 Storage API로 제거한다. 정상 저장된 파일은 지우지 않는다. 참조 중인 요청은 남겨 이후 첨부 삭제 시에도 정리할 수 있게 하고 마지막 확인 시각으로 순환 검사한다. 채팅 초안 삭제는 즉시 UI·DB에서 반영되지만 직접 업로드 바이트 삭제는 이 정리 작업에서 수행한다. 가이드북 원문은 검증 후 documents 테이블에 저장되므로 임시 Storage 사본은 만료 후 정리한다. 운영 배포 후 정기 실행을 설정하고 오류를 감시한다. 이번 작업에서는 원격 파일 정리를 실행하지 않았다.

## 재현 명령과 검사 경계

Node.js 24와 lockfile을 사용한다. 개인 원문, `.local` 모듈, API 키 없이 실행할 수 있다.

```sh
npm ci
npm test
npm run typecheck
# 로컬 PostgreSQL 관리자 연결: 임시 DB 생성·삭제 권한 필요
TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/postgres npm run test:security
# CI 빌드 전용 설정. 실제 서비스 배포에는 Supabase 인증을 사용한다.
AUTH_MODE=local ALLOW_LOCAL_AUTH=true npm run build
```

PowerShell에서는 `$env:TEST_DATABASE_URL='...'`처럼 프로세스 환경 변수를 설정한다. RLS 검사는 원격 호스트를 거절하고 매번 임시 DB를 생성·제거한다. 실제 PostgreSQL에 모든 마이그레이션과 정책을 실행하지만 `auth.uid()`와 Storage 스키마는 테스트용 모형이다. Supabase HTTP 서버·실제 JWT 서명·실계정 로그인 검증을 대신하지 않는다.

`npm test`는 전체 `*.test.ts`/`*.test.mts`, 콘텐츠 계약, bootstrap 화면/query 검사를 실행한다. 학교 필터 범위, 프롬프트의 실제 버전 전달, 합성 원문 추출을 검증하고, 개인 원문을 저장소에 복사하지 않는다. `.github/workflows/ci.yml`은 push/PR에서 설치 → 검사 → RLS → 타입 → 빌드를 실행한다. DB 기반 HTTP 통합 검사와 유료 AI 품질 검사는 별도이며 이번 CI에서 실행하지 않는다.

## 운영 환경에서 남은 확인

- 동일 로그인 토큰을 유지한 상태로 계정을 비활성화하고 Data API, 세 Storage 버킷의 읽기/쓰기, 완료 API가 거절되는지 확인한다.
- 4.5MB보다 큰 실제 휴대폰 녹화와 퀴즈 음성을 저장·재생하고, 도중 질문 변경·접속 끊김·재시도를 검증한다.
- 학생이 처음 답하기 → 도움 받기 → 나중에 같은 질문 재답변하기 흐름과 유료 음성/피드백 품질을 확인한다.
- 채팅 15MB 첨부와 관리자 5MB HTML 등록도 직접 업로드로 전환했다. 담당 직원의 배정 권한을 업로드 완료 시 다시 검사한다. 원래의 파일 시그니처·HTML 계약 검사는 유지한다. 초기 bootstrap 조회와 전역 CSS 정리는 별도 작업이다.

근거: [Supabase Storage 접근 정책](https://supabase.com/docs/guides/storage/security/access-control), [표준 업로드와 6MB 이상 권고](https://supabase.com/docs/guides/storage/uploads/standard-uploads), [Vercel 요청·응답 한도](https://vercel.com/docs/functions/limitations).

## 2026-10-18 로컬 최종 검증

저장소 스냅샷을 새 임시 디렉터리에 풀고 개인 환경 파일 없이 npm ci를 실행했다. 전체 테스트 505개, bootstrap 실제 컴포넌트/query 검사 28개, 타입 검사와 프로덕션 빌드가 통과했다. 별도 로컬 PostgreSQL 임시 DB에서 전체 마이그레이션 및 RLS 검사 29개가 통과했다. 호스팅된 Supabase HTTP·Vercel 실배포·휴대폰·유료 AI 검증은 수행하지 않았다.


## 교재 원문 열람 경로

학생 열람과 관리자 미리보기 API는 HTML과 구조화 본문 대신 문서 ID·종류·해시·원문 URL을 반환한다. 발행 상태/현재 활성 계정/담당자 배정과 기존 원문 계약·해시 검증을 마친 뒤에만 URL을 발급한다. 관리자 확인 digest는 원본 데이터로 계산하므로 이전 발행 검수 절차는 유지된다.

Supabase 모드에서는 `document-originals` 비공개 버킷에 문서 ID/해시별로 보관한다. 브라우저의 직접 읽기·쓰기·변경은 허용하지 않고 서버만 60초 URL을 발급한다. 기존 교재도 첫 열람 때 검증된 DB 원문을 저장하므로 재등록할 필요가 없다. 이미 저장된 원문은 재업로드하지 않으며 동시 최초 요청의 중복 파일 응답만 허용한다. 저장소 장애 시 HTML JSON으로 우회하지 않는다. DB 원문은 계약 검증용으로 유지한다. 이 버킷은 임시 업로드 정리 대상이 아니며 교재 삭제 시 별도 보존 정책에 따라 정리해야 한다.

브라우저는 Storage에서 직접 바이트를 받은 뒤 SHA-256을 확인하고 구조화 본문을 추출한다. 원문은 기존 `sandbox=""` iframe에 넣어 실행 권한을 주지 않는다. 로컬 개발에서는 같은 인증/권한 검사를 거친 별도 원문 요청을 text/plain으로 제공한다. Supabase 모드에서는 이 로컬 원문 경로를 차단한다.

배포 전에 새 마이그레이션과 서버 전용 키를 적용해야 한다. 실제 Supabase/Vercel에서 5MiB 교재 등록 → 관리자 미리보기/확인 → 발행 → 학생 원문 열람을 확인하고, 개발자 도구에서 원문 바이트가 Storage로부터 전송되는지 확인한다. 기존에 발급된 URL은 비활성화 후에도 만료까지 최대 60초 유효하다.

추가 원문 분리 검증: 계약을 통과하는 정확히 5MiB HTML로 작은 메타데이터 응답과 원본 바이트 보존을 확인했다. 서버/브라우저 원문 전달 회귀 검사 6개, PostgreSQL RLS 검사 32개, 로컬 HTTP/PostgreSQL 교재 통합 검사 97개가 통과했다. HTTP 검사의 합성 계정 5개는 모두 정리했다. 프로덕션 빌드도 통과했다. 실제 Supabase Storage HTTP·Vercel 배포 검증은 별도로 남아 있다.

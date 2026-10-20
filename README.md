# 각자ON — 각자의답 웹앱

각자의답의 학습 서비스 **각자ON**입니다. 학생의 활동·지원 학교 기준·회상·모의면접·피드백·새 답변을 같은 맥락으로 연결하는 Next.js/PostgreSQL 웹앱입니다. 현재 제품 요구사항은 [서비스 PRD v2.2](확정안/4.%20서비스_PRD_v2.2.md), 문서별 적용 범위와 원문 보존은 [문서 정본 색인](docs/document-authority.md)을 따릅니다. 과거 구현 설명과 QA는 당시 범위의 기록이며 현재 모든 기능의 통과 선언이 아닙니다. Supabase 전환을 준비하며 Expo 앱은 이번 웹 작업에 포함하지 않습니다.

학습 개선의 기준은 완료 개수보다 **자신의 말로 설명한 요소·도움 이용·새 독립 답변·경과 시간·실제 발화 관찰**입니다. [개선·검증 요약](docs/learning-remediation.md)에 현행 구현과 잔여 인수 게이트를 정리했습니다. [후속 QA 화면 보고서](.local/learning-remediation-2026-10-14/report.html)는 [변경 전 24장 QA](.local/learning-audit-2026-10-14/report.html)를 그대로 보존하고 수정 후 같은 시나리오의 화면·저장값을 별도로 연결합니다. 실제 학생의 장기 기억이나 실력 향상은 별도 확인 대상입니다.

## 실행

Node.js 22 이상과 npm을 사용합니다. 기본 포트는 3000번이며, Windows 실행 파일을 사용하면 실행 완료 메시지에 표시된 실제 주소로 접속합니다.

Windows에서는 루트의 `start server.bat`를 더블클릭하면 됩니다. PostgreSQL과 웹 서버를 백그라운드로 실행하고 준비가 끝나면 브라우저를 엽니다. 기본 3000번 포트를 사용할 수 없으면 3100번부터 사용 가능한 포트를 선택하고, 실제 주소를 출력합니다. `.env`의 `PORT`로 기본 포트를 지정할 수도 있습니다. 이미 실행 중인 서버와 직전 실행 포트는 재사용하며, 원격 PostgreSQL 설정에서는 로컬 DB를 시작하지 않습니다. 로그는 `.local/logs/postgres.log`와 `.local/logs/web.log`에 저장합니다. 기존 테스터 계정과 데이터는 다시 생성하지 않습니다.

```powershell
npm install
# 터미널 1: 실제 PostgreSQL 프로세스, 127.0.0.1:54329
npm run db:start
# 터미널 2: 최초 실행 또는 migration 추가 후
npm run db:setup
npm run dev
```

로컬 DB 파일은 `.local/postgres`에 저장합니다. Windows의 한글 경로 문제를 피하기 위해 임시 ASCII junction을 사용하며 실제 데이터는 작업 폴더에 남습니다. Docker는 필요하지 않습니다. `db:seed`를 다시 실행해도 기존 학생 답변과 학습 데이터는 초기화하지 않습니다.

프로젝트 루트 `.env.local`은 DB·개인 키, `.env`는 비밀이 아닌 기본값, `.env.example`은 입력 예시입니다. 웹과 실행 스크립트는 프로세스 → `.env.local` → `.env` 순서로 읽습니다. 설정을 바꾸면 서버를 재시작하세요. 자세한 내용은 [환경 설정](docs/environment.md)에 있습니다.

## 테스트 계정

학생부·개인 활동·답변은 합성 테스트 데이터입니다. 학교 공통 자료에는 실제 학교와 공식 출처가 포함될 수 있으므로 개인 합성 기록, 대학 인재상, 전형 운영 자료, 서비스 연습 질문을 구분합니다.

| 역할 | 이메일 | 자료 |
| --- | --- | --- |
| 관리자 | admin@gakja.test | 운영 화면 |
| 학생 | harin@gakja.test | 현재 학교 등록부터 다시 시작할 수 있도록 초기화한 상태 |

2026-10-20 요청에 따라 도윤·발행 대기·담당자 테스트 계정은 로컬 백업 후 삭제했습니다. 초기 계정 생성 스크립트도 관리자·하린만 유지하며 삭제한 계정을 다시 생성하지 않습니다. `db:seed`는 하린의 합성 예시 교재를 다시 추가할 수 있으므로 초기화한 가입 흐름을 확인할 때는 재실행하지 마세요.

테스터 비밀번호는 서버의 `TEST_ACCOUNT_PASSWORD` 설정을 확인합니다. 실제 인증 값을 문서에 보관하지 않습니다. 학생 교재는 DB/인증 경로에 비공개로 저장하고, 과거 두 책 발행본과 새 FINAL 가이드북 발행본은 각각 당시 버전으로 보존합니다.

## 화면 구조

| 주 메뉴 | 주요 자식 화면·내용 |
| --- | --- |
| 오늘 훈련 `/my` | 실제 면접 일정·하루 가능 시간·진단 관찰에 따른 누적 복습 → 집중 보완 → 연결 면접 → 정리. 첫 진단 `/my/diagnosis`, 개별 훈련 `/my/train`, 학습 시간 수정 `/availability` |
| 준비 현황 `/preparation` | 학교별 일정과 남은 학습 시간, 학생부·내 경험별 본질문·꼬리질문·글·음성 답변·도움·확인 메모. 활동·교재·교육자료와 연결 |
| 내 기록 `/records` | `sessions/[id]`, `reports/[id]`, `history`, `comparisons/[questionId]` · 당시 답변·발화·도움·시간과 재답변 비교 |

직접 연습 `/learn`, 퀴즈 `/quiz`, 모의면접 `/interview`, AI 비서 `/on/[threadId]`는 오늘 훈련의 하위 기능입니다. 준비 현황에서는 내 경험 `/armory`, 교재·활동·질문·브리핑 `/materials`, 지식한입 `/knowledge`, 지원 학교 `/schools`, 사실 확인 `/account/confirmations`으로 이동합니다. 계정 설정은 `/account/settings`에 있습니다. 관리자 `/admin`은 학생·과제·대학별 기준·일정·콘텐츠 등록·이력·검수·공용 자료·설정을 별도 레이아웃으로 제공합니다.

데스크톱과 모바일은 모두 **오늘 훈련·준비 현황·내 기록**의 세 메뉴를 사용합니다. 목록과 상세 URL, 기존 `/practice`, `/chat`, `/interview/new?kind=chat|video` 진입 주소를 유지합니다. 가입 후 학교·학과·전형을 연결하고 평일·주말, 수능 전후, 쉬는 날과 날짜별 예외 시간을 설정합니다. 준비 기간은 가입일과 실제 전형 일정으로 계산하며 가까운 7일만 자세히 보여줍니다. 공개 면접기간의 시작일은 개인 확정일이 아닌 준비 목표로 표시합니다. 배분·기록·제약과 검사 명령은 [혼합형 면접 훈련](docs/hybrid-training.md)에 정리했습니다.

Pretendard variable font, 밝은 배경과 짙은 글자, 관련 내용의 들여쓰기·여백을 사용합니다. 반복 설명·과도한 괘선·둥근 박스·굵기 경쟁을 줄이고 다음 행동을 앞세웁니다. 로고의 `#00EE77`과 원본 비율·형태를 유지하고 밝은 바탕의 얼굴 요소는 흰색으로 사용합니다. 첫 페이지는 중앙 로그인이며, 로그인 로고는 시계방향 90° 실제 회전 후 멈추는 1초 주기의 GSAP 모션과 reduced-motion 설정을 적용합니다. 모션 변화는 저장·학습 향상의 증거와 구분합니다.

퀴즈 풀이와 모의면접 답변을 저장할 때 학습 기록도 함께 누적합니다. **학습 마치기** 또는 로그아웃에서 리포트를 확정하고, 창 종료 신호가 유실되면 다음 접속에서 저장된 기록으로 복구합니다. 확정 리포트는 당시 답변을 보존하며 측정하지 않은 점수나 발화 지표를 추정하지 않습니다.

## Supabase 연결

1. Supabase PostgreSQL의 직접 연결 또는 session pooler URL을 `DATABASE_URL`에 설정합니다. 기본 transaction pooler 대신 session pooler를 권장하는 현재 구현입니다.
2. `DATABASE_SSL=true`, `AUTH_MODE=supabase`, `ALLOW_LOCAL_AUTH=false`로 변경합니다.
3. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`을 설정합니다.
4. `npm run db:migrate`를 실행합니다. SQL migration은 로컬 PostgreSQL과 Supabase를 구분해 RLS를 적용하고, Supabase에는 기본 비공개 `student-media` 버킷과 소유자 접근 정책을 구성합니다. `SUPABASE_MEDIA_BUCKET`을 다른 이름으로 바꾸면 해당 비공개 버킷과 접근 정책도 별도로 준비해야 합니다.
5. 테스트용 Supabase 프로젝트에서 `npm run seed:supabase`를 실행합니다. Supabase Auth 사용자 ID와 DB 프로필을 일치시키고 동일 테스터 계정을 생성합니다. 실제 서비스 계정과 분리된 테스트 프로젝트에 사용하세요.

Supabase Authentication URL configuration에 사이트 URL과 `/auth/callback` 복귀 주소를 등록합니다. 초대·비밀번호 재설정 메일은 아래 링크 형식을 사용합니다.

```text
초대:
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/invite

비밀번호 재설정:
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
```

Supabase 모드에서는 검증된 Auth 사용자와 DB 역할을 함께 검사합니다. `user_metadata.role`로 권한을 부여하지 않습니다. 초대·복구 링크로 검증된 일회성 세션에서만 새 비밀번호를 설정합니다. 로컬 모드에서 재설정 메일을 보냈다고 표시하지 않습니다. [Supabase SSR 문서](https://supabase.com/docs/guides/auth/server-side/creating-a-client?queryGroups=framework&framework=nextjs)를 기준으로 cookie 갱신을 구성했습니다.

비공개 학생 파일은 인증 API를 통해 제공합니다. 로컬 녹화는 PostgreSQL bytea에, Supabase 모드 녹화는 비공개 Storage에 저장합니다. 학생 교재를 `public` 폴더에 배포하지 않습니다.

## OpenAI 연결

`.env.local`의 `OPENAI_API_KEY`에 본인 API 키를 설정하고 개발 서버를 다시 시작합니다.

```dotenv
OPENAI_MODEL_CHAT=gpt-5.6-terra
OPENAI_MODEL_INTERVIEW=gpt-5.6-terra
```

[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)의 Responses API와 구조화 출력을 사용합니다. 챗은 학생·지원처·발행 버전·선택 활동·질문·승인 브리핑만 사용하고 허용 근거 ID를 검증합니다. 대화는 당시 자료를 보존합니다.

2026-10-14 사용자 결정으로 녹음 전사는 `gpt-4o-mini-transcribe`, 화면용 문장 정리는 `gpt-6-luna`를 사용합니다. 같은 서버 키 하나를 공유하고 두 단계가 끝난 정리본을 일반 답변 영역에 표시합니다. 원전사는 별도로 보존해 습관어·반복·실제 발화 관찰에 사용하며 정리본을 실력 향상이나 새 시도로 집계하지 않습니다. 정리 실패 시 원음/원전사를 유지하고 원전사 확인·정리만 재시도를 제공합니다. 자세한 설정과 검증 상태는 [전사·화면용 정리](docs/transcription-pipeline.md)에 있습니다.

```dotenv
STT_PROVIDER=openai
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
TRANSCRIPT_CLEANUP_ENABLED=true
OPENAI_TRANSCRIPT_CLEANUP_MODEL=gpt-6-luna
OPENAI_TRANSCRIPT_CLEANUP_TIMEOUT_MS=25000
```

TTS는 기존 `SPEECH_PROVIDER=google`을 유지합니다. STT/TTS 설정과 실제 호출 상태를 분리하며 오류 시 다른 모델·공급자로 자동 우회하지 않습니다. 설정을 바꾸면 개발 서버를 다시 시작하세요. 이 모델 변경의 실행 결과는 이번 전환 검증에 기록하며 아래 이전 QA 수치를 재사용하지 않습니다.

키가 없는 상태에서는 챗이 명확한 연결 오류를 표시합니다. 발행된 질문으로 면접 연습·답변 저장·훈련·자기 점검 리포트는 사용할 수 있습니다. 없는 AI 응답이나 합격 점수를 만들어 표시하지 않습니다. 실제 모델 접근권한·과금·응답 성공은 제공할 API 계정으로 별도 확인해야 합니다.

## 콘텐츠 등록

관리자에서 학생과 연결 제작 건을 선택하고 외부 검수가 끝난 최종 가이드북 HTML 한 파일을 등록합니다. 파일에는 `<script type="application/json" id="gakja-learning-pack">` 승인 데이터 블록이 있어야 합니다. 검증 후 원본 교재를 미리 보고 확인한 뒤 발행합니다. 활동별 지원처 평가와 질문·퀴즈를 같은 데이터로 연결하며 기존 학습 기록과 이전 두 책 발행본은 보존합니다. 자세한 운영은 [최종 가이드북 등록](docs/final-guidebook-import.md)을 따릅니다.

공유 계약은 `packages/content-contracts/src/index.ts`입니다. 스키마 1.2.0, 확정 목차 v1.1, 패키지·내용 버전·학습 해시, ID 및 참조, 지원처와 제작 건을 검사합니다. 기존 두 책 계약도 유지합니다. 미리보기 확인은 해당 교재 원본과 데이터 해시에 연결되고, 새 버전과 이전 버전 복귀를 구분합니다. 학생 작성본·대화·훈련·과거 리포트는 import로 덮어쓰지 않습니다. 학습 화면은 구조화 blocks를 표시하고 원본은 실행 권한 없는 sandbox iframe으로 열 수 있습니다.

학습 계약을 따르는 합성 fixture 생성 함수와 테스트가 공유 패키지에 있습니다. 현재 신규 등록은 **FINAL 가이드북 HTML 한 파일**입니다. PDF 인쇄본 연결·동일 버전 검수는 별도 후속 범위이며 과거 두 책 계약은 기존 발행본 호환·복귀를 위해 유지합니다.

## 학교 선택과 면접 일정

현행 가입 흐름은 학교 → 실제 학과/모집단위 → 전형 → 2027학년도 수시 면접 일정 자동 조회 → 등록 확인입니다. **2027학년도 수시의 면접은 실제 2026년 날짜**를 조회하고 학년도와 실시일을 별도로 저장합니다. 날짜/공개 기간, 날짜 미정, 공식 면접 미실시, 자료 미확인, 조회 실패를 구분합니다. 공개 기간을 개인 배정 시각으로 바꾸거나 시간 없는 일정에 임의 시각을 만들지 않습니다.

88개 학교는 책 본문이 확인된 출발 목록이며 모든 학과·전형 운영 사실이 검증됐다는 뜻이 아닙니다. 학교 인재상·학과 교육목표·전형 평가요소·서비스 질문 비중도 별도입니다. [대학 공식자료 적용 계약](docs/university-source-contract.md)과 [일정 연동](docs/admission-calendar.md)에 출처·확인 범위·관리자 변경 책임을 기록합니다. 이번에는 격리된 첫 사용자로 서울시립대 환경공학부·전형·공개 일정 검토/등록·캘린더와 학교 인재상 질문 진입을 확인했습니다. 실제 소셜 가입 왕복과 88교 전 학과·전형의 동일 품질은 아직 인수 게이트입니다.

## 검증

2026-10-14 후속 검증은 선택 순수 검사 87/87, 격리 PostgreSQL 학습 기록 검사 85개, 퀴즈 HTTP 검사 81개, 학교 등록 HTTP 검사 42개와 최종 타입/빌드를 통과했습니다. 브라우저에서 같은 질문의 회상 → 도움을 받은 면접 → 새 탭 복귀 → 리포트 → 보완 과제 → 답변 비교와 첫 학교 등록을 실행했습니다. 운영 `public` 62개 테이블의 행 수·digest는 모두 동일했습니다. 서로 다른 검사 수를 더해 전체 기능 커버리지로 해석하지 않으며, [후속 QA](.local/learning-remediation-2026-10-14/report.md)에 화면·저장 증거와 미검증 범위를 구분합니다.

```powershell
npm run typecheck
npm run build
npm test --workspace=@gakja/content-contracts
node --import tsx scripts/smoke-api.mts
node tests/security-ai.mjs
node --import tsx --test tests/schedule.test.ts
node --import tsx tests/briefing-thought-api.mts
node tests/chat-composer.mjs
node --import tsx --test tests/quiz-rules.test.ts tests/planner.test.ts tests/knowledge-bites.test.ts
node --import tsx tests/quiz-api.mts
node --import tsx tests/planner-api.mts
node --import tsx tests/knowledge-bites-api.mts
node --conditions=react-server --import tsx tests/study-session-api.mts
```

HTTP 검사는 실행 중인 로컬 DB·개발 서버를 대상으로 임시 합성 데이터를 사용하며 종료 후 검사 데이터를 정리합니다. 권한 격리, 등록·발행·복귀, revision 충돌과 기록 보존, 복습 큐, 미등록 키 처리, 세션 재접속, 비공개 미디어·Range 다운로드, 전사 정정 이력을 검사합니다. 실제 OpenAI 요청은 검사에 포함하지 않습니다.

## 후속 범위

현재 웹의 구현과 실제 외부 환경 검증은 구분합니다. Supabase 실계정, 실제 소셜 인증 왕복·AI/음성 공급자, Vercel 배포, Expo 앱, PDF 연결, iOS·Android의 녹음/STT 정정·재녹음, 큰 파일 직접 업로드, 작업 복구, 실시간 음성, pgvector는 각각 별도 검증/후속 게이트입니다. RMS 기반 음량·쉼 관찰 경로가 있어도 원음 정확도·한국어/잡음/기기 품질을 실측해야 합니다. 얼굴·시선으로 성격이나 진실성을 추정하지 않습니다. 현재 미디어는 제한된 크기(20MB)의 인증 API 업로드 경로이므로 운영 배포 전 직접 업로드를 확인해야 합니다. 지식한입은 확인된 자료/영상의 주제 매칭을 사용하며 영상의 자동 수집·내용 이해를 완료했다고 주장하지 않습니다.

운영 환경에는 `.env`를 업로드하지 않고 환경변수로 설정합니다. Vercel Root Directory는 `apps/web`이며 저장소 루트의 lockfile을 함께 사용합니다.

등록된 88개 학교의 면접 일정은 아컨의 수시 일정에서 면접 항목만 수집해 PostgreSQL에 보관합니다. 갱신·날짜 미수록 학교·검증 범위는 [면접 일정 연동](docs/admission-calendar.md)을 참고하세요. 새 환경에서는 migration 적용 후 `node --import tsx scripts/sync-acon-calendar.mts`를 실행합니다.

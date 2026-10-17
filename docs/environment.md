# 환경 설정

> 현행 계약·검증 갱신: 2026-10-14. [문서 적용 순서](document-authority.md)와 [서비스 PRD v2.2](../확정안/4.%20서비스_PRD_v2.2.md)를 따른다. [개선·검증 요약](learning-remediation.md)과 [후속 QA](../.local/learning-remediation-2026-10-14/report.md)·[화면 보고서](../.local/learning-remediation-2026-10-14/report.html)에 실제 API/저장값·학교 등록·같은 질문의 학습 연결 검증을 기록했다. 아래 이전 테스트와 화면은 당시 범위로 보존한다. 실제 OAuth·Live/STT·장기 회상·88교 전 학과 콘텐츠 품질·운영 보안은 후속 인수 게이트이며, 이번 결과가 모든 기능이나 실제 학습 효과의 완료를 뜻하지 않는다.

## 2026-10-14 모델·키와 검증 상태

추가 학습 AI를 사용하더라도 기존 서버 전용 `OPENAI_API_KEY` 하나를 공유한다. 학생별 키나 브라우저 키를 새로 만들지 않는다. 기존 `OPENAI_MODEL_CHAT`·`OPENAI_MODEL_INTERVIEW`의 실제 모델 선택을 존중하고 호출 기능·루브릭/프롬프트 버전·사용량·실패를 분리해 기록한다.

2026-10-14 사용자가 STT를 `gpt-4o-mini-transcribe`, 화면용 후가공을 `gpt-6-luna`로 명시 변경했다. 두 단계는 기존 서버 `OPENAI_API_KEY` 하나를 공유한다. `STT_PROVIDER`는 전사 공급자, `SPEECH_PROVIDER`는 기존 낭독/TTS 공급자 설정으로 구분한다. TTS는 2026-10-17 사용자 요청에 따라 기존 OpenAI 키를 쓰도록 전환했다. 스트리밍 중계·Face/VAD·배치 정렬을 환경 변수만으로 활성화했다고 표시하지 않는다.

이번 문서 통일에서 .env/.env.local의 비밀 값·DB 주소·OAuth/Google 자격 증명을 수정하지 않았다. 실제 공급자 왕복·모델 가용성·한국어 음질과 측정 품질은 제공된 계정·기기로 별도 검증해야 한다.

프로젝트 루트의 `.env.local`에 DB 주소, 비밀번호, 서비스 키와 개인 설정을 보관한다. `.env`는 인증 방식·모델·언어 등 비밀이 아닌 기본값을 담고, `.env.example`은 새 환경을 위한 빈 키 예시다. 기존 설정 값은 유지했으며 알 수 없는 사용자 키는 `.env.local`에 보존한다.

Next, 실행 배치 파일, DB 시작·마이그레이션·테스터 생성·API smoke 스크립트는 `scripts/load-env.mjs`를 공통으로 사용한다. 우선순위는 **이미 주입한 프로세스 환경 변수 → 루트 `.env.local` → 루트 `.env`**다. 빈 문자열도 명시한 값으로 취급한다. 경로는 스크립트 파일에서 계산하므로 실행 디렉터리와 무관하다. `apps/web` 안에 환경 파일을 중복해서 만들지 않는다.

`.env`, `.env.local`과 개인 환경 파일은 `.gitignore`로 제외한다. `.env.example`에는 실제 인증 값을 넣지 않는다. 서비스 계정 JSON은 `.local/` 등 버전 관리에서 제외된 위치에 보관한다. 공개 변수는 빌드 시 브라우저에 포함될 수 있으므로 DB 주소·서비스 역할 키·AI 키·Google 인증 값에 `NEXT_PUBLIC_`를 붙이지 않는다.

## 로컬 실행

현재 로컬 DB 주소와 테스터 비밀번호는 `.env.local`에 그대로 유지했다. `start server.bat`를 실행하면 DB에 연결한 뒤 사용 가능한 웹 포트를 선택한다. 마지막 앱 포트는 `.local/server.json`에 기록한다. 3000번을 사용할 수 없으면 3100~3119번에서 선택하며, 이미 실행 중인 앱은 재사용한다. 새 포트가 선택되면 해당 실행의 `NEXT_PUBLIC_APP_URL`도 로컬 주소에 맞춘다.

새 환경에서는 `.env.example`을 루트 `.env.local`로 복사한 뒤 `DATABASE_URL`과 테스터 생성용 비밀번호를 직접 설정한다. `DATABASE_URL`은 실제 사용자·비밀번호·호스트·포트·DB 이름이 포함된 PostgreSQL 연결 문자열이어야 한다. 로컬 `db:start`는 `localhost`와 `127.0.0.1`만 허용한다. 기존 로컬 PostgreSQL을 사용하는 경우 URL의 사용자와 비밀번호가 실제 DB와 일치해야 한다.

| 설정 | 역할 |
|---|---|
| `DATABASE_URL` | DB 연결과 로컬 PostgreSQL 시작의 기준. |
| `DATABASE_SSL` | `true`이면 서버 인증서를 검증하는 TLS 연결. 로컬 기본은 `false`. |
| `AUTH_MODE`, `ALLOW_LOCAL_AUTH` | 로컬 테스터 인증은 `local`, `true`. 운영 Supabase는 `supabase`, `false`로 설정. |
| `TEST_ACCOUNT_PASSWORD` | 테스터 생성과 API smoke의 로그인 값. 원격 테스터는 기본 비밀번호 사용 금지. |
| `PORT` | 선호 웹 포트. 비워 두면 자동 선택. 실제 실행 주소는 `.local/server.json` 확인. |
| `NEXT_PUBLIC_APP_URL` | 인증 콜백의 앱 주소. 배포에서는 실제 HTTPS 도메인으로 설정. |
| `LOCAL_PG_PORT`, `LOCAL_PG_PASSWORD` | 기존 호환 설정으로 보존. 현재 로컬 DB 스크립트는 이 값 대신 `DATABASE_URL`을 사용. |
| `SMOKE_BASE_URL` | 선택한 API smoke 대상 주소. 없으면 마지막 실행 주소, 앱 주소 순으로 선택. |

아래 검사는 DB·웹 서버를 시작하거나 외부 서비스를 호출하지 않는다.

```powershell
node scripts/start-server.mjs --check-config
```

환경 파일을 바꾸면 웹 서버를 재시작한다. 이미 실행 중인 서버의 환경이 자동으로 갱신되지는 않는다. 배포의 `NEXT_PUBLIC_` 변경은 새 빌드에 반영한다.

## Supabase

실제 프로젝트의 `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`를 `.env.local` 또는 배포 환경에 설정한다. `AUTH_MODE=supabase`, `ALLOW_LOCAL_AUTH=false`, `DATABASE_SSL=true`로 전환한다. `SUPABASE_MEDIA_BUCKET` 기본 이름은 `student-media`이며 기존 migration이 같은 이름의 비공개 버킷과 소유자 접근 정책을 구성한다. 직접 업로드는 student-media 버킷 이름을 검증하며 다른 이름을 자동 허용하지 않는다. 채팅 첨부는 student-chat-files, 가이드북 임시 원문은 content-imports 비공개 버킷을 사용한다. 환경 변수의 이름을 바꾸는 것만으로 Storage 버킷이나 정책이 생성되지는 않는다.

`db:migrate`는 지정된 DB에 스키마를 적용하고, `seed:supabase`는 원격 테스터를 만든다. 이번 환경 정리에서는 테스터를 다시 생성하거나 기존 학습 데이터를 초기화하지 않았다.

## AI와 음성

`OPENAI_API_KEY`는 서버 전용이다. 질문·코칭·리포트 모델은 기존 `OPENAI_MODEL`, `OPENAI_MODEL_CHAT`, `OPENAI_MODEL_INTERVIEW` 값으로 유지한다. `AI_DAILY_REQUEST_LIMIT`는 학생별 일일 요청 한도다. 키가 비어 있으면 외부 텍스트 AI를 호출하지 않는다.

새 전사 흐름은 비공개 녹음 → OpenAI STT 원전사 저장 → OpenAI 화면용 정리 → 완료된 정리본 표시다. 저장/발화 관찰의 원전사와 화면용 정리본, 학생 직접 정정문을 구분한다. 문장부호·띄어쓰기·줄바꿈 등 가독성을 다듬되 경험·근거·수치·태도·확신을 보충하지 않는다. 후가공 실패 시 원음/원전사를 보존하고 실패와 재시도를 표시하며 정리된 답변인 것처럼 보여주지 않는다. 자세한 계약은 [전사·화면용 정리](transcription-pipeline.md)를 따른다.

| 전사·후가공 설정 | 값·역할 |
|---|---|
| `STT_PROVIDER` | 현행 `openai`. TTS 선택과 독립. |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe`. JSON 원전사, 언어/용어 힌트, 습관어 보존 요청. |
| `TRANSCRIPT_CLEANUP_ENABLED` | 현행 `true`. 화면용 정리 단계를 사용. 비활성 상태를 후가공 완료로 표시하지 않음. |
| `OPENAI_TRANSCRIPT_CLEANUP_MODEL` | `gpt-6-luna`. Responses API의 구조화 출력, `reasoning.effort=none`. |
| `OPENAI_TRANSCRIPT_CLEANUP_TIMEOUT_MS` | 기본 `25000`, 허용 5,000–30,000ms. 실패 시 모델 자동 우회 없음. |
| `SPEECH_PROVIDER` | `openai`. 기존 서버 키로 Live 질문 낭독. |

STT API의 파일 한도와 앱의 업로드 한도는 다르다. `gpt-4o-mini-transcribe`의 공식 파일 전사 한도는 25MB이며 현재 앱의 인증 미디어 업로드는 더 작은 20MB 한도를 따른다. 이 모델에서 Whisper 방식 단어 타임스탬프를 제공한다고 가정하지 않는다. 쉼은 실제 음량 관찰, 습관어·반복은 원전사를 사용한다. [OpenAI 전사 모델](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe), [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

낭독은 `SPEECH_PROVIDER=openai`, `OPENAI_TTS_MODEL=gpt-4o-mini-tts`를 사용한다. 2026-10-17 실제 Live 질문 MP3 생성·저장 공급자 검증을 통과했다. 마이크 녹음·전사·청취 품질 전체 검증을 뜻하지 않는다. 아래 Google 값은 Google 공급자를 명시적으로 선택할 때만 필요하다. 인증 값이 없으면 설정 필요 상태로 처리하며 다른 공급자로 자동 전송하지 않는다. Google 프로젝트 ID, 서비스 계정 경로, 액세스 토큰은 추정하지 않고 빈 값으로 남긴다. 아래 Google STT 값은 이전 공급자 경로의 호환 설정이며 현행 OpenAI STT의 필수 값이 아니다.

| Google 설정 | 값·역할 |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | 실제 Google Cloud 프로젝트 ID. |
| `GOOGLE_APPLICATION_CREDENTIALS` | 사용할 서비스 계정 JSON의 절대 경로. 값과 파일을 브라우저에 전달하지 않음. |
| `GOOGLE_SPEECH_ACCESS_TOKEN` | 서비스 계정 파일 대신 명시할 임시 액세스 토큰. 만료 후 갱신 필요. |
| `GOOGLE_STT_LOCATION` | 이전 Google STT 호환 지역 `us`. 국내 처리 전용으로 표시하지 않음. |
| `GOOGLE_STT_MODEL` | 이전 Google STT 호환 모델 `chirp_3`. 현행 STT는 OpenAI. |
| `GOOGLE_STT_LANGUAGE_CODE` | 이전 Google STT 호환 언어 `ko-KR`. |
| `GOOGLE_TTS_LANGUAGE_CODE` | `ko-KR`. |
| `GOOGLE_TTS_VOICE_FEMALE` | `ko-KR-Chirp3-HD-Aoede`. |
| `GOOGLE_TTS_VOICE_MALE` | `ko-KR-Chirp3-HD-Charon`. |
| `GOOGLE_SPEECH_RELAY_URL` | 별도 실시간 음성 중계 서비스의 준비용 주소. 현재 빈 값이며 이 값만으로 스트리밍이 활성화되지 않음. |

서비스 계정 파일을 사용하는 경로와 임시 토큰 경로를 구분한다. 로컬 사용자 ADC 로그인이나 다른 ADC 방식은 현재 서버 어댑터가 지원하는지 확인해야 한다. Google Speech/Text-to-Speech API 활성화, 결제, 권한과 모델·지역 사용 가능 여부는 실제 프로젝트에서 검증해야 한다. 이번 정리에서 유료 호출이나 음성 정확도·청취 검증은 하지 않았다.

OpenAI 전사·정리 모델의 접근 권한은 실제 API 계정에서 확인한다. 현행 낭독 설정은 `SPEECH_PROVIDER=openai`와 `OPENAI_TTS_MODEL=gpt-4o-mini-tts`이며 전사 설정과 구분한다. 공급자 오류를 다른 공급자로 자동 우회하지 않는다.

별도 Cloud Run WebSocket 중계, GCS 배치 정렬과 장기 비동기 작업은 현재 Next 요청 중심 구조와 분리해서 준비해야 한다. 필요한 서비스가 없는 상태에서 환경 변수만 설정해 완료된 기능으로 취급하지 않는다.

배포 시 [출시 안정화 절차](release-stabilization.md)를 따른다. 활성 계정 RLS와 서버 발급 업로드 경로를 적용하는 20261017143841 migration을 앱보다 먼저 적용한다. 브라우저가 파일을 Storage로 직접 보내므로 Vercel의 4.5MB 요청 한도를 넘지 않는다. 운영 마이그레이션 적용과 실계정 HTTP 검증은 별도 수행 항목이다.

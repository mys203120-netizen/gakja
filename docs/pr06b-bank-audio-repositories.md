# PR06-B 질문은행·음성 Repository 구현·검증

2026-11-06 KST. **PR06-B의 기존 local 읽기·writer 추출 범위를 완료했다.** 기준은 `docs/architecture-blueprint-v2.html` §20·§21, `pr05-domain-contracts.md`, `pr06a-read-repositories.md`다. 평가 공급계약은 §14·PR03, 분석 생성검수규격은 기존 codec의 보완 명세로 유지한다. 철회 정책·독립 공통 분석 초안·수신 제안 envelope를 새 운영 저장 형식으로 사용하지 않는다. PR06 전체·운영 다사용자 저장·서비스 공개 완료는 아니다.

## 기준선과 환경

`main`, HEAD `a666f7a81dd2e80851f8589d135a0aac67c1eae2`. PR01~PR06-A와 사용자 수정은 미커밋·미추적 작업 트리에 존재한다. HEAD 단독 checkout은 기준본이 아니다. B 시작 시 A 최종 manifest와 비교하여 **1,733개 파일 모두 동일**함을 확인했다. 추가·변경·삭제 0개, source tree SHA `02b8449b441a50bf77281c86b0f6b3fce2d81a89a56110c075e92c0c2412c32c`다.

- BEFORE: `C:/Users/MaYunsong/Documents/gakja-pr06b-source-before-20261106/source-snapshot-manifest.json`.
- AFTER: `C:/Users/MaYunsong/Documents/gakja-pr06b-source-after-20261106-final/source-snapshot-manifest.json`. 실제 tree SHA·파일 수는 이 manifest와 `artifacts/pr06b/source-capture-after-final.log`에 기록한다. 전후 파일별 SHA와 보호 영역 비교는 `artifacts/pr06b/source-change-summary.json`이다.
- A와의 비교: `artifacts/pr06b/pr06a-baseline-comparison.json`.
- 설치 환경: Node `v24.16.0`, npm `11.13.0`, Python `3.11.9`, Next `16.4.3`, Windows PowerShell. OS·Git 상태는 `artifacts/pr06b/environment-before.json`에 있다.
- lockfile SHA: `c52e65258cdbf40ab562c68f97214e006492a3248588d7962453c669bd0be451`.
- BEFORE는 source만 복사했고 실행에 기존 node_modules junction을 사용했다. 새 npm ci 또는 clean-checkout 검증으로 표현하지 않는다. data·비밀키·node_modules·Git metadata·실행 artifacts를 source snapshot에 넣지 않았다.
- W0는 `각자의답NEW-w0` / `codex/w0-frontend`의 별도 작업이다. 이 backend 작업에 병합하지 않았고 진행률·통합 통과를 추정하지 않는다. stage/commit/reset/clean/stash/push/deploy/branch merge를 실행하지 않았다.

## 실제 읽기·쓰기 연결

| 실제 caller | 기존 I/O → port → local adapter | 남는 도메인 권위 |
| --- | --- | --- |
| `realtime.ts: requireQuestionBank` → `loadQuestionBank` | key의 ready JSON → `QuestionBankRepository.readReady(purpose: current)` → `local-question-bank-repository.ts` | context/source/활동/모델/음성 identity, bank content hash, row 순서·quarantine·candidate/승인/근거 검사 |
| 세션 복구 → `loadQuestionBankByPinnedPlan` | plan.poolKey의 ready JSON → `readReady(purpose: pinned)` | poolContentSha256, 고정 context·voice/model, 기존 plan/후보 검증; 누락·손상을 current로 대체하지 않음 |
| 준비 진단 → `loadQuestionBankPreparationSummary` | ready/partial JSON → `readReady` / `readPartial` | 확인된 후보만 계산; 명시적 content pin 불일치는 준비 정상 데이터로 우회하지 않음 |
| 준비 CLI·`prepareQuestionBank` | partial checkpoint, donor/ready 조회, ready 저장, partial 삭제 → `readPartial/readReady/writePartial/publishReady/removePartial` | generation·검수·예산·quarantine·후보 순서·중복 방지·최종 재검증은 그대로 도메인에 남음 |
| `validCandidate` 및 공개 verify/inspect | 기존 `data/audio/<speechHash>.mp3` → `AudioRepository.read(question-bank-validation)` → `local-audio-repository.ts` | question/voice → speech key, candidate/승인 계약·audioSha256·binary 대조 |
| `prepareQuestionBank`의 음성 저장 | 음성 tmp 작성→rename→cleanup → `AudioRepository.publish(publication: bank-atomic)` | 생성 결과 URL/key/비어 있지 않은 bytes 확인, 저장 후 실제 후보 검증, 이후 metadata checkpoint |
| `clova-tts.ts: synthesizeSpeech` → singleton `SpeechAudioCache` | disk cache read/plain background write → `AudioRepository.read/publish(publication: speech-cache)` | text/voice/settings key 계산, TTS fetch·35초 제한·응답 검증, inFlight·구독자 취소·RAM LRU·write 대기는 기존 위치에 유지 |
| `readSpeechAudio` / `readDurableSpeechAudio`, `/api/audio/:id` | RAM/durable cache 조회 → 같은 singleton·AudioRepository | read는 RAM 우선, durable은 write 완료 및 RAM/disk bytes 대조; 읽기에서 합성 호출 없음 |
| `approvedAudioReplay` → realtime의 이전 `questionAudioUrl` 재사용 → audio endpoint | 기존 순수 승인·원문 검증 후 URL 재사용, endpoint는 위 cache/port 사용 | 질문·anchor·ANSWER_TURN revision과 계약 검증 그대로. 순수 replay helper에 불필요한 I/O를 추가하지 않음 |

준비 writer도 실제 port를 사용한다. `prepared-question-bank.ts`와 `speech-audio-cache.ts`에 bank/audio 경로 조합과 fs 호출을 남기지 않았다. root resolve는 composition용이며 실제 directory/key/file/tmp 결정은 local adapter에 있다. `createQuestionBankProductionProviders`의 질문/TTS orchestration, 기존 question review authority·활동/source QA는 이번 저장소가 대신하지 않는다.

QuestionBankRepository는 ready/partial의 기존 도메인 타입을 사용한다. 은행 JSON을 generic envelope로 변경하지 않았다. AudioRepository는 정확한 기존 key의 durable bytes를 읽고 두 기존 writer 방식을 구분한다. 음성 metadata는 원래 candidate/bank에 있으므로 별도 metadata 파일을 발명하지 않았다.

scope는 owner, 알려진 student/target/PDF/record/common/target/profile, source content/fingerprint, bank key/content hash를 전달한다. 명시적 null은 알려진 context pin을 지우지 않는다. 현재 context에 없는 extraction `sourceRevision`은 null로 남기고, 외부에서 지정한 검증 불가능한 nonnull pin은 거부한다. 최신 source pointer를 다시 읽어 채우지 않는다. donor는 다른 revision이므로 알 수 없는 donor pin을 새 bank의 값으로 위장하지 않으며 기존 candidate 검증을 계속 통과해야 한다.

일반 음성 cache의 기존 전역 key에는 student/target 정보가 없으므로 이를 임의 삽입하지 않는다. local owner 검사는 운영 Auth/RLS나 다사용자 계정 격리의 완성이 아니다. 기존 `preparing` map의 root:key 수명과 CLOVA module의 singleton cache 수명을 보존했고 새 전역 cache를 도입하지 않았다.

## 저장·취소·실패의 보존 범위

- 은행 JSON과 bank audio는 기존 `mkdir(mode 0700)` → UUID `.tmp` `writeFile(mode 0600, flag wx)` → 단일 rename → finally unlink 순서를 유지한다. JSON의 들여쓰기·key/배열 순서·final bytes도 유지한다. 기존 코드에 없는 Windows rename 재시도를 추가하지 않았다.
- 일반 speech cache는 기존 plain `writeFile(mode 0600)`을 백그라운드에서 실행한다. RAM playback은 즉시 가능하고 durable 조회는 실제 write를 기다린다. cache 저장 실패는 기존 경고와 RAM 보존/durable null 의미를 유지한다.
- 같은 key의 provider 작업 공유, 다른 key의 독립 생성, 일부 구독자 취소, 마지막 구독자 취소, 늦은 provider 결과 폐기, 재시도, 저장 시작 후 취소의 기존 경계를 유지한다. provider와 generation 판단은 Repository 밖이다.
- 기존 한계도 유지한다. speech cache는 nonempty disk bytes의 내용 hash/codec을 자체 검증하지 않는다. 부분 plain write 후 프로세스가 재시작하면 남은 nonempty bytes를 cache hit로 읽을 수 있다. 은행의 별도 audioSha256 검증은 이런 불일치를 거부한다. 이를 새 추출의 crash 내구성으로 표현하지 않는다.
- bank/audio/metadata 전체를 묶는 트랜잭션은 없다. audio 저장 후 candidate 거부 또는 metadata 실패는 고아 음성을 남길 수 있다. cleanup 실패는 미완료 tmp를 남길 수 있으며 ready로 읽지 않는다. fsync, 전원 차단 복구, 다중 프로세스 lock/lease, DB/Outbox는 구현하지 않았다.

추가 scope 옵션 검토 중 명시적 bank content pin 불일치가 partial summary/재생성으로 이어질 가능성을 막았다. 유효한 pinned ready가 없으면 summary/prepare가 원본 쓰기나 provider 호출 전에 거부한다. 새 옵션의 검증 보강이며 기존 미지정 호출의 의미 정책을 바꾸지 않는다. A의 잘못된 recordRevision 재해시 거부도 그대로다.

## 변경 파일과 커밋 후보

| 이번 변경 | 파일·이유 |
| --- | --- |
| 기존 실제 caller 수정 | `server/data/prepared-question-bank.ts`, `server/providers/speech-audio-cache.ts`, `server/providers/clova-tts.ts`: 기존 읽기·writer를 주입 경계에 연결 |
| 신규 port/local adapter | `server/repositories/question-bank-ports.ts`, `local-question-bank-repository.ts`, `audio-ports.ts`, `local-audio-repository.ts`: scope·purpose와 기존 파일 동작을 분리 |
| 신규 회귀 | `tests/question-bank-repositories.test.ts`, `tests/audio-repository.test.ts`, `tests/pr06b-audio-caller.test.ts`, `tests/fixtures/pr06b-audio-caller.ts`: 실제 caller·writer·scope·부분 실패·새 프로세스 재읽기 |
| 독립 관측·비교 | `scripts/pr06b-bank-cases.ts`, `pr06b-audio-cases.ts`, `pr06b-private-evidence.ts`, `pr06b-compare-evidence.ts`: 선택한 고정 source-root에서 실행하고 결과/저장 이벤트를 비교 |
| 기록 | 이 문서와 `docs/architecture-implementation-status.md`: 완료 범위·미검증 관문·C 진입 조건 |

위 파일은 B의 커밋 후보이며 실제 stage/commit은 하지 않았다. 전체 재현 커밋에는 기존 PR01~A의 필요한 미추적 소스도 포함해야 한다. 시작 tracked-only closure는 **21개 edge / 11개 누락 파일**, 종료는 **29개 edge / 15개 누락 파일**이다. 새 8개 edge가 참조하는 신규 저장소 파일은 위 4개 port/adapter다. 정확한 기존·신규 파일 및 caller 목록은 `artifacts/pr06b/tracked-dependencies-before.json`, `tracked-dependencies-after.json`에 있다. edge 수를 파일 수로 표기하지 않는다.

커밋 제외 대상은 비공개 `data/`(학생 source/분석/은행/음성/세션/평가/검수), `.env*` 비밀키, node_modules, `.next`, Git metadata, `artifacts/` 실행 보고서와 합성 실패 주입 저장소다. 수신 원본 schema/보고서와 PR05 generated domain 계약은 변경하지 않았다. source-change-summary는 프런트·공동 설정·기존 계약·A source/analysis 구현의 불변성도 검사한다.

## 독립 비교와 실제 자료 불변

`artifacts/pr06b/repository-comparison.json`의 **53개 검사 통과, 실패 0**을 확인했다. BEFORE는 A 완료 후 B 직전 고정 snapshot의 실제 모듈, AFTER는 변경 후 실제 모듈을 실행한다. 같은 신규 helper를 양쪽에서 호출하지 않는다. 입력 fixture/해시·source module 해시도 기록한다.

- **은행 18건**: current/pinned/선정, missing/corrupt/hash 거부, 음성 손상과 복구, 예산·transport 실패 checkpoint 재개, 같은 bank 동시 준비 공유, audio/partial/ready의 ENOSPC·EPERM, 기존 ready 교체 실패. 결과·provider 수·ID·hash·최종 JSON/binary bytes와 순서 있는 저장 이벤트가 같다.
- **cache 17건**: memory/disk hit, 같은/다른 key 공유, 일부/전체/사전 취소, 늦은 결과·재시도, write 실패·저장 중 취소, empty/nonempty 손상, durable 불일치, LRU, provider 실패·빈 결과, partial write. 실제 기존/신규 cache와 default writer를 격리 디렉터리에서 실행했고 결과·경고·파일·이벤트가 같다.
- **실제 CLOVA 공개 caller 2모드**: 합성 fetch를 주입한 `synthesizeSpeech` → 실제 singleton cache → 실제 local writer와 새 프로세스의 재읽기. 같은 key를 공유하면서 한 구독자만 취소하고 다른 key도 생성한다. 생성 단계 합성 fetch 2회, 새 프로세스 재시작 뒤 두 음성 모두 disk hit(`sameKeyCache=otherKeyCache=disk`), reopen provider fetch 0회, 실제 상용 호출 0회. 생성/reopen의 동일 audio key·bytes/hash를 확인했다. `getOrCreate`를 mock한 시험이 아니다. PR06-C 진입 시 원본 before/after-clova-caller.json과 별도 execFile 호출을 확인해 기존의 “재시작 disk hit 0회”라는 문구만 정정했다. 제품 코드 수정이나 동일 시험 재실행은 필요하지 않았다.
- **비공개 read-only**: full/portable 실행 후에도 1,497개 파일·2,015,815,973 bytes 불변. 음성 492개를 포함한 audio/prepared/sessions/session-contexts/conversation-logs/evaluation-jobs/local 그룹의 파일 identity+binary SHA가 같다. 실제 current/pinned 은행 후보 35개, 고정 seed의 선정 5회·승인 replay, 실제 cache의 음성 35개 읽기·durable bytes가 같다. 쓰기·network 시도 0, 원문·학생 식별값 export 0이다.

비교 자료는 `bank-before-cases.json` / `bank-after-cases.json`, `before-audio-cases.json` / `after-audio-cases.json`, `before-clova-caller.json` / `after-clova-caller.json`, `before-private.json` / `after-private.json`이다. 각 명령은 scripts의 `--source-root`, 명시적 `--output` 및 private runner의 `--data-root`를 사용한다. CLOVA child는 `--source-root`, `--mode=generate|reopen`과 `pr06b-clova-*` 격리 cwd를 요구한다.

비결정성은 다음처럼 제한적으로 처리했다. bank writer는 동일한 고정 clock을 입력으로 주고, UUIDv4 tmp 이름의 철자만 일대일 ordinal로 표시한다. 원래 UUID 형식·대상·쓰기 mode/flag·순서·rename·오류·최종 bytes는 모두 검증한다. 서로 다른 audio key의 초기 저장 완료 순서는 BEFORE 반복에서도 달랐고 그 원본 로그를 보존했다. 최종 비교는 두 producer가 동시에 진입한 뒤 첫 저장 완료 후 둘째를 풀어 실행 순서만 통제했으며 이벤트 sort/drop은 하지 않았다.

private context의 `questionStrategies.generatedAt`도 B BEFORE 반복 실행에서 raw hash 차이와 나머지 projection/입력 불변을 확인한 뒤 이 필드 하나만 비교에서 제외한다. 최초·반복 BEFORE 및 AFTER raw hash는 보고서에 남긴다. 정본·payloadJson·파일을 정규화하지 않는다. 성능 duration 수치의 동일성을 주장하지 않고 유한한 비음수 범위·cache 종류·providerMs null 의미를 검증한다. 원본 파일 bytes, JSON.stringify/domain hash, transport payloadJson, audio binary SHA는 별도로 비교했다.

## 실행 검사와 남은 관문

다음은 B에서 실제 실행한 결과다. A의 89/1362/1163 통과는 이전 기록이며 합산하지 않았다. 로그는 모두 `artifacts/pr06b/`에 있다.

| 실행 | 결과·근거 |
| --- | --- |
| `npm test` | **1,372/1,372 통과**, skip/fail 0; `test-final.log` |
| `npm run test:portable` | **1,173/1,173 통과**, skip/fail 0; `portable-final.log` |
| `npm run typecheck` | 통과; `typecheck-verified.log` |
| `npm run lint` | 통과; `lint-final.log`; 이후 증거 스크립트는 `evidence-lint-verified.log` 별도 확인 |
| `npm run build` | production build 통과; `build-final.log` |
| `npm run verify:contracts` | 제안 52 shape + 4 UTF-16 + 4 추가 parity 통과; `contracts-final.log` |
| `npm run verify:domain-contracts` | 현행 38 shape + 32 transport + 8 span + 18 roundtrip 통과; 같은 로그와 `domain-contracts-validation.json` |
| `npm run verify:analysis-private -- --proposal=<확인한 기존 비공개 proposal> --output=artifacts/pr06b/analysis-domain-private-roundtrip.json` | 현재 Full/Target/wire exact, 활동 161·학업 57·정본 목적 34·근거 478; 과거 21개(v1 2/v2 19)와 보호 파일 불변 통과; `analysis-private-final.log` |
| `npm run verify:question-private` | runtime 목적 36·후보 35·승인 계약 35, 108개 envelope 및 기존 평가 결과 31개 검증 통과; `question-private-final.log`, `question-domain-private-roundtrip.json` |
| `npm run prepare:evaluation-scopes -- coverage` | 질문 승인 35 / 평가 규격 승인 **0** / 검수 대기 35, `scope_review_required`, sessionEvaluationReady=false, provider 0; `evaluation-coverage.log` |
| `node scripts/verify-source-closure.mjs --working-tree` | **1,685개 import 통과**; `source-closure-final.log` |
| tracked-only source closure | **exit 1**, 29개 미추적 dependency edge / 15개 파일; `tracked-closure-after.log` |
| `git diff --check` | 통과; `diff-check-final.log`; source manifest와 함께 확인 |

초기 typecheck는 새 `pr06b-bank-cases.ts`의 inventory 배열과 provider callback 매개변수의 implicit any 5개에서 실패했다. 명시적 타입만 추가했고 재검사에서 통과했다. `typecheck-initial.log`를 보존한다. 제품 코드 회귀나 W0 실패로 분류하지 않았다. 이후 변경은 증거 스크립트와 문서뿐이므로 비용이 큰 전체 테스트를 반복하지 않았다.

전체 범위는 `tests/*.test.ts`; portable은 [private-fixture-suites.json](../tests/private-fixture-suites.json)의 **21개 파일 전체를 제외**하며 그 안의 합성 시험도 빠진다. 이번 전체/portable 차이는 199개다. 제외 파일 목록은 바꾸지 않았고 PR06-A 기록에도 명시돼 있다. Python parity와 browser 진단은 별도 명령이며 npm test 개수에 섞지 않았다.

TS/Python 공통 검증은 형태·전달 scope·payload SHA·portable JSON·UTF-16 구간이다. 기존 source QA·승인·도메인 hash 재계산 권위는 TS에 남고 shape-valid/TS-domain-invalid 6건의 차이를 숨기지 않는다. 제안 계약의 Ajv 6 부분집합 projection을 Draft 2020-12 전체 지원이라고 표시하지 않는다. 기존 실행 보고서는 `prior-*`로 보관한 뒤 새 B 결과를 별도 복사했으며 수신 원본 보고서는 변경하지 않았다.

**G0 원격 관문 미완료:** 올바른 미추적 소스를 포함한 기준 커밋과 그 커밋의 실제 원격 CI가 필요하다. working-tree 성공이 이를 대신하지 않는다. 이번 새 npm ci·원격 CI·배포는 미실행이다.

**G1 실제 검수·미디어 미완료:** 실제 문항/종료 답변의 A/B 내용 검수와 실마이크·스피커·상용 STT/TTS 품질/통합 검증은 별도다. 이번은 합성 provider·bytes와 실제 로컬 fs/HTTP 회귀다. 브라우저 진단을 새로 실행하지 않았고 PR05의 실제 Chrome+합성 미디어 기록을 B 실행으로 세지 않는다. Windows 오류는 실제 local writer에 ENOSPC/EPERM을 주입한 시험이며 실기기 전원 차단·실제 파일 잠금 실험은 아니다.

**W0 별도:** 별도 worktree 미병합, 이 backend 결과를 W0 통합 검증으로 표현하지 않는다. 평가 승인 0·held-F·A/B 분리·원본 평가를 보존했고 PR04 의미 품질은 미완료다. 모델·음성 설정·질문 선정·면접 시간·과금 정책과 C/D 구현은 변경하지 않았다.

## 다음 PR06-C와 롤백

C는 이번에 구현하지 않는다. 진입 조건은 B의 실제 caller/읽기·writer·독립 비교·필수 검사 통과와 남은 환경 관문의 명시다. 다음 대상은 기존 `server/storage/local-session-store.ts`의 `SessionStore` / `LocalSessionStore`, `server/storage/conversation-log.ts`, `server/session-runtime.ts` 및 realtime의 load/context/log/checkpoint/save caller다. 기존 save-only 인터페이스를 재사용·확장하고 중복 SessionStore를 만들지 않는다.

C 회귀 기준은 owner/context hash, frozen input, 동일 answer/next/end 멱등성, 같은 종료 payload, 이벤트 순서/replay, 10분 복구, Windows atomic replace 재시도와 원본 세션 bytes 보존이다. 평가 registry/job/revision persistence 추출은 D에 남긴다.

B local composition 복구는 bank options의 주입을 제거해 기본 local bank/audio adapter를 사용하고, CLOVA는 `new SpeechAudioCache(createLocalAudioRepository())`를 유지하면 된다. 기존 `SpeechAudioCache(directory, maxBytes, maxEntries, persistBytes)` 생성자도 호환된다. 추출 전체를 되돌릴 때는 B 직전 snapshot과 B 변경 목록으로 해당 hunk만 역적용한다. A/PR01~05/사용자/W0 변경을 포함한 reset은 하지 않는다. 저장 형식·key가 같으므로 DB 역이관·실제 음성 재생성은 필요 없다.

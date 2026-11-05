# PR06-A 원문·분석 읽기 Repository 구현·검증 기록

2026-11-06 KST. 청사진 v2 §20·§21, PR05 계약 대응표를 기준으로 **PR06-A의 로컬 읽기 경계 추출을 완료했다.** PR06 전체, G2/G3 전체, 운영 Auth/RLS, DB 전환 또는 공개 완료를 뜻하지 않는다. 평가 공급계약은 §14·PR03의 보완 명세이며 기존 학생 분석 codec을 유지한다. 철회된 4대 정책과 superseded prototype은 사용하지 않았다.

## 기준선과 변경 범위

시작·종료 기준은 `main`, HEAD `a666f7a81dd2e80851f8589d135a0aac67c1eae2`다. PR01~05는 미커밋·미추적 파일을 포함한 작업 트리이며, 이 HEAD만 checkout하면 이번 검증 구현을 얻을 수 없다. 이번 작업에서 stage/commit/reset/clean/push하지 않았다.

| 기준 | 위치·결과 |
| --- | --- |
| 직전 PR05 snapshot | `C:/Users/MaYunsong/Documents/gakja-pr05-source-20261106-verified/source-snapshot-manifest.json`; tree SHA `b2536eb7b65aae80241eaa33320d5ca0966beeec36118c84212e5737c9c4c2cd` |
| PR06-A 변경 전 snapshot | `C:/Users/MaYunsong/Documents/gakja-pr06a-source-before-20261106/source-snapshot-manifest.json`; 1,724개 파일; tree SHA `612102bbeb087441dedea2f1a00666df5a64276128e972f04b4446f550667831` |
| PR06-A 변경 후 snapshot | `C:/Users/MaYunsong/Documents/gakja-pr06a-source-after-20261106-final/source-snapshot-manifest.json`; 실제 파일 수·tree SHA는 해당 manifest와 `artifacts/pr06a/source-capture-after-final.log`에 기록 |
| 전후 파일 차이 | `artifacts/pr06a/source-change-summary.json`: 파일별 SHA, 추가·변경·삭제 및 프런트/공동 설정 불변 여부 |
| lockfile | 전후 SHA `c52e65258cdbf40ab562c68f97214e006492a3248588d7962453c669bd0be451` |

PR05 snapshot 이후 코드 차이는 없었고, README·구현 기록·PR05 대응표 수정과 PR05 검증 문서 추가만 있었다. 근거는 `artifacts/pr06a/pr05-baseline-comparison.json`이다. 이 차이를 숨기거나 PR05의 과거 통과를 현재 실행 결과로 재사용하지 않았다.

전후 snapshot은 Git-visible 소스를 실제 bytes로 복사하고 manifest에 SHA를 기록했다. 비공개 `data`, 환경 비밀키, node_modules, Git metadata, 실행 artifacts는 포함하지 않았다. 변경 전 코드를 실행할 때만 기존 node_modules를 junction으로 연결했으며 **새 의존성 설치 검증이 아니다**. private 입력은 원래 data root에서 읽었다. 새 설치 검증은 PR05 기록의 별도 실행이다.

프런트 W0의 진행률은 추정하지 않는다. 이번 전후 manifest 비교에서 `app/`, `components/`, `hooks/`, `lib/`와 package/lockfile/Next/TypeScript/CI 설정을 확인한다. 이 영역을 수정할 필요가 없었고 전체 검사에서도 프런트 병렬 변경으로 인한 실패는 확인되지 않았다.

## 구현 파일과 실제 연결

| 변경 파일 | 변경 이유 |
| --- | --- |
| `server/repositories/analysis-read-ports.ts` | SourceRepository/AnalysisRepository, 명시적 scope·purpose·selection, 원본 bytes/path/SHA 반환 계약 |
| `server/repositories/local-read-repositories.ts` | 실제 경로 선택·조합·파일 읽기·최초 bytes 고정·freshness 비교를 맡는 local adapter와 factory |
| `server/data/full-student-analysis.ts` | current/staged/source/review 조회를 port에 연결; 기존 loader 반환 형식을 유지하고 snapshot 반환 경로 추가; 기존 도메인 검증 유지 및 record pin 누락 보강 |
| `server/data/load-interview-context.ts` | 한 호출의 repository를 source/analysis/policy에 공유; 처음 읽은 bytes로 manifest 생성; 기존 manifest writer 유지 |
| `server/data/staged-interview-context.ts` | base/staged/pinned PDF·cache 조회가 같은 repository를 사용; staged overlay와 current manifest 구분 유지 |
| `server/data/prepared-activities.ts` | full-analysis 분기의 정본·source 조회를 snapshot에 연결; legacy activities cache와 writer 유지 |
| `server/policy/interviewer-policy.ts` | context가 이미 읽은 MD bytes로 동일 정책 컴파일; 기존 단독 호출과 원래 읽기 실패 진단 유지 |
| `tests/analysis-read-snapshots.test.ts`, `tests/read-repositories.test.ts`, `tests/interviewer-policy.test.ts` | 실제 주입 경로, scope/pin, null/missing/fallback, bytes 고정·경쟁, 정책 bytes/오류 보존 회귀 |
| `scripts/pr06a-repository-evidence.ts` | 지정한 source-root의 실제 코드를 실행해 private 자료의 비식별 digest·불변성 수집 |
| `scripts/pr06a-repository-cases.ts` | 변경 전에 고정한 같은 익명 fixture로 독립 코드 트리별 정상·거부 35건 실행 |
| `scripts/pr06a-context-race-evidence.ts` | 메모리에서 포인터/정본 변경을 주입하고 혼합 context 방지 검증 |
| `scripts/pr06a-compare-repository-evidence.ts` | 구/신 관측치를 비교해 차이·한계와 89개 검사 결과 기록 |
| 이 문서, `docs/architecture-implementation-status.md` | 이번 완료 범위와 후속 관문을 기존 단계 기록과 구분 |

| 기존 직접 I/O / 실제 caller | Port | Local adapter | 계속 실행되는 기존 권위 |
| --- | --- | --- | --- |
| `loadInterviewContextAt`: 설정 PDF·MD·preparedStudent·dictionary 등 | `source.readConfiguredInputs` | `interviewConfig.files` 선택, readFile, bytes/SHA/error 보존 | 기존 cache/schema/source integrity/PDF 대조와 정책 compiler |
| `loadFullRecord`: full-record-current → source JSON | `source.readCurrentRecord` | current pointer와 record-revisions 경로, JSON/원본 bytes | `validateFullRecord`: content/page/block/UTF-16/source hash 및 scope 검사 |
| `loadFullStudentAnalysis`: analysis-current → current 분석 | `analysis.readCurrentPointer`, `readAnalysis(selection: current)` | 최초 pointer/document 읽기와 경로 제한 | 기존 v1/v2 판별, Full/Target hash, source/target/profile/revision, evidence·source QA |
| `loadStagedFullStudentAnalysis`: 지정 revision와 QA | `readAnalysis(selection: staged)`, `readQaManifest` | revision/analysis.json와 sibling analysis-qa.json | staged v2, QA manifest, common/target 관계·source/review 검증 |
| source review·objective review 및 부모 정본 | `readReviewFile`, `readAnalysis(selection: review-parent)` | proposal/artifacts/analysis revision 경계 | 기존 review 구조, 원문 연결, artifact/proposal SHA 및 parent 검증 |
| `loadStagedInterviewContextAt`: 원래 PDF·student cache | `source.readPinnedInput` | 역할별 허용된 설정 경로에서 최초 bytes 반환 | manifest pin과 원문 PDF/evidence 대조 |
| current/staged context의 manifest evidence | snapshot metadata + `currentPointerUnchanged` / `analysisDocumentUnchanged` | 처음 bytes를 반환하고 이후 bytes는 비교만 수행 | 기존 `FULL_ANALYSIS_MANIFEST_REVISION_CHANGED`; 새 revision 재선택 없음 |
| `loadPreparedActivities` full-analysis 분기 | staged snapshot helper → 같은 ports | source/analysis/QA 읽기 | 기존 fingerprint·projection·hash 검사 |

`selection: revision`은 특정 정본을 읽는 port capability이며 새 운영 caller가 연결됐다고 주장하지 않는다. 현재 실제 경로는 current, staged와 review-parent다. 과거 v1/v2 읽기·adapter 검증은 별도 private inventory에서 확인했다.

순수 codec/materialize/hash/source QA와 기존 ID 생성은 도메인에 남아 있다. 저장 payload의 경로·key 순서·배열·UTF-16 인용을 다시 쓰지 않는다. transport envelope를 저장 정본이나 인증 객체로 사용하지 않는다. factory가 operation별 local adapter를 만든다. adapter 내부 파일 cache는 해당 operation에만 속하며 새 전역 cache는 없다. 기존 `loadInterviewContext`의 `cachedContext`는 유지한다.

scope는 owner/student/target/PDF/record/source/common/target/profile revision과 purpose를 명시한다. 아직 확인하지 못한 pin은 null이며 검증된 source와 pointer로 후속 요청을 채운다. null이 기존 context의 알려진 pin을 지우지 않는다. source/analysis가 없는 fallback도 명시적으로 요청한 pin을 무시한 정상 context를 반환하지 않는다. owner 검사는 `localDevelopmentOwner()`에 의한 로컬 모드 경계이며 운영 Auth/RLS 또는 다사용자 격리 증거가 아니다.

## 읽기와 부수효과의 경계

신규 read adapter에는 쓰기·모델 호출이 없다. private/equivalence 실행은 `writeManifest: false`로 기존 writer를 끄고 읽기 경계를 확인했다. 일반 `loadInterviewContextAt`의 기본 manifest 생성과 쓰기 시점은 그대로다. staged loader도 기존 base manifest 동작을 유지하고 staged overlay를 current manifest로 저장하지 않는다. 따라서 일반 호출 전체가 무조건 읽기 전용이라고 설명하지 않는다.

save/stage/publish/activation의 기존 쓰기, CAS를 위한 pointer 재확인, bank/recovery readiness 조회는 그 경로에 남았다. 이를 read cache로 바꾸지 않았다. standalone 정책 compiler, legacy activities JSON/MD cache, bank/audio/session/evaluation persistence도 남는다. 전체 모듈의 모든 fs 호출을 제거한 변경이 아니다.

staged 정본 읽기와 활성화는 다르다. staged v2와 QA를 통과해도 준비/승인 계약 없이 current를 갱신하지 않는다. current v1/v2의 기존 허용 범위와 staged v1 거부를 유지한다. target-only revision의 commonAnalysisRevision 관계도 그대로다.

## 독립 전후 비교와 실제 자료

`artifacts/pr06a/repository-comparison.json`: **89개 검사 통과, 실패 0**. BEFORE는 고정한 PR06-A 이전 source-root의 모듈을, AFTER는 변경 후 모듈을 불러왔다. 두 경로가 같은 새 helper를 호출하는 비교가 아니다. `before-private-extended.json`, `before-synthetic.json`, `before-context-races-extended.json`과 각각의 after 보고서를 보존한다.

- 합성 35건 중 34건은 결과/거부 코드와 도메인 digest가 같다. 다른 owner/target/pin, missing/corrupt JSON/hash/source, current v1/v2, staged v2/QA·거부, target-only, 미승인 활성화와 포인터 경쟁을 포함한다.
- 의도한 차이 1건: `analysis-common-record-pin-rehashed`. 기존에는 source와 다른 `common.recordRevision`을 재해시하면 정상 반환했지만 이제 `FULL_ANALYSIS_STUDENT_OR_REVISION_MISMATCH`로 거부한다. 같은 검증을 current/staged QA에 적용했다. 질문·평가 승인을 변경한 것이 아니다.
- 실제 configured input/source/정본/manifest/pointer **22개 파일 및 별도 활성 은행 bytes 불변**. source 24페이지·43블록, runtime evidence 478개·목적 36개, 후보 35개의 ID·원문·앵커·순서·question/audio hash와 108개 ordered payloadJson envelope가 같다. private 원문·개인 ID를 공개 fixture나 보고서에 복사하지 않았다.
- analysis pointer 또는 문서가 첫 읽기 이후 바뀌는 두 경쟁은 구/신 모두 거부했다. source pointer 변경은 최초 source를 한 번만 선택해 원래의 일관된 context를 반환했다. 새로운 source와 이전 분석이 섞인 정상 context는 없었다.
- context 전체 JSON bytes는 동일하다고 주장하지 않는다. 기존 실행 시각 `questionStrategies.generatedAt`만 달랐으며 BEFORE를 두 번 실행해도 변한다. 기존 catalogContentHash도 이 필드를 제외한다. 비교용 projection에서 **이 필드 하나만** 제외했고 원본 객체·파일·payloadJson·정본 hash를 정규화하지 않았다. 나머지 context는 같았다.
- 읽기 비교 실행의 쓰기 시도·provider 호출은 각각 0이다. 파일 bytes, JSON.stringify/domain hash, transport payloadJson bytes를 각각 비교했다.

추가 private roundtrip은 실제 현재 자료를 다시 읽어 활동 161·학업 57·정본 목적 34·근거 478개를 확인했다. Full/Target·원래 wire·wire envelope exact roundtrip과 보호 파일 6개 불변을 통과했다. 과거 정본 **21개(v1 2, v2 19)**의 형태·hash·adapter와 원본 bytes도 통과했다. 질문 roundtrip에서는 36개 runtime 목적·35개 후보·35개 승인 계약의 108개 envelope와 과거 평가 결과 31개의 불변성을 확인했다. 개수를 과거 보고서의 고정 기대값으로 강제하지 않고 이번 inventory 결과로 기록했다.

현재 coverage는 질문 승인 35, **평가 규격 승인 0, 검수 대기 35**, `scope_review_required`, `sessionEvaluationReady: false`, provider 호출 0이다. 질문 승인과 A/B 평가 승인을 합치지 않았고 ROLE 자동 승인·사전 승인 복제·held-F 삭제/재가중·원본 평가 덮어쓰기는 하지 않았다. PR04 의미 품질 개선은 별도 미완료다.

## 실제 실행 검사와 미실행 범위

아래 로그는 `artifacts/pr06a/`에 있다. source 추출 후 회귀 보강으로 최종 검사를 수행했고, 그 이후 증거 스크립트의 타입 주석만 수정했다. 이 수정에 대해 타입·빌드 및 해당 ESLint를 다시 실행했다.

| 실행 | 실제 결과 / 근거 |
| --- | --- |
| `npm test` | **1,362/1,362 통과**, fail/skip 0; `test-final.log` |
| `npm run test:portable` | **1,163/1,163 통과**, fail/skip 0; `portable-final.log` |
| `npm run typecheck` | 통과; `typecheck-verified.log` |
| `npm run lint` | 통과; `lint-final.log`; 증거 스크립트 최종 타입 주석의 lint도 통과 |
| `npm run build` | production build 통과; `build-verified.log` |
| `npm run verify:contracts` | 수신 제안 52개 형태+4개 UTF-16+4개 추가 parity 통과; `contracts.log` |
| `npm run verify:domain-contracts` | 현행 6종 계약: 38 shape+32 transport+8 span+18 roundtrip 통과; `contracts.log` |
| `npm run verify:analysis-private -- --proposal=<기존 비공개 proposal> --output=artifacts/pr06a/analysis-domain-private-roundtrip.json` | 현재·과거 자료 통과; `analysis-private-verified.log` |
| `npm run verify:question-private` | 통과; `question-private.log`, 별도 보관 `question-domain-private-roundtrip.json` |
| `npm run prepare:evaluation-scopes -- coverage` | 검수 대기 확인; `evaluation-coverage.log` |
| `node scripts/verify-source-closure.mjs --working-tree` | 1,646개 local import 통과; `source-closure-final.log` |
| tracked-only source closure | 시작 13 → 종료 **21개 미추적 dependency edge**; `tracked-closure-before.log`, `tracked-closure-after.log`; 미통과를 숨기지 않음 |
| `git diff --check` | 통과; Git의 기존 LF/CRLF 안내는 별도 |

첫 최종 typecheck/build에서 증거 스크립트 `pr06a-context-race-evidence.ts`의 TS7022 진단이 있었다. `results.at(-1)` 변수의 순환 추론을 명시적 타입 주석으로 고쳤고 위 재실행이 통과했다. 초기 실패 로그를 남겼다. 제품 동작 오류를 프런트 탓으로 분류하지 않았다.

전체 테스트는 `tests/*.test.ts`이며 portable은 [private-fixture-suites.json](../tests/private-fixture-suites.json)의 21개 파일을 통째로 제외한다. 따라서 그 파일 안의 합성 테스트도 제외되며 이번 차이는 199개다. Python parity와 `tests/browser/` 진단은 이 두 npm test 집계에 들어가지 않는다.

제외 파일: `actual-user-core-replay`, `backend-http`, `bank-quality-audit`, `compiled-runtime-policy`, `deep-bank-rebind`, `dialogue-action-gold`, `evaluation-end-idempotency`, `full-md-policy`, `interviewer-policy`, `live-e2e-replay`, `natural-interview-core`, `playback-event-delivery`, `question-grounding`, `question-purpose-lineage`, `realtime-recovery`, `realtime-staged-capture`, `reviewed-bank-upgrade`, `school-context`, `single-core-demand-boundary`, `source-integrity`, `submission-deadline-http` (모두 `.test.ts`).

TS/Python의 공통 범위는 형태·전달된 scope·정확한 payloadJson SHA·portable JSON·UTF-16 구간이다. source QA/기존 hash 재계산/승인 권위는 TS 도메인에 있다. shape-valid지만 TS domain-invalid인 6사례도 보고서에 명시한다. Python을 연결하려고 TS 정본을 generic schema로 바꾸지 않았다. 현행 도메인은 생성 Draft-07을 검증하며 제안 스키마의 Ajv 6 부분집합 변환을 Draft 2020-12 전체 지원으로 표시하지 않는다. 수신 스키마와 원래 검증 보고서는 보존했다.

이번에는 새 npm ci 환경, 원격 CI, 배포·운영 Auth/RLS/DB, 실제 마이크·상용 STT/TTS·유료 모델을 실행하지 않았다. PR05의 실제 Chrome+합성 미디어 94/95/96초·재시도·새로고침·재접속·종료 기록은 이전 증거이며 PR06-A에서 재실행한 것으로 세지 않는다. 실장치 시험에는 실제 장치·권한·상용 provider가 필요하다. 문서의 명령 예시는 이 환경 또는 승인 공급의 실행 증거가 아니다.

G0 원격 관문은 미완료다. 현재 소스 변경과 미추적 의존을 의도한 커밋에 포함하고, 그 정확한 커밋의 원격 CI 결과를 확보해야 한다. working-tree closure 통과는 이를 대체하지 않는다. G1 실장치/상용 통합과 실제 평가 내용 검수도 남는다. PR05 codec 범위 및 PR06-A 로컬 읽기 범위의 완료를 G2/G3 전체로 확대하지 않는다.

## 다음 PR06-B/C/D와 롤백

순서는 A → B → C → D다. 이번에는 후속 port 구현이나 writer 전환을 섞지 않았다.

| 후속 작업 | 대상·실제 caller·필요 경계 | 회귀와 롤백 기준 |
| --- | --- | --- |
| **B: QuestionBankRepository / AudioRepository** | `server/data/prepared-question-bank.ts`, `server/providers/speech-audio-cache.ts`, `approved-audio-replay.ts`. `realtime.ts`의 `requireQuestionBank`에서 `loadQuestionBank`/`loadQuestionBankByPinnedPlan`, 다음 문항 선택과 승인 음성 재생, `providers/clova-tts.ts`의 audio cache가 caller다. 기존 key/pin으로 bank와 audio를 읽는 계약부터 분리하고 준비/쓰기 경계는 별도 명시한다. | bank key·candidate fingerprint·질문 승인·audio bytes/hash·취소/동시 synthesis·tmp rename·Windows 재시도·부분 실패·pinned 과거 bank 회귀. 기존 local reader/writer를 adapter로 보존하고 composition을 local 구현으로 되돌린다. key/hash/선정 또는 원본 bytes가 달라지면 다음 slice로 넘기지 않는다. |
| **C: 기존 SessionStore 확장** | `server/storage/local-session-store.ts`의 기존 save-only `SessionStore`를 재사용하고 실제 `load/list/saveContext/loadContext/save`를 계약에 반영한다. `server/storage/conversation-log.ts`, `server/session-runtime.ts`, `realtime.ts`의 store 생성/복구/종료, worker·supply의 session 조회가 연결점이다. log/checkpoint 책임은 기존 순서대로 분리한다. | owner/context hash·freeze·answer/next/end 멱등성·동일 종료 snapshot·이벤트 seq/replay·10분 복구·Windows atomic replace 실패 재시도·로그 손상 회귀. 기존 LocalSessionStore/ConversationLogger를 그대로 주입할 수 있게 유지하며 파일 형식·이벤트/종료 순서를 바꾸지 않는다. 새 save-only 중복 저장소를 만들지 않는다. |
| **D: EvaluationRepository / ReviewRepository** | `evaluation-job-store.ts`, `evaluation-revisions.ts`, `evaluation-history.ts`, `data/evaluation-scope-registry.ts`, `data/reviewed-evaluation-context.ts`. 실제 caller는 `evaluation-worker.ts` store 구성, `realtime.ts` 결과 조회/재시도, `evaluation-supply.ts` 종료 입력 공급·별도 revision append다. 기존 job/snapshot/result와 서명 검수/registry/reference 조회·CAS 경계를 구분한다. | A/B 분리·서명/철회·잘못된 owner·CAS 경쟁·job/revision identity·완료 전후 철회·held-F·v4 과거 결과·원본 불변·같은 입력 재시도 회귀. 기존 local stores/factory로 되돌리고 원본 job/result/reference를 재작성하지 않는다. DB lease/Outbox·새 승인 정책은 이 I/O 추출 중 결정하지 않는다. |

A의 저장 포맷과 기존 writer를 보존했으므로 데이터 이관 없이 local factory를 유지할 수 있다. 추출 자체를 되돌려야 하면 위 BEFORE snapshot과 전후 파일 목록을 기준으로 **PR06-A의 caller/port 변경만** 역적용한다. 현재 HEAD 전체 checkout/reset 또는 사용자 PR01~05/W0 변경 복원으로 처리하지 않는다. ID·인용·hash 변경, 원본 쓰기, 승인 확대, owner/target mismatch 허용, 미승인 staged 활성화가 발견되면 영향을 받은 A 변경을 먼저 수정·재검증하거나 국소 롤백하고 실패 근거를 남긴다.

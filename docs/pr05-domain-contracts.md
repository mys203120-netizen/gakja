# PR05 — 현행 정본 codec과 공유 경계

기준은 `architecture-blueprint-v2.html` §16·§20·§21이다. 평가 공급계약은 §14/PR03, 분석 생성검수규격은 기존 분석 codec의 보완 명세다. 철회된 4대 정책과 superseded prototype은 적용하지 않았다. 이 문서는 이번 코드의 대응표이며, 문서에 적힌 명령이나 승인 예시는 실행·승인 증거가 아니다.

## 정본과 실제 연결

| 현행 계약 | 권위·버전 | 기존 저장/사용 경계 | 이번 adapter와 연결 |
| --- | --- | --- | --- |
| `studentAnalysisCodecV2Schema` | `server/data/full-student-analysis.ts`의 기존 Zod. wire=`student-analysis-wire-v2`, codec=`student-analysis-codec-v2` | 모델 결과/원본 proposal → dictionary 검증 → `decodeStudentAnalysisV2` → materialize | 원래 schema를 재수출. `decodeAnalysisWireV2PreservingOrder`가 원래 source 검증을 호출하고 입력 순서를 보존한다. 원문 없이는 bridge decode를 거부한다. |
| `FullStudentAnalysis` | 같은 파일의 기존 interface; `full-student-analysis-v1/v2` | `data/prepared/student-analysis-revisions/.../analysis.json`의 `common`; 활성 포인터는 기존 `student-analysis-current.json` | `analysis-domain-codecs.ts`의 버전별 shape + `decodeFullAnalysisPreservingOrder`; 실제 save/load/staged-load에 연결. v1을 v2로 재표기하지 않는다. |
| `TargetStudentAnalysis` | 기존 interface; common과 같은 v1/v2, 별도 target revision | 같은 산출물의 `target`; `commonAnalysisRevision`, `supportTargetId`, `profileRevision` | 버전별 shape + `decodeTargetAnalysisPreservingOrder`; 기존 source QA/target identity/활성화 gate를 유지한다. 실제 hash-bearing target-only 이관 metadata도 보존한다. |
| `StudentObjectiveCandidate` | `server/question-objective.ts`의 기존 interface. 개별 객체에 schemaVersion 없음 | Target의 objectives 및 runtime context의 공통 모듈 목적 | `studentObjectiveCandidateSchema` + `decodeStudentObjectiveCandidate`; 실제 `loadInterviewContextAt`의 objective 구성에 연결. 기존 목적 ID를 그대로 둔다. |
| `PreparedMainCandidate` | `server/data/prepared-question-bank.ts`의 기존 interface. 개별 객체에 schemaVersion 없음; 은행 `prepared-q0-objective-pool-v2` | 은행 slots/candidates; 원래 candidate identity·원문·승인·음성 파일 검증 | `preparedMainCandidateSchema` + `decodePreparedMainCandidate`; 실제 `validCandidate` 첫 단계에 연결하고 기존 전체 검증을 계속 실행한다. |
| `ApprovedQuestionContract` | `server/question-objective.ts`; `approved-question-contract-v1` / blueprint `question-objective-v2` | candidate draft, 실제 turn metadata, 평가 gate가 참조하는 정확한 계약 | `approvedQuestionContractSchema` + `decodeApprovedQuestionContract`; 기존 hash 식을 helper로 추출했다. draft가 있으면 원래 utterance/semantic/review 검증까지 실행한다. |

별도 공통 분석 정본이나 generic Analysis 타입을 도입하지 않았다. `server/contracts/analysis-domain-adapters.ts`와 `question-domain-codecs.ts`는 **검증에 Zod를 쓰되 parse 결과로 원본을 재구성하지 않는다.** 검증 후 원래 객체를 복사하므로 key 순서, 누락 optional 필드, ID, 원문, anchor, 승인 계약을 유지한다.

`server/contracts/read-domain-envelopes.ts`의 `readExistingDomainEnvelopes`는 기존 context/bank 검증을 거친 common·target·objectives·candidates·contracts를 읽어 공유 transport에 연결한다. `scripts/verify-question-domain-roundtrip.ts`가 실제 로컬 자료에서 이 경로를 실행한다. wire의 실제 원본 연결은 `scripts/verify-analysis-domain-roundtrip.ts`가 검증한다. 원본 writer·포인터·평가 결과는 이 bridge에서 호출하지 않는다.

## 저장과 전송의 경계

`existing-domain-envelope-v1`에는 kind, payloadVersion, scope, **payloadJson 원문 문자열과 그 UTF-8 SHA-256**을 넣는다. 기존 payload 안에 owner/target/version 필드를 임의로 추가하지 않는다. 개별 버전이 없는 objective/candidate의 payloadVersion은 `unversioned`이며 원래 container version을 대체하지 않는다.

scope는 ownerId, studentId, supportTargetId, sourceRevision, recordRevision, sourceContentSha256, analysisRevision, profileRevision, bankKey를 명시적으로 전달한다. 본문에 있는 student/target/revision 값 및 nested common-module target과 모순되면 거부한다. 알 수 없는 metadata는 `null`이며 빈 문자열이나 생략으로 숨기지 않는다. sourceRevision은 추출 source revision이고 recordRevision, 분석 revision, bank key와 혼용하지 않는다. target-only 검수 이후 target/objective의 analysisRevision은 common revision과 다를 수 있으므로 각각 원래 값을 전달하고, common 연결은 별도 commonAnalysisRevision으로 검증한다.

owner는 현재 `localDevelopmentOwner()` 경계를 사용한다. `readVerifiedQuestionDomainExport`는 다른 owner를 거부하지만 이것은 기존 로컬 모드의 검증이다. transport 자체는 인증/권한/승인을 제공하지 않는다. 운영 RequestContext와 다사용자 권한 저장소는 PR07/G3에서 주입해야 한다. envelope의 `authority=transport_only_not_approval_or_authentication`은 이 차이를 명시한다.

Python은 내부 JSON을 다시 직렬화해 기존 hash를 계산하지 않고 **payloadJson을 그대로 전달**한다. 외부 envelope는 일반 JSON으로 재직렬화할 수 있다. TS 수신은 transport 검사 후 해당 현행 domain adapter를 다시 실행한다. source와 common/target의 관계는 기존 source QA, 승인과 실제 utterance의 관계는 원래 draft/bank gate가 최종 권위다.

## 부속 5개 제안 envelope와 대응

| 수신 제안 | 현행 계약과의 관계 | 이번 경계 / 후속 조건 |
| --- | --- | --- |
| `evidence-ref` | wire의 proof_ref·dictionary, AnalysisProof, objective/blueprint의 anchorRefs, runtime StudentEvidence | 하나의 정본 타입으로 합치지 않는다. page-relative와 evidence-relative UTF-16 좌표를 각각 원문에서 검증한다. 제안의 source/quote hash는 추가 transport 검증이지 기존 hash의 대체가 아니다. |
| `interview-decision` | 기존 decision/QuestionDraft가 objective·PreparedMainCandidate·ApprovedQuestionContract를 참조 | 문항의 뜻·행동 정책을 변경하지 않는다. 현행 draft/계약을 버전별로 보존하고 API/event 버전 전환은 해당 caller migration에서 한다. |
| `answer-submission` | 현재 제출 DTO·turn/answer ID·전사 revision; 위 6개 정본의 대체물 아님 | 제출 원인·빈 전사·멱등 처리의 기존 경로를 유지한다. 신규 generic 저장 형식으로 변환하지 않는다. |
| `playback-event` | 현재 playback event 및 동일 턴 utterance/attempt; candidate 음성 identity를 사용 | 관측 수신과 delivered 판정을 합치지 않는다. 제안의 sequence/clock 필드만으로 과금하거나 신규 충분재생 임계치를 도입하지 않는다. |
| `evaluation-scope-approval` | 질문 계약을 참조하는 **별도** QuestionEvaluationSpec(A) / 실제 종료 승인(B) | 제안의 `objective_knowledge`는 현행 `objective_accuracy_core`와 명시적 대응이 필요하고 `none`은 `unresolved`이지 승인 면제가 아니다. 현재 A/B 서명 공급 경로를 유지한다. 제안 형식만으로 운영 승인을 import하는 adapter는 제공하지 않는다. |

따라서 이번 공유 schema는 `packages/contracts/domain-v1/generated.schemas.json`에 **현행 6개 codec에서 별도로 생성**한다. 수신 `reference/proposed-v2-2026-11-06`의 5개 schema·52개 사례·원래 검증 보고서는 변경하지 않는다. 5개 envelope를 운영 DTO로 전환했다고 표시하지 않는다. 현재 API/event는 기존 `server/protocol.ts`와 caller가 계속 권위를 갖는다.

## 누락·미확인·인용·hash 규칙

- 필수 nullable 필드의 `null`은 미확인 값이다. grade 누락은 grade=null과 다르다. optional legacy provenance의 부재는 그대로 부재다.
- `[]`는 명시적인 빈 목록이다. 빈 anchorQuote는 실제 공통 승인 모듈 목적에서 허용되며 가짜 학생 근거를 생성하지 않는다. 각 필드의 기존 minLength/enum이 권위다.
- `record_fact`, `student_claim_unverified`, `conflict_needs_review`, `model_interpretation_not_record_fact`, `independentSemanticReview=false`는 서로 대체되지 않는다.
- 위치는 0-based UTF-16 code unit, 끝 제외다. dictionary literal 좌표는 해당 quote 기준, AnalysisProof는 해당 page 기준, ObjectiveEvidenceRef는 해당 evidence/answer text 기준이다. 이들을 offset만 복사해 다른 원문에 붙이지 않는다.
- 설치된 Zod 4.6.7의 일반 string min/max는 **Unicode codepoint 수**다. 이는 인용 좌표 단위와 다르다. 90개 emoji/180 UTF-16 unit 사례로 확인한다.
- Full/Target의 content hash는 `contentSha256`을 제외한 기존 객체의 `JSON.stringify` UTF-8 SHA-256이다. key insertion order가 의미를 갖는다. Full common의 v2 revision은 기존 `{identityBase,inputSha256}` 직렬화 hash를 유지한다. Target의 독립 검수 revision을 이 식으로 다시 계산하지 않는다.
- 승인 계약은 기존 body·blueprint·questionText·semanticContract·premiseValidation의 hash를 유지한다. candidate ID의 기존 sorted fingerprint와 speech/audio hash 알고리즘도 유지한다. transport hash는 **추가 값**으로 이들을 대체하지 않는다.
- 허용되는 직렬화 차이는 기존 JSON 규칙(공백/개행 표현, 객체의 optional `undefined` 생략)뿐이다. Unicode 정규화, 문장 trim, 배열/key sort, ID 재발급, null 삽입은 하지 않는다. JSON.stringify 비교는 원본 파일의 예쁜 들여쓰기 bytes와 구별하며 파일 bytes도 별도로 전후 대조한다.
- transport에는 중복 JSON key, lone surrogate, 비유한 숫자/안전 범위 밖 정수를 거부한다. 기존 저장 파일을 정규화하는 규칙이 아니다.

## TS/Python 공통 검사와 차이

`npm run export:domain-schemas`는 설치된 TS/Zod에서 **native Draft-07**을 생성한다. `npm run verify:domain-contracts`는 generated 파일이 현재 codec과 같은지 확인한 뒤 Zod/Ajv/Python을 같은 익명 fixture로 실행한다. Python은 jsonschema 4.26.0 Draft7Validator를 사용한다. schema export에서 표현할 수 없는 타입은 오류로 처리한다.

공통 검사는 형태·필수/nullable/enum·문자 길이, transport 버전·scope 일치·payload bytes hash·portable JSON, 별도의 UTF-16 원문 구간이다. 원문 dictionary의 전체 QA, identity 생성 규칙, 실제 bank/음성·승인 신뢰 검증은 **TS의 기존 domain 검증**에서 수행한다. shape가 맞지만 원문/hash가 틀린 6개 사례는 Python shape 단계가 통과하고 TS domain 단계가 거부한다는 차이를 보고서에 명시한다. Python 검증 성공을 독립적인 승인이나 TS 전체 도메인 검증 완료로 표시하지 않는다.

수신 5개 제안의 `verify:contracts`는 별도다. Python Draft 2020-12와 Ajv 6의 fail-closed 공통 키워드→Draft-07 projection을 대조한다. 이를 Ajv의 Draft 2020-12 전체 지원으로 표현하지 않는다.

## PR06 — Repository 추출의 순서와 통과 기준

PR06은 파일 I/O 경계를 추출하는 별도 변경이다. 이번 PR05에는 DB writer·Auth·RLS·OCR 전환을 넣지 않았다.

| 순서 | 추출 대상과 port | 보존할 local adapter / 회귀 기준 |
| --- | --- | --- |
| 1 | `full-student-analysis.ts`, `load-interview-context.ts`의 원문·정본·활성 포인터 read → AnalysisRepository/SourceRepository | codec·materialize·source QA는 도메인에 둔다. 기존 파일 경로/manifest·포인터 hash, v1/v2 읽기, current/staged 차이, 원문 및 ID roundtrip이 같아야 한다. |
| 2 | `prepared-question-bank.ts`의 은행 JSON·audio read/write → QuestionBankRepository/AudioRepository | 기존 bank key·candidate fingerprint·승인 검증·durable audio hash·tmp rename을 유지한다. 같은 context/plan에서 동일 후보와 동일 audio가 선택돼야 한다. |
| 3 | `server/storage/local-session-store.ts`의 **기존 SessionStore와 LocalSessionStore를 재사용**하고 read/context/log/checkpoint 계약을 도메인 port로 분리 | save-only 인터페이스를 중복 생성하지 않는다. owner 경계, frozen input, 같은 answer/next/end 멱등 결과, 새로고침·재접속·종료 replay 및 10분 복구 정책을 보존한다. |
| 4 | `evaluation-job-store.ts`, `evaluation-revisions.ts`, scope registry의 persistence → EvaluationRepository/ReviewRepository | 원본 결과 불변, job/revision identity, A/B 승인 분리, 서명 철회, CAS/원자 확정, held-F와 묶음 제외, v4 과거 결과 조회를 보존한다. |

port는 도메인 record와 명시적인 owner/target/revision을 받고 local adapter만 파일 경로를 안다. 각 단계는 기존 fixture를 같은 port 구현에 실행해 결과·저장 이벤트를 비교한다. 기존 실제 세션 replay, 전체/portable 테스트, 계약 parity, private roundtrip, 타입·린트·빌드가 기준이다. 테스트가 없는 의미 정책을 파일 이동과 함께 바꾸지 않는다.

회귀 중단 기준은 ID/인용/hash 변화, 원본 파일 덮어쓰기, 승인 범위 확장, owner/target mismatch 통과, 중복 제출/종료 작업, held-F 누락이다. PR06의 롤백은 factory/import를 기존 local 구현으로 되돌리는 것으로 충분하도록 저장 포맷과 writer를 유지한다. **DB 쓰기가 없으므로 DB 역이관은 PR06에 포함하지 않는다.** DB writer 전환은 PR07에서 단일 writer·이관/역보존·계정 격리 검증과 함께 별도 승인 가능한 변경으로 준비한다.

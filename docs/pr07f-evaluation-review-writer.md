# PR07-F 평가·검수 writer와 종료 인계 consumer

2026-11-07 KST. 기준선은 E `4469aaf9769f972d1beee9210f8135ee2b105bc3`다. [청사진 v2](architecture-blueprint-v2.html), [평가 공급계약](evaluation-supply-contract-v0.1.md), [PR07 전환 계획](pr07-account-storage-transition-plan.md), [E](pr07e-session-writer.md), [PR06-D](pr06d-evaluation-review-repositories.md)와 현행 TS 정본을 따른다. 철회된 정책이나 제안 envelope로 평가 엔진·정본을 대체하지 않는다.

이 문서는 구현 경계와 재현 계약이다. 실제 최종 SHA·명령/exit code·새 설치·원격 CI·보존·실패/미검증 판정은 Git 제외 `artifacts/pr07f/final-report.json`을 따른다. E 수치나 문서의 명령 예시를 F 실행 증거로 사용하지 않는다. 원래 네 E 진단과 새 좁은 재현은 `artifacts/pr07f/e-diagnostic-review.md`에 분리한다. 시작 지연으로 단정했던 설명은 철회하며, 자연 실패의 원인이 재현되지 않은 부분은 미확정으로 남긴다.

## 별도 원본·상태·writer

E의 `session_evaluation_handoffs`와 canonical session은 UPDATE/DELETE하지 않는다. `awaiting-evaluation-consumer`와 `evaluationApprovalGranted:false`는 인계 당시 원본 사실이다. F의 대기·승인·작업·완료는 별도 행과 조회 projection이다. F 완료를 표현하기 위해 E에 job/result를 넣거나 기존 local 세션·평가 파일을 갱신하지 않는다.

F는 명시적인 `isolated-evaluation-writer` composition에서만 실행한다. 실제 계정·학생 귀속, 운영 검수 서비스와 운영 provider를 설치하지 않는다. production에서는 이 composition이 활성화되지 않으며 기본 service mutation503과 retained entry를 보존한다. 기존 local CLI/adapter는 기존 local guard를 유지한다. authenticated runtime을 local-development로 바꾸거나 가짜 `directory`를 DB adapter에 주지 않는다.

| 원본 E 필드 | F에서의 실제 검사·사용 |
|---|---|
| row `payloadJson/payloadSha256` | `decodeSessionEvaluationHandoff`가 원래 UTF-8 TEXT SHA를 확인하고 원형을 반환 |
| `committedRevision` | bigint 문자열로 읽어 accepted revision보다 뒤이고 현재 행 revision 이하인지 검사. JS number로 축소하지 않음 |
| row/payload `contextSnapshotSha256`, `frozenSessionSha256` | 실제 E session/context TEXT 및 runtime pin과 모두 대조 |
| `acceptedEndIntentId/acceptedEndInputSha256` | E end intent ID·원문 SHA·runtime 최초 acceptedEndRequest와 대조 |
| `sessionJson/contextJson/pinsJson` | 현재 시점의 다른 context로 재구성하지 않음. E 저장 bytes와 exact 비교 |
| `evaluationSourceSha256` | 원래 `evaluationSessionSourceFingerprint`를 frozen context/session/model에 실행해 대조 |
| `model/pipelineVersion` | E pins의 evaluation model/pipeline과 대조. 새 ENV 값을 채택하지 않으며 미지원 실행 버전은 거부 |
| owner/student/applicationTarget/supportTarget | 현재 A/B scope와 E 관계, context의 기존 support target, pins의 session authority를 각각 대조 |
| `sourceRevision` | 누락/null/값과 필드 존재를 보존. 미확인 상태를 전체 권한이나 최신 source 선택으로 바꾸지 않음 |

## 실제 caller와 정본 재사용

| caller | F 연결 | 유지되는 도메인 권위 |
|---|---|---|
| service HTTP 인증·scope | `createServiceRealtimeServer`에 명시적인 `evaluationMutations` 주입 | 기존 JWT·Host/Origin·현재 owner/student/개인 지원처 검사 |
| A inventory/공급 | 실제 D/C pinned bank reader → `prepareBankScopeReview`, `validateBankScopeReview`, `verifyBankScopeReviewReceipt` → DB current registry CAS | 정확한 은행·문항·계약·원문·정책, UTF-16 요구 인용, 승인 actor·서명 |
| B proposal/공급 | 실제 E frozen handoff → `prepareEndedSessionReview`, `validateReviewedSessionEvaluationInput` → 불변 bundle/review envelope | 실제 질문·답변·claim·packet·조건·A/B 별도 결합 |
| consumer | 위 입력 → `createReviewedEvaluationKnowledgeContext`, `prepareReviewedEvaluationJobInput` → DB 원자 등록 | 원래 source fingerprint·job ID·held 단위·별도 reviewed context |
| 독립 worker | finite DB grant + 새 authenticated worker execution → `runEvaluationWorkerOnce` | 실제 readiness/fingerprint, stored A/B 검증, evaluator/파싱/checkpoint/집계 |
| raw model I/O | 기존 `evaluateSession.requestEvaluation` seam | worker/evaluator 전체 대체 없음. 서비스에서 readiness/fingerprint/evaluate 우회 거부 |
| 현재/과거 조회 | 별도 F projection/revision → 원래 reference·job/input/result hash·현재 승인 검사 | E/local 원본을 재작성하지 않음. 과거 사실과 현재 표시 권한을 분리 |

worker의 filesystem 없는 core에는 get/snapshot/claim/renew/checkpoint/usage/complete/requireReview/fail만 필요하다. 서비스는 `pending()`으로 모든 소유자를 스캔하지 않는다. E의 실제 read transaction은 mapping credential 없는 `createPostgresSessionCommandReader`로 재사용한다. 기존 E writer composition은 같은 mapping pool과 동작을 유지한다.

## A/B 검수와 현재 신뢰

질문 승인, A 사전 평가 규격 승인, B 실제 종료 세션 승인은 별개다. ROLE/경험 라벨·로그인·유효한 서명 하나·DTO role·`--reviewer` 문자열이 서비스 발행 권한이 되지 않는다.

별도 server-installed `evaluation-review-trust-v1` revision은 owner/student/개인 application/support scope와 issuer/subject→actor/public key/action/notBefore/expiresAt/revoked를 고정한다. 설치는 서버의 finite trust-admin capability로만 가능하며 일반 HTTP 경로가 없다. 공개 SPKI Ed25519 키만 받으며 private key를 trust 원문에 저장하지 않는다. SPKI-DER key fingerprint, trust JSON domain seal, 원문 TEXT SHA는 서로 다르다.

A 발급자와 B 검수자는 다른 키를 사용할 수 있다. 두 actor의 현재 권한을 각각 확인한 뒤 기존 signature/proposal/bundle gate를 실행한다. 원본 receipt의 발급·유효기간, DB의 공급 수락 시각, 실행 시 현재 신뢰/철회는 별도다. 공급 시에는 현재 유효해야 한다. stored 검증은 기존 발급 시각/기간 구조 해석을 유지하고 현재 trust/registry/approval generation을 재검사한다. 과거 receipt를 새로운 만료 해석으로 일괄 무효화하거나 자동 재발급하지 않는다.

외부 신뢰 자료의 현재 관측을 DB trust revision에 동기화하는 경계는 명시적인 composition 입력이다. SQL generation/lock이 보장하는 원자성은 동기화된 DB 범위이며 외부 기관의 모든 철회를 즉시 차단한다고 표현하지 않는다.

| 공급계약 | 실제 F gate |
|---|---|
| EV-01/02/05 | 질문/A만으로 B를 만들지 않음. 승인 부족은 durable review_required, runnable/model/가짜 점수0 |
| EV-03/04/10/11/12 | 정확 문장·계약·source/target/session/답변·서명·중복/철회 검사 |
| EV-06 | 실제 record_consistency_only binding. 과학적 진실 권한을 추가하지 않음 |
| EV-07/08/14 | objective packet·실제 주장 span·가정/제외 범위·허용 인용의 기존 gate |
| EV-09/15 | F1/F2 자료를 Q0에서 복제하지 않음. held F를 지우거나 재가중하지 않으며 원래 묶음 제외·집계 사용 |
| EV-13 | handoff/승인 입력·job/source identity·멱등 receipt로 같은 논리 결과를 재사용 |

## JSON·identity·멱등 의미

registry/bundle 원문과 B의 `{receipt,proposal}` review envelope를 TEXT로 보관한다. raw SHA는 정확한 UTF-8 bytes이고 기존 sealed registry/bundle/reference·receipt hash는 원래 TS 대상이다. JSONB는 관계/검색 projection이며 서명이나 정본 bytes의 대체물이 아니다. key 정렬·trim·Unicode 정규화·null 삽입·기존 ID 재발급을 하지 않는다.

기존 `evaluationJobId(sessionId,ownerId,sourceSha256,pipelineVersion)`를 유지한다. source fingerprint에는 기존 approved bundle, registry, session receipt와 평가 입력·model/pipeline이 포함된다. 승인 revision이 바뀌면 별도 reviewed context/source/job lineage가 생긴다. 같은 입력의 네트워크 재전송은 새 평가가 아니다. 같은 승인과 원래 input의 명시적 재소비는 기존 job/checkpoint/result를 재사용하며, 재승인이 유효한 경우 authority generation만 재고정하고 옛 lease를 fence한다.

command input SHA는 `{version,sessionId,action,payload}`의 원래 `JSON.stringify`다. key/CAS generation metadata와 구분한다. consume은 handoff payload SHA와 승인 SHA를 payload에 명시한다. 승인 null은 현재 B가 없다는 뜻이며 wildcard가 아니다. 같은 key의 다른 승인 입력은 충돌한다. 현재 계정·요청 권한을 확인한 committed receipt는 stale CAS보다 먼저 재생한다. 같은 key로 과거 검수 대기 응답을 조회했다고 새 승인이 적용된 것으로 바꾸지 않는다.

기존 revision reference의 `contentSha256`는 body domain hash다. `revisionSha256`는 이 기존 ID를 유지하고 `revisionRawSha256`는 sealed reference 원문의 SHA다. 둘을 같다고 간주하지 않는다. result/snapshot의 기존 JSON.stringify hash도 SQL JSONB 재직렬화로 대신 계산하지 않는다.

E의 `pins.sessionAuthority.sourceRevision`은 당시 선택한 접근 grant의 범위이며, 누락은 그 scope의 source revision을 제한하지 않는 기존 A/B 권한 의미다. 등록된 `binding.sourceRevision`과 최상위 문서 pin은 별도다. 명시한 null/string 권한은 정확히 일치해야 하고, 문서 pin이 있으면 실제 등록된 source와 일치해야 한다. 누락을 null로 넣거나 wildcard 권한과 문서 revision이 같은 필드인 것처럼 바꾸지 않는다.

## 명시적 HTTP와 worker 진입

기존 E/local DTO와 자동 호환인 것처럼 표시하지 않는다. F POST는 version이 있는 별도 command다.

```json
{"version":"authenticated-evaluation-command-v1","key":"example-1","expectedTrustGeneration":"0","expectedRegistryGeneration":"0","expectedApprovalGeneration":"0","payload":{}}
```

| `/api/sessions/:id/evaluation` 아래 경로 | 동작 |
|---|---|
| GET 기본 | F control generation·원래 E handoff 참조·별도 현재 projection |
| GET/POST `registry` | 실제 은행의 pending A inventory/current 원문 조회; `{registryJson,receiptJson}` 공급 |
| GET `review` | frozen 종료 입력과 정확한 현재 A에 대한 B proposal. 승인 발급 아님 |
| GET/POST `approval` | 별도 B 원문 조회; `{bundleJson,reviewJson}` 공급 |
| POST `withdraw` | `{reason}`으로 현재 B를 철회. 기존 bundle/receipt/result 원문 불변 |
| POST `consume` | `{handoffPayloadSha256,approvalSha256}` 명시 입력으로 대기 또는 실제 job 등록 |
| POST `retry` | `{jobId}`의 같은 현재 유효 lineage 재시도 |
| GET `commands` | key/inputSha256의 durable 최초 결과 조회 |
| GET `revision` | jobId의 원래 별도 revision 조회. 현재 무효이면 historical 표시·현재 승인 false |

F 기록이 없으면 writer/fence의 null은 아직 F 행이 없다는 뜻이다. generation0은 아직 발행/공급 기록이 없는 초기 CAS 값이다. 승인 부족·철회·all-held 입력은 review_required이고 숫자 점수 없이 기다린다. 일부 ready 단위와 held F가 함께 있으면 실제 evaluator가 그 경계를 유지한다.

worker는 HTTP가 발행한 임의 role을 받지 않는다. 서버가 발급한 만료 시각·허용 job 목록·owner/student/application/support binding의 finite DB grant와 authenticated execution capability를 모두 요구한다. 독립 worker는 request+worker pool만 사용하고 mapping/admin/bypass credential은 필요하지 않다. 실제 evaluator에는 raw provider 응답만 주입하고 실제 gate·파싱·인용·집계·checkpoint/usage 경로를 통과한다.

## 짧은 transaction과 DB 권위

새 SQL은 `0005_evaluation_writer.sql`이다. B bootstrap/seed와0001~E0004 bytes/checksum, 기존 checkpoint는 보존한다. scope의 trust/registry generation, session의 별도 B approval generation, session writer fence, job의 lease token/fence를 구분한다. 한 session의 B 공급이 다른 session의 작업까지 무조건 철회하지 않는다.

- 소비·원래 E 참조·승인·job/snapshot/context/reference·멱등 receipt를 원자 등록한다. 같은 무승인 입력을 반복해 runnable job을 쌓지 않는다.
- claim/renew/checkpoint/usage/complete/fail/review 변경은 DB 시각의 유효 lease와 현재 token/fence·account/review generation을 검사한다. 새 F는 Node 시각으로 DB lease의 유효성을 대신 판단하지 않는다.
- provider/Storage await 중 DB transaction/client/row lock을 유지하지 않는다. heartbeat 상실·취소는 실제 evaluator의 AbortSignal과 최종 SQL fence로 늦은 결과 공개를 차단한다. signal/callback은 request fingerprint에 넣지 않는다.
- 모델 호출 전과 결과 확정 전 최신 A/B·서명·현재 권한을 확인한다. 최종 SQL은 account/share 및 review generation 잠금/CAS와 함께 확정한다.
- 기존 결과 envelope의 bytes/hash·완료 job·불변 result revision·공개 pointer는 같은 최종 transaction에서 확정한다. 임시 저장만으로 completed를 노출하지 않는다.
- checkpoint/usage는 실제 동일 job/input/source/context/pipeline/model/review binding에만 연결한다. 외부 모델 호출까지 전역 exactly-once라고 주장하지 않는다.

현재 표시가 철회되더라도 원래 result bytes는 남는다. 기본 status는 현재 승인 없는 숫자 결과를 숨기고 review_required로 표시한다. 명시적 revision 조회는 원래 context/source/reference/result hash를 검증한 historical 결과와 현재 승인 false를 구분한다. 원래 local v4 reader와31개 과거 결과를 F 작업으로 변환하지 않는다.

## 역보존·롤백

F 기록 전에는 F consumer/주입만 비활성화할 수 있다. E 원래 대기와 A/B 인증·권한을 되돌리지 않는다. F 기록 후에는 새 claim/쓰기/외부 작업을 막고 현재 worker를 fence한 뒤 역보존한다.

최종 manifest는 실제 테이블을 열거한다: evaluation scopes/artifacts/sessions/jobs/consumptions/consumption history/command receipts/worker grants/checkpoints/usage/results/result revisions/projection pointers/audit events와 원래 E session 및9개 child collection·그 정확한 참조/해시다. F의 새 승인·context·result bytes는 DB TEXT에 저장하며 `newResultObjects:[]`를 명시한다.

첫 F 기록에서 E의 실제 D run/scope/plan pin과 해당 C 객체의 ref·size·원래 expected hash·관측 actual hash/state/revision을 별도 불변 `source_dependencies_json` TEXT와 SHA에 보존한다. pinned/observed D generation을 구분하고 D의 JSONB metadata와 원래 plan domain hash도 구분한다. D pin이 없는 통제 fixture는 `no-D-pin`으로 표시한다. 이 메타데이터는 F의 14개 테이블 안에 있으며 export→별도 readonly restore→재export에도 보존한다. C/D 원본 행이나 Storage bytes를 새로 복원했다고 주장하지 않는다. 원래 외부 객체의 보관·복원은 이 ref/hash manifest에 근거한 별도 C/D 운영 조건이다.

소유한 새 격리 DB에서 읽기 전용 복원→정확 입력/result/revision 조회→동일 command replay와 새 claim/model 차단을 시험한다. 단순 export, DOWN migration, 원래 handoff로 표시 복귀, ref 삭제나 local writer 우회는 복구 성공이 아니다. 정상 시험에서 필요한 E의 공식 C/Storage reader와 F의 DB 저장/복원을 구분한다.

## 재현과 남은 관문

기존 다섯 CI job을 유지하고 F를 별도 여섯 번째 격리 job으로 식별한다. root full/portable은 `tests/*.test.ts`, nested B/C/D/E/F는 별도 실행이다. 기존 private 제외21파일/199사례를 늘리지 않고 수를 합산하지 않는다. 새 final SHA의 npm ci/pinned Python/closure/type/lint/contracts/build/diff 및 각 suite, 비공개112비교·원본1665/credential1/공개17/평가31·기존 작업본의 전후 보존을 실행 보고서에 연결한다.

실제 은행은 질문승인35/평가규격승인0/검수대기35/`sessionEvaluationReady=false`를 유지한다. 격리 합성 signature/model 성공은 실제 검수·정오·장치·상용 음성 검증이 아니다. 유료 호출·실학생 외부 업로드·실제 승인 발급·운영 migration/배포는0이다.

G는 시작하지 않는다. 실제 Auth/귀속/provider/bucket·검수 주체/키/철회 동기화·운영 관리 책임, private 실제 Storage, 제한 범위·쓰기 이후 역보존과 실계정 W0/G1 검증이 필요하다. W0 디자인/API 전체·200% 실제 브라우저·미디어·장치, PR04 의미 품질, PR08 범용 큐/비용 체계, G4 identity/OCR는 별도다. E 자연 실패의 인과 원인이 미확정인 범위도 G 인계에서 그대로 유지한다.

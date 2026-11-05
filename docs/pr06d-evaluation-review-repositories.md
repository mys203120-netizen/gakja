# PR06-D 평가·검수·revision 저장 경계와 검증

2026-11-06 KST. [청사진 v2](architecture-blueprint-v2.html) §14·§20·§21, [평가 공급계약](evaluation-supply-contract-v0.1.md) EV-01~15, [PR05 대응표](pr05-domain-contracts.md), [A](pr06a-read-repositories.md)·[B](pr06b-bank-audio-repositories.md)·[C](pr06c-session-storage.md)를 기준으로 한다. 학생부 codec·목적/세션/답변 ID·원문·hash·정본은 유지한다. 철회된 구현정책이나 수신 envelope를 운영 DTO로 적용하지 않았다.

**PR06-D 범위의 구현·자동검증을 완료했다.** 기존 JobStore를 재사용해 실제 caller와 local persistence를 연결했다. 전체 1,401건·portable 1,202건·독립 비교 123항목이 통과했으며 비공개 1,508개 파일이 불변이다. 실제 승인 발급·DB writer 전환·서비스 공개를 위한 변경은 아니다. 문서 예시·형식 검사·합성 서명은 실제 사람의 내용 검수 증거가 아니다.

## 기준선과 변경 범위

| 항목 | 증거 |
|---|---|
| 작업 공간 | `C:/Users/MaYunsong/Documents/각자의답NEW`, `main`, HEAD `a666f7a81dd2e80851f8589d135a0aac67c1eae2`; 미커밋 PR01~D 작업 트리 |
| C 이후 차이 | C 최종 1,758개 source 파일과 bytes 일치, 수정/추가/삭제 0. `artifacts/pr06d/c-baseline-comparison.json` |
| D BEFORE | `C:/Users/MaYunsong/Documents/gakja-pr06d-source-before-20261106/source-snapshot-manifest.json`, 1,758개, tree SHA `c47153e94e67d45609e95ec586bb87714aca6938c0fbdba13cb3702babcf93cc` |
| D AFTER | 최종 `gakja-pr06d-source-after-20261106-final/source-snapshot-manifest.json` 및 `artifacts/pr06d/source-change-summary.json`에 정확한 tree SHA·파일 수·파일별 전후 SHA 기록. 이 문서의 자기 hash를 문서에 삽입하지 않음 |
| lockfile | `c52e65258cdbf40ab562c68f97214e006492a3248588d7962453c669bd0be451`, 변경 없음 |
| 환경 | Windows build 26300, Node 24.16.0/npm 11.13.0/Python 3.11.9/Next 16.4.3. `environment.json` |
| 의존성 | 현재 node_modules 재사용, BEFORE는 dependency junction. 새 npm ci·원격 CI로 집계하지 않음 |

B의 음성 cache 문구는 C에서 이미 확인·정정했으므로 별도 B 진입 확인을 반복하지 않았다. 기존 B 회귀는 필수 전체 suite에 포함된다. private data·환경 비밀키·node_modules·Git metadata·실행 artifacts는 source snapshot에 넣지 않았다. 사용자/PR01~C/W0 파일을 reset·clean·stash·stage·commit·merge하지 않는다.

## 실제 caller → I/O → 계약 → local 구현

| caller와 부수효과 | 계약·local 구현 | 남는 도메인 권위 |
|---|---|---|
| realtime 종료/재시도, reviewed queue, 공급 서비스, worker | 기존 `EvaluationJobStore`가 구조적 `EvaluationRepository` 구현. `createLocalEvaluationJobStore`로 실제 구성 | ID·source/snapshot/result hash·상태·attempt·실행 lease·retry/review_required 판단 |
| JobStore get/snapshot/result | `EvaluationJobPersistence.read` → `local-evaluation-job-persistence.ts` | 파일명만 신뢰하지 않음. 기존 schema/identity/owner/context/pipeline/model/hash 검사 |
| JobStore enqueue/claim/renew/checkpoint/usage/complete/fail/retry | 같은 persistence의 `locked/atomic`, 기존 local constructor·replaceFile/readLockFile 호환 | snapshot→job, result→completed job 순서, 실제 lease token 소유·전이·checkpoint/usage 멱등 |
| JobStore pending | `listJobIds/read/atomic` | 손상 job bytes를 유지하면서 quarantine 진단을 작성할 수 있음. 순수 조회로 분류하지 않음 |
| registry load/publish, 실제 준비 CLI | `ReviewRepository`, `local-review-repository.ts`의 pointer/revision read·publish lock·immutable write·pointer rename | schema·서명·actor·scope·현재 reference·expectedCurrent CAS·철회 상태 |
| supply B bundle/receipt 저장, stored receipt 검증 | 같은 review port의 knowledge revision·session receipt | 정확한 종료 입력/원래 context·질문 계약·답변 hash·A/B 분리·서명된 실제 입력 결합 |
| worker 모델 호출 전/결과 확정 전 | `verifyStoredSessionEvaluationReview`에 review port 전달, 두 번 모두 실제 새 읽기 | 최신 registry/receipt와 frozen 입력 재검사. source snapshot 고정과 철회 최신성을 혼동하지 않음 |
| 검수 context 생성 | `createReviewedEvaluationKnowledgeContext`는 원래 순수 함수 그대로 | 별도 context 파생·binding/gate 검증. 원래부터 없던 파일 I/O를 추가하지 않음 |
| revision append/load/retry, realtime 최신 결과 | `EvaluationRevisionRepository`, `local-evaluation-revision-repository.ts`의 list/read/publish | hash·원래 session·job/snapshot/context·서명 권위 재검증, 최신 receipt 시각 선정·동일 시각 충돌 차단 |
| history v4 조회 | 기존 `loadHistoricalCompletedEvaluation`가 구조적 job read 계약 사용 | 원래 pipeline/input/result hash 및 현재 frozen session의 동일성 검증. 임의 과거 점수 fallback 없음 |
| prepare-approved-knowledge CLI | review port로 canonical bundle/evaluation-context 저장 | 기존 validate/derivation·서명 공급 호출, UTF-8 옵션·상대 provenance 유지 |
| prepare-evaluation-scopes CLI | job/session/review/revision 계약의 동일 실행별 주입 | 기존 A publish·B supply·coverage gate. 명시적 사용자 입력 파일 읽기와 `--output` proposal export는 CLI I/O로 유지 |

새 job 정본이나 중복 job store를 만들지 않았다. legacy `directory`는 기존 constructor·worker review-root 유도와의 호환 metadata이며 운영 권한이 아니다. 명시적 worker root/review port로 구성할 수도 있다. realtime의 job/session singleton 수명, C 로그 큐·checkpoint와 A/B source/analysis/bank/audio pin을 유지했다. review adapter는 cache가 없으며 최신성 확인마다 파일을 다시 읽는다.

## 승인·평가·실패 의미의 보존

- 질문 승인, A 사전 규격, B 실제 종료 입력 승인은 별개다. ROLE/경험 라벨·A·Q0 승인으로 다른 session/F를 자동 승인하지 않는다. 검수 부재는 기존 hold/null/review_required이며 모델 재시도로 승인 부재를 해결하지 않는다.
- 같은 receipt와 종료 입력은 같은 job/context/revision을 재사용한다. 다른 receipt는 기존 fingerprint에 포함되며 동일 시각의 다른 revision은 conflict-closed다. revision read/retry 역시 현재 권위와 원본 고정 입력을 재검사한다.
- domain hash·서명 대상은 기존 `JSON.stringify` 그대로다. 파일의 compact/pretty JSON, key/배열 순서, UTF-16 원문, 누락/null, 원본 pipeline/model/version을 변경하지 않았다. 별도 transport payloadJson/정본 hash를 서로 대체하지 않는다.
- job writer는 기존 PID+UUID temp→rename, EPERM/EACCES/EBUSY에 `[10,25,50,100,150,200]`ms 후 재시도(최대 7회)다. 최종 실패 tmp는 기존처럼 남을 수 있다. snapshot 전에 runnable job을 발행하거나 result 전에 completed 상태를 쓰지 않는다.
- 짧은 filesystem lock의 3초 획득 예산·30초 expiresAt·live PID 보호·dead PID 재확인·token 비교 후 해제와 worker 실행 lease/heartbeat는 다른 층이다. 기존 논리를 옮겼으며 새 분산 lock/fencing/Outbox/전원 차단 보장을 추가하지 않았다.
- registry publish는 mkdir→wx lock→현재 pointer/서명 조회→CAS→불변 revision→임시 pointer→rename→close/unlink 순서다. lock에 새 대기/만료 정책을 넣지 않았다. 실패한 pointer temp cleanup도 새로 추가하지 않았다.
- reviewed revision은 기존 wx temp→hard link(create-if-absent)→unlink다. partial temp write가 throw하면 정리 진입 전이므로 tmp가 남는다. link 실패는 정리하지만, link 성공 뒤 unlink 실패는 유효 revision을 남기면서 오류를 반환할 수 있다. 이는 다중 파일 트랜잭션이 아니다.
- held-F와 null 점수, 묶음 전체 제외, 기존 가중치·집계·v4 신뢰 검증을 유지한다. 원래 session/context/transcript/완료 result를 새로운 검수·평가로 덮어쓰지 않는다.

기존 trust 범위도 그대로다. 신뢰 공개키와 signed actor의 정확한 결합을 확인하지만 별도 운영 actor/issuer 권한 저장소·Auth/RLS는 없다. 현재 receipt schema에 없는 issuer를 임의로 생성하지 않는다. 신규 발행은 현재 시각의 유효기간을 확인하고, 저장된 A/B receipt 조회는 기존 발행 시각/기간 관계와 현재 registry 조건을 사용한다. 모든 저장된 receipt를 현재 시각의 expiresAt만으로 자동 철회하는 새 정책을 구현한 것이 아니다. C 로그의 fallback owner metadata는 평가 권한을 부여하지 않는다.

## EV-01~15와 실제 회귀 대응

| 계약 | 보존한 실제 검사 |
|---|---|
| EV-01/02 | `evaluation-supply.test.ts`: 질문 승인/ROLE만 있으면 hold, 일반 worker provider 0/review_required |
| EV-03/04 | 실제 질문 한 글자·승인 계약·source manifest·같은 semantic hash의 새 계약 불일치 거부 |
| EV-05/06 | A만으로 B 생성하지 않음; 정확한 signed record-consistency B만 별도 context/worker에 전달, 과학적 진실 권한 없음 |
| EV-07/08 | objective packet 외 실제 claim review·적용 조건·제외 범위 검증 |
| EV-09/15 | 미검수 F 자동 상속/생략/0점/재가중 없음, 원래 묶음 제외 유지 |
| EV-10/11 | 전사·답변 정정의 stale bundle, 다른 owner/session 결합 거부 |
| EV-12 | duplicate binding, 공급 전·worker 시작 전·provider 대기 중 registry 철회 및 결과 확정 전 재검사 |
| EV-13 | 동일 signed 공급·종료 retry job/revision 재사용, 다른 receipt 분리·동일 시각 conflict |
| EV-14 | model 출력이 승인 span 밖의 A 근거를 인용하면 기존 출력 검증에서 보류 |

이전 `evaluation-history`, `evaluation-revisions`, `evaluation-v4-compatibility`, `evaluation-end-idempotency`, C session 회귀를 재사용했다. 신규 `evaluation-job-persistence.test.ts`, `review-repository.test.ts`, `evaluation-repository-composition.test.ts` 검사는 실제 local persistence와 domain gate를 실행한다. 특히 세 revision 부분 실패 후 실제 signed supply 재시도/coverage 조회까지 port 전달을 검증한다. 모델만 합성으로 바꾸며 store 전체나 승인 gate를 통과 stub으로 대체하지 않는다.

## 독립 비교와 private 원본

BEFORE의 실제 모듈은 새 helper에 연결하지 않는다. source-root별 원래 모듈과 D 모듈을 따로 실행하고 같은 합성 입력의 결과/거부/provider 수/identity/상태/I/O 이벤트/최종 bytes를 대조한다. natural BEFORE 반복으로 비결정성을 먼저 관측한 뒤 Date/UUID/테스트 Ed25519 입력을 제어한다. hash-bearing payload·signature·receipt를 비교에서 삭제하지 않는다. 단순 inventory의 파일 경로 정렬과 실행 event 순서/JSON 직렬화는 구별한다.

독립 job·review·signed worker 통합 결과와 최종 comparator는 `artifacts/pr06d/`에 기록한다. job **21개**는 BEFORE 반복/AFTER, review **25개**는 BEFORE/AFTER, signed worker 통합 **15개**는 natural BEFORE 두 번·controlled BEFORE 두 번/AFTER를 실행했다. job의 실제 PID가 들어가는 짧은 lock JSON과 임시 파일명은 검증한 PID 관계만 대응시키고 원래 raw lock bytes/hash를 별도 보존했다. domain job/snapshot/result/quarantine bytes는 정규화하지 않았다. review와 signed 통합의 전체 case·서명 대상·최종 파일 bytes에는 어떠한 정규화도 적용하지 않았다. 최종 comparator와 private AFTER는 아래 증거로 확인한다. 실제 새 process에서 job/result/receipt/revision/history를 조회하며 RAM 상태로 재시작을 대신하지 않는다. 제어된 CAS/claim/철회/실패 순서의 근거를 모든 다중 프로세스 경쟁의 증명으로 확대하지 않는다.

D의 실제 private BEFORE inventory는 **1,508개 / 2,019,122,525 bytes**다. C가 보호한 7개 그룹 1,497개에 기존 diagnostics 6·log-reviews 4·references 1개를 추가로 포함했다. 숫자를 C에 맞추려고 제외하지 않았다. 실제 get/snapshot/result 31개, 참조 context 68개, revision 110개(79 null/31 기존 legacy 거부), historical 110개(4 검증된 반환/106 null)를 읽었다. signed registry는 현재 null이다. private reader는 pending/quarantine·공급·worker·append를 실행하지 않는다. 실제 원문·ID·키는 출력하지 않으며 읽기 전후 모든 파일 bytes·write/network 시도를 확인한다. 최종 AFTER는 필수 검사가 모두 끝난 뒤 같은 reader fixture로 수행했다. **1,508개 파일 / 2,019,122,525 bytes의 파일 identity·물리 bytes와 실제 조회 결과가 모두 동일**했고 private write/network 시도는 각각 0이었다. 실제 job/snapshot/result 31개씩 모두 기존 검증을 거쳐 반환되었고 legacy revision 거부도 그대로 보존했다. owner별 목록·큰 pinned context의 실제 반복 조회까지 수행하므로 마지막 scan은 약 3분 소요됐으며 중단·축소하지 않았다.

## 실행 결과와 미실행 범위

| 실행 | 최종 결과 |
|---|---|
| 전체 / portable | **1,401/1,401**, **1,202/1,202** 통과. 실패/취소/skip 0; `full-tests.log`, `portable-tests.log` |
| 타입 / 린트 / build | 모두 exit 0. 최종 evidence scripts 포함 타입·린트 통과, production 정적 페이지 5개 생성 |
| 제안 계약 / 현행 domain 계약 | 둘 다 통과. 제안 52 형태+4 span+4 추가 parity; 현행 38 형태+32 transport+8 span+18 roundtrip. Ajv 공통 부분집합과 Python/TS 도메인 권위 차이 유지 |
| 기존 질문·분석 private roundtrip | 둘 다 통과. 원래 보고서는 보존하고 D 실행 보고서를 별도 저장 |
| 실제 coverage | 질문 승인 35, **평가 규격 승인 0**, 검수 대기 35, `scope_review_required`, `sessionEvaluationReady=false`, provider 0 |
| 독립 전후 / private AFTER | **123/123 항목 통과**, 실패 0. 고유 합성 사례 61개(job 21/review 25/signed integration 15), raw 파일 byte/hash 검증 615회. 1,508개 private 파일 불변; `repository-comparison.json` |
| working-tree / tracked-only closure | 둘 다 실행·공개. BEFORE tracked-only **34 edge/18 직접 누락**, AFTER **47 edge/23 직접 누락**. working-tree **1,808개 import 통과**, Git 추적 기준은 exit 1. 전이 미추적 의존 **25개**와 전체 후보는 `commit-candidates.json` |
| diff / 최종 snapshot | diff 검사 exit 0. 수정 11·추가 15·삭제 0, 최종 소스 1,773개. `source-change-summary.json` 및 최종 manifest에 검사한 코드·파일별 SHA 연결 |

초기 검사에서 새 test fixture의 session 인자/존재하지 않는 gatePassed 필드 가정, sync throw를 async rejection으로 검사한 테스트, 기존 safeParse가 TS union을 좁히지 않는 타입 문제가 있었다. 테스트·타입만 수정했으며 domain 의미 정책을 바꾸지 않았다. 독립 runner의 Windows child import는 file URL로 수정했고 관측 로직을 바꾼 관련 증거는 전부 재생성한다. 제품 새 회귀가 확인되면 별도 기록하고 관련 검사를 다시 실행한다.

전체는 `tests/*.test.ts`; portable은 `tests/private-fixture-suites.json`의 21개 파일 전체(**199개 테스트**)를 제외하며 그 안의 합성 사례도 제외한다. 정확한 파일 목록은 아래에 명시했다. Python parity는 별도 실행, 실제 브라우저/장치 시험은 미실행이다. 새 npm ci·원격 CI·유료 모델/STT/TTS·실제 사람 승인·실학생 평가 재생성·W0 통합·DB writer 전환은 실행하지 않았다.

## 롤백과 D 다음 작업

local composition은 기존 `EvaluationJobStore(directory, io)`와 local factory, review/revision local adapter로 복구할 수 있다. 추출 전체를 되돌릴 때 D BEFORE와 `source-change-summary.json`을 기준으로 D 코드만 역적용한다. 파일명/저장 포맷/ID/hash가 같으므로 데이터 재작성·역이관은 필요 없다. PR01~C·사용자·W0 변경 및 기존 session/승인/평가 원본은 보존한다. ID/hash/서명 bytes 변화, 잘못된 승인 확대, 두 번째 철회 확인 누락, frozen input 덮어쓰기, 충돌을 성공으로 처리하는 변경은 회귀/롤백 기준이다.

다음은 **별도 재현·통합 단계의 순서**이며 이번에 실행하지 않았다.

1. `commit-candidates.json`의 직접 누락뿐 아니라 전이 소스·관련 테스트·문서·CI 설정을 PR01~D 커밋 단위로 정리한다. private data/키/node_modules/artifacts는 제외한다. 새 의존성 설치·정확한 변경 commit의 원격 CI를 통과시켜 G0 재현 관문을 닫는다.
2. W0 `w0-closeout.md`, `w0-test-comparison.md`, source manifest를 별도 작업 트리에서 확인했다. 실제 32개 통합 대상은 `artifacts/pr06d/w0-integration-review.json`; 이번 backend 동일 경로 충돌 0개다. 통합 시점에 다시 diff/경로 충돌을 확인한다.
3. 별도 통합 기준선에서 W0 32개와 backend를 합쳐 타입/린트/전체/portable/build·실제 production preview 차단·기존 `/`→`/interview`·scene·음성/종료/복구 격리를 검증한다. 개별 작업창 테스트 수를 합산해 통합 통과로 표시하지 않는다.
4. W0는 구현 완료·통합 전이다. 관련 84/84, production HTTP 224/224, 개발 HTTP 21/21, 신규 실패 0은 W0의 기존 실행 보고이며 D에서 재실행한 숫자가 아니다. 양쪽 기준본의 기존 실패 46개와 실제 200% 확대 미검증을 숨기지 않는다. shell 구현을 새 기능 개발로 되돌리지 않고 실제 확대를 통합 검사에 남긴다.
5. 그 기준선 위에서 PR07 owner/target·계정·DB·Storage·migration과 단일 primary writer 전환을 설계한다. 실제 Auth/RLS·DB writer·W0 API 연결은 별도 구현/검증 범위다.

커밋 후보는 다음 묶음으로 검토하되, 실제 import graph로 각 중간 commit의 closure를 확인하고 닫히지 않는 묶음은 함께 반영한다. 아래 순서는 이번 stage/commit 실행이나 독립 배포 단위를 뜻하지 않는다.

| 후보 묶음 | 실제 대상과 완료 검사 |
|---|---|
| 재현 기반 PR01 | `.gitignore`, package/lockfile, `.github/`, portable 제외 manifest·runner, source closure/snapshot 도구. public/private 분리와 새 설치 CI 설정 확인 |
| 현행 codec/승인 공급 PR03·05 | `server/contracts/`, `packages/contracts/`, 평가 scope policy/registry/supply/revisions/history, 기존 gate/queue/worker 변경과 대응 CLI·EV/codec 테스트. 원본 수신 schema·report와 TS 정본을 유지하고 전이 의존 포함 |
| 기존 runtime 수정과 A~D local 추출 | pause-ready 변경, `server/repositories/`, session/log/job store·realtime/data/provider 호출부, repository/HTTP/회귀 테스트. 이전 묶음과 상호 참조하면 동일 commit으로 닫고 portable+전체를 각각 실행 |
| 증거·설계 기록 | PR05/A/B/C/D 문서·구현 상태·비공개 자료 없는 재현 도구. `artifacts/`와 원본 학생/승인/평가 파일은 추가하지 않음. PR04 미완료 의미 품질 작업을 완료 변경으로 포함하지 않음 |

이 후보 검토에는 직접 누락 23개보다 넓은 전이 미추적 의존 25개, 전체 Git-visible 미추적 후보 122개, 기존 tracked 변경 목록을 사용한다. 원격 CI는 최종 실제 commit SHA에서 source closure·portable·타입·린트·build·계약 parity를 실행하고, private 전체 검사와 실제 서비스 검증은 별도 환경의 증거로 연결해야 한다. W0 통합은 이 기준선이 확보된 다음이며 두 작업 트리의 별도 통과 숫자를 합산하지 않는다.

| 최종 관문 | 상태 |
|---|---|
| PR06-D 범위 | **완료**: 기존 job/review/revision local persistence와 실제 worker/realtime/supply/CLI, 독립 보존·회귀 검사 |
| PR06-A~D local 저장 경계 | **요청 범위 완료**: source/analysis 읽기, bank/audio, session/context/log, evaluation/review/revision. 기존 local adapter/정본 유지 |
| G0 원격 재현 | **미완료**: 미추적 47 edge/23 직접 파일·25 전이 의존 포함 커밋 정리, 정확한 변경 commit·새 설치/원격 CI |
| G1 실제 검수·미디어 | **미완료/외부 의존**: 실제 A/B 내용 검수와 운영 권한 공급, 실마이크·상용 STT/TTS·장치/서비스 E2E. 평가 승인 0/검수 대기 35 유지 |
| W0 | **구현 완료·통합 전**: 32개 파일 읽기 검토·현재 경로 충돌 0, 실제 API/원격 CI/200% 확대/통합 검증 별도 |
| PR04·후속 운영 단계 | 의미 품질 개선은 별도 미완료. DB/Auth/RLS/Outbox/OCR/권리원장 등 운영 전환은 이번 범위 아님 |

로컬 Repository 분리 완료는 실제 평가 승인 공급·운영 다사용자 준비·서비스 공개 완료가 아니다. 최종 기계 판독 보고서 `artifacts/pr06d/final-report.json`은 전체 manifest·명령/exit code·독립 비교·commit 후보·W0 목록을 연결한다.

## Portable 제외 파일

```text
actual-user-core-replay.test.ts
backend-http.test.ts
bank-quality-audit.test.ts
compiled-runtime-policy.test.ts
deep-bank-rebind.test.ts
dialogue-action-gold.test.ts
evaluation-end-idempotency.test.ts
full-md-policy.test.ts
interviewer-policy.test.ts
live-e2e-replay.test.ts
natural-interview-core.test.ts
playback-event-delivery.test.ts
question-grounding.test.ts
question-purpose-lineage.test.ts
realtime-recovery.test.ts
realtime-staged-capture.test.ts
reviewed-bank-upgrade.test.ts
school-context.test.ts
single-core-demand-boundary.test.ts
source-integrity.test.ts
submission-deadline-http.test.ts
```

## 변경 파일 묶음

| 파일 | 변경 이유 |
|---|---|
| `server/evaluation-job-store.ts`, `evaluation-worker.ts`, `repositories/evaluation-job-ports.ts`, `local-evaluation-job-persistence.ts` | 기존 lifecycle 저장소 재사용, physical path/IO/lock과 호출 계약 분리, 실제 worker 두 번의 최신 검수 확인 |
| `server/data/evaluation-scope-registry.ts`, `repositories/review-ports.ts`, `local-review-repository.ts` | 서명/actor/CAS 도메인 유지, canonical review 파일 I/O 분리 |
| `server/evaluation-revisions.ts`, `evaluation-history.ts`, `repositories/evaluation-revision-ports.ts`, `local-evaluation-revision-repository.ts` | 불변 reference publish·조회 분리, 기존 v4 검증은 타입 계약만 변경 |
| `server/evaluation-supply.ts`, `reviewed-evaluation-queue.ts`, `realtime.ts`, 두 prepare CLI | 실제 persistence port/factory 전달·구성, 원본 보존 및 운영 명령 동작 유지 |
| 새 테스트 3개·`scripts/pr06d-*.ts` 5개 | 실제 local writer 실패·gate·독립 전후/private 증거 수집 및 비교 |
| 본 보고서·`architecture-implementation-status.md` | 완료/외부 관문 분리, W0 구현 완료·통합 전 상태, 다음 재현/통합·롤백 기준 |

파일별 정확한 변경 전후 SHA와 source manifest는 `source-change-summary.json`, 실제 명령·exit code는 `checks.json`을 정본으로 사용한다.

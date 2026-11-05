# PR06-C 세션·context·로그 저장 경계 구현·검증

2026-11-06 KST. 기준은 [청사진 v2](architecture-blueprint-v2.html) §15·§20·§21, [PR05 계약 대응표](pr05-domain-contracts.md), [PR06-A](pr06a-read-repositories.md), [PR06-B](pr06b-bank-audio-repositories.md)다. 평가 공급계약은 §14·PR03의 보완 명세이며 기존 분석 codec을 유지한다. 철회된 4대 정책·독립 공통 분석 초안·수신 제안 envelope를 적용하지 않는다.

**PR06-C 범위의 구현·자동검증을 완료했다.** 기존 세션/context writer를 재사용하고 실제 caller·로그 I/O·checkpoint 저장 경계를 연결했다. 독립 전후 비교 60개 확인 항목, 전체 1,385개, portable 1,186개가 통과했다. G0 원격 재현·G1 실제 승인/기기·G2 나머지 Repository 추출은 별도 관문이다. 상세 실행·소스 identity는 `artifacts/pr06c/checks.json`, `repository-comparison.json`, `final-report.json`을 함께 본다.

## B 진입 확인과 C 기준선

B의 `artifacts/pr06b/before-clova-caller.json`, `after-clova-caller.json`과 `tests/fixtures/pr06b-audio-caller.ts`의 독립 child 실행을 확인했다. 생성 단계는 합성 fetch 2회다. **새 프로세스의 reopen은 두 음성 모두 disk hit, provider fetch 0회**이며 생성/reopen의 audio key·bytes/hash가 같다. 실제 상용 호출은 0이다. 같은 프로세스 RAM hit를 재시작 증거로 사용하지 않았다.

따라서 B의 “재시작 disk hit 0회” 문구만 `docs/pr06b-bank-audio-repositories.md`에서 정정했다. 제품 코드 수정이나 같은 시험 재실행은 필요하지 않았다. 일반 speech cache의 부분 plain write 후 nonempty 손상 파일을 읽을 수 있는 기존 한계는 별도이며 C에서 바꾸지 않는다.

| 기준 | 확인한 값·근거 |
| --- | --- |
| 작업 트리 | `main`, HEAD `a666f7a81dd2e80851f8589d135a0aac67c1eae2`; PR01~B의 미커밋·미추적 소스 포함 |
| B 최종 snapshot | `C:/Users/MaYunsong/Documents/gakja-pr06b-source-after-20261106-final/source-snapshot-manifest.json`; 1,746개, tree SHA `b2d24dc3639a531b4f8e193391fd1eac43f43ca55bdc35392ba57604f1b39e50` |
| C BEFORE snapshot | `C:/Users/MaYunsong/Documents/gakja-pr06c-source-before-20261106/source-snapshot-manifest.json`; **1,746개**, tree SHA `f3da16717e6805eb541f58ff187db955e3cc3d3d2d087b965609465d6da887f9` |
| B→C BEFORE 차이 | B 보고서 문구 수정 1개, 추가·삭제 0개, 제품 코드 차이 없음; `artifacts/pr06c/pr06b-baseline-comparison.json`, `pr06b-entry-comparison.json` |
| lockfile | SHA `c52e65258cdbf40ab562c68f97214e006492a3248588d7962453c669bd0be451` |
| 실행 환경 | Windows 10 build 26300, Node `v24.16.0`, npm `11.13.0`, Python `3.11.9`, Next `16.4.3`; `artifacts/pr06c/environment-and-git.json`에 HEAD·작업 트리·별도 W0 worktree 상태 기록 |
| C AFTER snapshot | `C:/Users/MaYunsong/Documents/gakja-pr06c-source-after-20261106-final/source-snapshot-manifest.json`; 이 문서까지 포함한 최종 tree SHA·파일 수는 해당 manifest와 `artifacts/pr06c/source-change-summary.json`을 정본으로 사용한다(문서 자체의 hash를 자기 참조하지 않음) |

BEFORE는 B 보완 이후 소스를 독립 복사한 기준본이다. 필요한 실행에 기존 node_modules junction을 재사용하며 새 npm ci·원격 clean-checkout 검증으로 표시하지 않는다. data·비밀키·node_modules·Git metadata·실행 artifacts는 공개 source snapshot에서 제외한다. HEAD 단독 checkout으로 미추적 구현을 재현할 수 없다. stage/commit/reset/clean/stash/push/deploy/branch merge는 이번 범위가 아니다.

## 실제 caller와 저장 경계

기존 save-only `SessionStore`의 동일한 책임을 `server/storage/session-store.ts`로 옮겨 `save/load/list/saveContext/loadContext` 계약으로 확장했다. `local-session-store.ts`는 기존 경로에서 타입을 재수출하고 기존 생성자도 유지한다. 중복 save-only 저장소나 generic CRUD를 만들지 않았다.

| 실제 caller | 기존 I/O → 계약 → local 구현 | 남는 도메인 권위 |
| --- | --- | --- |
| realtime 세션 생성·복구·조회 | 세션 JSON save/load/list → 확장 `SessionStore` → 기존 `LocalSessionStore`, `createLocalSessionStore` | 세션 ID/형태·owner, 기존 복구 가능 여부·고정 context·accepted end 상태 |
| realtime context 저장·재접속 | owner+context hash 파일 → `saveContext/loadContext` → 같은 local store | 원래 snapshotHash와 envelope owner/version/hash; 현재 분석·은행으로 교체하지 않음 |
| realtime `save` | 기존 updatedAt 설정·저장 → `saveSessionSnapshot(session, Pick<SessionStore,'save'>)` → 기존 queued save | updatedAt만 갱신; checkpoint·복구 기한·종료 입력을 새로 만들지 않음. 기존 await·오류 전달 유지 |
| runtime checkpoint·복구 | 기존 `checkpointSession`, `assertRecoverableSession`, `restoreLogicalSession`, `recoveryProjection` | 상태 전이·checkpoint·epoch·전사/turn/answer·재생 불확실성 판단은 순수 runtime에 유지 |
| realtime journal·상태 조회·종료 flush | 같은 `defaultConversationLogger`의 `append/getStatus/flush` → `ConversationLog` | 기존 호출 순서·await 여부, 보조 기록의 optional 진단; 세션 필수 저장 실패와 구별 |
| `ConversationLogger` append/load | mkdir/read/open-a/chmod/write/close → `ConversationLogRepository` → `local-conversation-log-repository.ts` | seq·eventId 중복·malformed 행·누락 newline·redaction·상태/진단·파일별 공유 큐/version |
| logger flush | open-r+/sync/close → 같은 log repository | 명시적 flush 대기·실패 상태 반환. 새 자동 flush·close/replay API를 만들지 않음 |
| worker·검수 공급·평가 revision·운영 CLI의 세션 조회 | 기존 local store 생성 → `SessionStore` 주입 및 local factory | 원래 owner·frozen input·A/B 승인·receipt·평가 gate. job/registry/result writer 추출은 D로 남김 |

LocalSessionStore 자체가 local adapter이므로 실제 fs·경로·원자 저장을 그 안에 보존한다. 의미 함수에 파일 경로 조합을 새로 추가하지 않는다. `ConversationLogger`의 fs/path는 local log adapter로 옮겼다. log repository의 `coordinationKey`는 adapter가 제공하는 불투명한 동일 파일 식별자이며 payload나 승인 증거가 아니다.

## 보존한 저장·수명·실패 의미

- 세션 JSON은 기존 `JSON.stringify(session, null, 2)`, context envelope는 기존 compact JSON과 owner hash/content hash 파일명을 사용한다. ID·key/배열 순서·누락/undefined/null·UTF-16 원문을 재구성하지 않는다.
- save 호출 시 직렬화한 정확한 snapshot을 기존 instance별 writes queue에 넣는다. 앞선 실패 후 다음 저장의 재시도 가능성도 유지한다. 요청마다 store를 새로 만들어 이 큐를 잃지 않는다.
- 세션 writer는 기존 mkdir→고정 `.json.tmp` write(mode 0600)→rename이다. EPERM/EACCES/EBUSY에만 `[10,25,50,100,150,200]`ms를 기다리며 최대 7회 시도한다. 다른 오류·최종 오류를 필수 저장 성공으로 바꾸지 않는다. 기존 tmp 잔존·instance 간/프로세스 간 경쟁 한계도 유지한다.
- context는 기존 mkdir(mode 0700)·write(mode 0600, wx)·EEXIST 처리다. 이미 있는 파일을 새로 검증·덮어쓰는 정책을 발명하지 않았다. 손상된 기존 context는 원래 loadContext hash 검사에서 거부한다.
- log의 module-level `fileQueues/fileVersions`를 유지한다. 서로 다른 logger/adapter도 같은 물리 파일이면 동일 큐·version으로 직렬화한다. 다른 directory 또는 session의 큐는 섞지 않는다. 기존 default logger singleton 수명과 compatibility wrapper도 유지한다.
- 로그 load는 기존 유효 seq의 최댓값·eventId를 읽고 잘못된 행을 진단한다. tail을 잘라내거나 정렬하지 않는다. newline 없는 tail 뒤에는 기존 방식대로 newline을 붙인다. redaction은 logger가 담당한다.
- append·chmod·write·close·flush 오류는 기존 optional 로그 진단/상태로 반환한다. 부분 append는 tail을 남길 수 있고, write 후 close 오류는 다음 load에서 이미 쓴 eventId의 중복으로 확인될 수 있다. 이를 필수 session/context 저장 오류를 삼키는 근거로 사용하지 않는다.
- 로그는 보조 관측이다. 복구의 상태는 저장된 session/context/runtime에 있다. offline JSONL parser 조회를 새로운 event replay·state reconstruction으로 표현하지 않는다.
- 로컬 owner 경계는 운영 Auth/RLS가 아니다. default logger/repository가 생성 시 캡처한 local owner는 **port metadata**다. ESM import 후 dotenv가 로드되면 fallback이 먼저 캡처될 수도 있다. 이를 세션 owner의 인증으로 사용하지 않으며 실제 세션 owner 검사는 SessionStore/runtime의 기존 `assertSessionOwner`가 맡는다.

복구 시간은 바꾸지 않았다. active 세션은 `checkpoint.disconnectedAt ?? checkpoint.at`을 기준으로 `now - interruptedAt > 600000` 또는 미래 시각이면 거부한다. 정확히 600000ms는 기존처럼 허용한다. non-active도 owner 검사를 먼저 한다. 단순 조회·save의 updatedAt 변경으로 checkpoint를 새로 쓰거나 10분 기한을 연장하지 않는다. restore의 streaming→paused, epoch 변경·delivery uncertainty·진행 중 operation 처리는 그대로다.

PR06-A 최초 bytes/source·analysis pin, B pinned bank/audio와 승인 계약은 복구 입력을 제공한다. 최신 활성 자료를 다시 골라 저장된 세션에 섞지 않는다. 질문/평가 승인·시간·과금·모델·음성 설정·held-F/묶음 제외 정책은 이번 저장 경계의 권위가 아니다.

## 변경 파일과 독립 비교

C BEFORE 대비 **수정 10개·추가 12개·삭제 0개**다. B 캐시 문구 수정 1개는 C 진입 전에 별도 반영했다. 기존 PR01~B와 사용자 변경은 되돌리지 않았으며 lockfile·평가 저장 writer·기존 원본 데이터는 변경하지 않았다.

| 파일 묶음 | 변경 이유 |
| --- | --- |
| `server/storage/session-store.ts`, `local-session-store.ts` | 기존 계약 확장·재수출·local factory. 저장 포맷과 실제 writer는 유지 |
| `server/repositories/conversation-log-ports.ts`, `local-conversation-log-repository.ts`, `server/storage/conversation-log.ts` | 물리 log I/O와 logger 도메인 분리, 동일 global queue/version과 singleton 유지 |
| `server/session-runtime.ts`, `server/realtime.ts` | 기존 save 동작의 도메인 helper와 store/default logger composition 연결 |
| `evaluation-worker.ts`, `evaluation-supply.ts`, `evaluation-revisions.ts`, `reviewed-evaluation-queue.ts`, `scripts/prepare-evaluation-scopes.ts` | 세션 접근에 확장 계약·factory 주입. 평가 persistence 정책 변경 없음 |
| `tests/session-store-contract.test.ts`, `session-persistence-boundary.test.ts`, `conversation-log-repository.test.ts` | 실제 local writer·계약·checkpoint 저장·공유 로그 큐·부분 실패 회귀 |
| `scripts/pr06c-session-store-cases.ts`, `pr06c-conversation-log-cases.ts`, `pr06c-private-evidence.ts`, `pr06c-handler-cases.ts`, `pr06c-compare-evidence.ts` | 명시한 source-root의 독립 BEFORE/AFTER 실행·비식별 관측, 엄격한 전체 결과 비교 |

**확인 완료:** store **30개**, log **14개** 사례의 BEFORE/AFTER `cases` 전체가 strict equality를 통과했다. 결과·거부·status·순서 있는 실제 I/O 이벤트·최종 bytes/hash를 함께 비교했다. AFTER만 새 helper를 사용하고 BEFORE는 C 직전 실제 모듈을 실행한다. fixture hash도 같다.

- store 30건: session/context 왕복·owner/list 필터·missing/corrupt/hash·wx 기존 손상·queued snapshot과 실패 후 재개·다른 세션·Windows 3종 retry/7회 실패·영구 오류·부분 tmp·mkdir 실패·새 프로세스 재시작·10분 직전/정확 경계/직후·미래 clock·disconnectedAt 우선·checkpoint fallback·재저장으로 기한 미연장.
- log 14건: 여러 instance의 동일 파일 큐/version/중복, 다른 directory/session, newline 없는 유효 tail·malformed/외부 session tail, redaction/invalid/직렬화 실패, mkdir/read/open/chmod/partial write/close 오류와 재시도, flush sync 실패, 실제 새 프로세스의 중복 확인·다음 seq.
- log timestamps에는 고정 Date와 명시적 eventId를 사용했다. 이벤트 stream을 sort/drop하거나 원본 파일을 정규화하지 않았다. source/fixture hash 불변도 확인했다.
- 로그 관련 기존·신규 회귀 **19/19**, 담당 파일 lint 및 당시 전체 typecheck는 통과했다. 이 부분 실행을 아래 최종 전체 검사 통과로 확대하지 않는다.

근거는 `artifacts/pr06c/session-store-before-cases.json`, `session-store-after-cases.json`, `before-conversation-log.json`, `after-conversation-log.json`이다. 실제 HTTP/WS handler는 natural BEFORE 두 번으로 UUID·시각 비결정성을 확인한 뒤 Date/performance/유효 UUID 입력을 제어하여 BEFORE 두 번·AFTER 한 번 실행했다. answer-candidate 중복·rename barrier에서 next 중복·end 재전송·capture 저장 중 end·세션 간 분리·새 프로세스에서 원래 context/같은 turn/부분 전사 복구를 검증했다. 실제 세션·context·평가 enqueue 산출물 bytes는 정확히 같고, 세 로그의 `provider.config.payload.ports.realtime/web`만 타입/범위/key를 검증한 뒤 기준 포트로 일대일 대응시켜 **전체 반환값·원문 파일·행/키 순서·hash 관계**를 대조했다. 임시 포트 이외의 로그 행·시각·ID는 제거·정렬하지 않았다. 원래 raw 파일 bytes/hash도 별도로 남겼다. 독립 최종 비교 `repository-comparison.json`의 **60/60 항목 통과**, 실패 0이다. 제어한 실행 순서의 근거이며 모든 다중 프로세스 경쟁·전원 차단·실기기 시험은 아니다.

## Private 자료와 최종 검사 상태

BEFORE private 관측은 완료했다. 보호 대상은 audio/prepared/sessions/session-contexts/conversation-logs/evaluation-jobs/local의 **1,497개 파일**이다. 실제 `load/list/loadContext`, runtime recovery projection과 기존 JSONL parser를 실행하며 private append·복구 save·이벤트 보정은 하지 않는다. 원문·ID·owner는 출력하지 않고 digest만 기록한다.

BEFORE에서 세션 110개 중 79개 반환·31개 기존 owner/runtime 조건으로 거부, 참조 context 68개 반환을 관측했다. 이를 110개 세션의 이관·인증 성공으로 표현하지 않는다. context 73개 파일 전체는 별도 binary inventory로 보호한다. 로그는 세션 110개에 대응하는 조회 slot이며 실제 로그 파일 수와 구별한다. `before-private.json`의 write/network 시도는 각각 0이다. 최종 AFTER에서 같은 결과를 관측했고 **1,497개 파일 / 2,015,815,973 bytes 전체의 파일 identity·bytes가 동일**했다. 세션 반환 79·기존 거부 31, context 반환 68, 순서 있는 로그 parser 출력 및 owner별 목록/recovery projection도 일치한다. 실제 자료의 쓰기·네트워크 시도는 0이며 원문·실제 식별값을 공개 fixture로 복사하지 않았다.

| 필수 검사 | 현재 보고 상태 |
| --- | --- |
| `npm test` | **1,385/1,385 통과**, 실패·취소·skip 0; `full-tests.log` |
| `npm run test:portable` | **1,186/1,186 통과**, 제외 21개 파일·199개 테스트; `portable-tests.log` |
| `npm run typecheck`, `npm run lint`, `npm run build` | 모두 exit 0. production build 정적 페이지 5개 생성. 후속 증거 도구 수정은 별도 최종 타입·린트 검사 |
| `npm run verify:contracts`, `npm run verify:domain-contracts` | 둘 다 exit 0. 제안 52 형태+4 span+4 추가 parity; 현행 6종 codec 38 형태+32 transport+8 span+18 roundtrip. Python 권한/원문 QA와 TS 의미 검증 차이를 원래 보고서대로 명시 |
| `npm run verify:analysis-private -- --proposal=<확인한 기존 비공개 입력>`, `npm run verify:question-private` | 둘 다 exit 0. 분석 현재 full/target/wire exact·과거 21개(v1 2/v2 19) 보존; 질문 목적 36·후보 35·승인 계약 35·envelope 108·기존 평가 31개 보존, provider 0 |
| `npm run prepare:evaluation-scopes -- coverage` | exit 0: 질문 승인 35, 평가 규격 승인 **0**, 검수 대기 35, `scope_review_required`, `sessionEvaluationReady=false`, provider 0 |
| working-tree / tracked-only source closure | working-tree **1,720개 local import 통과**. tracked-only exit 1: BEFORE **29 edge /15 파일**, AFTER **34 edge /18 파일**. 정확한 의존·커밋 포함 대상은 `source-closure-summary.json`; Git 추적/원격 CI 완료로 표현하지 않음 |
| `git diff --check`, AFTER manifest·보호 영역 대조 | diff 검사 exit 0. 최종 manifest/change summary·private 비교는 아래 개별 증거에 기록 |

전체 테스트는 `tests/*.test.ts`, portable은 기존 `tests/private-fixture-suites.json`의 21개 파일 전체를 제외한다. Python parity는 별도 실행이며 browser/device 진단은 이번에 실행하지 않았다. JS Ajv는 fail-closed Draft-07 공통 부분집합 변환이며 Draft 2020-12 전체 지원이 아니다. 수신 원본 스키마·원래 보고서를 보존했고 기존 기본 출력 보고서는 백업·복구하여 새 결과를 `artifacts/pr06c/`에 따로 남겼다. B의 전체 1,372/portable 1,173을 C 기대값이나 현재 통과 수로 고정하지 않는다. 수집 도구 개발 중 UUID variant가 잘못된 제어 입력은 400으로 거부됐다. 이를 유효한 합성 UUID로 수정했다. 종료가 먼저 수락된 capture의 기존 WS 응답은 finalized가 아니라 error임을 BEFORE에서 확인해 기대값을 맞췄다. 마지막 선택적 error journal까지 기록되는 것을 기다린 뒤 증거를 수집하도록 수정하고 다섯 handler 실행을 모두 다시 수행했다. 제품 의미 정책은 변경하지 않았다. 담당 테스트의 타입 단언 수정도 실제 동작 변경은 아니다. 새 npm ci·원격 CI·W0 통합·실마이크/상용 STT/TTS·유료 모델은 이번 부분 검증에서 실행하지 않았다.

G0는 정확한 변경 commit과 필요한 미추적 의존 포함, 그 commit의 원격 CI가 확보될 때까지 미완료다. working-tree 성공은 원격 관문을 대체하지 않는다. G1 실제 문항/종료 답변 A/B 내용 검수와 실장치 미디어는 별도다. PR04 의미 품질도 미완료이며 W0는 별도 worktree 미통합 상태다. 실제 평가 승인을 자동 생성하지 않는다. G2에서 C의 계약·local caller·독립 보존 검증 관문은 충족했다. G2 전체는 D의 평가/검수 저장 경계가 남아 미완료다. 이번 실제 Windows 파일 I/O·HTTP/WS child process 실행은 로컬 실환경 검증이며, transport/provider/PCM은 합성이므로 실제 브라우저·마이크·상용 STT/TTS 검증으로 표현하지 않는다.

## PR06-D 진입 조건·분해와 롤백

C의 실제 caller/실패/복구·독립 비교·필수 검사 관문을 확인했다. 다음 D는 아래 순서의 별도 변경으로 준비한다. **이 문서 작성으로 D를 구현하거나 승인하지 않는다.**

| D의 다음 slice | 대상·실제 caller·보존할 경계 | 필수 회귀 |
| --- | --- | --- |
| 평가 job/snapshot/result local I/O | `evaluation-job-store.ts`, `evaluation-worker.ts`, realtime 상태/재시도 → 현행 EvaluationJobStore의 평가 저장 계약·local adapter 분리 | 동일 job ID/fingerprint·snapshot/result hash·상태·원자 확정·실패 재시도·기존 lease 의미. 새 DB lease/fencing/Outbox 정책 제외 |
| 서명된 검수 자료·현재 registry | `data/evaluation-scope-registry.ts`, `evaluation-supply.ts`, `data/reviewed-evaluation-context.ts` → 제안 ReviewRepository 경계와 기존 gate 분리 | 사전 규격 A와 실제 종료 입력 B 구분, 서명/actor·owner·정확 답변/hash, CAS 충돌, 모델 전/확정 전 철회, 미승인 review_required |
| 검증된 평가 revision·과거 결과 조회 | `evaluation-revisions.ts`, `evaluation-history.ts`, realtime 조회·별도 revision append → 평가 저장 경계에 연결 | 동일 receipt 재전송/새 receipt revision, conflict-closed, v4 완료 결과 검증, held-F·묶음 제외, 원본 세션·결과 불변 |
| 실제 composition·운영 CLI | worker/realtime/supply의 기존 store 수명과 factory를 위 계약에 연결 | 실제 caller·writer와 독립 BEFORE/AFTER fixture, 부분 실패·종료 재시도·세션 port 연계. 다사용자 Auth/RLS 완료로 확대하지 않음 |

국소 fallback은 기존 `new LocalSessionStore(directory, io)` 또는 local factory와 동일 default logger를 사용한다. C 전체 추출을 되돌릴 때는 C BEFORE snapshot과 파일별 diff로 **C의 계약·caller·adapter 변경만** 역적용한다. 저장 포맷·ID·hash를 바꾸지 않아 데이터 재작성·역이관은 필요 없다. A/B·PR01~05·사용자·W0 변경을 포함한 reset/clean은 사용하지 않는다. ID/원문/hash 변화, frozen input 덮어쓰기, 필수 오류의 성공 처리, 복구 기한 연장·승인 확대가 발견되면 C의 해당 변경을 먼저 수정·재검증하거나 국소 롤백한다.

## Portable 제외 파일과 소스 추적

`tests/private-fixture-suites.json`의 다음 21개 파일 전체가 제외된다. 해당 파일 안의 합성 사례도 제외되므로 이번 전체 1,385개 실행이 별도로 필요했다.

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

추적 파일이 직접 참조하는 미추적 대상 18개는 `artifacts/pr06c/source-closure-summary.json`의 `after.requiredUntrackedFiles`에 정확한 상대 경로로 남겼다. 여기에 각 파일의 전이 의존성과 관련 테스트·문서·CI 설정을 최종 working-tree manifest 기준으로 함께 포함해야 한다. 이 작업에서 stage/commit을 수행하지 않았다. C 추가/수정 파일 목록은 `source-change-summary.json`이며 이전 PR의 미추적 구현을 C 신규 구현으로 집계하지 않는다.

직접 누락된 18개 파일(34개 import edge와 구별):

```text
server/contracts/analysis-domain-adapters.ts
server/contracts/question-domain-codecs.ts
server/data/evaluation-scope-registry.ts
server/data/reviewed-evaluation-context.ts
server/evaluation-history.ts
server/evaluation-revisions.ts
server/evaluation-supply.ts
server/policy/evaluation-scope-policy.ts
server/repositories/analysis-read-ports.ts
server/repositories/audio-ports.ts
server/repositories/conversation-log-ports.ts
server/repositories/local-audio-repository.ts
server/repositories/local-conversation-log-repository.ts
server/repositories/local-question-bank-repository.ts
server/repositories/local-read-repositories.ts
server/repositories/question-bank-ports.ts
server/reviewed-evaluation-queue.ts
server/storage/session-store.ts
```

# PR07-E 격리 세션 단일 writer·CAS·멱등

2026-11-07 KST. 기준선은 D `34c257efe27d268bffb7ba560ff79ae2880a6602`다. [청사진 v2](architecture-blueprint-v2.html), [PR07 전환 계획](pr07-account-storage-transition-plan.md), [D 읽기 계약](pr07d-read-shadow.md), [PR06-C](pr06c-session-storage.md)·[PR06-D](pr06d-evaluation-review-repositories.md), [현행 codec](pr05-domain-contracts.md)와 [평가 공급계약](evaluation-supply-contract-v0.1.md)을 따른다. 철회된 정책·제안 envelope로 정본을 교체하지 않는다.

이 문서는 구현 계약과 재현 방법이다. 실제 최종 SHA·실행 명령/exit code·고유 로그·두 서버/CI·원본 보존 판정은 Git 제외 `artifacts/pr07e/final-report.json`과 개별 보고서를 따른다. D의 실행 수를 E 통과 수로 재사용하지 않는다. 실제 D 인계는 D 작업본의 `artifacts/pr07d/pr07e-handoff.md`에서 확인했으며 새 문서로 대체하지 않았다.

## 범위와 writer 권위

기존 local 세션·답변·평가 저장은 그대로 유지한다. E가 쓰는 것은 소유한 격리 환경의 합성 인증 세션이다. 운영 미설정 mutation503, 실제 계정/학생 귀속 미공급, private 실제 Storage 미검증을 유지한다. E composition은 명시적인 `environment: isolated-session-writer`와 synthetic provider·서버가 주입한 DB pools/현재 A identity/D preparation을 요구하며 production에서는 활성화할 수 없다. 환경변수 하나로 기존 개인 세션을 DB writer로 전환하지 않는다.

DB의 세션 writer 행이 owner/student/개인 applicationTarget/supportTarget/source와 writer mode·generation/token을 결정한다. 프로세스 Map은 provider socket/cache만 보관한다. 같은 E 세션을 local로 fallback하지 않는다. 독립 local 프로그램이 DB를 조회하지 않아도 분산 fencing을 갖춘다고 주장하지 않는다. 대신 새 authenticated payload는 local writer가 거부하고 E composition에는 local writer가 없다.

| 계약 | 보존·신규 의미 |
|---|---|
| `session-runtime-v1` | 기존 local owner/mode·epoch·JSON·서명/hash 대상 유지. 기존 파일 일괄 변환 없음 |
| `authenticated-session-runtime-v1` | owner.mode=`authenticated`; A가 발급한 owner를 사용. 실제 scope는 DB의 바깥 binding이 권위 |
| runtime `epoch` | 기존 논리적 재접속·provider 관찰 세대. 10분 복구 창 유지 |
| DB `revision` | 매 command/progress의 CAS 선행 상태. 최신 snapshot 무조건 upsert 없음 |
| DB `writerGeneration`/`writerToken` | writer 선택/복구/동결 fence. token은 서버 내부이며 DTO 소유권 값으로 사용하지 않음 |
| `operationId`/`operationToken`/`attemptId` | durable 업무와 외부 시도 식별. 늦은 결과는 원래 intent/generation/CAS에만 연결 |
| `sessionJson`/`contextJson` | 정확한 TEXT 및 UTF-8 SHA. JSONB는 권한/관계 검증 projection이며 원래 bytes/hash 대체물 아님 |
| 새 인증 codec/schema | 새 인증 envelope/command의 version 호환 검증. 기존 Full/Target/목적/질문 codec와 수신5종 schema는 유지 |

## 실제 caller와 저장 연결

| 기존 caller·도메인 | E 실제 경로 | 확정·부수 효과 |
|---|---|---|
| local `/api/sessions`, `newSession`, `prepareTurn` | `createServiceRealtimeServer`의 명시적 E mutation → `createIsolatedSessionService` → 공유 lifecycle/turn preparer → command repository | verified D context/source/analysis/profile/bank/policy/schema/model pin을 먼저 고정. context+session publication+receipt를 같이 확정 |
| WS start/finish·PCM | 같은 service WSS ticket/Auth 경계 → opaque connection/capture 소유권 → synthetic STT → 공유 capture/전사 gate → DB CAS | PCM await 동안 DB connection 없음. provider-confirmed part와 error/unknown을 구분. 다른 socket close가 현재 producer를 닫지 않음 |
| staged candidate·answer·next | 기존 `assertCapture*`·single-core 판단/검증·`answerMetrics`·answer observation·공유 `prepareTurn` | candidate 우회/answer ID 교체 금지. answer fact·필수 event·canonical 새 turn·receipt 최종 원자확정 |
| playback/event/timings | 공유 `applySessionClientEvent`/`recordQuestionPresentation` | 생성/준비와 실제 전달을 구분. late event는 frozen 입력을 다시 쓰지 않음 |
| GET/context/receipt·recover | 현재 A/B 권한 → E snapshot/정확한 TEXT/receipt → 공유 authenticated recovery → CAS | 현재 revision/generation 조회, 10분 창·streaming→paused·새 epoch와 DB fence. 오래된 WS/provider 결과 거부 |
| `commitSessionEnd` | 공유 첫 종료 입력 수락 → durable end intent → DB 밖 ordered capture drain → 공유 end finalization → frozen F handoff/receipt | DB 세션에서 local `beginEvaluation`/`evaluationJobs.enqueue`/파일 pointer 생성0 |

소켓 close는 current generation의 opaque connection token별 최초 DB 시각을 별도 불변 관측 원장에 남긴다. 이 관측은 canonical session JSON/revision을 바꾸지 않아 대기 중 정상 provider commit을 방해하지 않는다. 10분 복구 창의 마지막 관측 기준이며 접속자 존재를 증명하는 lease는 아니다. 새 generation은 옛 관측을 재사용하지 않는다.

`prepareTurn`·`prepareClosing`의 원래 함수 본문을 provider/persistence dependency가 명시된 factory로 추출했다. local 실제 caller도 같은 factory를 사용한다. 별도 질문 엔진이나 의미 정책을 복제하지 않는다. 원문·승인·F 상한·clarification·재생·시간/과금 규칙은 기존 함수를 따른다. 함수 본문 대응과 회귀 증거는 `artifacts/pr07e/domain-extraction-proof.json`에 있다.

## Command·receipt·transaction

`SessionStore`의 save/load/list/saveContext/loadContext 5개 계약은 유지한다. 새 DB API는 `SessionCommandRepository`의 enroll/findCreation/read/list/receipt/beginIntent/persistProgress/commit/claimWriter/freeze/export/restore로 분리한다. enroll은 특정 scope/session/creationKey/input SHA/만료/current-check에 묶인 서버 내부 finite capability를 요구한다.

추가 SQL은 `0004_session_writer.sql`이며 B bootstrap/0001/seed, C0002, D0003와 checkpoint bytes는 변경하지 않는다. 적용·재실행·SQL checksum 변조·catalog drift를 별도로 검증한다. owner/student/applicationTarget의 복합 관계·RLS·제한 역할을 사용한다. 일반 요청이 임의 verified 객체·다른 scope·기존 local 세션을 등록하지 못한다.

멱등 키는 현재 인증 scope/session에 묶인다. 업무 입력 fingerprint는 `{version, action, payload}`의 원래 `JSON.stringify`이며 key/CAS revision/generation/resume metadata와 구분한다. business payload의 필드·배열·optional/null을 정규화해 맞추지 않는다. 같은 키의 다른 업무 입력은 충돌이다. 같은 입력의 이미 committed receipt는 현재 권한/입력 SHA를 확인한 뒤 stale revision/generation 검사보다 먼저 반환한다. 다른 키의 같은 turn/answer/capture semantic identity도 중복 확정하지 않는다. 이미 확정된 by-key/semantic 결과를 읽기 전용으로 먼저 확인한 뒤, 새 명령은 순수 도메인 preflight와 begin 이후 동일 조건을 다시 검사한다. 거부된 입력의 key를 다른 입력으로 재사용하도록 완화하지 않는다. 종료는 다른 키의 재요청이 최초 수락 입력을 덮어쓰지 않는다.

긴 작업은 begin intent → connection 반환 → provider/Storage await → 현재 권한·operation token·writer generation·expected revision 확인 → commit 순서다. 공유 preparer의 준비 draft/audio checkpoint는 progress로 저장하되 canonical 새 turn/committed 응답은 최종 receipt와 함께 저장한다. 정상 완료의 session/answer fact/context 참조/필수 event/receipt는 하나의 transaction이다. 관측 로그를 fire-and-forget 파일에만 두지 않는다.

권한 확정은 account 행의 `FOR SHARE`와 현재 grant 검사로 mapping 변경/철회의 순서를 정한다. `FOR KEY SHARE`로 non-key revision 변경까지 막는다고 표현하지 않는다. DB connection/row lock을 외부 await 동안 유지하지 않는다. statement timeout·pool reset·A context/current scope 재검사 뒤 결과를 공개한다. 확정 후 철회되면 권한 없는 receipt 조회는 거부하지만 committed 사실을 지우지 않는다.

95초는 동일 turn/answer/capture의 durable `SubmissionWorkRecord` 한 개에 묶인다. staged finish 전에 DB 시각으로 시작하고 STT finalization→candidate→answer→next가 같은 deadline을 사용한다. 다른 endpoint/서버/재시도가 새95초를 주지 않는다. Node waiter는 잔여 시간을 monotonic timer로 제한하고 SQL 최종 CAS도 같은 deadline을 검사한다. CONTINUE 뒤 정당한 새 capture revision은 별도 시도다. 이전 epoch/terminal attempt는 되살리지 않는다. 기존 local registry의 의미는 유지한다. 새 mutation과 WSS 연결은 현재 엔진 버전도 확인하며 기존 committed receipt와 읽기는 보존한다. 격리 v1에는 `cancel_submission` adapter가 없으며 지원하지 않는 명령을 명시적으로 거부한다. 기존 local 취소 경로는 유지하고, E의 취소·회수는 durable recovery/freeze fence와 provider 정리로 검증한다.

## 버전이 명시된 격리 HTTP/WSS

모든 개인 요청은 실제 JWT를 검증하고 `applicationTargetId` 등 선택 query로 A/B scope를 결정한다. client owner/role/header가 권위가 아니다. 기존 local UI DTO와 E DTO는 자동 호환으로 가장하지 않는다. W0 실계정 UI/API는 이번 범위 밖이다.

```json
{
  "version": "authenticated-session-command-v1",
  "key": "example-create-1",
  "expectedRevision": "0",
  "writerGeneration": "1",
  "payload": {}
}
```

POST `/api/sessions`는 생성, `/api/sessions/:id/{capture-start,capture-finish,answer-candidate,answer,next,events,timings,recover,end,closing}`는 명시한 command를 처리한다. 생성 ID는 현재 서버 scope+creation key로 결정하며 원래 local ID를 바꾸지 않는다. `resume:true`는 미확정 같은 생성 입력의 명시적 복구이며 새 writer fence를 획득한다. 이미 확정된 생성은 원래 receipt를 재조회한다.

GET `/api/sessions/:id`는 현재 revision/generation·recovery·handoff 상태를, `/context`는 정확한 context/pins TEXT와 각 SHA를 반환한다. `/commands?key=...&inputSha256=...`는 실제 durable 최초 receipt를 반환한다. 응답은 operation ID/committed revision/input SHA와 결과를 포함하며 writer token은 노출하지 않는다. receipt 부재·CAS/input 충돌·권한 거부·기한 초과·의존성 장애·commit 결과 불명을 구분한다.

WSS는 기존 일회용 ticket과 Origin/Host/current-authority 검사를 유지한다. E ready에서 writer generation을 전달하고 `{"type":"command","action":"capture-start","command":{...}}` 형태를 사용한다. connection token은 서버 내부다. capture 시작 응답 뒤 해당 socket의 PCM을 받으며 현재 capture/connection/generation을 검사한다. unsupported 작업과 기본 운영 mutation은 계속 명확히 거부한다.

freeze 뒤의 closing은 별도 presentation/receipt로 보존하며 canonical frozen session에 넣지 않는다. 그 재생 event는 `payload.closingReceipt={key,inputSha256}`로 실제 같은 세션의 closing receipt를 검증한다. 라벨이나 DTO 음성 URL만으로 발화·전달을 승인하지 않는다.

## 종료·F 인계

첫 end 요청의 elapsed/metrics/capture scope를 먼저 durable하게 수락한다. 같은 intent의 재시도가 다른 최초 입력을 만들지 않는다. HTTP end와 WS의 전송 순서가 다르므로 같은 capture scope의 ordered finish marker를 기존2초 범위에서 기다리고 선행 PCM을 배출한다. 확인되지 않은 stream은 error/unknown으로 보존하며 정상 침묵으로 승격하지 않는다. provider wait는 DB transaction 밖이다. 다른 서버가 종료를 받으면 capture 소유 서버의 같은 finalize receipt로 합류한다. 2초 안에 순서대로 수신한 marker의 durable checkpoint가 있으면 기존 STT 15초 한도까지 최종화를 기다리며, PCM 수신 허용 창 자체는 늘리지 않는다.

최종 답변/전사·accepted end input·checkpoint와 context/source/model/schema pin을 확정하고, 동일 transaction에 unique `session-evaluation-handoff-v1` intent를 기록한다. F 입력에는 정확한 session/context/pins TEXT와 hash·pipeline/model·accepted intent를 포함한다. 새 DB 경로는 `awaiting-evaluation-consumer`/`review_required`이며 실제 job이 없으면 queued/running/completed라고 표시하지 않는다. E에는 평가 worker·검수 writer·서명 발급·점수 생성 경로가 없다.

질문승인35/평가규격승인0/검수대기35 및 `sessionEvaluationReady=false`를 유지한다. A 사전 문항 승인과 B 종료 입력 검수 승인을 합치거나 복제하지 않는다. ROLE 자동 승인·held-F 삭제/재가중·평가 모델 재시도를 추가하지 않는다.

## 실패·롤백·검증 관문

commit 전 실패는 미확정 intent/progress와 논리적 성공 receipt를 구분한다. commit 후 응답 유실은 같은 key/input SHA의 receipt와 최초 결과를 조회하며 새 답변·새 종료를 만들지 않는다. stale generation/provider 결과는 최신 snapshot을 덮어쓰지 않는다. 외부 호출의 전역 exactly-once를 주장하지 않으며 각 attempt와 단일 결과 확정을 구분한다.

DB 신규 확정 전에는 revision0과 receipt 부재를 확인하고 writer 선택을 복귀시켜 이전 generation을 차단한다. 확정 후에는 먼저 read-only freeze로 진행/옛 writer를 차단하고 context/session/답변/event/receipt/end/Fhandoff·ID/version/hash를 역보존한다. 소유한 별도 빈 격리 DB에 복원하여 재조회와 동일 멱등 요청 replay를 확인한다. 단순 JSON export만을 복구 성공으로 세지 않는다. 인증 runtime을 local-development로 바꿔 강제 복귀하지 않으며 호환되지 않으면 DB 읽기 전용 보존으로 남긴다. migration DOWN·전체 DB/bucket 삭제·자동 local fallback은 데이터 보존 롤백이 아니다.

실제 두 서버 시험은 서로 다른 Node 프로세스/독립 max1 pool과 실제 PostgreSQL17.11에서 수행한다. 기존 B/C/D와 별도의 E CI job은 공식 Storage API에서 D preparation을 검증하고 그 context로 실제 E HTTP/WSS caller를 실행한다. SQL 단독·controlled body provider 진단·공식 Storage·합성 STT/TTS/LLM을 구분하고 유료 AI 호출은0으로 유지한다. 임의 sleep만으로 경합을 정하지 않고 barrier/실패 주입/receipt로 확정 순서를 확인한다.

새 설치와 필수8검사, root full/portable·private codec roundtrip/coverage 및 B/C/D/E nested suite를 각각 기록한다. root glob은 `tests/*.test.ts`이며 nested SQL/Storage/session-writer suite를 포함하지 않는다. 기존 private 제외21파일/199사례를 늘리지 않는다. 비공개 원본1665·credential1·공개17·평가결과31 및 backend/W0/A/B/C/D의 physical bytes와 Git 상태를 전후 대조한다. D private112비교는111완전일치+전략 표시시각1명시예외를 유지한다.

완료는 E 구현, 합성 실제 DB/두 서버 격리 검증, 기존 local/원본 보존을 구분한다. 운영 writer 전환은 범위 밖이다. private 실제 Storage, 실제 Auth/귀속/provider/bucket/운영 책임, W0 실계정 브라우저 QA, G1 실제 검수·장치/상용 음성, PR04 의미 품질, F 평가·검수 writer/G 제한 전환/PR08 일반 job·비용/G4 identity·OCR는 별도 관문으로 남긴다.

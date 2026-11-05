# PR07 계정·DB·비공개 Storage 전환 준비

2026-11-06 KST. **준비 문서이며 구현·이관·운영 전환의 완료 보고가 아니다.** [청사진 v2](architecture-blueprint-v2.html) §8·§14·§16·§18·§20·§21, [평가 공급계약](evaluation-supply-contract-v0.1.md), [현행 codec 대응표](pr05-domain-contracts.md), [PR06-D 저장 경계](pr06d-evaluation-review-repositories.md)를 따른다. 철회된 정책이나 제안 envelope를 새로운 정본으로 적용하지 않는다.

PR07 착수 전에는 PR01~D 백엔드와 W0 합본의 정확한 Git 커밋, 새 설치, tracked source closure, 필수 검사, 원격 CI 결과를 각각 확인한다. 이 문서는 G0·통합 QA가 끝났다고 선언하지 않는다. 실행 SHA·run URL·미검증 항목은 별도 실행 보고서를 따른다. W0 일반 화면의 disconnected 상태와 개발 전용 합성 preview는 실제 API를 연결하기 전까지 유지한다.

## 소유권과 버전의 경계

| 경계 | 다음 구현에서 확정할 계약 | 보존·거부 조건 |
|---|---|---|
| 인증 계정 | 검증된 Auth subject에서 내부 account/owner를 서버가 결정한다. 이메일·표시명·브라우저가 보낸 owner 값은 권위가 아니다. | 토큰 issuer/audience/유효성 확인과 계정 매핑 실패 시 거부. 웹·WSS·worker 모두 같은 소유권 규칙 적용 |
| owner | 개인 행·객체·작업·검색·캐시를 소유하는 안정된 내부 식별자 | 현재 `LOCAL_INTERVIEW_OWNER_ID`와 `local-development-owner`는 개발 경로다. production에서 fallback으로 인증을 대체하지 않음 |
| student | 소유 계정에 속한 학생 프로필. 계정 subject와 학생 ID는 별개 | 기존 `studentId` 보존. 같은 학생명·PDF hash로 타 계정 프로필을 합치지 않음. 공동 소유/보호자 공유는 별도 권한 계약 전까지 지원한다고 가정하지 않음 |
| application target | owner/student에 속한 개인 지원처와 모집단위·전형·학년도·검증된 profile revision의 연결 | 현행 `supportTargetId`와 개인 지원처의 신규 DB 키를 구분. 기존 payload의 ID를 새 DB UUID로 덮어쓰지 않음 |
| source/analysis version | 원본·extraction·분석·profile·bank의 불변 revision과 활성 포인터 분리 | `FullStudentAnalysis`/`TargetStudentAnalysis`, 목적 ID, 원문·인용·앵커·UTF-16 범위·hash 보존. common identity 분리와 OCR 운영화는 G4 |
| session/answer | 세션 생성 시 owner/student/target/source/policy/bank/model/schema snapshot을 고정 | 현재 지원처 변경이 과거 세션 snapshot을 바꾸지 않음. 답변·전사 수정은 새 revision이며 메모 수정과 실전 발화를 구분 |
| review authority | 실제 검수자·권한·서명키/철회 정보를 운영 주체가 제공 | 질문 승인, 사전 평가 규격 A, 종료 입력 검수 B를 분리. 로그인하거나 DB에 옮긴 사실만으로 승인하지 않음 |

기존 `ReadScope`/`DomainScope`의 null은 미확인 pin이며 전체 계정 접근이나 최신 포인터 자동 선택을 뜻하지 않는다. 현행 코드가 허용하는 null의 읽기 호환성은 유지하되 새 production 요청에서 필수 소유권을 검증하지 못하면 실행을 거부한다. 누락·null·빈 문자열·미확인 상태를 한 값으로 일괄 변환하지 않는다.

## 현재 port와 실제 연결점

| 현재 계약·caller | DB/Storage adapter가 맡을 부분 | 도메인에 남길 부분·선행 제약 |
|---|---|---|
| `SourceRepository`·`AnalysisRepository` → current/staged/context/검수 조회 | owner 범위 원본 객체, 불변 분석 버전·현재 pointer 조회 및 변경 감지 | codec, 원문 hash·revision 검증, 읽기 중 동일 snapshot 확인. 신규 generic schema로 교체하지 않음 |
| `QuestionBankRepository` → 은행 조회·준비 | owner/target/bank key·정본 hash별 준비 상태와 발행 pointer | 기존 목적/승인 계약·은행 내용 검증. UI target 전환을 다른 은행 읽기 권한으로 삼지 않음 |
| `AudioRepository` → CLOVA cache·승인 음성 재생 | 비공개 객체와 메타데이터, owner 확인 후 제한된 음성 전달 | 실제 재생 확인과 생성 완료 구분. hash가 같아도 개인 음성은 계정 간 공유하지 않음 |
| `SessionStore` 5개 메서드 → realtime·종료·복구 | 세션/context 저장·owner 조회와 불변 snapshot | accepted end input·checkpoint·멱등·시간/과금 정책. 현재 메모리 직렬화는 다중 서버 DB CAS 보장이 아님 |
| `ConversationLogRepository` → logger | owner/session별 전사·이벤트 append와 내구 저장 | 순번·중복 제거·redaction·오류 처리. 현재 `coordinationKey`와 프로세스 큐를 분산 lock으로 표현하지 않음 |
| `EvaluationRepository`·기존 `EvaluationJobStore` → worker | job/snapshot/result·시도별 usage·상태 전이의 트랜잭션 저장 | 작업 ID·pipeline·정확한 종료 입력·최신 승인 검사·held-F·v4 reader. 파일 short lock을 DB lease/fencing으로 단순 치환하지 않음 |
| `ReviewRepository` → 공급·검수 registry·준비 CLI | 불변 receipt/bundle/context와 현재 registry pointer의 CAS | 서명·actor·입력 binding, 모델 전/결과 확정 전 최신 승인 확인. Storage URL이 검수 권위가 아님 |
| `EvaluationRevisionRepository` → 결과 revision/history | owner/session별 불변 revision reference 및 조회 | 원본 결과·v4 신뢰 검증·동일 시각 conflict·이전 결과 보존 |

현재 ports는 local 추출의 경계다. `ReviewRepository`의 경로 반환 메서드와 `EvaluationRepository.directory`/legacy root 추론은 DB 경로가 아니므로 그대로 가짜 파일 경로를 반환하는 adapter를 만들지 않는다. 실제 caller의 locator 사용을 먼저 열거하고, 명시적인 객체 참조/구성 입력이 필요한 곳만 버전 호환 계약으로 확장한다. local adapter와 기존 호출부의 회귀를 함께 남긴다. worker용 owner scope와 요청 인증도 경로 문자열로 추론하지 않는다.

## 작은 구현 단위와 통과 조건

아래 순서는 제안 작업 단위다. 이번 작업에서는 SQL 실행, 계정 발급, RLS 변경, 객체 업로드, DB writer 교체를 하지 않는다. 각 단위는 검토 가능한 별도 변경과 해당 환경의 실행 증거를 요구한다.

| 단위 | 범위와 산출물 | 다음 단위로 이동할 조건 |
|---|---|---|
| PR07-A 요청 identity | 검증된 인증 주체→owner/student/target의 `RequestContext`, production 개발 fallback 차단, HTTP/WSS·worker 전달 규칙. 기존 local 개발 경로 보존 | 두 계정의 같은 문서 hash·같은 target 명칭·추측한 session/job ID로 교차 조회·수정이 모두 거부됨. production 미인증 거부, local 회귀 통과 |
| PR07-B 관계·RLS 설계와 격리 실험 | 격리 DB에서 account/student/target·불변 version·객체 메타데이터·migration mapping 관계를 검증하는 migration 및 테스트 준비. 개인 행에 owner, 복합 FK 또는 트랜잭션 소유권 검증 | 사용자 토큰·service role·worker 각각 직접 ID 조회와 join/검색/목록의 두 계정 격리 통과. service role의 RLS 우회를 명시적으로 통제 |
| PR07-C 비공개 객체 adapter | 원본 PDF·원문·분석·음성·검수 bundle의 object key와 정확한 원본 bytes 보존. 사용자 입력 key 대신 서버가 소유권을 확인한 객체 참조 사용 | 발급/완료 확인/읽기/만료·취소의 권한 시험. signed URL 발급을 업로드 접수 완료로 오인하지 않음. hash·크기·owner가 확인되기 전 active pointer 변경 없음 |
| PR07-D 읽기 이관과 shadow 비교 | 아래 inventory/mapping 절차, 기존 local reader와 DB/Storage reader의 독립 조회 대조. local이 유일 writer인 상태 | 원본 bytes·ID·인용·앵커·hash·버전·조회/거부 결과 보존. missing/rejected/quarantine을 임의 복구해 통과시키지 않음 |
| PR07-E 세션 writer 전환 | owner/student 또는 session별 전환 상태, 트랜잭션 version/CAS·멱등키·결과 재조회 경계. 종료·답변·context 확정의 단일 writer | 두 서버 동시 제출/종료 중복 0, DB commit 후 응답 유실의 재시도 결과 동일, 권한 변경/DB 장애 시 미확정 성공 응답 없음 |
| PR07-F 평가·검수 writer 전환 | A/B 검수 공급·job/result/revision·승인 pointer의 DB 경계. 기존 권한과 frozen input 연결, stale worker 방지 방식의 독립 설계·검증 | 전환 전후 최신 승인 확인, 실행 중 철회, CAS 경합·멱등·부분 실패·재시도·held-F·검증된 v4 조회 일치. 실제 승인 자료 없이 점수 생성하지 않음 |
| PR07-G 제한된 전환 검증 | 명시적으로 선택한 범위만 새 primary writer로 전환하고 역보존·복구 훈련 | 다음 절차의 증거와 운영 승인 후 범위 확대. W0 실계정 API는 별도 계약/구현/검증으로 연결 |

Outbox, 분산 lease/fencing, 권리·과금 원장은 G3의 필요한 운영 조건이다. PR07 준비만으로 구현됐다고 표시하지 않는다. DB commit과 외부 전송 사이를 원자적으로 처리해야 하는 범위를 정한 뒤, Outbox 중복 소비/재시도와 stale worker commit 거부를 별도 작은 변경으로 검증한다. 현재 모델·질문 의미·95초 처리·과금 정책 변경을 같은 migration에 넣지 않는다.

## 읽기 이관·검증 계획

1. 보호 inventory를 현재 실제 파일에서 만든다. 원본 경로, bytes/SHA, 기존 ID, owner/target/source/policy revision, 현재 포인터, 이전 결과·거부 이유를 비공개 manifest로 기록한다. 과거 파일 개수를 맞추려고 누락시키지 않는다. 공개 보고서는 원문·학생 ID·영수증·비밀값을 제외한다.
2. 소유권이 입증된 범위에만 `old_id → new_storage_id` mapping을 만든다. 개발 owner를 처음 로그인한 계정에 자동 귀속하지 않는다. legacy domain ID와 서명된 payload는 그대로 보존하고 별도 권한 mapping의 승인 근거를 남긴다. 기존 서명 payload의 owner 값을 바꿔 새 승인을 만들지 않는다.
3. 불변 객체와 기존 serialized payload를 복사하고 bytes·원래 hash 대상을 각각 검증한다. JSONB의 key 재정렬·숫자/Unicode 변환이 원본 JSON 또는 서명 대상 bytes를 대신하지 않게 한다. 원본 text/bytes, 검색용 projection, transport `payloadJson`을 구분한다.
4. 불변 revision·mapping·참조 정합성이 검증된 뒤 shadow reader에서 current/staged/pinned/historical을 대조한다. active pointer는 임의로 최신 값을 선택하지 않는다. 분석·질문·답변의 UTF-16 span과 anchor, exact source pin, 목적 ID, 승인 계약 및 원래 hash를 확인한다.
5. 결과뿐 아니라 거부 코드, 누락/null, 검수 대기, stale revision, 변조된 과거 결과, held-F, owner 불일치, 동일 receipt 재시도·revision conflict를 함께 비교한다. 비교 차이를 일괄 정렬·trim·null 삽입으로 숨기지 않는다. 허용할 변환은 사전 규칙과 역추적 mapping으로 제한한다.
6. 읽기 비교 통과 후에도 기존 파일은 read-only migration 원본으로 보존한다. 새 DB 읽기 성공은 Auth/RLS·다중 writer·실기기·실제 내용 검수 통과를 대신하지 않는다.

## 단일 primary writer 전환과 롤백

전환 범위는 학생 또는 세션 단위로 명시한다. 서로 참조하는 session/context/answer/job/revision의 일관성 묶음을 먼저 정하고, 해당 묶음의 전환 상태를 하나의 권위 있는 위치에서 확인한다. 무제한 local+DB dual-write는 사용하지 않는다.

1. **Local primary / shadow read:** local만 저장한다. DB에는 승인된 이관 도구가 불변 기준본을 적재하고 비교한다. shadow 실패가 실제 운영 결과를 바꾸거나 성공으로 숨겨지지 않게 기록한다.
2. **전환 준비:** 해당 범위의 새 쓰기를 차단하고 진행 중 요청·worker를 종료/회수하는 절차를 정한다. 마지막 local checkpoint와 mapping·DB 복사·검증을 고정한다. 전환 경계에서 접수된 요청의 멱등키와 응답 재조회 방법을 남긴다.
3. **DB primary:** 범위의 writer 선택을 원자적으로 전환한다. 이전 local writer와 stale worker는 더 이상 확정할 수 없어야 한다. DB 장애 시 local로 조용히 쓰기를 우회하지 않는다. 사용자에게 확정되지 않은 저장을 성공으로 응답하지 않는다.
4. **DB 신규 쓰기 전 롤백:** 전환 시점 이후 새 확정 기록이 없음을 확인한 뒤 adapter/트래픽 선택을 local로 되돌리고 차단을 해제한다. 원본이나 과거 결과를 다시 쓰지 않는다.
5. **DB 신규 쓰기 후 롤백:** 먼저 해당 범위 쓰기를 동결하고 DB에서 새 확정 답변·전사·종료·usage·job/result/revision을 별도 역보존한다. local이 표현할 수 있는 형식/정책인지 검증하고, ID·버전·승인·원본 hash·멱등 상태까지 일치하는 역이관 또는 호환 reader를 준비한 뒤 전환한다. 보존을 증명하지 못하면 DB를 읽기 전용으로 유지하며 장애를 복구한다. 단순 adapter 토글로 새 데이터를 버리지 않는다.

롤백 훈련은 DB commit 전/후 연결 실패, 응답 유실, 만료된 worker, 검수 철회, 객체 업로드와 메타데이터 확정 사이 실패, 전환 중 재접속을 포함한다. 로그의 시각만으로 commit 여부를 추정하지 않고 확정 상태·멱등키·버전으로 조회한다. 파일 어댑터의 기존 short lock/rename 재시도와 DB 트랜잭션의 보장 범위는 별도로 설명한다.

## 별도로 남는 운영 관문

- G0는 정확한 변경 SHA의 원격 실행 결과가 있어야 완료다. W0 통합·실제 확대·기존 면접 격리는 합본 QA이며 개별 작업창 통과 수의 합이 아니다.
- 질문 승인 35/평가 규격 승인 0/검수 대기 35는 D의 관측값이다. 전환 전후 실제 coverage를 다시 확인하며 DB 이관으로 승인 수를 늘리지 않는다. 실제 평가 승인 공급은 운영 검수 절차를 필요로 한다.
- 실마이크·상용 STT/TTS·실제 iOS/Android, PR04 의미 품질, API/DB 운영 연결, G4 identity/OCR, 발행·삭제 전파·비용/쿼터 부하는 각각의 검증 관문으로 남긴다.
- 서비스 자격증명은 서버 secret 참조로만 관리한다. 테스트용 격리 DB에서 검증했다고 운영 Auth/RLS 설정이나 배포가 완료됐다고 표시하지 않는다.

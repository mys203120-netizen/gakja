# 청사진 v2 기준 구현 기록

## 2026-11-07 PR07-D 읽기 이관·shadow 단계

C의 정확한 `3204e83`에서 별도 기능 브랜치를 시작했다. [D 계약·실행 경로](pr07d-read-shadow.md)는 inventory/귀속(D1), C lifecycle 기반 격리 적재·typed reader의 실제 caller 연결(D2), 독립 C baseline/후보 비교(D3)를 구분한다. 기존 local이 세션·답변·평가의 유일 writer다. 시작/최종 SHA·새 설치·고유 실행 로그·CI와 보호 자료의 전후 증거는 Git 제외 `artifacts/pr07d/final-report.json`을 따른다. 명령 예시나 이전 C 통과 수를 D 성공 증거로 사용하지 않는다.

| D 관문 | 판정 범위 |
|---|---|
| 구현 | source/analysis/context/bank/audio, book/그림·QA·검수/조상·registry 의존 reader; typed locator·version/legacy/source pin·C receipt 및 generation; 별도0003·CLI·회귀 |
| 합성 통합 | 독립 exact-C checkout/프로세스와 실제 PostgreSQL/고정 공식 Storage API의 정상 두 계정·거부/장애. 최종 SHA CI로 판정 |
| private 비교 | 불변 복사본의 inventory·독립 local codec/도메인 비교와 원본1665·credential1·공개17·기존평가31 보존을 실행 증거로 판정. 실제 Storage 경로는 별도 |
| private 실제 Storage | Windows Docker 엔진이 없어 미검증. private 자료를 원격 CI/hosted bucket으로 보내지 않음 |
| 운영 읽기 이관 | 미완료: 운영 귀속/Auth/provider/bucket·관리 책임과 운영 검증 미공급 |
| E 인계 | 별도 세션 writer 변경: 실제 귀속·단일 writer 선택·CAS/멱등·응답 유실·경합·역보존/롤백 기준 필요. F/G writer·제한 전환은 포함하지 않음 |

기존 정본·ID·UTF-16·hash·active pointer와 B/C migration/checkpoint, A retained entry/기본 차단을 보존한다. 질문승인35/평가규격승인0/대기35 및 `sessionEvaluationReady=false`를 유지한다. W0 실계정/브라우저 QA·G1 장치/상용 미디어·PR04 의미 품질·G4 identity/OCR와 C의 hosted CDN/signing-key/실제2시간 만료는 별도 미완료다.

## 2026-11-06 PR07-C 비공개 객체 단계

PR07-B는 `858401c`에서 격리 DB·회귀·해당 SHA CI를 완료했다. C는 `pr07c-private-storage.md`의 C1(reader)과 C2(접수/실제 검증/확정/취소)를 구분한다. B metadata 행은 업로드 완료가 아니며 새 원장·typed object 관계와 서버 할당 refs를 통해 검증한 객체만 reader로 전달한다. 실제 코드 SHA·새 설치·시험 수·CI·보호 원본 비교는 Git 제외 `artifacts/pr07c/final-report.json`의 실행 증거로 판정한다.

| C 관문 | 판정 범위 |
|---|---|
| C1 reader | A/B 현재 권한→verified object binding→실제 Storage bytes/size/raw SHA→권한·상태/ref 재검사 |
| C2 객체 등록 | 멱등 접수·staging upload·별도 final bytes 검증·CAS 확정·취소/deadline·cleanup 재시도 |
| 격리 재현 | 명시 mock/실제 PostgreSQL/공식 Supabase Storage API·최종 SHA CI를 각각 기록 |
| 운영 연계 | 실제 provider/Auth/mapping·bucket/credential·등록/삭제 책임 미공급, 미완료 |
| hosted CDN·학생 이관·writer | 실제 시험/전환 범위 밖. D shadow와 E/F writer의 별도 관문 유지 |

기존 정본·ID/hash·활성 pointer·local/runtime-v1·A/B 승인·held-F와 service 기본 거부/변경503을 보존한다. W0 실제 브라우저 QA·G1 장치/상용 미디어·PR04 의미 품질, 평가 승인0/대기35는 계속 별도 미완료다.

## 2026-11-06 PR07-B 격리 DB 단계

PR07-A는 `dfeb203`에서 구현·재현·해당 SHA CI를 완료했다(전체1482/portable1283). 실제 Auth/운영 mapping과 다사용자 운영은 미연결 상태다. B는 `pr07b-db-rls.md`의 관계·제한 역할/RLS·DB resolver와 합성 격리 시험을 구현한다. 실제 버전·역할·시험 수·commit/CI 판정은 Git 제외 `artifacts/pr07b/` 실행 보고를 따른다.

| B 관문 | 범위 |
|---|---|
| 관계·권한 계약 | issuer/subject→account/owner·학생·개인 지원처·source pin·자원/불변 version/pointer/object/legacy의 복합 FK와 역할 경계 |
| 격리 DB 검증 | 실제 제한 PostgreSQL 역할·정상/교차/RLS·pool·철회·A HTTP/WSS/worker 통합. 최종 실행 기록으로 판정 |
| 운영 연계 조건 | 실제 제공자 신뢰·등록/철회 책임·운영 mapping 미공급, 미완료 |
| 운영 적용·writer/출시 | 이번 범위 밖. DB/Auth 설정·학생 적재·Storage·면접/평가 writer·W0 실계정 API 미착수 |

A의 service 기본 거부·retained entry와 runtime-v1/local writer·정본/ID/hash를 보존한다. G0/W0 코드 통합 완료와 W0 실제 브라우저 QA 미검증, G1/PR04·평가 승인0/대기35의 별도 관문도 유지한다.


## 2026-11-06 PR07-A 요청 경계 업데이트

G0 원격 재현과 W0 코드 통합은 `c60f3ce`에서 완료됐으며, 실제 브라우저 확대·편집·키보드 QA는 미검증이다. 이전 PR06 완료 기록의 G0/W0 미완료 표시는 당시 기준의 이력이다. 현재 PR07-A 구현은 `pr07a-request-identity.md`를 따른다.

| 구분 | 현재 범위 |
|---|---|
| 요청 인증·소유권 구현 | 실제 service HTTP/WSS·worker 진입 연결. 운영 mapping이 없는 요청은 개인 자료 접근 전 거부 |
| 합성 검증 | 실제 서명 토큰·두 계정·교차 접근·부수 효과·ticket/만료/권한 변경 검사. 최종 명령/결과/SHA는 Git 제외 `artifacts/pr07a/` 실행 기록으로 판정 |
| 기존 local composition | 명시적 로컬 런처/테스트 composition과 기존 writer·정본·모델/시간 정책 유지 |
| 실제 Auth 연결 | 미완료: 운영 제공자와 계정/자원 mapping 미공급. 테스트용 resolver는 운영에 자동 활성화되지 않음 |
| 운영 전환 | DB/RLS·Storage·writer 전환·실계정 API 미착수. PR07-B 이후 별도 |
| 기존 미완료 | 실제 평가 승인0/대기35, G1 실장치/상용 미디어, PR04 의미 품질, W0 실제 브라우저 QA는 별도 관문 |


> 최신 PR05 구현·재현 검증은 [PR05 검증 기록](pr05-verification.md), codec/제안 envelope 대응과 PR06 범위는 [계약 대응표](pr05-domain-contracts.md)를 따른다. 아래 직전 실행 수치와 새 검증 수치를 구분한다. 평가 승인 0개, PR04 의미 품질 미완료는 유지한다.

2026-11-06 사용자의 변경 지시에 따라 **아키텍처 청사진 v2를 최상위 기준**으로 사용한다. 이후 전달된 4대 구현정책은 철회됐으며 현재 개발 기준으로 사용하지 않는다. 평가범위 공급계약은 사용자가 별도로 확인한 청사진 §14·PR03의 보완 명세다.

## 유효한 기준

- [아키텍처 청사진 v2](architecture-blueprint-v2.html): 기존 TypeScript 엔진·정본·목적 ID를 보존하는 G0~G8 이행 계획.
- [평가범위·검수자료 공급계약](evaluation-supply-contract-v0.1.md): 사전 문항 규격과 실제 종료 세션 승인을 분리하는 EV-01~15.
- [학생부 분석·생성·검수 규격](student-analysis-generation-spec-v0.1.md): 청사진에서 참조하는 기존 codec의 보존·확장 기준.
- [부속 계약 원본과 검증](../packages/contracts/README.md): 원본 5개 스키마, 52개 형태 사례와 4개 UTF-16 사례. 운영 API를 대체하는 계약으로 승격하지 않는다.

첨부 문서의 명령 예시나 상태 선언은 실제 수행·승인 증거가 아니다. 원본 부속 파일과 수신 당시 검증 보고서는 변경하지 않고, 새 실행 보고서를 별도로 쓴다.

## 변경 지시 반영

철회된 정책을 바탕으로 만들던 별도 `IndependentCommonAnalysis`/`StagedTargetExtension` 저장소와 CLI는 활성 소스에서 제거했다. 개발 중 초안은 작업 외부의 `architecture-review-20261106/superseded-an-prototype`에 파일 해시와 함께 보관했다. 기존 `FullStudentAnalysis`, `TargetStudentAnalysis`, `StudentObjectiveCandidate`와 활성 분석 포인터는 그대로 유지한다. 새 목적 ID를 일괄 재발급하지 않는다.

공통/지원처 identity 분리와 OCR 일반화는 청사진 G4에서 기존 정본의 version adapter로 구현한다. 이미 검증된 11축은 기존 산출물의 정확한 원문·분석·dictionary 연결을 확인하는 파생 조회로 재사용하며, 이를 지원처 독립 분석의 신규 승인으로 취급하지 않는다.

`server/data/whole-record-axes.ts`의 조회 helper는 현재 자료의 11축을 모델 호출 없이 읽고 기존 목적 34개를 유지하는 것을 확인했다. 일반 runtime context와 가이드북 UI에 자동 연결한 상태는 아니다.

일시정지 중 서버 준비가 완료되면 client ready wait를 끝내는 수정은 청사진 §15에 해당하므로 유지한다. 4대 정책에서 가져온 active clock 과금 단계 변경은 되돌렸다. 준비 대기·재생·정지의 분리와 기존 시간 정책을 구별한다. 94/95/96초 경계와 같은 질문 재시도는 자동검사 범위이며 실제 기기 시험은 별도다.

평가에서는 특정 ROLE/경험 template에 대한 자동 통과와 사전 승인 registry에서 실제 세션 승인 binding을 자동 복제하는 경로를 제거한다. 기존 gate를 유지하고, 사전 규격 → 실제 종료 입력 검수 → 승인 bundle → 별도 평가 context → worker 순으로 연결한다. 사전 문항 승인과 종료 세션의 평가 승인은 서로 다른 상태다.

## 이번 개발 범위

| 청사진 단계 | 구현 범위 | 남은 완료 관문 |
| --- | --- | --- |
| G0 / PR01 | 소스 추적, 새 lockfile 설치/portable/타입/린트/빌드, Node/Python CI 설정 | 변경 commit·실제 원격 CI·출시 환경 검증 |
| G1 / PR02 | 정지 중 준비 완료·95초 초과·같은 턴 retry·새로고침/재접속/종료를 실제 Chrome+합성 미디어로 검증 | 실마이크·상용 STT/TTS·실제 서버/장치 통합 E2E |
| G1 / PR03 | 정확한 사전 평가 규격, 별도 종료 검수 입력, 기존 gate 공급, 명시적 검수 대기 | 실제 문항·실제 종료 답변의 내용 검수, 서비스 인증·권한 저장소 연결 |
| PR04 | 이번 변경 없음, 별도 미완료 | 실제 의미 품질 개선·독립 검수·지연 근거 |
| G2 / PR05 | 현행 6종 codec/adapter 실제 연결, 대응표, TS/Python parity, 현재/과거 자료 ID·인용·hash roundtrip | 이번 PR05 범위 충족. 다사용자 인증·운영 event/DB 전환은 후속 단계 |
| G2 / PR06-A | SourceRepository/AnalysisRepository의 실제 current/staged/source/review 조회 연결, local adapter, 독립 전후 비교 | A 범위 완료. B 은행/음성·C 세션·D 평가/검수는 아래 별도 기록 |
| PR06-B | QuestionBankRepository/AudioRepository의 current/pinned 조회·기존 준비 writer·실제 CLOVA cache 연결 | B 범위 완료. 새 프로세스 두 음성 disk hit, reopen provider fetch 0회로 기록 정정. 원격·운영 저장 관문 미완료 |
| PR06-C | 기존 SessionStore 5개 메서드·factory, 세션/context 실제 caller, 로그 물리 I/O port, checkpoint 저장 경계 | C 범위 완료. 전체 1,385/portable 1,186 및 독립 전후·private·소스 기준선은 [C 기록](pr06c-session-storage.md) |
| PR06-D | 기존 EvaluationJobStore 계약·물리 I/O, ReviewRepository, revision/history 실제 worker/realtime/supply/CLI 연결 | D 범위 완료. 전체 1,401/portable 1,202·독립 비교 123항목 통과, private 1,508개 불변. 관문·롤백·후속 재현/통합은 [D 기록](pr06d-evaluation-review-repositories.md). DB writer/운영 승인 공급은 별도 |
| W0 | 확정 셸·4메뉴·5진입·개발 전용 합성 흐름 구현 완료 | 별도 worktree, backend 통합 전. 기존 관련 84/production HTTP 224/개발 HTTP 21은 W0 보고값이며 D 검사와 합산하지 않음. 실제 200% 확대·실제 API/기기·원격 CI 별도 |
| G4 사전 연결 | 기존 분석의 근거를 보존하는 11축 파생 조회 | common/target identity 분리·Python OCR·DB job·운영 writer 전환 |

계정/DB/RLS/Storage, 분산 job lease/fencing/Outbox, 권리 원장, ID 이력 이관, 전체 IA 및 발행은 청사진의 후속 단계다. 이 작업을 G0~G8 전체 구현 완료로 표시하지 않는다. PR06-A의 당시 기준선·검사는 [A 기록](pr06a-read-repositories.md), PR06-B의 1,372개 전체/1,173개 portable 검사와 독립 전후 비교·저장 한계는 [B 기록](pr06b-bank-audio-repositories.md)에 있다. 세션·로그는 [C 기록](pr06c-session-storage.md), 최신 평가·검수 local 경계 및 재현/통합 순서는 [D 기록](pr06d-evaluation-review-repositories.md)에 있다. PR05 완료는 6종 codec 범위이고 A~D local 분리는 운영 저장 전환과 다르다. W0는 구현 완료한 별도 worktree이며 backend에 병합·검사 수 합산을 하지 않았다.

## 평가 자료 상태

현재 로컬 은행에서 실제 후보 35개를 확인했다. 질문 승인은 평가 규격 승인과 다르며 **실제 평가 범위 승인 0개**다. 생성한 검수 목록은 pending이며 사람 검수를 대신하지 않는다. 실제 세션의 답변·주장·적용 조건 검수도 별도로 필요하다.

검수 자료가 없으면 점수와 정오 판정을 보류한다. 질문 승인을 평가 승인으로 복제하거나, 평가불능 F를 생략하고 나머지 점수를 재가중하지 않는다. 모델 재시도 대신 `review_required` 상태로 기다리며 화면에도 검수 대기를 표시한다. 승인된 정확한 종료 입력을 공급한 후 별도 평가 작업을 등록한다.

로컬 서명 검증 어댑터는 서비스 인증의 대체물이 아니다. 서명 발급자·권한·철회 저장소는 운영 서비스가 관리해야 한다. worker나 CLI가 임의로 검수자를 만들거나 스스로 승인하지 않는다. 기존 완료 평가 결과는 원래 pipeline·입력·결과 해시를 검증해 읽고, 미완료 구버전 작업은 명시적으로 재시도한다.

운영자용 로컬 CLI는 다음 순서로 사용한다. 실제 은행과 소유 회차를 읽으므로 임의의 session/context JSON을 작성할 필요가 없다. 검수자와 서명 영수증은 인증된 검수 서비스가 실제 검수 후 제공해야 한다. 이 CLI에는 서명·자기승인 기능이 없다.

```powershell
# 사전 문항 검수 목록과 현재 상태
npm run prepare:evaluation-scopes -- stage
npm run prepare:evaluation-scopes -- coverage
npm run prepare:evaluation-scopes -- validate --reviewed-input spec.json --reviewer actor
npm run prepare:evaluation-scopes -- publish --reviewed-input spec.json --reviewer actor --receipt signed-A.json --expected-current none

# 실제 종료 입력의 검수 대기 자료 → 별도 승인 bundle 공급
npm run prepare:evaluation-scopes -- prepare-ended --session-id UUID --output proposal.json
npm run prepare:evaluation-scopes -- supply-ended --session-id UUID --proposal-input proposal.json --reviewed-input session-bundle.json --receipt signed-B.json
npm run prepare:evaluation-scopes -- coverage --session-id UUID
```

신뢰 공개키는 `EVALUATION_SCOPE_REVIEW_PUBLIC_KEY`에서 읽는다. `validate` 통과는 내용 승인이나 발행 권한이 아니다. 실제 출력은 `data/prepared/evaluation-scope-registry`의 비공개 버전 파일로 저장된다. 실행 worker는 최신 사전 규격·서명된 실제 세션 검수를 모델 호출 전과 결과 확정 전에 확인한다. 보류된 F는 숫자 점수 없이 남고 기존 묶음 제외 정책에 포함된다.

별도 승인 입력에서 만든 평가 job과 조회 revision은 원본 세션·전사·기존 결과를 덮어쓰지 않는다. 일반 회차 조회는 검증된 최신 평가 revision을 읽으며, 동일 서명 입력 재시도는 같은 job을 재사용한다. 사전 승인 수만으로 질문 재고·다양성까지 준비됐다고 표시하지 않는다.

## 재현 검증

기준 커밋 `a666f7a`를 Git archive로 별도 추출했다. 설치된 `node_modules`를 재사용했으므로 새 의존성 설치 환경이나 원격 CI 실행으로 표현하지 않는다.

- 기준본 타입검사 통과.
- 비공개 준비 파일 없는 기준본 전체 테스트: 1,137개 중 1,091 통과, 46 실패.
- 비공개 PDF·로그·manifest가 필요한 21개 테스트 파일을 명시적으로 분리한 기준본 portable 테스트: 1,005/1,005 통과.
- `tests/private-fixture-suites.json`은 파일 단위 제외 목록이다. 그 파일의 합성 테스트도 portable에서 제외되므로 출시 검증은 `npm test` 전체 실행이 필요하다.
- 부속 계약은 원본 52개 형태 + 원문 구간 4개 + 추가 parity 4개를 Python jsonschema 4.26.0과 JS Ajv 6.15.0에서 대조했다. JS는 미지원 키워드를 거부하는 공통 부분집합 변환이며 일반 Draft 2020-12 구현이 아니다.
- 실제 모델 의미 품질·기기·상용 인증·이용권 결제 E2E는 오프라인 테스트 통과와 구분한다. 이번 작업에서 유료 API나 실제 학생 분석 생성·승인은 실행하지 않았다.

```powershell
npm run typecheck
npm run lint
npm test
npm run test:portable
npm run build
node scripts/verify-source-closure.mjs --working-tree
py -3.11 -m pip install --target artifacts/contracts-validation-deps -r packages/contracts/requirements-validation.txt
npm run verify:contracts
```

소스 추적 검사의 기본값은 Git 추적 파일만 확인한다. 아직 커밋하지 않은 개발 트리에는 `--working-tree`를 사용한다. CI는 기본값으로 검사한다. 상세 로그와 새 계약 보고서는 Git 제외 경로 `artifacts/implementation-*.log`, `artifacts/proposed-contracts-validation.json`에 저장한다.

### 직전 단계 실행 결과 (PR05 이전)

| 확인 | 결과 |
| --- | --- |
| 전체 `npm test` | 1,308 / 1,308 통과 |
| `npm run test:portable` | 1,111 / 1,111 통과 |
| TypeScript / ESLint / production build | 모두 통과 |
| 소스 추적 검사 / `git diff --check` | 통과 |
| TS/Python 부속 계약 | 52개 형태 + 4개 원문 구간 + 4개 추가 parity 통과 |
| 실제 은행 `stage` / `coverage` | 질문 승인 35, 평가 규격 승인 0, 검수 대기 35, provider 호출 0 |

회귀에는 합성 서명 A/B → 실제 worker 코드 → 별도 결과 조회·재시도, 평가 전/중 철회, 보류 F의 묶음 제외, 원본 세션 bytes 보존, 실제 a666f7a 코드로 산출한 v4 고정 해시가 포함된다. 실제 사람의 35개 내용 검수, 실제 모델/장치 시험, 원격 CI·배포는 완료한 것으로 표시하지 않는다.

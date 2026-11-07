# PR07-D 읽기 이관·독립 shadow 검증

2026-11-07 KST. 시작점은 PR07-C `3204e83ea5bde64c57fe0da57cc7abc8ecca44fb`다. [청사진 v2](architecture-blueprint-v2.html)를 최상위 기준으로 사용한다. [평가 공급계약](evaluation-supply-contract-v0.1.md)은 §14·PR03 보완이며 [현행 codec 계약](pr05-domain-contracts.md)을 대체하지 않는다. 아래 명령은 재현 방법이다. 실제 변경 SHA·실행 결과·CI·자료 개수는 Git 제외 `artifacts/pr07d/final-report.json`과 연결된 개별 보고서로 판정한다.

## 관문과 선택 범위

| 관문 | 구현·검증 범위 | 별도 조건 |
|---|---|---|
| D1 | 원본 raw inventory, 명시적 귀속, 선택/의존/제외/누락/미지원/격리, immutable plan fingerprint | 보호 대상 전체와 실제 선택 집합의 개수는 다를 수 있음 |
| D2 | C 접수→업로드→최종 bytes 검증→cleanup→정확한 receipt revision에 D typed binding, 실제 도메인 reader 주입 | 운영 writer·기존 active pointer 변경 없음 |
| D3 합성 | 정확한 C 코드의 독립 프로세스 local 실행과 D PostgreSQL/공식 Storage 실행 비교 | 제어된 body provider는 진단용이며 실제 Storage 통과와 구분 |
| D private | 소유한 불변 복사본의 실제 원본 inventory·local C/D codec/도메인 비교·보존 증거 | Windows Docker 엔진이 없으면 private 실제 Storage 경로는 미검증 |
| 운영 읽기 이관 | 미완료 | 운영 Auth subject→계정/학생/개인 지원처 귀속, provider/bucket·관리 책임 및 운영 검증 미공급 |

합성 학생·문서·분석·은행·음성·검수 fixture로 두 계정 경로를 검증한다. 정상 도메인 검증에 필요한 공개 학교 catalog의 선택 행과 Git의 공개 정책 문서는 별도 공개 참조 입력이다. 실제 학생 파일·학생 ID·credential은 원격 CI에 보내지 않는다. 전체 세션·평가 snapshot을 새 DB reader로 이관하지 않는다. 그 경로의 v4/서명·철회·종료 입력·held-F는 기존 root 회귀와 기존 결과 보존으로 확인한다.

`binding: local-verification-only`는 고정 복사본과 격리 계정의 검증 mapping이다. 원래 payload의 owner·student·supportTarget·서명을 다시 쓰지 않는다. `provenanceOwnerId`는 원래 도메인 검증용이고 A/B 권한은 현재 인증 context와 DB owner/student/application target/supportTarget으로 검사한다. 이름·PDF hash·같은 지원처 이름으로 운영 귀속을 추론하지 않는다.

## locator·version·object 및 실제 caller

| 입력/현행 caller | 출처·hash에 보존할 값 | 실제 접근과 검증 |
|---|---|---|
| source PDF/원문/context의 `load-interview-context` | 원래 configured reference, extraction/source pin, raw bytes | `SourceRepository`→shadow selector→D binding→C bounded read→현행 source QA; PDF 재추출 비교 |
| `FullStudentAnalysis`/`TargetStudentAnalysis`, current/staged/historical | v1/v2 payload, 목적 ID, source/common/target revision, 원래 domain hash·UTF-16 좌표 | `AnalysisRepository`, current 전용 shadow pointer 및 명시적 historical/revision alias, 현행 codec/원문 gate |
| `read-domain-envelopes`·question-domain adapters | 기존 정본·목적/승인 계약과 직렬화 hash | 주입한 source/analysis repositories를 실제 export 경로까지 전달 |
| book corpus/source/QA/그림·strategy | dictionary/corpus/image/source hash와 원래 경로 binding | 좁은 `ArtifactReadRepository`; 그림 PNG/JPEG 구조·raw hash 및 기존 book/strategy gate |
| prepared activities·source review/proposal/receipt/journal·review-parent | 원래 revision, ancestry, signed payload, multirow JSONL bytes | 실제 adjudication/review authority caller까지 artifact reader 전달, 조상 참조 별도 selector |
| evaluation-scope registry·revision | 질문 승인과 평가 규격 승인, 원래 digest | read-only registry reader 주입, 기존 gate 그대로 적용 |
| prepared question bank current/pinned | candidate/목적/승인 계약/bank key, ready/partial 상태, 기존 domain hash | 좁은 `QuestionBankReader`; shadow에서 누락 injection은 오류, local fallback 없음 |
| 승인 음성 | 원본 MP3/WAV bytes·MIME·객체 pin | C `audioMetadata`/`audio`, read-only 음성 계약, 기존 proxy의 private/no-store·Range 416 유지 |

local `StoredFile.path`는 유지한다. 후보는 `LocatedStoredFile`의 typed locator와 `provenancePath`를 반환하며 존재하지 않는 파일 path나 Storage URL로 가장하지 않는다. 출처 경로는 hash/display 용도이고 파일·URL 접근 명령으로 실행하지 않는다. 후보는 mirror 디렉터리를 만들지 않는다. 실제 후보 읽기 계수에서 DB/Storage 접근과 local 파일 접근 0을 각각 확인한다.

D의 `0003_read_shadow.sql`은 shadow run/artifact/dependency/pointer와 generation, receipt binding 및 검증된 media metadata를 추가한다. B bootstrap/0001/seed와 C0002는 수정하지 않는다. 기존 analysis 전용 관계에 다른 종류를 밀어 넣지 않고 각 artifact의 role/kind/scope와 legacy/version/source pin을 저장한다. 누락·null·문자열은 존재 여부와 값을 분리하며 문자열 `'<null>'`도 null과 다르다. source pin을 포함한 동일 legacy pin의 다른 bytes는 충돌이다. 없는 domain hash를 raw hash로 채우지 않는다. JSONB는 plan metadata projection이며 원본 bytes·원래 서명/해시의 대체물이 아니다.

## 이관 CLI와 trusted composition

```powershell
# inventory는 원본 읽기만 한다. --out은 새 파일이며 기존 보고서를 덮어쓰지 않는다.
npm run shadow -- inventory --request artifacts/pr07d/request.json --roots artifacts/pr07d/roots.json --out artifacts/pr07d/inventory.json
npm run shadow -- import --inventory artifacts/pr07d/inventory.json --runtime artifacts/pr07d/runtime.ts --out artifacts/pr07d/import.json
npm run shadow -- verify --inventory artifacts/pr07d/inventory.json --runtime artifacts/pr07d/runtime.ts --out artifacts/pr07d/verify.json
npm run shadow -- shadow --inventory artifacts/pr07d/inventory.json --runtime artifacts/pr07d/runtime.ts --out artifacts/pr07d/compare.json
# resume/status/cleanup도 같은 inventory와 명시적 runtime을 사용한다.
```

`ShadowInventoryRequest`는 `server/shadow/shadow-plan.ts`, SQL로 전달하는 `ShadowRunPlan`/artifact/selector는 `server/shadow/shadow-ports.ts`가 권위 있는 타입이다. 최소 inventory 입력 모양은 다음과 같다. 실제 scope와 참조·pin·의존 closure는 운영자가 제공해야 하며 아래 ID는 예시다.

```json
{
  "version": "shadow-inventory-request-v1",
  "runId": "example_run_001",
  "binding": "synthetic",
  "ownerId": "owner-a",
  "studentId": "student-a",
  "applicationTargetId": "app-a",
  "supportTargetId": "support-a",
  "artifacts": [{
    "artifactId": "source-md",
    "role": "source-markdown",
    "locatorId": "source-md-001",
    "reference": "original/source.md",
    "selection": "configured",
    "scope": "common",
    "required": true,
    "dependencies": [],
    "availability": "present",
    "classification": "selected",
    "objectKind": "source-markdown",
    "source": {"rootId": "copy", "relativePath": "source.md"}
  }]
}
```

별도 roots JSON은 `{"copy":"C:/owned-disposable-copy"}`처럼 신뢰한 고정 루트만 지정한다. 상대 경로의 traversal·URL·절대 경로·루트 밖 symlink를 거부한다. source pin·version·legacy·originalPin은 원래 존재 상태를 보존한다. 선택 graph는 최대512 artifact/객체16MiB이며 required 의존 누락/순환, 형식·expected raw SHA 실패는 eligible=false다. 빈 JSONL 파일은 존재하는 미지원 자료로 기록하며 absent로 바꾸지 않는다. 명시적 known-absent는 파일을 읽지 않는다. `notSelected`에는 제외 이유를 남기고 새 run은 `previousAttempt`에 이전 run·재시도 사유를 연결할 수 있다.

runtime은 trusted 서버/운영자 composition module이며 inventory나 문서에서 executable module을 고르지 않는다. `openReadShadowRuntime({inventory})`가 C identity/object service, `createPostgresShadowRepository`, 특정 run/plan/owner/student/지원처/유한 artifact/만료/current-check에 묶인 `createShadowImportCapability`, `createShadowImporter` 및 close를 제공한다. `verifyDomain` callback은 필수이며 기존 TS context/analysis/bank/QA gate를 실제 실행해야 한다. 없으면 verify가 거부된다. `shadow`는 독립 baseline/candidate executor를 제공한다. 단순 admission·raw hash 일치를 내용 승인으로 표시하지 않는다. 운영 환경 변수를 자동 채택하거나 임의 기존 DB/bucket을 사용하는 기본 runtime은 제공하지 않는다.

각 단계는 새 보고서에 상태·plan fingerprint·개별 결과를 기록한다. stdout은 digest/개수만 남기고 개인 provenance·원문·서명/토큰은 출력하지 않는다. 실제 재현 fixture/조립은 `tests/shadow/read-shadow.integration.test.ts`와 `scripts/run-pr07d-*.mjs`에 있다.

## bytes·비교·실패 경계

raw bytes/크기/SHA, 도메인 codec/hash/원문 QA, A/B scope 및 mapping/version/object 관계를 따로 확인한다. BOM·CRLF·Unicode·key/배열 순서·optional/null을 정규화하지 않는다. 선언된 provenance 필드(`revisionPath`/`manifestPath`/`provenancePath`)의 OS 경로 구분자 차이는 원래 값과 digest를 남기고 비교한다. 별도 context 비교에서는 매 load마다 생성되는 `questionStrategies.generatedAt` 한 필드만 원래 양측 시각·전체 반환값 SHA를 기록한 후 제외한다. 기존 catalog hash는 원래 이 필드를 제외하므로 `contentSha256` 일치를 별도 검사한다. inventory 보고 표의 정렬은 관측 파일 집합의 metadata 표시 순서에만 적용하고 원래 read trace를 보존한다. raw/domain hash·목적/승인/인용 값을 고쳐 맞추지 않는다.

비교기는 정상 동등성을 양쪽의 실제 payload 성공으로 판정한다. 두 null·두 오류·모두 거부를 정상 읽기로 세지 않는다. 현행 local catch→null의 원인이 불명확하면 indeterminate다. A/B 신규 권한 거부는 의도된 더 강한 거부로 분리한다. 후보 SQL/provider/권한/변조 실패는 정상 absent로 숨기지 않는다. local writer로의 조용한 fallback은 없다. QA·PNG·JSONL·review-parent·source-review의5종 byte 변조는 별도 C 복사본에서도 관찰한다. C의 snapshot 복구/검수 규칙이 일부 변조를 무시하거나 null로 축약하는 경우와 D의 raw 무결성 거부를 동등 성공으로 합치지 않는다. 이5종은 파일 삭제 시험과 구분한다.

MP3는 최소2개 연속 LayerIII frame의 header·길이·rate/channel 일관성을 검사하고 ID3-only/절단/위장/trailing junk를 거부한다. bounded ID3v2·일부 VBR과 기존 MP3를 원본 그대로 지원하며 entropy decode/음질 판정/CRC 검증을 주장하지 않는다. WAV는 RIFF/fmt/data 정합성, PNG는 chunk CRC·bounded zlib/scanline(Adam7 미지원), JPEG는 segment/scan/EOI 구조를 검사한다. 이미지 의미/음성 내용 승인은 별도다. MP3 `audio/mpeg`, WAV `audio/wav`와 이미지 MIME는 원장의 권위 있는 metadata에 연결하고 재검사·object identity에 포함한다. transcode·재생성·TTS 호출은 없다.

run generation·artifact pin·pointer 및 C receipt revision을 캡처하고 I/O 전후 현재 권한과 관계를 재확인한다. DB connection은 Storage I/O 전에 반환한다. 관측된 변경/삭제·ABA는 payload 반환 전에 거부한다. local 파일 사전/사후 hash는 중간 변경 후 원복의 부재를 증명하지 않는다. 마지막 권한 검사 후 철회까지 원자적으로 막거나 이미 전송한 bytes를 회수한다고 주장하지 않는다.

멱등키는 run+plan SHA+artifact ID에 고정된다. 부분 import/응답 유실은 같은 receipt를 조회·재검증해 재개하며 terminal receipt를 부활시키지 않는다. cleanup은 자신의 run에 연결한 C receipt만 cancel/delete하고 실패/잔여를 기록한다. 응답 유실로 불확실한 receipt는 같은 finite admission으로 추적하며 cancelled/quarantined run에서는 cleanup 추적만 허용한다. receipt 미확인은 미업로드로 가정하지 않는다. cleaned도 늦게 나타난 provider 잔여의 재정리를 허용하며 다른 run/control 객체나 원본은 지우지 않는다.

## 검증 범위와 실행 환경

- `npm test`: root `tests/*.test.ts`만 실행한다. nested DB/Storage/shadow suite를 포함하지 않는다.
- `test:portable`: 기존 private 의존21파일/199사례 제외 목록을 유지한다. 제외 목록을 늘리지 않는다.
- `test:storage-unit`, `test:shadow-unit`: nested unit 검사를 별도 실행한다.
- B `test:db-isolation`, C `test:storage`, D `test:shadow`: 각각 독립 실제 서비스 검사다. 기존 verify/B/C CI job을 유지하고 D read-shadow job을 추가한다.
- D runner는 소유 marker의 빈 disposable PostgreSQL17.11과 고정 공식 Storage API v1.89.12 image를 생성한다. C baseline은 정확한 C SHA checkout과 별도 npm ci를 사용한다. 제어된 body provider 모드는 CI에서 금지한다.
- 최종 SHA의 새 npm ci·pinned Python 설치·필수8검사·root full/private roundtrip/coverage·보존 증거와 정확한 remote CI를 각각 기록한다. 이전 C 성공/진단 성공을 D 공식 Storage 통과로 대신하지 않는다.

실제 운영 Auth/provider mapping, private 실제 Storage, hosted CDN/signing-key 회전·철회, 실제2시간 signed-upload 만료, W0 실계정/브라우저 QA, G1 실기기·상용 STT/TTS와 PR04 의미 품질은 수행 범위와 미검증 사유를 별도로 유지한다. 평가 상태는 질문승인35/평가규격승인0/대기35, `sessionEvaluationReady=false`를 유지한다.

## 롤백과 PR07-E 인계

D 주입 선택을 해제하는 것과 격리 자원 cleanup을 분리한다. primary local writer와 A retained entry·인증 차단·B 권한·C 검증 절차는 유지한다. 원본 active pointer/정본/기존 결과에 복원 쓰기를 할 필요가 없어야 한다. 운영 오류를 옛 unguarded realtime 또는 자동 local fallback으로 우회하지 않는다. 격리 신규 데이터는 참조·확정 상태를 보존한 후 소유 run만 cleanup한다. migration DOWN이나 전체 bucket 삭제를 롤백으로 사용하지 않는다.

E는 별도 변경이다. 실제 귀속과 owner/student/session별 writer 선택 권위, context/answer/end-input의 동일 transaction/CAS·멱등/응답 유실 재조회, 두 서버 경합·stale writer 차단과 DB 장애 시험을 먼저 확정한다. D의 검증된 selector·pin·generation 및 부족한 private/운영 관문을 인계한다. DB 신규 확정 전에는 writer 선택 복귀를 검증하고, 신규 확정 후에는 쓰기 동결·ID/버전/승인/hash/멱등 상태의 역보존이 완료된 뒤에만 복귀한다. E가 평가/검수 writer(F), 제한 전환(G), G4 identity/OCR를 함께 구현하지 않는다.

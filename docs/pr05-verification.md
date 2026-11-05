# PR05 구현·검증 기록 — 2026-11-06 KST

현행 도메인 codec·공유 계약·version adapter 연결과 현재 환경에서 가능한 검증을 완료했다. G0 원격 CI, G1 실제 검수 자료·실마이크/STT/TTS는 미완료다. PR04 의미 품질 개선은 별도 미완료로 추적한다. 문서의 명령 예시·상태 선언을 실행·승인 증거로 대신하지 않았다.

## 커밋과 재현 기준선

- HEAD: `a666f7a81dd2e80851f8589d135a0aac67c1eae2` (`chore: track server data source modules`). 새 commit·stage·push 없음.
- 앞선 PR01~03 구현은 이미 작업 트리에 있었다. 이를 초기화하지 않고 필요한 PR05 변경만 추가했다. 원본 소스 bytes·Git 상태를 snapshot에 기록했다.
- 검증 소스: `C:/Users/MaYunsong/Documents/gakja-pr05-source-20261106-verified`, Git-visible 1,723개 파일. HEAD clean checkout이라고 부르지 않는다.
- source tree SHA-256: `b2536eb7b65aae80241eaa33320d5ca0966beeec36118c84212e5737c9c4c2cd`.
- lockfile SHA-256: `c52e65258cdbf40ab562c68f97214e006492a3248588d7962453c669bd0be451`.
- 새 설치 디렉터리: `C:/Users/MaYunsong/Documents/gakja-pr05-fresh-20261106-final`.
- `npm ci`로 405 packages 설치. 기존 node_modules 복사·junction 재사용 없음. npm 다운로드 cache는 사용했다. 마지막 parity 수정 뒤 소스만 다시 고정해 반영했으며 lockfile 동일, node_modules가 일반 폴더임, 전체 manifest bytes를 확인했다.
- Windows / Node `24.16.0` / npm `11.13.0` / Python `3.11`. 원격 Ubuntu/Node22 환경과 구별한다.
- `data/`, `.env`·비밀키, 기존 node_modules, Git metadata, artifacts는 소스 snapshot에 복사하지 않았다. Python 의존성도 pinned requirements로 새로 설치했다.
- 이 보고서와 최종 문서 갱신은 실행 후 기록이다. 실행 코드의 기준은 위 snapshot과 `source-snapshot-manifest.json`이다.

증거: `artifacts/pr05/verified-source-capture.log`, `final-source-overlay.json`, `final-npm-ci.log`, `final-python-install.log`.

## 기존 완료 항목 대조와 관문

| 항목 | 구현됨 | 자동검증됨 | 실환경에서 확인한 범위 | 외부 의존 / 남은 관문 |
| --- | --- | --- | --- | --- |
| G0/PR01 | source closure·portable·CI 설정 | 새 설치, 타입·린트·빌드·1,142 portable | 현재 Windows/Node24 | 변경 commit, 정확한 원격 CI, Ubuntu/Node22 |
| G1/PR02 | 기존 pause-ready·같은 턴 retry 유지 | 회귀 + 실제 wall-clock Chrome | Chrome156 실제 UI/hooks/native media·WebSocket | 실마이크/스피커·한국어 STT/TTS·실서버 통합 |
| G1/PR03 | A/B 분리·worker 공급·검수 대기 유지 | 서명·철회·held-F·원본 보존 회귀 | 실제 은행 coverage 조회 | 실제 내용 검수, 종료 답변 승인, 운영 인증/검수 서비스 |
| PR04 | 이번 변경 없음 | 기존 테스트를 새 의미 품질 승인으로 해석하지 않음 | 신규 실제 모델/사람 의미 검수 없음 | 별도 미완료, 실제 실패 사례·검수·지연 근거 필요 |
| G2/PR05 | 현행 6종·adapter·공유 경계 연결 | 공통 fixture·v1/v2·원문·ID/hash roundtrip | 실제 현재 자료와 과거 분석 21개 읽기 전용 검증 | 이번 PR05 범위 충족. Python source QA나 운영 인증 구현으로 확대하지 않음 |
| 11축 파생 조회 | 이전 helper 유지 | 관련 회귀 통과 | 실제 자료 조회 기록 있음 | 일반 UI/runtime 자동 연결·common identity·OCR는 G4 |

평가 규격 승인은 **0개**로 유지했다. 실제 coverage는 questionApproved=35, specApproved=0, pendingScope=35, sessionEvaluationReady=false, providerCalls=0이다. 질문 승인·ROLE/경험 라벨·사전 규격을 실제 세션 평가 승인으로 복제하지 않았다. F/묶음 제외와 기존 시간·과금·모델·질문 의미 정책도 보존했다.

## 변경 파일과 이유

| 파일군 | 변경 이유 |
| --- | --- |
| `server/contracts/analysis-domain-codecs.ts`, `analysis-domain-adapters.ts` | 기존 wire를 그대로 공유, Full/Target v1·v2 shape·기존 hash/source QA 검증. 기존 이관 metadata 보존. |
| `server/contracts/question-domain-codecs.ts`, `question-domain-adapters.ts` | 목적·candidate·승인 계약 검증과 기존 은행·owner 경계를 거친 읽기. |
| `server/contracts/domain-envelope.ts`, `read-domain-envelopes.ts` | 정확한 payloadJson bytes 전달, 버전/target/source pin 일관성, 실제 로컬 읽기 경로 연결. |
| `server/data/full-student-analysis.ts`, `load-interview-context.ts`, `prepared-question-bank.ts` | 기존 save/load/staged/context/candidate 경로에 adapter 추가. 원래 gate도 계속 실행. |
| `server/question-objective.ts` | 기존 body/blueprint hash 검사를 helper로 추출. 계산식·계산 대상 보존. |
| `packages/contracts/domain-v1/*`, `scripts/{export-domain-schemas,verify-domain-contracts}.ts`, `validate-domain-contracts.py` | 현행 codec에서 별도 Draft-07 생성, staleness·TS/Ajv/Python parity. 수신 원본 5개 보존. |
| `tests/{analysis-domain-contracts,question-domain-codecs,domain-envelope}.test.ts`와 익명 fixtures | 구버전·누락/null/빈 값·원문/hash·Unicode/UTF-16·target-only revision 회귀. |
| `scripts/verify-{analysis,question}-domain-roundtrip.ts` | 비공개 원본을 덮어쓰지 않는 재현 검증. Git 제외 보고서에는 원문/학생 ID를 출력하지 않음. |
| `scripts/capture-source-snapshot.mjs`, `verify-source-closure.mjs` | 작업 트리 고정, 의존성/비밀값 제외, manifest bytes와 import closure 검사. |
| `tests/browser/g1-native-browser.mjs`, `README.md` | 격리 Chrome·합성 서버로 실제 client 95초/재생/복구 재현. |
| `package.json`, `.github/workflows/verify.yml`, 관련 문서 | 재현 명령·공유 검증 CI와 증거/미완료 상태 추가. |

기존 정본·목적 ID·원문·anchor·승인 계약·hash key 순서를 유지했다. API를 generic schema로 바꾸거나 DB writer를 도입하지 않았다. 상세 대응표·허용 직렬화·null/미확인 규칙은 [PR05 계약 대응표](pr05-domain-contracts.md)에 있다.

## 실제 실행 결과

아래 로그는 `artifacts/pr05/` 아래에 있다.

| 실행 | 결과 | 증거 |
| --- | --- | --- |
| 새 `npm ci` / pinned Python install | exit 0, node_modules 복사 없음 | `final-npm-ci.log`, `final-python-install.log`, `final-source-overlay.json` |
| 새 설치 source closure `--manifest` | 1,624 local imports, 전체 source bytes 일치 | `fresh-closure.log` |
| 새 설치 typecheck / lint / build | 모두 exit 0, production build 통과 | `fresh-typecheck.log`, `fresh-lint.log`, `fresh-build.log` |
| 새 설치 `test:portable` | **1,142/1,142 통과** | `fresh-portable.log` |
| 현재 로컬 `npm test` | **1,339/1,339 통과** | `test-final.log` |
| 현행 TS/Ajv/Python 계약 | **38 shape + 32 transport + 8 UTF-16**, 익명 domain roundtrip 18개 일치 | `domain-contracts-validation.json`, `fresh-contracts.log` |
| 수신 5개 제안 검증 | 52 shape + 4 UTF-16 + 4 추가 parity 통과 | `proposed-contracts.log`, `fresh-contracts.log` |
| 실제 분석/원본 wire | Full·Target·wire·wire envelope 동일, 보호 원본 6개 불변 | `analysis-domain-private-roundtrip.json`, `analysis-domain-private-execution.json` |
| 과거 분석 21개 | v1 2개/v2 19개, shape/hash/adapter 실패 0, 변경 0 | 같은 analysis 보고서 |
| 실제 은행/공유 transport | 108 envelopes 동일, 기존 평가 결과 31개 불변 | `question-domain-private-roundtrip.json`, `question-private-final.log` |
| 실제 Chrome | 94,551 / 95,678 / 96,795ms 경계와 retry/reload/reconnect/end 통과 | 아래 browser 증거 |
| diff / 현재 source closure | working-tree 검사 통과; tracked-only 차이는 아래 참조 | `diff-check.log`, `source-closure-final.log` |

현재 분석은 활동 161, 성적 행 57, 목적 34, 근거 478개다. runtime 목적 36개는 기존 분석 목적에 기존 공통 목적을 포함한 값이다. common/target 각 1 + 목적 36 + 후보 35 + 승인 질문 계약 35 = 108개 envelope이며 새 목적을 발급하지 않았다.

새 코드에서 발견한 target-only revision의 scope 혼동, Python `$`의 끝 개행 허용 차이, wire/context.source 핀 대조 누락만 수정하고 거부/회귀 사례를 추가했다. source pins 4개 변조와 끝 개행을 TS/Python 모두 거부한다. shape는 맞지만 원문·기존 hash 위반으로 TS domain이 거부하는 **6개 사례**는 보고서에서 따로 공개한다. Python shape 통과를 TS 전체 source QA·승인 완료로 표시하지 않는다.

## 테스트 범위와 제외

전체 `npm test`는 `tests/*.test.ts`를 실행하며 실제 로컬 자료 suite도 포함한다. browser diagnostic과 Python parity는 별도 명령이다. 새 설치 환경에는 비공개 자료를 복사하지 않아 private 전체 suite 대신 portable을 실행했다.

portable은 같은 glob에서 `tests/private-fixture-suites.json`에 적힌 아래 **21개 파일 전체**를 제외한다. 해당 파일의 합성 테스트도 제외되며 전체와 테스트 197개 차이가 난다.

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

## 실제 브라우저와 미실행 시험

Chrome `156.0.8078.80`의 새 프로필에서 제품 InterviewShell·session/audio hooks, native fullscreen, AudioContext/Worklet, HTMLAudio, localStorage와 실제 WebSocket을 실행했다. 준비 완료 뒤 일시정지 상태에서 실제 95초를 넘겼고 audio fetch 실패 후 같은 질문을 재시도했다. `/next`와 `/end`는 각각 1회. 실제 beforeunload 확인을 처리한 새로고침과 같은 session 복구·WebSocket 재접속도 통과했다.

증거: `artifacts/browser-g1/2026-11-05T19-28-40-512Z/evidence.json`과 스크린샷 12개. 재현: `node tests/browser/g1-native-browser.mjs`. `--quick`은 95초 증거가 아니다.

backend·학생 자료·전사·가짜 마이크·WAV tone은 합성이고 camera는 건너뛰었다. 유료 provider 호출 0, 브라우저 예외 0. 외부 MediaPipe telemetry 시도는 차단했다. Next router/실제 realtime server/운영 인증 통합 E2E나 물리 마이크·상용 STT/TTS 시험으로 표현하지 않는다.

실기기 시험에는 마이크/스피커 권한과 한국어 음성 입력, 승인된 STT/TTS credential·호출 예산, 실제 서버, 소음/중단/복구 시나리오가 필요하다. 이 환경과 실제 입력이 공급되지 않아 미실행으로 남겼으며 PR05를 중단하지 않았다.

## 원격 CI와 완료 판단

`.github/workflows/verify.yml`은 npm ci, pinned Python 설치, 두 계약 검사, source closure, 타입·린트·portable·빌드를 설정한다. **설정과 실제 원격 통과는 별개다.** HEAD의 PR-triggered 첫 페이지 조회 결과는 빈 목록이었다. 모든 Actions 실행이 없다는 뜻으로 확대하지 않는다. 미커밋 작업 트리의 원격 실행은 하지 않았다. 증거: `remote-ci-observation.json`.

working-tree와 snapshot source closure는 통과했다. 기본 tracked-only 검사에는 새 미추적 모듈 의존 13개가 보고된다. 필요한 파일이 아직 commit에 들어가지 않았기 때문이며 clean checkout 성공으로 숨기지 않는다(`tracked-source-closure.log`). 사용자 변경과 새 모듈을 함께 검토해 commit한 후 정확한 원격 CI를 실행해야 G0 원격 관문이 닫힌다.

| 관문 | 판정 |
| --- | --- |
| G0 현재 변경의 로컬 재현 기준선 | 충족: 새 설치/lockfile·manifest·필수 검사 |
| G0 원격 clean-checkout CI | 미충족: 변경 미커밋, 정확한 원격 실행 없음 |
| G1 pause-ready/95초/동일 턴 retry client | 실제 브라우저 + 합성 미디어 범위 충족 |
| G1 전체 운영 | 미충족: 실기기/STT/TTS·실제 평가 검수 공급/운영 인증 |
| G2 이번 PR05 | 충족: 대응표, 실제 adapter 경로, 현재/구버전 roundtrip, 공통 정상·거부 parity와 차이 공개, 회귀/필수 검사 |

PR06은 [계약 대응표의 추출 순서·회귀·롤백 기준](pr05-domain-contracts.md)에 따라 기존 local adapter를 보존하는 별도 변경으로 준비한다. 기존 SessionStore를 재사용하고 파일 I/O를 분리하며 DB writer 전환은 포함하지 않는다.

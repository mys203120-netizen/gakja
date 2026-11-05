# W0 전체 테스트 기준본 대조

2026-11-06 KST. 고정한 기준본과 W0를 같은 새 설치 의존성·Node·환경·자료 가용성에서 실행했다. **W0 신규 실패 0건, 새 W0 테스트 26/26 통과**다. 전체 suite는 양쪽 모두 기존 실패 46건이 남아 있어 전체 통과로 보고하지 않는다.

## 실행과 source 기준

- 기준 커밋: `a666f7a81dd2e80851f8589d135a0aac67c1eae2`. W0 브랜치: `codex/w0-frontend`.
- 현재 source code fingerprint: `7c7ceed08962b72642c3c292f21352c723a6c6e0342318acf23f1b1eca8b9bb3`. [정확한 source manifest](w0-source-manifest.json). a666f7a만으로 새 W0 코드를 재현할 수 있다고 쓰지 않는다.
- Node `v24.16.0` / npm `11.13.0`. `NODE_ENV=test`, `TZ=Asia/Seoul`, `NEXT_TELEMETRY_DISABLED=1`; 상속 환경도 동일 객체·fingerprint로 고정.
- 현재 snapshot에서 lockfile 기준 `npm ci`로 405개 package를 새 설치했다. npm 기본 다운로드 cache는 재사용했다. 기준본은 그 새 설치 node_modules를 가리키는 junction으로 정확히 같은 의존성 트리를 사용했다. 이전 개발 junction 사용을 새 설치로 표현하지 않았다.
- lockfile SHA-256: `33b86860cf620bade3c6f113a7c0c0cb05c10e3748af5bf537365d3e8b16c7cc`. package/lockfile·설치 tree lock·tsx/TypeScript/Next 버전이 양쪽 일치.
- 기존 공통 test 파일 140개의 bytes가 정확히 같다. 현재는 143개 파일이며 추가된 파일은 w0-model/w0-routing/w0-memo 세 개다. 최신 백엔드 미커밋 소스는 포함하지 않았다.
- 실행은 같은 Node의 `--import tsx --test --test-concurrency=4`와 정렬한 `tests/*.test.ts` 목록, 동일 외부 structured reporter로 기준본→현재 순서였다. 시험 삭제·stub·기대값/정책 완화는 없다.

| 실행 | tests | pass | fail | skip | exit | 시간 |
|---|---:|---:|---:|---:|---:|---:|
| 기준본 | 1137 | 1091 | 46 | 0 | 1 | 77.18s |
| 현재 W0 | 1163 | 1117 | 46 | 0 | 1 | 88.38s |

## 이름·위치·원인 대조와 판정

| 판정 단계 | 공통 기존 실패 | W0 신규 실패 | 기존 실패 해소 | 원인 변경/비교 불가 |
|---|---:|---:|---:|---:|
| 기계적 exact 원인 서명 | 39 | 0 | 0 | 7 |
| 아래 증거로 7건 원인 검토 후 | 46 | 0 | 0 | 0 |

7건의 observed cause 차이는 삭제하거나 같은 문자열로 바꾸지 않았다. [정확한 JSON](w0-test-comparison.json)에 기준본/현재 cause fingerprint·오류·location·판정 근거를 각각 남겼다.

- 6건: `compileInterviewerPolicy`의 `Promise.all`이 첫 번째로 보고한 실패 role이 다르다. 양쪽 12개 정본 MD의 bytes가 모두 같고 두 환경 모두 고정 hash와 불일치한다. LF→CRLF checkout이 원인이며 backend 정책을 수정하지 않았다. 정확한 관찰 role A→B를 표에 보존했다.
- 1건: school-context의 expected `[]`와 actual 오류 배열(길이3)의 hash가 달랐다. 변경 없는 source가 구성하는 `studentPdf 없음 / preparedStudent 없음 / 정책 hash role 오류` 배열을 안전하게 재구성해 **실제 full-run 두 hash 모두에 정확히 일치**함을 확인했다. 기준본 role student·현재 glossary이며 추가 진단에서도 첫 role 선택이 달라졌다. 원문·학생 자료·assertion 본문은 노출하지 않았다.
- configured material 22개 역할의 존재 여부·존재하는 파일의 내용 hash가 모두 같고 5개는 양쪽에 없다. ENOENT는 실제 누락 경로의 stable identity와 실패 당시 exists=false를 기록했다. 비공개 자료를 가져와 검사를 통과시키지 않았다.

| 원인 묶음 | 건수 |
|---|---:|
| 누락 ignored replay/검수 은행 | 10 |
| 준비 자료/context 후속 assertion | 2 |
| 누락 generated prepared/cache | 7 |
| 공통 정본 raw-byte hash | 13 |
| 누락 비공개 원본 PDF | 13 |
| 하위 실패의 부모 집계 | 1 |

## 46개 실패별 위치와 원인

`TS 위치`는 현재 고정 source의 실제 test 선언 또는 source-mapped 실패 프레임이다. Node가 `--import tsx` 아래에서 내보낸 선언 위치는 line1의 변환 후 위치이므로 JSON의 `nodeEmitted`로 별도 보존했다. parent/child/ancestor를 포함해 46건을 각각 대조했고, 부모 집계 실패를 누락하지 않았다.

| # | 정확한 테스트 이름 | TS 위치 | 원인·대조 |
|---:|---|---|---|
| 1 | actual-user replay freezes precisely the immutable 3 real sessions and 25 original question-answer pairs | `tests/actual-user-core-replay.test.ts:12:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 2 | same-prefix checkpoint deletes its old current decision, excludes future turns, and never invents ending observations | `tests/actual-user-core-replay.test.ts:30:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 3 | verified diagnostic rebind proves identical student PDF and exact surviving quotations while disclosing changed context | `tests/actual-user-core-replay.test.ts:44:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 4 | manual semantic labels separate met comparison and optional concept deepening from unfinished negation and refusal | `tests/actual-user-core-replay.test.ts:64:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 5 | real local HTTP status is usable without credentials and rejects foreign origins | `tests/backend-http.test.ts:19:1` | 필수 자료 미준비로 preparationReady undefined (기대 false) · exact 서명 일치 |
| 6 | the preserved historical real bank retains its seven approved objectives and failing quality gate | `tests/bank-quality-audit.test.ts:83:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 7 | five fixed-seed real-slot simulations use presentation-aware least-used history without current-session duplicates | `tests/bank-quality-audit.test.ts:96:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 8 | active audit resolves the active bank and typed canonical instead of replaying the historical Q30 proposal | `tests/bank-quality-audit.test.ts:105:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 9 | registry partitions every original character in all twelve documents with exact source spans | `tests/compiled-runtime-policy.test.ts:16:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 10 | all mapped realtime article instructions stay active while other stages have explicit exclusion reasons | `tests/compiled-runtime-policy.test.ts:24:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 11 | conditional excerpts preserve exact normative source and all mandatory rules, even with mixed dialogue signals | `tests/compiled-runtime-policy.test.ts:34:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role glossary → student; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 12 | updating MD hashes without a reviewed policy mapping cannot silently publish new normative clauses | `tests/compiled-runtime-policy.test.ts:41:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role brand → glossary; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 13 | normative appendix sections link to governing articles without repeating prompt instructions | `tests/compiled-runtime-policy.test.ts:53:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role brand → glossary; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 14 | single-core canonical rendering accounts for every realtime article exactly once and preserves all overrides | `tests/compiled-runtime-policy.test.ts:63:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role brand → operating; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 15 | single-core reusable prefix stays identical when conditional MD excerpts change | `tests/compiled-runtime-policy.test.ts:77:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role student → school; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 16 | explicit staged-context read-only option preserves the existing source manifest and analysis pointer | `tests/deep-bank-rebind.test.ts:176:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 17 | historical live cases retain the exact frozen question and source identity | `tests/dialogue-action-gold.test.ts:57:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 18 | HTTP end freezes the first accepted source across repeated/concurrent requests and delayed browser events | `tests/evaluation-end-idempotency.test.ts:9:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 19 | runtime instructions contain all twelve exact originals in stable numeric order, not compact substitutes | `tests/full-md-policy.test.ts:18:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 20 | missing, reordered, changed or manifest-mismatched policy originals fail closed without filesystem substitution | `tests/full-md-policy.test.ts:38:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 21 | capture accepts only the exact twelve configured MD roles approved by policy and manifest inputs | `tests/full-md-policy.test.ts:55:1` | 공통 LF→CRLF raw-byte hash 불일치 · 첫 실패 role brand → glossary; Promise.all의 첫 reject가 다르며 12개 공통 hash 불일치 원인은 같음 |
| 22 | policy compilation binds explicit clauses to exact reviewed MD hashes and execution checks without provider calls | `tests/interviewer-policy.test.ts:8:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 23 | changed canonical MD bytes fail policy compilation instead of silently changing the running rules | `tests/interviewer-policy.test.ts:23:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 24 | restoration checkpoint contains the verified bank Q0 and no old answers, metrics or decisions | `tests/live-e2e-replay.test.ts:42:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 25 | compiled policy maps current core requirements and explicit user overrides to all twelve current source documents | `tests/natural-interview-core.test.ts:191:1` | 공통 LF→CRLF raw-byte hash 불일치 · exact 서명 일치 |
| 26 | playback outbox batches restore the F budget durably before progression without another semantic call | `tests/playback-event-delivery.test.ts:12:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 27 | registered PDF excerpts reproduce whitespace false negatives and all match verified source slices | `tests/question-grounding.test.ts:135:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 28 | the reviewed real CNT relation binds both preserved bank files and all three observed histories | `tests/question-purpose-lineage.test.ts:110:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 29 | real realtime HTTP/WS recovers provider faults without external APIs | `tests/realtime-recovery.test.ts:140:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 30 | real HTTP/WS keeps staged capture separate from sole-core decision and answer commitment | `tests/realtime-staged-capture.test.ts:11:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 31 | metadata-only bank migration uses the reviewed target and preserves old source approval without copying the old semantic contract | `tests/reviewed-bank-upgrade.test.ts:14:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 32 | a proposed surface rewrite drops old premise approval and requires its exact reviewed new utterance hash | `tests/reviewed-bank-upgrade.test.ts:32:1` | 양쪽에 없는 ignored 실사용 replay/검수 질문은행 자료 · exact 서명 일치 |
| 33 | the manifest reads the root files, preserves verified duration, and never uses the old snapshot | `tests/school-context.test.ts:79:1` | 누락 자료 2종과 정책 hash 오류로 context.errors 3건 · 오류 배열 fingerprint는 다름; full-run hash를 재구성해 studentPdf/preparedStudent 누락 + policy role student → glossary로 정확히 확인 |
| 34 | demand-boundary human labels retain exact historical words and distinguish synthetic contrasts | `tests/single-core-demand-boundary.test.ts:21:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 35 | continuous F proposal names an actual approved bank surface without forcing model actions | `tests/single-core-demand-boundary.test.ts:112:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 36 | matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets / file | `tests/source-integrity.test.ts:1:3838` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 37 | matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets / offset | `tests/source-integrity.test.ts:1:3838` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 38 | matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets / page-count | `tests/source-integrity.test.ts:1:3838` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 39 | matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets / text | `tests/source-integrity.test.ts:1:3838` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 40 | current sources use one shared path contract and the manifest verifies actual PDF excerpts and every file hash | `tests/source-integrity.test.ts:24:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 41 | missing files, wrong guide version and a changed PDF fail closed rather than using an old source location | `tests/source-integrity.test.ts:36:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 42 | matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets | `tests/source-integrity.test.ts:48:1` | source-integrity 하위 4건 실패에 따른 부모 집계 · exact 서명 일치 |
| 43 | same-version question and evaluation guides cannot be swapped by their cross-reference headers | `tests/source-integrity.test.ts:63:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 44 | an offset past the actual page end is rejected even when slice would return the exact page text | `tests/source-integrity.test.ts:70:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |
| 45 | full-document PDF audit distinguishes complete source coverage from a valid partial excerpt | `tests/source-integrity.test.ts:86:1` | 양쪽에 없는 생성 prepared/cache 자료 · exact 서명 일치 |
| 46 | ordered voice submission owns one deadline through STT, candidate, next and cancellation | `tests/submission-deadline-http.test.ts:9:1` | 양쪽 clean snapshot에 없는 비공개 원본 PDF · exact 서명 일치 |

## 추가 W0 검사와 사용법

새 W0 26개는 모델/리듀서/캐시16, 라우팅6, 메모4로 전부 통과했다. 기준본에 없던 테스트를 기준본의 기존 통과 수에 섞지 않았다. 이전 관련80/80은 이전 보고값이며, 이 문서의 현재 수치는 frozen full run에서 직접 얻었다.

동일 source가 준비되어 있을 때 비교 명령은 다음과 같다. 경로는 [JSON 실행 metadata](w0-test-comparison.json)의 실제 snapshot을 따른다.

```powershell
node scripts/w0-compare-tests.mjs --baseline "C:\Users\MaYunsong\Documents\각자의답NEW-w0-verify\20261106-closeout\baseline" --current "C:\Users\MaYunsong\Documents\각자의답NEW-w0-verify\20261106-closeout\current" --out "C:\Users\MaYunsong\Documents\각자의답NEW-w0\artifacts\w0-closeout\test-comparison"
```

비교기는 strict cause 변화가 있으면 exit1을 유지한다. 이번에도 비교기 exit1은 7건의 엄격한 차이를 보존한 결과다. 사람의 원인 검토 판정은 이 문서/JSON의 별도 층이며 기계적 로그를 덮어쓰지 않는다. 최초 reporter의 Windows path scheme 오류는 시험 시작 전 계측 실패였고, file URL 수정 뒤 실제 두 full run을 완료했다.

이 결과는 **로컬 W0 검증의 조건부 마감** 근거다. 기존 백엔드/source-integrity 실패는 소유 경계와 재현 조건을 남겨 후속 처리한다. 원격 CI·실제 iOS/Android·물리 미디어·상용 STT/TTS 통과, 실제 API 연결 또는 공개 가능 판정은 아니다. production HTTP·개발 smoke·접근성의 별도 관찰은 [W0 QA](w0-qa.md)를 따른다.

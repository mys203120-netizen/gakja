# W0 검증 기록

작성일: 2026-11-06 (Asia/Seoul). 브랜치: `codex/w0-frontend`. 기준 커밋: `a666f7a81dd2e80851f8589d135a0aac67c1eae2`.

현재 마감 결과는 [검증 마감·통합 준비 기록](w0-closeout.md)과 [전체 실패 대조](w0-test-comparison.md)를 따른다. 새 `npm ci` 환경의 타입·린트·production 빌드, 관련 회귀 **84/84**, production HTTP **224/224**, 개발 HTTP **21/21**이 통과했다. 전체 검사는 기준본 1137개 중 1091 통과·46 실패, 현재 W0 1163개 중 1117 통과·46 실패다. W0 전용 26개는 모두 통과했고 신규 실패는 없다. 실제 API·공개는 연결 전이며, 200% 실제 확대·원격 CI·실제 기기·미디어 시험은 미검증으로 남긴다.

## 검증 마감 실행 기준

- [소스 매니페스트](w0-source-manifest.json)의 기준 HEAD와 W0 추가 파일을 함께 고정했다. 기준 커밋만으로 현재 W0를 재현할 수 없다.
- 실행 코드 fingerprint: `7c7ceed08962b72642c3c292f21352c723a6c6e0342318acf23f1b1eca8b9bb3`. lockfile: `33b86860cf620bade3c6f113a7c0c0cb05c10e3748af5bf537365d3e8b16c7cc`.
- Node 24.16.0 / npm 11.13.0. 격리 `current`에 실제 새 의존성 디렉터리를 `npm ci --no-audit --no-fund`로 설치했다. 기본 다운로드 cache는 활성화됐으며, node_modules 복사나 junction으로 새 설치를 대신하지 않았다. 기준본·개발 서버만 이 새 설치를 공유했다.
- 기준본과 현재본의 기존 파일·자료 가용성·의존성·실행 환경을 동일하게 맞췄다. 실패 39건은 원인까지 정확히 같고, 진단이 달라진 7건도 증거로 같은 기존 원인임을 확인했다. 관찰 차이는 대조 보고서에 그대로 남겼다.
- 마지막 검증은 사용자 지시에 따라 코덱스 인앱 브라우저만 사용했다. 메모의 숨은 dirty 경고와 과거 이동 확인 동작을 수정하고, 계속 편집/폐기·Back/Forward·지원처 분리·새로고침 초기화·키보드/중첩 dialog 초점·실제 production 화면을 확인했다.

아래의 80개·1158개 검사 및 4개 폭 관찰은 **초기 구현 단계의 이력**이다. 새 설치·전체 기준본 대조를 마친 현재 결과와 구분하며, 현재 결과는 위 수치와 마감 기록을 우선한다.

## 화면별 완료 상태

| 화면 | 일반 확인 경로 | 골격 | 인터랙션 검증 | 실제 API 연결 | 공개 가능 |
|---|---|---|---|---|---|
| H01 MY 홈·공통 셸 | `/w0` | 완료 | 4개 폭에서 메뉴·선택·프로필 관찰 | 미연결 | 아니오 |
| G01 생기부 진입 | `/w0/record` | 완료 | 목차·예시 메모·지원처 분리·보호 동작 관찰 | 미연결 | 아니오 |
| I00 면접 연습실 진입 | `/w0/interviews` | 완료 | 연습/실전 두 진입과 안내 연결 관찰 | 미연결 | 아니오 |
| A00 내 답변 진입 | `/w0/answers` | 완료 | 3개 진입·잠금·기록/검수 상태 관찰 | 미연결 | 아니오 |
| M00 암기 훈련실 진입 | `/w0/memory` | 완료 | 퀴즈/지식한입/이슈픽 안내 연결 관찰 | 미연결 | 아니오 |
| 하위 page 40개 안내 | `/w0/view/{ID}` | 안내 골격 완료 | 45개 page ID의 라우트 대응 자동 검사. 모든 안내 화면의 개별 브라우저 시험은 아님 | 미연결 | 아니오 |
| G04 합성 미리보기 | `/w0/preview/view/G04?scenario=ready` | 합성 UI 완료; 정본 G04 전체 기능과 별도 | 답변 편집/저장/취소·질문 저장/해제·뒤로/앞으로·초안 보호 관찰 | 실제 저장 미연결 | 아니오 |
| G09·A04 | 가이드북 dialog / 리포트 details | 호스트 UI 구현 | G09 열기/Escape/포커스 복귀 관찰; A04는 예시 컨테이너 | 실제 응답·리포트 미연결 | 아니오 |
| I04·U06 | [registry의 문맥 호스트](ia-registry.csv) | 호스트 안내 매핑만; 기능 미구현 | 해당 기능 완료로 집계하지 않음 | 미연결 | 아니오 |
| I09·U08 | 기존 면접 복구 / 프로필 action | I09 기존 엔진 보존; U08 이용 불가 안내 | 실제 복구·로그아웃 성공으로 표시하지 않음 | W0 인증 연결 미연결 | 아니오 |
| 기존 면접 | `/interview`, `/interview/scene`, `/` | 기존 구현 보존 | 직접 진입·idle 렌더·스타일 경계 관찰 | 기존 면접 연결과 W0 계정 연결 구분 | 이 W0로 공개 판정하지 않음 |

## 실행 환경과 산출물

| 항목 | 실제 값·결과 |
|---|---|
| worktree | `C:\Users\MaYunsong\Documents\각자의답NEW-w0` |
| 개발 실행 | worktree에서 `npm run dev:web -- --port 3100` 또는 `npx next dev --webpack --hostname 127.0.0.1 --port 3100` |
| 확인 주소 | `http://127.0.0.1:3100/w0`; 예시 `http://127.0.0.1:3100/w0/preview?scenario=ready` |
| 브라우저 | Codex IAB Chromium. 정확한 Chromium 버전은 확인하지 못함 |
| 의존성 | 기존 저장소 `node_modules` junction 재사용. package/lockfile 수정·새 라이브러리 설치 없음 |
| 정본·출처 | [IA 및 백엔드 연결 요청](w0-ia-mapping.md), [51개 원본 registry+W0 매핑](ia-registry.csv), [구현 안내](w0-frontend.md) |
| 스크린샷 | `artifacts/w0/home-desktop.jpg`, `home-mobile.jpg`, `g04-desktop.jpg` (ignored 로컬 산출물) |

일반 `/w0` 경로는 `scenario=ready`가 붙어도 미연결 모델만 사용한다. 예시 자료는 `/w0/preview`에서만 제공하며 화면에 `예시 데이터`로 표시한다. 상태 9개는 `ready`, `empty`, `loading`, `pending`, `error`, `forbidden`, `review_required`, `long-target`, `one-target`이다.

## 초기 구현 단계의 코드·자동 검사 이력

| 검사 | 실제 결과·의미 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과. 전체 실행 로그 `artifacts/w0/full-lint.log` |
| `npm run build` | 마지막 수정 후 최종 재실행 통과. Next 16.4.3 production 컴파일·TypeScript·라우트 생성 완료 |
| 초기 관련 회귀 | 80/80 통과: 당시 W0 22개(모델/리듀서/캐시 16 + 라우팅 6), 기존 오디오·시작·종료 보존·장치 관련 58개. 현재 검사는 84/84 |
| W0 라우팅 | 51개 활성 ID·45개 page 라우트 대응·패널/행동 독립 URL 차단·삭제 ID/알 수 없는 경로 거부·기존 면접 경계 검사 |
| W0 상태/초안 | 미연결·fixture 차단·null 점수·미확정 날짜·지원처별 투영·초안 캐시/취소/폐기·질문 저장 독립성 검사 |
| `npm test` | exit 1. 1158개 중 1112 pass / 46 fail / 0 skip. 67.3초. 전체 통과로 보고하지 않음 |
| 대표 기존 실패 재현 | `node --import tsx --test tests/interviewer-policy.test.ts tests/actual-user-core-replay.test.ts`: 기존 6개 모두 같은 원인으로 실패. W0 import 없음 |
| registry 원본 보존 | 사용자 CSV 네 열·행 순서 전체 일치. 51개 unique, A05/G08 미포함 |
| 평가 공급 계약 | 사용자 제공 문서 전체 읽기·기존 계약과 바이트/SHA-256 일치. 평가 상태 기준 변경 없음 |
| 변경 경계 | 보호된 기존 9개 경계 파일의 HEAD 대비 변경 없음. server/공유 codec/schema/정책/worker/DB 변경 없음. 원본 미커밋 백엔드 변경 보존 |
| fixture 차단 | 서버가 `NODE_ENV !== development`이면 동적 import 전에 preview 거부. 클라이언트의 fixture import 없음. production 정적 client chunk에서 합성 예시 문자열 미검출 |
| CSS | 새 토큰·reset·반응형·모션이 W0 CSS Module 셸 안에 한정. 전역 layout/CSS 변경 없음 |

마지막 재검토 수정 후 production 빌드 재실행을 완료했다. 최종 production HTTP 확인에서 `/w0`·`/w0/record`는 200, preview 및 A05/G08/G09/A04/U08 독립 경로는 404, 루트는 307 `/interview`였다. 일반 경로에 `scenario=ready`를 붙여도 예시 자료는 없었고, production client chunk의 합성 fixture 문자열 검색 결과도 0건이었다.

전체 테스트의 46개 실패는 다음과 같다. 실패명·위치·개인 경로를 제외한 원인은 `artifacts/w0/full-tests-summary.json`에 46건 모두 기록했다. 원본 log는 `full-tests.log`이며 개인 원본 파일 경로를 포함할 수 있어 공유용 결과에는 요약을 사용한다.

| 실패 분류 | 건수 | 확인한 근거 |
|---|---:|---|
| clean worktree에 없는 기존 자료 | 30 | 비공개 원본 PDF 13, ignored 검수 은행/실사용 replay 10, 생성 prepared/cache 7. 자료를 임의 복사하지 않음 |
| 기존 정책의 raw-byte hash | 13 | `core.autocrlf=true`. 정본 MD 12개가 HEAD LF→worktree CRLF. 12개 모두 HEAD bytes는 고정 hash와 일치하고 worktree를 LF로 정규화하면 HEAD와 정확히 일치 |
| 위 자료/정책 실패에 따른 context assertion | 2 | 기존 backend status·school context가 예상 정상 준비 상태와 다름 |
| 하위 실패의 부모 집계 | 1 | private PDF 누락으로 실패한 네 source-integrity 하위 검사의 부모 |

추적 대상 기존 테스트·server·scripts·면접 코드·package·정본 MD에 HEAD 대비 diff가 없다. W0 전용 테스트가 실패 목록에 포함되지 않았다. 이 증거는 기존 테스트 실패를 숨기거나 실제 비공개 자료가 있는 환경의 전체 통과를 대신하지 않는다.

## 초기 구현 단계의 브라우저 관찰 이력

| 범위 | 관찰 결과 |
|---|---|
| 320 / 390 / 768 / 1440px | 5개 진입 × 4개 폭, 총 20회 long-target 화면 방문. 가로 overflow 없음. 320/390/768은 하단 4탭, 1440은 헤더 4메뉴 확인 |
| 지원처 0/1/여러 개·긴 이름 | A00의 empty·one-target·ready/long-target 상태 및 선택 확인. 예시 선택은 계정 등록이나 실제 면접 지원처 변경으로 표시하지 않음 |
| 일반 경로 직접 진입 | 5개 일반 진입에 `?scenario=ready`를 붙여도 예시 자료 미노출·선택기 비활성. 암기 진입 새로고침 확인 |
| 상태 | A00에서 empty/loading/pending/error/forbidden/review_required/one-target 관찰. 검수 대기는 텍스트로 표시하고 0점 없음 |
| I00·I01·I05 | I00 카드 정확히 2개. I01 질문 출처 선택·AI 탭·채팅/화상 radio 동작 확인, 시작 버튼은 비활성이고 이유 표시. I05는 화상 전용·매체 radio 없음, 기존 `/interview` 새 탭 링크 확인 |
| A01·A03·A06 | A01 연습/실전 radio 탭 pointer 및 ArrowLeft 확인. A03 native report details 펼침 확인, 검수 대기 null 점수·0점/다운로드 없음. A06 미확정 날짜 잠금과 U01 안내 확인 |
| 프로필 dialog | 포커스 진입 확인. Shift+Tab 첫 항목→로그아웃, Tab 마지막→닫기 경계 순환 확인. Escape로 닫고 트리거 복귀 |
| G09 dialog | 가이드북 내부에서 열기·Escape·트리거 포커스 복귀 확인. 실제 응답은 이용 불가 상태 |
| G04 390px | 편집→취소로 직전 답변 복구, 로컬 저장 명시, 원문/질문 전환 후 초안 유지, 질문 저장 독립 동작 확인 |
| G04 이동 보호 | 메뉴 이동 확인에서 계속 편집하면 문구 유지. 브라우저 Back→Forward 후 정확한 dirty 문구 복구. 폐기 후 이동→Back하면 editing=false이고 폐기 문구 없음 |
| G04 지원처 분리 | A→B에서 editor/질문 자료 없음 안내, B→A에서 A 상태 복귀. 해당 관찰에서 overflow 없음 |
| G01 메모 | 지원처별 브라우저 메모 상태·이동 보호 구현. 실제 계정 저장과 구분 |
| reduced-motion | 실행 환경의 시스템 설정 true. 프로필 버튼 computed transition=0s 확인. 일반 모션/프레임 성능 효과는 미측정 |
| A06 | 날짜 미확정 시 잠금 유지·임의 D-Day 생성 금지는 코드로 확인. 개인 일정 기반 실제 해제는 미구현 |
| 200% 확대 | **미검증**. IAB 확대 단축키가 viewport/DPR를 바꾸지 않았고 native Chrome 창 복원도 완료하지 못함. 200% 통과로 집계하지 않음 |
| 가상 키보드·safe area | 사용자 확대 제한 metadata가 없고 입력 16px·dynamic viewport·safe-area inset은 코드 확인. 실제 소프트웨어 키보드/하드웨어 inset 동작 미검증 |
| G04 320 / 390 / 768 / 1440px | `scenario=long-target`에서 실제 innerWidth를 매번 확인하고 재시험. 모두 가로 overflow 없음. 모바일 주요 버튼 최소 44px, desktop 47px. 모바일 원문 숨김/2개 전환, desktop 가이드 링크 7개 표시 확인. 320px viewport+reload 화면을 시각 검사 |

브라우저 폭 변경은 실제 iOS/Android 기기 시험이 아니다. 대비·터치·키보드 관련 코드를 점검했으나 별도 스크린리더 전체 흐름이나 모든 OS 입력 환경을 시험한 것으로 집계하지 않는다.

## 기존 면접 보존

| 항목 | 확인한 범위 | 남은 범위 |
|---|---|---|
| 루트·직접 경로 | 브라우저 `/`가 `/interview`로 이동. `/interview` idle에 `.interview-shell` 1개, W0 셸 없음. `/interview/scene` 직접 idle 진입 확인 | 실제 진행 세션 경로·재접속까지 실행하지 않음 |
| 스타일 격리 | W0 지원처/프로필 조작 전후 기존 면접 root accent `#6654ff` 유지. 기존 루트 CSS/layout 변경 없음 | 다른 장치의 전체 면접 시각 QA는 별도 |
| 시작 배치 파일 | `start server.bat`와 `scripts/start-local.mjs` bytes·기존 `/interview` 진입 보존 확인 | 배치 파일 직접 실행하지 않음 |
| 세션·미디어 | 기존 면접 셸/훅/음성/장치 흐름을 수정하지 않음. 관련 자동 회귀 58개 통과 | 실제 STT/TTS·녹음·카메라·MediaPipe/아바타·live-session 초기화 시험 미실행 |
| 단축키·타이머·일시정지·재시도·종료·복구 | 해당 기존 엔진 변경 없음; 관련 코드·자동 회귀 범위 보존 | 실제 장시간 진행·중단/복구 재시험 미실행 |

보호 경계 9개: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `app/interview/page.tsx`, `app/interview/scene/page.tsx`, `components/interview/InterviewShell.tsx`, `hooks/useInterviewSession.ts`, `start server.bat`, `scripts/start-local.mjs`.

## 발견한 결함과 재확인

| 발견한 결함 | 수정 | 재확인 |
|---|---|---|
| 닫힌 details 안의 desktop 목차가 숨겨지는 경계 | desktop 상시 목차와 mobile disclosure 분리 | desktop의 여섯 장·도움말 링크와 4개 폭 탐색 확인 |
| 셸의 reset 우선순위가 하위 컴포넌트의 간격/표시 규칙과 충돌 | 셸 내부 reset에 `:where`로 낮은 specificity 적용 | 진입 카드·목차·G04 배치 재확인 |
| 선택 지원처가 다른 자료를 빌려 표시할 수 있는 투영 | strategy/question/session을 target 범위로 엄격 투영; 이용권/기간은 owner 범위 유지 | 모델 회귀와 A→B→A 브라우저 확인 |
| 라우트 이동으로 미저장 답변이 사라질 수 있음 | target+질문/답변 revision별 메모리 캐시·dirty 이탈 보호·명시적 폐기 처리 | G04 Back/Forward의 정확한 문구 복구·폐기 문구 미복구 확인 |
| 프로필 dialog의 경계 Tab이 브라우저 본문 밖으로 나감 | native dialog에 첫/마지막 Tab 경계 처리 추가 | Shift+Tab·Tab 양방향 순환과 Escape 복귀 확인 |
| 빠른 라우트 이동 뒤 scroll effect가 native radio/details 클릭에 간섭 | 경로 변경의 scroll/닫기를 `useLayoutEffect`에서 paint 전에 처리 | 바로 이동한 A01 radio 선택과 A03 details `open=true`를 실제 브라우저에서 재확인 |

## 미검증 및 공개 전 의존성

실제 iOS/Android 기기, 소프트웨어 키보드, 하드웨어 safe area, 200% 확대, 스크린리더 전체 흐름, reduced-motion이 꺼진 실제 모션과 프레임 성능, 실제 진행 중 면접 세션의 보존, 음성·미디어 실측은 미검증이다. 실제 계정·지원처·발행·권리·저장·평가·결제·운영 연결도 이 W0에서 완료하지 않았다.

개발 예시 답변/메모/질문 저장은 브라우저 메모리다. client Back/Forward에서는 상태를 유지하지만 전체 새로고침·탭 닫기는 지운다. dirty 상태에는 beforeunload 보호를 등록하며 브라우저가 실제 경고를 표시하는 조건은 브라우저 정책에 따른다. 서버 저장 성공으로 알리지 않는다.

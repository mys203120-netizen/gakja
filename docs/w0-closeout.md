# W0 검증 마감·통합 준비 기록

작성일: 2026-11-06 (Asia/Seoul). 대상: `각자의답NEW-w0`의 W0 프런트. 이 기록은 이전 [QA 기록](w0-qa.md)의 검사를 그대로 재사용하지 않고, 아래 고정 소스·새 설치 환경에서 실행한 마감 검증을 구분한다.

새 설치의 타입·린트·빌드·관련 회귀, production 격리와 수정 영향 IAB 확인을 완료했다. 전체 suite의 46개 실패는 기준본에도 존재하는 원인으로 대조했고 W0 신규 실패는 0건이다. **200% 실제 브라우저 확대는 미검증이므로 검증 마감은 조건부다.** 마지막 G04 편집·키보드·초점·production 및 기존 면접 idle 스모크도 아래 범위에서 확인했다.

| 완료 구분 | 현재 판정 |
|---|---|
| W0 구현 완료 | 공통 셸·확정 4메뉴·5개 진입·하위 기능 안내·개발 전용 합성 인터랙션 완료. 전체 IA 기능 완료가 아님 |
| W0 검증 마감 | 로컬 재현·검사항목 완료, 200% 실제 브라우저 확대가 남은 조건부 마감 |
| 실제 API 연결 | 연결 전. 실계정·권리원장·발행·정본·저장·평가·서비스 공개 미완료 |
| 원격 CI·기기 검증 | 원격 CI와 실제 iOS/Android·미디어 검증 미실행 |

## 실행 소스와 새 설치

기준 커밋만으로는 W0를 재현할 수 없다. W0는 기준 커밋 위의 추가 파일을 포함하므로 [소스 매니페스트](w0-source-manifest.json)의 경로·바이트 해시와 실행 코드 fingerprint를 함께 사용한다. 보고서·매니페스트 등은 순환 해시를 피하기 위해 실행 코드 fingerprint에서 제외하며, 제외 규칙은 매니페스트에 기록했다.

| 항목 | 고정한 값 |
|---|---|
| 작업 공간·브랜치 | `C:\Users\MaYunsong\Documents\각자의답NEW-w0` · `codex/w0-frontend` |
| 기준 HEAD | `a666f7a81dd2e80851f8589d135a0aac67c1eae2` |
| 실행 코드 SHA-256 | `7c7ceed08962b72642c3c292f21352c723a6c6e0342318acf23f1b1eca8b9bb3` |
| lockfile SHA-256 | `33b86860cf620bade3c6f113a7c0c0cb05c10e3748af5bf537365d3e8b16c7cc` |
| Node / npm | `24.16.0` / `11.13.0` |
| 주요 의존성 | Next `16.4.3`, React/React DOM `19.3.1`, TypeScript `6.0.3`, tsx `4.23.15` |
| 격리 검사 상위 경로 | `C:\Users\MaYunsong\Documents\각자의답NEW-w0-verify\20261106-closeout` |
| 기준본 | 위 경로의 `baseline` · 기준 커밋의 detached HEAD |
| 현재 W0 | 위 경로의 `current` · 동일 detached HEAD에 W0 추가 파일을 고정 |
| 개발 서버 소스 | 위 경로의 `development` · 현재 W0와 같은 애플리케이션 바이트 |
| 공통 파일 바이트 | 기존 worktree의 변경 없는 파일 바이트를 기준본과 W0에 동일하게 사용. CRLF를 포함한 checkout 바이트 차이를 새 W0 회귀로 섞지 않음 |
| 새 설치 | `current`에서 `npm ci --no-audit --no-fund` exit 0, 405개 패키지 설치. 설치 전 `node_modules`가 없었으며 설치 후 실제 디렉터리로 존재. junction이 아님 |
| npm cache | 기본 `C:\Users\MaYunsong\AppData\Local\npm-cache` 사용 가능 상태. cache 비사용·전체 오프라인 설치를 입증한 검사는 아님 |
| 기준본·개발 의존성 | `baseline`과 `development`는 정확히 위 새 설치 의존성을 junction으로 공유. 각각 별도 새 설치로 집계하지 않음 |

기존 개발 worktree가 원본 `node_modules` junction을 사용했던 검증과 이번 새 설치 검증을 구분한다. [환경 기록](../artifacts/w0-closeout/environment.json)에 설치 명령·실제 경로·cache 사용·주요 버전을 남겼다. 원본 저장소의 최신 미커밋 백엔드 소스나 비공개 ignored 자료를 기준본·현재본에 가져오지 않았다. 다른 작업창의 테스트 통과 수를 W0 결과로 사용하지 않는다.

애플리케이션 소스의 보존과 도구의 생성 파일을 구분한다. 검사 중 `.next/**`, `next-env.d.ts`, `*.tsbuildinfo`는 매니페스트의 허용 생성 범위이며 실행 코드 fingerprint 규칙에 따라 취급한다. 격리 검사 디렉터리의 Git 전체가 clean하다는 뜻은 아니다.

## 이번 마감에서 수정한 W0 결함

| Before | After | Why |
|---|---|---|
| 메모를 편집할 수 없는 상태에서도 숨겨진 초안이 dirty로 취급되어 이동 경고가 나타날 수 있음 | 메모의 표시·편집·dirty 판단에 같은 `canEdit` 조건 사용. 메모 reducer/cache와 4개 회귀 검사 추가 | 보이지 않는 입력 때문에 이동이 막히거나 폐기 상태가 혼동되는 문제 방지 |
| `review_required` 때문에 유효한 가이드북의 개인 메모까지 편집 불가로 처리될 수 있음 | 해당 지원처의 유효한 가이드 자료가 있으면 평가 검수 대기와 메모 편집 가능 여부를 구분 | 평가 승인 상태로 학생의 개인 메모 편집권을 임의 제한하지 않음 |
| 경로·시나리오·지원처가 바뀐 뒤 이전 이탈 확인 또는 pending action이 남을 수 있음 | 문맥이 바뀌면 W0App의 stale guard와 pending action 정리 | 이전 화면의 이동 의도를 새 문맥에서 뒤늦게 실행하지 않음 |

메모·답변·질문 저장은 명시적 개발 예시의 브라우저 메모리 동작이다. 실제 계정 저장 성공으로 표시하지 않는다. Back/Forward 복원과 전체 새로고침 초기화 규칙을 유지한다. 새 화면·새 상품 기능·계정 API·운영 schema는 추가하지 않았다.

## 고정 소스의 검사 결과

| 검사 | 현재 결과·증거 |
|---|---|
| `npm run lint` | 새 설치·고정 소스에서 통과. [실행 로그](../artifacts/w0-closeout/fresh-lint.log) |
| `npm run build` | 새 설치·고정 소스에서 통과. [실행 로그](../artifacts/w0-closeout/fresh-build.log) |
| `npm run typecheck` | 새 설치·고정 소스에서 exit 0. [실행 로그](../artifacts/w0-closeout/fresh-typecheck.log) |
| 전체 기준본 suite | 1,137개 중 1,091 pass / 46 fail |
| 전체 현재 W0 suite | 1,163개 중 1,117 pass / 46 fail |
| W0 전용 신규 검사 | 26개 모두 통과. 메모 4개를 포함한 `w0-memo`, `w0-model`, `w0-routing` |
| 현재 관련 회귀 | **84/84 통과**, fail/skip 0. W0 26개 + 기존 오디오·시작·종료·장치 관련 58개. [현재 실행 로그](../artifacts/w0-closeout/related-regression.log) |
| 이전 관련 80/80 보고 | 위 현재 84/84로 갱신. 이전 실행 수를 이번 결과로 재사용하지 않음 |

전체 suite는 통과하지 않았다. 실패 수가 각각 46이라는 이유로 같은 실패라고 판정하지 않고, [실패별 이름·위치·원인 대조](w0-test-comparison.md)와 [원인 fingerprint·판정 근거 JSON](w0-test-comparison.json)으로 실제 분류했다.

| 대조 단계 | 공통 기존 실패 | W0 신규 실패 | 기존 실패 해소 | 비교 불가·미해결 |
|---|---:|---:|---:|---:|
| 엄격한 원인 서명 일치 | 39 | 0 | 0 | 관찰 원인이 달라진 7건 별도 검토 |
| 7건의 증거 대조 후 | **46** | **0** | **0** | **0** |

7건의 원래 차이를 지우지 않았다. 6건은 변경 없는 정책 검증의 `Promise.all`에서 먼저 실패한 role이 달랐고, 두 환경의 정본 12개 바이트와 고정 hash 불일치 원인이 같았다. 나머지 1건은 school-context의 오류 배열 3개(PDF 부재·prepared 자료 부재·정책 role hash 오류)를 안전하게 재구성한 hash가 실제 두 실행의 fingerprint에 각각 정확히 일치했다. 따라서 같은 기존 원인으로 판정하되 기준본과 현재의 서로 다른 관찰 role·오류·hash를 JSON에 모두 보존했다.

최종 원인 묶음은 ignored replay/검수 은행 부재 10건, prepared/context 후속 assertion 2건, 생성 prepared/cache 부재 7건, 정본 raw-byte hash 13건, 비공개 원본 PDF 부재 13건, 하위 실패의 부모 집계 1건이다. 공통 기존 test 140개는 바이트가 같고 현재 W0의 추가 파일 3개만 별도로 확인했다. 두 실행은 같은 Node·새 설치 의존성·환경·자료 가용성에서 `--import tsx --test --test-concurrency=4`와 정렬한 `tests/*.test.ts` 목록으로 수행했다. 비교 환경은 `NODE_ENV=test`, `TZ=Asia/Seoul`, `NEXT_TELEMETRY_DISABLED=1`로 고정했다.

누락 자료를 stub으로 통과시키거나 시험 삭제·기대값 완화·서버 정책 변경으로 전체 suite를 초록색으로 만들지 않았다. 기존 실패를 확인했다는 사실은 실제 비공개 자료를 갖춘 환경의 전체 통과나 원격 CI를 대신하지 않는다.

## Production HTTP와 fixture 격리

최종 고정 소스의 production build를 포트 `3121`에서 실행했다. build ID는 `8rRpb_EW6pLL0MwSbwoQL`이다. [Production HTTP 보고서](../artifacts/w0-closeout/production-http.json)는 각 URL의 예상 정책, 실제 status, 상태·payload·fixture marker, 시간과 오류를 기록하며 응답 본문을 저장하지 않는다.

| Production 요청 범위 | 결과 |
|---|---|
| 홈·4개 진입·G04: no query와 9개 scenario, 그 외 39개 page의 ready query, G04의 알 수 없는 scenario | 일반 경로 총 100건 모두 200. W0 셸과 비예시 payload 유지, fixture 선택기·고유 합성 자료·가짜 저장 성공 없음. 대표 6개 화면은 disconnected 상태 확인 |
| 대응하는 preview 경로와 알 수 없는 scenario | 총 100건 모두 기존 route 정책의 404. W0 셸·예시 선택기·예시 payload·고유 합성 자료 없음 |
| 폐기·미정의 ID, panel/action 독립 경로, 잘못된 catchall 하위 경로 | 일반·preview 총 24건 모두 404. 예시 내용 없음 |
| 합계 | **224/224 통과** |

일반 `/w0`·`record/interviews/answers/memory`·G04에 `?scenario=ready`와 다른 8개 scenario를 붙여도 예시 자료로 바뀌지 않는다. 45개 page 경로 전체를 포함했으며 G07는 안내 본문 특성상 `StateNotice`를 렌더하지 않으므로 전체 화면에 같은 `data-state` 유무를 강요하지 않았다. 200 또는 404만 확인한 검사가 아니며, 실제 응답의 셸·명시적 `isExample`·고유 자료 marker를 status와 별도로 대조했다.

[Production client chunk 검사](../artifacts/w0-closeout/production-client-chunks.json)는 `.next/static/chunks`의 26개 파일, 1,227,353바이트를 별도로 검사했다. 고유 합성 대학명·원문·질문·답변을 UTF-8 및 Unicode escape 형태로 검색한 결과 **0건**이었다. 파일별 SHA-256와 build ID를 기록했다. 공통 UI 코드에 남아 있는 `예시 데이터` 등의 일반 안내 문구나 scenario 이름을 학생 원문 fixture와 같은 것으로 판정하지 않았다. server build 안의 개발용 코드 존재 여부와 실제 production 접근 거부·client 자료 부재도 구분한다.

개발 서버는 분리된 포트 `3120`에서 실행했다. [Development HTTP 보고서](../artifacts/w0-closeout/development-http.json)의 21개 검사는 홈 9개 scenario, 4개 진입의 ready, G04 예시 원문·질문·답변과 초기 편집/질문 저장 control, 일반 6개 경로의 예시 격리, 알 수 없는 scenario 거부를 포함하며 **21/21 통과**했다. 이 HTTP 검사는 초기 HTML/control 확인이며 실제 편집·초점·dialog 조작은 아래 브라우저 관찰과 구분한다.

검사는 `node --import tsx scripts/w0-http-check.mjs --base http://127.0.0.1:3121 --mode production --out <절대 JSON 경로>`와 대응하는 development 명령으로 실행했다. 스크립트의 동시 요청 수는 production 4개·development 2개다. 검사용 서버를 다른 개발 서버와 분리했으며 이 검사에서 다른 작업창 프로세스를 종료하거나 기존 시작 배치 파일을 바꾸지 않았다.

검증을 끝낸 production 서버 3121은 이 작업이 소유한 실행 세션으로 종료했다. 인앱 확인용 development 서버 3120은 결과를 둘러볼 수 있도록 남겼다. 기존 면접의 idle 화면 확인 중 realtime 3001의 `/api/status` 연결은 `ECONNREFUSED`였으므로 실제 면접 API·음성·장치 통합이 통과했다고 집계하지 않는다.

## 접근성·편집·브라우저 관찰

이번 작업의 브라우저 제어는 사용자 제약에 따라 Codex IAB의 격리 개발 서버 `3120`과 production 서버 `3121`에서만 수행했다. 사용 가능한 읽기 전용 브라우저 API로 navigator/UA를 얻을 수 없어 정확한 Chromium 버전은 확인하지 못했다. PC의 native 브라우저·OS 설정을 조작한 검증으로 보고하지 않는다.

| 대상 | 판정 |
|---|---|
| 숨겨진 메모의 dirty 경고 | pending→ready에서 메모 초안 작성→Back으로 pending 복귀 시 editor 숨김·dialog 없음. 이 상태에서 I00 메뉴 이동 성공. ready로 돌아오면 정확한 초안 복원 확인 |
| 문맥 변경 후 stale guard·pending action | dirty 이탈 확인을 연 뒤 Back으로 query가 pending이 되면 이전 dialog가 닫힘. Forward로 ready에 돌아가면 초안 복원 확인 |
| 지원처별 메모·새로고침 | A에서 저장한 메모가 B에서는 editor·A 문구 없이 자료 없음으로 표시. A로 돌아오면 저장한 예시 메모 복원. URL 전환 완료를 기다린 뒤 reload하면 메모가 비어 있음 확인 |
| 평가 검수 대기와 메모 편집 | `review_required`라도 해당 지원처에 유효한 가이드 자료가 있으면 메모 편집 가능함을 확인 |
| 메모 계속 편집·명시적 폐기 | `계속 수정하기`에서 입력한 X 문구 유지. 다시 이탈 확인을 열고 폐기하면 홈으로 이동. Record 복귀 시 editor 닫힘·메모 비어 있음·폐기한 X 문구 없음 확인 |
| 중첩 dialog와 Escape 초점 | dirty 상태의 프로필→U01에서 native dialog 2개 열림. 첫 Escape는 이탈 확인을 닫고 U01 링크에 초점 복귀·프로필 유지. 다음 Escape는 프로필을 닫고 프로필 트리거에 초점 복귀 확인 |
| G04 답변 취소와 질문 저장의 독립성 | 예시 답변 초안 입력 후 질문 저장=true. 답변 수정을 취소하면 입력한 문구는 제거되지만 질문 저장 상태는 유지 확인 |
| G04 로컬 저장·지원처·새로고침 | 로컬 저장→B에서 editor 없음·empty 상태·A 문구 없음→A에서 저장한 답변과 질문 저장 상태 복원. URL 전환·network idle을 기다린 뒤 reload하면 답변 로컬 수정과 질문 저장 상태 초기화 확인 |
| 순수 키보드 프로필 | Enter로 열기, Shift+Tab 첫 control→로그아웃, Tab 마지막→닫기 순환, Escape 후 프로필 트리거 초점 복귀 확인 |
| 키보드 주 메뉴 | Enter로 A00 이동, 현재 메뉴의 `aria-current=page` 확인 |
| Production 브라우저 격리 | preview G04는 404·W0 셸 없음·fixture 선택기 없음. 일반 `/w0?scenario=error`는 disconnected·선택기 없음·등록 target 0개·예시 계정 없음 확인 |
| 기존 production 면접 idle | `/interview`의 기존 셸 1개·W0 셸 없음·accent `#6654ff`. `/`는 `/interview`로 이동. `/interview/scene`은 기존 h1·W0 셸 없음 확인. 실제 진행 세션 시험과 별도 |
| 200% 실제 브라우저 확대 | **미검증**. IAB 확대 단축키만으로 실제 확대를 입증하지 못함. viewport 축소 또는 DPR 변화는 200% 확대의 증거로 대체하지 않음 |
| 320/390/768/1440px | 이전 W0 화면 확인 기록은 [QA 기록](w0-qa.md)에 유지. 이번 마감에서 모든 화면·폭을 전부 재실행한 것으로 집계하지 않음 |
| reduced motion | 설정이 true인 IAB 환경에서 버튼 computed transition `0s` 관찰. 누름 transform/transition 제거와 모션 완료 비의존 규칙은 코드로 유지. 프레임 성능 실측이나 실제 기기 시험과 별도 |
| 실제 iOS/Android·소프트웨어 키보드·하드웨어 safe area | 미검증 |
| 실제 진행 중 면접·물리 마이크·카메라·상용 STT/TTS | 미검증. 기존 경계·코드 보존과 실제 상용 통합 시험을 구분 |
| 원격 CI·스크린리더 전체 흐름 | 미검증 |

점수 null은 0점·임의 평균으로 바꾸지 않고 `review_required`를 `평가 검수 대기`로 유지한다. 개인 면접일 미확정은 미확정이며 임의 D-Day를 만들지 않는다. 선택한 B 지원처에 자료가 없을 때 A 지원처의 전략·질문·기록을 빌려 표시하지 않는 target 투영 규칙도 유지한다.

마지막 화면 증거는 [production disconnected](../artifacts/w0-closeout/production-disconnected.jpg)와 [검증한 development 화면](../artifacts/w0-closeout/verified-development.jpg)에 저장했다. IAB에서 `Ctrl+=`·`Ctrl+KP_Add`를 시도했지만 실제 200% 확대가 됐다는 증거는 얻지 못했으며, 기본 DPR 2를 확대율의 증거로 사용하지 않았다.

## 통합할 파일과 보존 경계

통합 대상은 아래 W0 파일 28개와 마감 증거 문서 4개다. 기존 추적 파일의 변경은 없다. 경로별 최종 바이트 기준은 소스 매니페스트를 따르며, 마감 보고서·매니페스트·비교 보고서는 실행 코드 fingerprint와 구분해 함께 보관한다.

| 구분 | 가져올 경로 |
|---|---|
| Next 경로 2개 | `app/w0/[[...path]]/page.tsx`, `app/w0/layout.tsx` |
| 컴포넌트 10개 | `components/w0/DetailScreen.tsx`, `DetailScreen.module.css`, `EntryScreens.tsx`, `EntryScreens.module.css`, `QuestionPreview.tsx`, `QuestionPreview.module.css`, `W0App.tsx`, `W0Context.tsx`, `W0.module.css`, `ui.tsx` |
| 프런트 모델 5개 | `lib/w0/answer-draft.ts`, `development-fixtures.ts`, `memo-draft.ts`, `navigation.ts`, `view-model.ts` |
| 검사 3개 | `tests/w0-memo.test.ts`, `tests/w0-model.test.ts`, `tests/w0-routing.test.ts` |
| 재현·검증 도구 4개 | `scripts/w0-source-snapshot.mjs`, `scripts/w0-test-reporter.mjs`, `scripts/w0-compare-tests.mjs`, `scripts/w0-http-check.mjs` |
| 기존 W0 문서·registry 4개 | `docs/ia-registry.csv`, `docs/w0-frontend.md`, `docs/w0-ia-mapping.md`, `docs/w0-qa.md` |
| 마감 증거 문서 | `docs/w0-source-manifest.json`, `docs/w0-closeout.md`, `docs/w0-test-comparison.md`, `docs/w0-test-comparison.json` |

2026-11-06 KST에 원본 저장소의 위 동일 경로 존재 여부를 읽기 전용으로 재확인했으며 충돌은 0개였다. 이는 미래 통합 시점의 최신 백엔드와의 충돌 검사를 대신하지 않는다. 이번 작업에서 merge·push·공개·배포는 수행하지 않았고, 원본의 최신 미커밋 백엔드 코드를 복사하거나 합치지 않았다.

다음 기존 보호 경계 9개는 변경하지 않았다: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `app/interview/page.tsx`, `app/interview/scene/page.tsx`, `components/interview/InterviewShell.tsx`, `hooks/useInterviewSession.ts`, `start server.bat`, `scripts/start-local.mjs`. 기존 `/` → `/interview`와 직접 면접·scene 경로를 유지하며 W0 셸이 기존 면접을 감싸지 않는다. 예시 지원처를 실제 session에 주입하지 않았다. package/lockfile·realtime launcher·음성/장치/시간/종료/복구·server/공유 codec/schema/정책/평가 worker/DB에는 W0 변경이 없다.

원본 `Downloads/ia-registry.csv`의 `id/name_role/dependency/ia_status` 네 열, 51개 ID와 순서가 현재 registry와 정확히 일치한다. 원본 SHA-256는 `ea5b76e20e6a4d04ca5e462efe105c91b4105170f9636f1e1bea4136eb32fa6d`다. W0 매핑의 page 45 / panel 4 / action 2를 51개 완성 기능으로 해석하지 않는다. A05를 복원하거나 G08·독립 G09·관리자 메뉴를 만들지 않았다.

## 다음 연결 순서

새 운영 API나 schema를 확정하지 않는다. 데이터·행동·owner/target·상태/오류 및 기존 계약 여부는 [기존 백엔드 연결 요청표](w0-ia-mapping.md)를 유지한다.

1. 인증된 owner·등록 target·지원처 전환·권리/이용 현황을 확인하고 기존 면접의 고정 session 문맥과 분리한다.
2. 실제 발행권과 문서/분석 revision을 연결한 뒤 G01·G02·G04 정본과 정확한 원문 anchor를 제공한다.
3. 개인 답변/메모·질문 저장의 성공/실패/충돌과 연습 준비·진행 기록을 연결한다.
4. 실제 session/평가 revision의 답변 기록·검수 대기·정상/부분/무효 결과와 리포트를 연결한다.
5. 암기 자료·G09·D-1 요약은 권한·콘텐츠·공개 시각 등 남은 조건을 확인한 뒤 별도 연결한다.

W1 신규 화면, G02/G04 정본 본문 완성, 실계정·원장·발행·평가 연동, Expo·관리자·결제·서비스 출시는 이번 마감 범위에 포함하지 않는다.

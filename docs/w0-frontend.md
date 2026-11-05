# W0 프런트 구현 안내

기존 면접 엔진을 보존하는 별도 `/w0` 경로에 공통 앱 셸과 H01/G01/I00/A00/M00 진입 화면을 구현했다. 확정 4메뉴, 지원처·프로필 UI, 하위 기능의 안내 상태, 개발 전용 합성 자료와 편집 인터랙션을 제공한다. 실제 계정/API 연결·정본 가이드북 전체 기능·서비스 공개는 완료하지 않았다.

[51개 IA 매핑](ia-registry.csv), [정본 근거·백엔드 연결 요청](w0-ia-mapping.md), [실행한 검사와 브라우저 QA](w0-qa.md)를 함께 확인한다. W0를 G3~G8 또는 전체 IA 기능 완료로 보고하지 않는다.

검증 마감의 현재 재현 기준과 통합 파일 목록은 [마감 기록](w0-closeout.md)·[소스 매니페스트](w0-source-manifest.json)를 따른다. 새 설치 환경에서 관련 회귀 84/84, production HTTP 224/224, 개발 HTTP 21/21을 통과했다. [기준본 전체 대조](w0-test-comparison.md)는 기존 실패 46건과 신규 실패 0건을 구분한다. 실제 200% 확대가 미검증이므로 검증 마감은 이 제한을 포함한 조건부 상태이며, API·공개·원격 CI·실제 기기 완료로 표시하지 않는다.

## 실행과 기존 화면

작업 공간은 `C:\Users\MaYunsong\Documents\각자의답NEW-w0`, 브랜치는 `codex/w0-frontend`, 기준 커밋은 `a666f7a81dd2e80851f8589d135a0aac67c1eae2`이다. 원본 `각자의답NEW`의 미커밋 백엔드 작업을 복제하거나 수정하지 않았다. 기존 `node_modules`를 junction으로 재사용했고 package/lockfile을 변경하지 않았다.

worktree에서 다음 중 하나로 웹을 실행한다.

```powershell
npm run dev:web -- --port 3100
```

```powershell
npx next dev --webpack --hostname 127.0.0.1 --port 3100
```

| 화면 | 일반 경로 | 개발 예시 경로 |
|---|---|---|
| H01 MY 홈 | `/w0` | `/w0/preview?scenario=ready` |
| G01 생기부 진입 | `/w0/record` | `/w0/preview/record?scenario=ready` |
| I00 면접 연습실 | `/w0/interviews` | `/w0/preview/interviews?scenario=ready` |
| A00 내 답변 | `/w0/answers` | `/w0/preview/answers?scenario=ready` |
| M00 암기 훈련실 | `/w0/memory` | `/w0/preview/memory?scenario=ready` |
| G04 합성 편집 미리보기 | `/w0/view/G04` 안내만 | `/w0/preview/view/G04?scenario=ready` |
| 그 외 page 안내 | `/w0/view/{ID}` | `/w0/preview/view/{ID}?scenario=ready` |

위 명령은 로컬 3100 포트를 사용한다. 이번 검증에서 연 고정 소스의 별도 서버는 [일반 홈](http://127.0.0.1:3120/w0), [예시 홈](http://127.0.0.1:3120/w0/preview?scenario=ready), [G04 예시](http://127.0.0.1:3120/w0/preview/view/G04?scenario=ready)에서 확인한다. 3120은 검증용 `development` 사본의 실행 경로이며 다른 작업창의 서버를 대체하지 않는다.

루트 `/`의 `/interview` redirect, `/interview`, `/interview/scene`, `start server.bat`와 realtime launcher의 기존 면접 진입은 유지했다. W0 셸은 기존 면접을 감싸지 않으며 예시 지원처를 실제 면접 session에 넘기지 않는다. 기존 음성·장치·타이머·복구 흐름에 변경을 섞지 않았다. 배포는 수행하지 않았다.

## 구현 범위와 IA

상위 메뉴 순서는 `생기부 / 면접 연습실 / 내 답변 / 암기 훈련실`이다. MY 홈은 로고로 접근한다. PC는 헤더 4메뉴, 1000px 이하에서는 상단 로고·지원처·계정과 하단 4탭을 사용한다. 홈 탭이나 독립 AI 메뉴를 더하지 않았다.

| 범위 | 이번 구현 |
|---|---|
| H01 | 문맥 상태, 전체 클릭 4메뉴 카드, 실제 연결 전 이용 현황 안내, 개인 일정/미확정 표시 |
| G01 | 여섯 본문 목차·보조 사용법, 전략/대표 활동 영역의 연결 상태, 개발 예시와 개인 메모 UI |
| I00 | 연습 면접 / 실전 모의면접 두 카드. 연습은 채팅/화상, 실전은 화상 전용 규칙 유지 |
| A00 | 답변 보관함 / 면접 리포트 / 면접 직전 요약 세 카드, 세션/검수 상태·일정 잠금 |
| M00 | 퀴즈 / 지식한입 / 이슈픽 세 카드와 목적지 기능 안내 |
| 하위 page | 확정 기능의 설명·상태·가능한 다음 행동을 갖춘 안내. 5개 진입+40개 안내를 하나의 catchall route로 대응 |
| I01·I05·A01·A03·A06 안내 내부 | 연습 출처/방식 선택, 실전 화상 전용 표시, 기록 탭, 리포트 펼침, 일정 잠금의 로컬 UI. 실제 시작·평가·다운로드는 연결하지 않음 |
| G09 | 가이드북에만 있는 native dialog. 실제 AI 응답은 연결 전 안내 |
| A04 | 리포트의 native details 예시 컨테이너. 미확정 상세 시각화·PDF를 확정하지 않음 |
| I04·U06 | 문맥 호스트 안내만. 실제 다시 연습 선택·정정 접수 기능 미구현 |
| I09·U08 | I09는 기존 엔진의 복구 문맥 보존. U08은 프로필에서 실제 인증이 없는 상태를 정직하게 안내 |

제공된 원본 registry의 `id/name_role/dependency/ia_status` 네 열·51개 ID·행 순서를 보존하고 W0 매핑 열을 추가했다. page 45 / panel 4 / action 2의 구현 분류는 독립 페이지 51개를 뜻하지 않는다. `A05`는 폐기, `G08`은 미정의로 유지한다. 관리자 IA도 새로 만들지 않았다.

G02/G04 정본 본문, 전체 원문·정밀 앵커, 실제 발행권·학생 저장·평가·리포트 연결은 후속 의존성이다. 이번 합성 G04는 정본 데이터 계약을 대체하지 않으며 질문 의도·후속질문 미리보기·근거 팝업·즉시 연습 버튼을 복원하지 않았다.

## 개발 fixture와 상태

`lib/w0/development-fixtures.ts`는 명시적 개발 미리보기용 합성 자료만 만든다. 실제 학생 원문·답변·토큰을 fixture나 새 클라이언트 번들에 넣지 않았다. 상태 선택기는 preview에서만 표시한다.

| scenario | 확인 목적 |
|---|---|
| `ready` | 두 예시 지원처·A 지원처의 전략/질문/기록·로컬 편집 |
| `empty` | 지원처/자료 없음 |
| `loading` | 자료 조회 중 상태 UI |
| `pending` | 처리·검수 대기 |
| `error` | 조회 오류; 정상 예시로 대체하지 않음 |
| `forbidden` | 접근 범위 안내 |
| `review_required` | 평가 검수 대기·null 점수 |
| `long-target` | 긴 대학·캠퍼스·학과·전형명 |
| `one-target` | 지원처 한 개 |

일반 경로에 `?scenario=ready`를 붙여도 `createDisconnectedModel()`을 유지한다. production 서버 route는 preview를 `NODE_ENV` guard로 동적 import 전에 거부한다. fixture factory의 test 허용은 단위 검사 목적이며 production route 허용이 아니다. 클라이언트에서 fixture를 import하지 않고 production client chunk의 예시 문자열도 검사했다. production HTTP 서버·브라우저 시험과 코드/빌드 검사를 혼동하지 않는다.

프런트 전용 `W0Model`은 서버의 공식 schema가 아니다. `scopeW0Model`은 선택한 target에 속하는 전략·질문·sessions만 투영한다. B 지원처에 자료가 없으면 A 자료를 빌리지 않는다. 이용권·연습기간은 owner 범위로 유지한다. 실제 계정의 등록·권한·지원처 변경은 실행하지 않는다.

검수 대기는 `평가 검수 대기`로 표시하고 null 점수를 0점·평균·임의 총점으로 바꾸지 않는다. 면접일 미확정은 `미확정`이며 D-Day 0이나 D-1 잠금 해제를 만들지 않는다. 영구 로딩이나 가짜 저장 성공을 실제 미연결 기능에 사용하지 않는다.

## 로컬 편집과 이탈 보호

G04 예시에는 답변 수정→저장/취소, 질문 저장/해제를 구현했다. 질문 저장은 답변 저장·연습 실행과 독립이다. 저장 안내는 브라우저 미리보기 안에서만 반영됨을 명시한다.

합성 답변 상태는 target ID와 질문/초기 답변 내용으로 구별하는 메모리 캐시에 보관한다. 같은 client session의 뒤로/앞으로 탐색은 정확한 draft를 복원하며 질문 저장 상태도 분리한다. 전체 새로고침·탭 닫기는 캐시를 지운다. 실제 학생 답변을 localStorage·cookie에 보관하지 않는다.

메뉴·지원처·scenario를 바꾸려 할 때 dirty 답변이나 메모가 있으면 native dialog에서 계속 편집/폐기를 선택한다. 계속 편집하면 현재 문구를 유지하고 폐기는 캐시의 편집 상태도 취소한 뒤 이동한다. dirty 상태에는 `beforeunload` 보호를 등록한다. 브라우저의 경고 표시 조건은 브라우저 정책에 따른다. G01 메모도 target별 브라우저 메모리 상태와 이탈 보호를 사용한다.

## 토큰과 재사용 컴포넌트

기존 `--font-sans`와 Noto Sans KR variable font, `lucide-react`를 재사용했다. 새 라이브러리를 추가하지 않았다. 기존 semantic token 이름을 W0 `.shell` 안에서 확장하고 면접 루트의 전역 값을 변경하지 않았다.

| 구분 | W0 값·범위 |
|---|---|
| 배경/표면 | `--background:#171717`, `--panel:#202020`, `--surface-raised:#292929` |
| 글자/보조 | `--text:#f5f5f5`, `--muted:#aaa`, `--subtle:#858585` |
| 경계/강조 | `--line:#343434`, `--accent:#00ee77` |
| 상태 | `--warning:#edc880`, `--danger:#ffb0a6`; 아이콘·상태 문구 동반 |
| 간격 | `--space-1/2/3/4/6/8`: 4/8/12/16/24/32px |
| 곡률 | `--radius:16px`; 작은 control 8px, dialog 20px는 각 component CSS에 정의 |
| 그림자 | dialog `0 20px 80px #0008`, 가이드 AI 트리거 `0 4px 20px #0004`; 카드 반복 발광 없음 |
| 모션 | `--press-duration:140ms`, `--ease-out:cubic-bezier(.23,1,.32,1)`; transform 누름 피드백 |
| 패널 예약 값 | `--panel-duration:180ms` 정의. 현재 native dialog에 별도 등장 타이밍을 강제하지 않음 |
| 접근성·입력 | focus-visible outline, 44px 이상 주요 control, mobile input 16px, text selection·브라우저 확대 허용 |
| 반응형·모션 조건 | `100dvh`, safe-area inset, hover/pointer 조건, reduced-motion에서 transition/press transform 제거 |

모션은 애니메이션 종료를 동작 조건으로 사용하지 않는다. 키보드 focus-visible 조작에는 누름 이동을 적용하지 않고 `transition:all`·상시 반복 움직임·새 모션 라이브러리를 도입하지 않았다. 모션 성능 개선 수치는 측정하지 않았다.

| 파일/컴포넌트 | 책임·재사용 |
|---|---|
| `app/w0/[[...path]]/page.tsx` | 45개 page의 route 판정, 서버 preview guard·fixture 동적 import |
| `app/w0/layout.tsx` | W0 metadata·확대 제한 없는 viewport 설정. 기존 루트 layout 보존 |
| `W0App` | 헤더·하단 메뉴·지원처·프로필/G09/이탈 보호 native dialog, 포커스 경계 |
| `PageHeading` / `MenuCard` / `StateNotice` | 제목 위계, whole-card link, 상태별 아이콘·문구 |
| `GuideContents` / 5개 EntryScreens | 여섯 목차+보조 사용법, 각 진입의 확정 정보 위계 |
| `QuestionPreview` / `ExampleEditor` | 합성 원문/답변, 모바일 전환, 답변 리듀서·질문 저장 |
| `view-model.ts` / `answer-draft.ts` | 미연결 adapter 경계·target 투영·평가/일정 문구·로컬 캐시 |
| `navigation.ts` | 확정 4메뉴·목차·page 안내 정의·허용 route 판정 |
| CSS Modules 4개 | 셸·진입·하위 안내·질문 UI로 제한한 토큰·간격·입력·반응형 |

## 디자인 스킬 출처와 적용

사용자 지정 [emilkowalski/skills](https://github.com/emilkowalski/skills/tree/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills)를 `C:\Users\MaYunsong\Documents\emil-skills-w0`에 clone해 commit `c8a79627b59d72d764d6ab6f2c87c09a48169833` 원문을 읽었다. 전역 설치된 스킬로 보고하지 않는다.

| 읽은 원문 경로 | 적용·참조 범위 |
|---|---|
| [`skills/emil-design-eng/SKILL.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/emil-design-eng/SKILL.md) | 가독성·밀도·정렬·기존 도구 재사용·UI 품질 기준 적용 |
| [`skills/animate/SKILL.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/animate/SKILL.md), [`RECIPES.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/animate/RECIPES.md) | 누름 피드백·중단 가능한 짧은 반응·native dialog 관련 참조. CSS 우선 |
| [`skills/mobile-native/SKILL.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/mobile-native/SKILL.md) | 4탭·터치 영역·viewport/safe-area·입력 크기 적용 |
| [`skills/animation-performance/SKILL.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/animation-performance/SKILL.md) | transform 중심 CSS·reduced-motion·지속 연산 회피 검토. 성능 수치는 미측정 |
| [`skills/pick-ui-library/SKILL.md`](https://github.com/emilkowalski/skills/blob/c8a79627b59d72d764d6ab6f2c87c09a48169833/skills/pick-ui-library/SKILL.md) | 참조. 기존 접근성 라이브러리가 없어 native select/dialog/details 선택 |

Host Sites의 repository/local-only 흐름과 로컬 Next 16.4.3의 layouts/pages·server/client·CSS·dynamic routes 문서를 읽고 기존 Next 구조를 유지했다. Sites 배포, Expo·Swift 구현은 시작하지 않았다. 디자인 스킬을 IA·상품 권리·질문·평가 정책 변경 근거로 사용하지 않았다.

## 디자인 변경 설명

| Before | After | Why |
|---|---|---|
| 면접 직접 진입 중심의 기존 화면 | 별도 W0 셸과 확정 4메뉴·5개 진입 | 기존 엔진을 보존하며 프런트 병행 개발 |
| 새 화면에 전역 스타일을 덧붙일 가능성 | `.shell` 내부 차콜/`#00EE77` semantic tokens와 CSS Modules | 기존 면접의 루트 스타일·세션 경계 보존 |
| 닫힌 details 안의 desktop 목차가 숨겨지는 결함 | desktop 상시 목차와 mobile disclosure를 분리 | desktop의 여섯 장·도움말 링크를 유지하고 모바일 접기/펼치기를 보존 |
| 셸 reset의 우선순위 충돌 | `:where`로 낮춘 scoped reset | 하위 카드·목차·본문의 의도한 간격/표시 보존 |
| 지원처 전환 후 다른 지원처 자료가 표시될 여지 | target별 엄격한 view-model 투영·없음 상태 | 개인 자료·세션 범위를 혼동하지 않음 |
| 이동 시 편집 초안 소실·폐기 상태 재등장 가능성 | revision별 브라우저 메모리 캐시·계속 편집/폐기·Back/Forward 복구 | 작성 중 문구와 사용자의 폐기 의도 보존 |
| native dialog의 Tab 경계가 브라우저 본문 밖으로 이동 | 첫/마지막 control의 명시적 Tab 순환·Escape 복귀 | 프로필·이탈 확인의 키보드 조작을 유지 |
| 빠른 경로 이동 후 scroll effect가 native control 클릭에 간섭 | 경로 초기화를 paint 전 `useLayoutEffect`로 처리 | 빠르게 이동한 뒤 radio 선택·details 펼침을 정상 유지 |

## 검증과 남은 연결

현재 새 설치의 타입·린트·빌드와 관련 회귀 84/84를 통과했다. 전체 suite는 기준본 1137개 중 1091 통과·46 실패, 현재 W0 1163개 중 1117 통과·46 실패이며 W0 전용 26개가 모두 통과했다. 실패 원인을 하나씩 대조한 [결과](w0-test-comparison.md)와 [QA 기록](w0-qa.md)을 구분해 남겼다. 초기 5개 진입의 320/390/768/1440px 관찰을 이유 없이 반복하지 않고, 이번 수정 영향인 메모·확인창·G04·초점과 production 격리를 코덱스 인앱에서 추가 검증했다.

실제 iOS/Android, 소프트웨어 키보드·하드웨어 safe area, 200% 확대, 실제 진행 중인 면접의 세션 보존, STT/TTS·미디어 실측, 일반 모션 프레임 성능은 미검증이다. 서버 계약·owner/target 권한·발행/정본·저장/권리원장·평가/리포트·법률/PG 연결은 [백엔드 요청표](w0-ia-mapping.md)의 후속 작업이다. 골격과 인터랙션 관찰을 실제 API 연결·공개 가능으로 바꾸지 않는다.

# 면접관 장면 런타임 연결 현황

기록일: 2026-11-04, Asia/Seoul. 현재 제작한 코드·파일과 실제 실행을 구분한다. 승인된 얼굴과 원화 상태를 기준으로 파츠·리깅 제작을 진행하며, 이 문서는 추가 얼굴 보정이나 재승인을 요구하지 않는다.

## 현재 상태

| 항목 | 상태 | 확인 근거와 한계 |
|---|---|---|
| 출력 음성·현재 발화자·상태 제어 | 코드 구현, 단위 검증 완료 | `lib/live2d/`, `hooks/useInterviewSession.ts`, 관련 테스트. 모델 없는 상태의 제어 검증 |
| 공식 SDK 연결 번들 | 부분 완료 | 공식 Web Framework `5-r.5`·MotionSync Plugin `5-r.3` 소스로 번들 생성. `public/live2d/runtime/provenance.json`에 버전·커밋·SHA 기록, `runtimeVerified: false` |
| 전용 모델 렌더링·MotionSync 결과 | 차단됨 | 전용 모델의 실제 `.moc3`·`.model3.json`·모델별 `.motionsync3.json`과 검증한 Core 실행 조합이 아직 없음 |
| 원화 입력·PSD 패키징 | 별도 제작 경로 | `public/live2d/production/<speaker>/sources/`, 파츠 manifest와 PSD 검증 보고서가 실제 산출물의 정본. 원화 PNG가 존재한다는 사실은 리깅 완료를 뜻하지 않음 |
| 모션·표정 데이터 | 부분 완료 | 두 명의 motion3 12개·exp3 6개 생성. 숫자·정책 검사 통과. 현재 renderer의 모션/표정 manager에는 미연결 |
| Expo WebView 예제 | 코드·의존성 검사 완료, 기기 미검증 | `examples/expo-scene/`. 네이티브 실행·오디오 중단·카메라·녹음 공존·성능 측정 없음 |

배포용 장면 설정 `public/live2d/scene.json`은 `status: blocked`, `runtime: null`, `models: []`다. 모델과 Core가 없는 상태에서 실행 장면이 준비됐다고 표시하지 않는다. 기존 화면·연결 확인 경로의 정적 이미지는 대체 화면이며 완성 Live2D 결과가 아니다. 이번 원화 파츠 제작만으로 서비스 화면이나 장면 설정을 자동 전환하지 않는다.

## 실제 연결 코드

- `lib/live2d/types.ts`: 상태·발화 ID·명령·이벤트·renderer의 애플리케이션 계약.
- `lib/live2d/director.ts`: 눈·시선·호흡·작은 자세·진폭 입 열림 값. 학생 답변과 중단에서는 입을 닫는 상태 규칙.
- `lib/live2d/browser-scene.ts`: 기존 면접 오디오를 관찰하는 장면 수명주기, 출력 분석, 재배치, 숨김 상태와 자원 해제. 공유 오디오를 새로 재생하거나 소유하지 않음.
- `integrations/live2d/renderer.mjs`: 실제 공식 SDK를 가져오는 어댑터. 모델·텍스처·전경 로드, 파라미터 적용, 출력 PCM의 MotionSync 공급, 자체 GPU/SDK 자원 해제.
- `lib/live2d/command-player.ts`, `lib/live2d/bridge.ts`: 독립 장면·WebView용 고수준 명령 처리. 기존 면접 플레이어와는 별도 진입 경로.
- `components/interview/InterviewerScene.tsx`, `SceneHost.tsx`, `app/interview/scene/page.tsx`: 이미 존재하는 장면 호스트와 연결 확인 경로.

`interviewer-1`은 기존 primary 남성 출력, `interviewer-2`는 secondary 여성 출력에 대응한다. 연결 멘트·종료 발화는 화면에 보이는 질문과 발화자가 다를 수 있어 `visibleTurn`으로 추측하지 않고 실제 재생의 `activeSpeech`를 사용한다.

실제 오디오의 `playing`·`ended`·`pause`·취소와 `currentTime`이 동작 기준이다. 음성 요청 완료나 독립 타이머로 발화 시작을 선언하지 않는다. 장면에 전달하는 분석기는 면접관 출력 전용이며 학생 마이크 입력을 받는 명령은 없다. 발화마다 `turnId`와 `speakerId`를 두고 오래된 응답·취소된 발화를 버린다.

## SDK 준비와 설치·실행

프로젝트 루트에서 필요한 의존성을 설치하고 공식 공개 SDK 소스를 빌드한다.

```text
npm install
npm run prepare:live2d-sdk
```

실제 스크립트는 `scripts/setup-live2d-sdk.mjs`다. Git과 `esbuild`가 필요하며 공개 소스는 `node_modules/.cache/live2d-sdk/`에 둔다. 고정 태그·커밋과 소스 수정 여부를 확인하고 일치하지 않는 기존 폴더는 덮어쓰지 않는다. 출력은 `public/live2d/runtime/renderer.mjs`, `shaders/`, `licenses/`, `provenance.json`이다. Core와 전용 모델은 이 명령으로 생성·다운로드하지 않는다.

다음 실제 파일이 별도로 준비되어야 한다.

1. 공식 Web SDK 사용 조건을 확인한 Cubism Core와 동반 파일.
2. MotionSync 사용 시 공식 Plugin 배포 패키지의 MotionSync Core 및 필요한 `.wasm` 등 동반 파일.
3. 각 면접관의 실제 `.model3.json`·`.moc3`·텍스처·필요한 물리 설정·모델과 일치하는 `.motionsync3.json`.
4. 최종 장면 레이어와 좌표·가림 관계, 실제 모델 파라미터 목록.

Core는 renderer 모듈의 동적 import보다 먼저 로드되어야 한다. Framework가 모듈 평가 중 Core 상수를 읽기 때문이다. 공식 R5 소스 구조에 의존하는 셰이더 등록 코드도 있어 SDK 버전을 바꿀 때 실제 Core·모델과 다시 검사해야 한다. 버전·획득·라이선스 근거는 `sdk-research.md`와 `integrations/live2d/README.md`에 있다.

모든 파일을 준비한 뒤 manifest에 실제 URL과 공유 캔버스 픽셀 좌표를 연결한다. `layout`은 모델 drawable 전체의 기본 경계가 들어가는 사각형이며 얼굴이나 원화의 피벗을 자동 인식하지 않는다. 정적 레이어도 같은 캔버스를 사용한다. 모델 순서 100·110 사이/앞뒤의 `order`만으로 책상 위 손 접촉까지 자동 해결되지는 않으므로 모델 메쉬·마스크와 전경을 함께 검수한다.

```text
npm run verify:live2d
npm run typecheck
npm run dev
```

기존 로컬 실행 주소는 `http://localhost:3000/interview`이며 독립 연결 확인 경로는 `/interview/scene`이다. 현재 manifest에서는 자산 검사 결과가 `blocked`인 것이 정상이다. `verify:live2d`는 정적 파일 참조·내용 구조 검사이며 실제 Core 로드, 얼굴 품질, 한국어 립싱크, 기기 성능을 승인하지 않는다.

## 립싱크와 모션 소유권

`amplitude`는 출력 음성의 크기로 입 열림 정도를 제어하는 경로다. 다양한 입 모양을 갖춘 MotionSync 완성 결과로 계산하지 않는다. `motion-sync`는 현재 출력 URL을 디코딩한 48kHz mono PCM을 실제 재생 위치에 맞춰 해당 면접관의 `CubismMotionSync`에 전달하도록 구현되어 있다. 디코딩 결과는 현재 발화의 메모리에만 유지하며 새 발화·큰 재생 위치 변경에서는 분석 상태를 갱신한다.

실제 내보낸 MotionSync 설정에 있는 입 채널이 정본이다. 일반 모션과 표정은 이 채널을 덮어쓰지 않아야 한다. 현재 출력 음성이 멈추거나 학생 답변 상태가 되면 입을 닫는다. 입력 음성을 추가로 재생하거나 학생 마이크를 분석하지 않는다. 디코딩·샘플 공급 코드의 존재만으로 실제 모델의 발음·무음·전환 품질이 검증됐다고 판단하지 않는다.

현재 작성된 motion3/exp3 파일은 renderer의 모션/표정 관리자를 아직 연결하지 않았다. 연결 시 해당 머리·몸 ID는 director의 쓰기와 중복하지 않도록 소유권을 인계하고, 중단 때 현재 자세에서 중립으로 블렌딩해야 한다. `ReturnToNeutral`의 0 곡선만 적용하여 임의의 현재 자세가 부드럽게 복귀한다고 가정하지 않는다. 손 제스처는 현재 제작 데이터에서 0이다. 세부 계약은 `parameter_spec.md`, `motion_spec.md`에 있다.

## Expo·React Native 경로

예제 실행은 `examples/expo-scene/README.md`를 따른다. WebView가 `EXPO_PUBLIC_SCENE_ORIGIN`의 `/interview/scene`을 열며 같은 실행 환경 안에서 음성 재생·분석·입 제어를 수행한다. 앱과는 `prepare`, `speak`, `cancel`, `pause`, `resume`, `setListening`, `dispose` 및 준비·발화·오류 이벤트만 교환한다. 프레임별 입 값을 네이티브로 왕복하지 않는다.

예제는 동일 출처 탐색과 음성 URL을 제한하고 세션 ID·순번으로 오래된 명령을 거부한다. 앱 비활성화 시 일시정지하며 복귀만으로 음성을 자동 재개하지 않는다. WebView 새 로드와 렌더 프로세스 종료 때 실제 면접 턴·학생 답변의 복구는 기존 면접 시스템이 담당해야 한다. 물리 기기의 `localhost`는 PC를 가리키지 않으므로 기기에서 접근할 수 있는 HTTPS 환경이 필요하다.

이 예제의 의존성 설치·타입 검사·Expo 버전 호환 검사는 수행했다. Android/iOS 네이티브 빌드나 실제 기기에서 모델·CLOVA 음성·학생 녹음이 함께 실행된 결과는 없다.

## 원화 입력 검사

```text
node scripts/source-artwork-inspection.mjs
```

각 `public/live2d/production/<speaker>/sources/inspection.json`에 실제 PNG의 크기·SHA-256·IHDR RGB8 여부·실제 알파 채널·알파 값 분포와 두 경계를 기록한다. 경계는 `alpha > 0`, `alpha > 128`을 각각 계산하며 원점은 왼쪽 위, 오른쪽/아래는 exclusive 좌표다. PNG를 편집하거나 크기·색상·위치를 바꾸지 않는다. ICC가 없으면 sRGB 프로필이 들어 있다고 표시하지 않는다.

필수 입력은 `approved-master.png`, `underpaint.png`, `mouth-open-source.png`다. 없는 파일은 `missingExpectedFiles`와 `partial-inputs`로 기록한다. 추가 생성물을 복사한 뒤 다시 실행하면 최신 입력 상태가 반영된다. 투명 경계 검사는 해부학적 파츠 분리·얼굴 일관성·입 모양·등록 위치의 시각 검수를 대신하지 않는다.

이번 실제 검사에서는 두 면접관의 필수 입력 총 6개가 모두 존재했고 `complete-metadata`로 기록했다. 6개 모두 저장 형식이 RGBA 8-bit이며 실제 투명 픽셀이 있다. `approved-master`는 1672×941, 보완 원화와 입 열린 소스는 1671×941이므로 1픽셀의 캔버스 폭 차이를 보고서 경고에 기록했다. 원본에 ICC가 없어 프로필이 내장되었다고 표시하지 않았다. 실제 파츠 배치에는 명시적인 원점·좌표를 사용해야 한다.

## 실제 검증과 남은 검수

2026-11-04에 다음을 다시 실행했다.

| 실행 | 실제 결과 | 검증 범위 |
|---|---|---|
| `npx tsx --test tests/live2d-scene.test.ts tests/scene-playback-identity.test.ts` | 13개 통과 | 출력 발화자·입 닫힘·중단/취소·오래된 발화·브리지·manifest의 순수 코드 규칙 |
| `node scripts/prepare-interviewer-motions.mjs --check` | 18개 파일 통과 | 저장된 JSON·catalog·채널·범위·메타데이터 |
| `node scripts/prepare-interviewer-motions.mjs --self-test` | 손상 사례 12개 거부 | 생성 곡선 형식·정책 검사 |
| 원화 source inspection | 각 `sources/inspection.json` 참조 | 실제 파일 메타데이터와 알파 측정 |

위 테스트는 공식 SDK 모델 재생 테스트가 아니다. 이 문서 작성 시점에는 전용 모델을 실제 Core로 로드한 기록과 MotionSync 샘플 설정을 공식 파서에서 실행한 별도 결과를 확보하지 못했다. 해당 검사를 수행하면 정확한 입력 파일·SDK 버전·실행 명령·결과를 추가하고 범위를 구분한다. 샘플 파서 통과도 전용 모델 리깅·립싱크 통과를 뜻하지 않는다.

최종적으로 전용 모델의 실제 ID/범위와 MotionSync 매핑, 얼굴·안경·목·손·책상의 가림, 실제 한국어 출력 음성, 중단·블루투스·전화·백그라운드 복귀, 카메라·녹음·전사·시선 분석 동시 실행을 검수해야 한다. 30FPS는 초기 목표이며 지원 하한 기기에서 측정한 결과가 아직 없다. 생성 음성 저장·캐시·재사용은 모델·텍스처 캐시와 별개로 실제 CLOVA 계약·이용 정책을 확인해야 한다.

# Expo 면접 장면 연결 예제

독립 실행 가능한 Expo/WebView 연결 코드입니다. 두 면접관의 제작 완료를 뜻하지 않습니다. 실제 모델·Core가 없는 현재 장면은 `ready.mode = static-fallback`으로 보고하며 화면에도 정적 대체 이미지임을 표시합니다.

## 실행

프로젝트 루트에서 웹 서버를 먼저 실행합니다. 이 폴더에서 다음을 실행합니다.

```powershell
npm install
npx expo install --check
$env:EXPO_PUBLIC_SCENE_ORIGIN='https://실제-장면-서버-주소'
npm start
```

`EXPO_PUBLIC_SCENE_ORIGIN`은 경로 없이 출처만 입력합니다. 예: `https://interview.example.com`. 실제 배포 주소를 뜻하며 위 예시 도메인에 서비스가 있다는 의미는 아닙니다. 앱에서 `/interview/scene` 경로를 열어 같은 웹 장면을 사용합니다. API 키는 넣지 않습니다.

물리 기기에서 `localhost`는 PC가 아닌 기기 자신입니다. 현재 웹 개발 서버는 기본적으로 PC의 `127.0.0.1`에만 바인딩하므로 원격 기기에서는 직접 접근할 수 없습니다. 기기에서 접근 가능한 HTTPS 개발 환경이나 배포 환경을 사용합니다. 이 예제는 Android cleartext 허용이나 iOS ATS 예외를 추가하지 않습니다.

Expo SDK 58 환경의 개발 빌드를 사용합니다. Android는 Android SDK가 필요하고, iOS 네이티브 빌드는 macOS/Xcode가 필요합니다. 웹 장면은 실제 기기의 WebGL2·AudioContext·WebView 정책 지원이 필요합니다. `mediaPlaybackRequiresUserAction={false}`는 재생 허용 설정일 뿐 모든 기기에서 자동 재생을 보장하지 않습니다. 재생 거부는 웹에서 error 이벤트로 보고해야 합니다.

## 메시지 계약

앱 → 장면:

```json
{"channel":"each-answer-scene-v1","sessionId":"mount-specific-id","sequence":1,"command":{"type":"prepare"}}
```

장면 → 앱:

```json
{"channel":"each-answer-scene-v1","sessionId":"mount-specific-id","event":{"type":"ready","mode":"static-fallback"}}
```

`prepare`, `speak`, `cancel`, `pause`, `resume`, `setListening`, `dispose`만 보냅니다. `speak`에는 `turnId`, `speakerId`, `audioUrl`을 넣고 `cancel`에는 해당 `turnId`를 넣습니다. 발화 ID는 각 요청마다 새로 만듭니다. 서버에서 합성한 실제 음성 URL을 입력해야 하며 가짜 음성·더미 전사는 없습니다. 남녀 음성에 맞는 `speakerId`를 호스트가 지정해야 합니다. 이 예제는 서버의 음성 내용을 확인하거나 변환하지 않습니다.

음성 URL과 WebView 탐색은 설정한 출처로 제한합니다. 세션 ID는 오래된 메시지를 구분하는 식별자이며 로그인·인증 수단이 아닙니다. WebView 새 로드 때 수신 준비를 위해 `prepare`를 보내며 필요하면 `장면 준비 다시 시도`를 누릅니다. 실서비스의 인증은 기존 앱과 서버 정책에 맞게 별도로 연결합니다.

앱이 비활성화되면 `pause`를 보냅니다. 복귀 후에는 사용자가 `이어서 재생`을 눌러야 합니다. 네이티브 JS가 정지된 순간의 오디오 중단도 웹 장면의 visibility 이벤트와 함께 처리해야 합니다. WebView 렌더 프로세스가 종료되면 복구 버튼을 표시합니다. 이 예제에서 화면을 새로 불러오면 장면 발화는 복원하지 않으며 실제 면접 턴과 답변은 기존 면접 시스템에서 복구해야 합니다.

## 기존 앱 연동

`App.tsx`의 WebView와 `send`/`onMessage`를 기존 앱의 장면 컴포넌트로 옮깁니다. 카메라·학생 녹음·전사는 이 예제에 포함하지 않았습니다. 학생 마이크를 장면에 전달하는 명령도 없습니다. 입 모양 값은 WebView 안에서 계산하며 매 프레임 네이티브 브리지로 왕복하지 않습니다.

UI의 음성 주소 입력·재생 버튼은 연결 검수용입니다. 서비스 화면에서는 기존 턴 제어기가 서버 발화 URL과 올바른 면접관 ID를 보내도록 연결합니다. 질문 생성·회원가입·결제 등의 새 서비스 기능은 포함하지 않습니다.

## 확인 상태

- 작성: Expo 프로젝트 파일과 고수준 브리지 연결 코드.
- 실제 확인: `npm install --ignore-scripts --no-audit --no-fund`로 예제 의존성 460개 설치 완료, `npm run typecheck` 통과, `npx expo install --check`에서 의존성 호환 확인(`Dependencies are up to date`), 설정 JSON 파싱 및 App.tsx 변환 확인. 네이티브 빌드·기기 실행을 뜻하지 않습니다.
- 버전 근거: 2026-11-03 확인한 [Expo SDK 공식 호환 표](https://docs.expo.dev/versions/latest/)와 [npm의 Expo 배포 메타데이터](https://registry.npmjs.org/expo/latest), [Expo WebView 공식 안내](https://docs.expo.dev/versions/latest/sdk/webview/). Expo 58.0.22 / React Native 0.88.1 / React 19.3.0 / WebView 14.0.1로 고정했습니다.
- API 근거: [React Native WebView 공식 Reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md).
- 미검증: Android/iOS 네이티브 실행, 실제 CLOVA 음성, 모델 렌더링, 전화·블루투스·백그라운드 오디오, 카메라·녹음·시선 분석 동시 실행, 30FPS·발열·배터리·장시간 메모리.

실제 지원 하한 기기를 정한 뒤 위 항목을 측정해야 합니다. WebView를 사용한다는 이유로 성능 또는 녹음·재생 공존이 보장된다고 표시하지 않습니다.

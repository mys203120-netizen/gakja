# Cubism 저작 도구 확인과 실제 자동화 범위

확인일: 2026-11-04, Asia/Seoul. 사용자가 승인한 현재 얼굴을 제작 기준으로 유지한다. 앞서 지적한 네 가지 외형 보정은 이번 작업의 선행 조건으로 다시 요구하지 않는다. 이 문서는 설치 상태와 공식 저작 경로 조사이며, 모델 제작 완료 보고가 아니다.

## 이 컴퓨터에서 확인한 범위

다음 경로의 최상위와 최대 하위 2단계에서 Live2D·Cubism 이름의 디렉터리, 실행·설치·압축 파일, 시작 메뉴 바로가기를 읽기 전용으로 확인했다.

- `C:\Program Files`
- `C:\Program Files (x86)`
- `C:\Users\MaYunsong\AppData\Local`, 특히 `Programs`
- `C:\Users\MaYunsong\AppData\Roaming`
- `C:\Users\MaYunsong\AppData\Roaming\Microsoft\Windows\Start Menu\Programs`
- `C:\ProgramData\Microsoft\Windows\Start Menu\Programs`
- `C:\Users\MaYunsong\Downloads`

HKCU·HKLM·WOW6432Node의 Windows Uninstall 등록 항목과 실행 중인 프로세스 이름도 확인했다. 위 범위에서 **Cubism Editor 설치 디렉터리·실행 파일·설치 파일·바로가기·설치 등록·실행 프로세스를 찾지 못했다.** Downloads에서 이름에 Live2D가 들어간 계획 문서는 있었지만 설치 파일은 아니었다. 접근할 수 없는 경로, 다른 드라이브, 더 깊은 사용자 지정 경로까지 모두 검색한 것은 아니므로 컴퓨터 전체에 절대로 설치되지 않았다고 단정하지 않는다.

이번 조사에서 프로그램 설치, 사용권 동의, 체험판 활성화, Core 다운로드, Editor 실행은 수행하지 않았다.

## 확보 가능한 공식 도구

공식 릴리스 이력에서 확인한 최신 정식 Editor는 **5.3.04(2026-09-03)**, 최신 베타 항목은 **5.3.05 beta1(2026-10-13)**이다. 다운로드 페이지의 버전 숫자가 동적으로 표시되어 웹 텍스트에 나오지 않으므로, 실제 설치 파일을 받을 때 해당 페이지의 정식 버전 표시와 파일명을 다시 대조해야 한다. [공식 릴리스 이력](https://docs.live2d.com/en/cubism-editor-manual/new-feature-introduction-title/), [5.3 변경 기록](https://docs.live2d.com/en/cubism-editor-manual/updates-history5-3/)

[공식 Editor 다운로드](https://www.live2d.com/en/cubism/download/editor/)에서 Windows를 선택하고, 다운로드 구분과 필요한 정보를 입력한 뒤 Software License Agreement·Privacy Policy를 확인하는 절차가 제공된다. 프로그램은 무료 모드와 PRO 체험판으로 시작할 수 있다. 공식 현재 안내의 PRO 체험 기간은 최초 활성화부터 **42일**이다. 이 문서는 체험판을 활성화하거나 구매하는 절차를 실행하지 않는다. [공식 실행·활성화 안내](https://docs.live2d.com/en/cubism-editor-manual/cubism-editor-activation/)

### 다운로드만 미리 받을 수 있는지 확인한 결과

공개 다운로드 페이지는 로그인하지 않고 조회할 수 있었다. 그러나 사용권 동의 전에는 공식 Windows 다운로드 버튼이 비활성화되는 구조를 확인했다. 페이지의 공식 `download.js`는 `document.forms.agreement.accept.checked`를 확인하고, 체크되지 않았으면 Windows·macOS·베타·이전 버전 다운로드 버튼을 비활성화한다. 최초 다운로드는 유효한 이메일 등 추가 입력도 확인한다. 즉, 파일 URL을 추측하거나 스크립트에서 직접 추출하여 요청하는 것은 이 공식 절차의 동의 단계를 우회하는 것이 된다. [공개 다운로드 페이지](https://www.live2d.com/en/cubism/download/editor/), [페이지가 사용하는 공식 다운로드 스크립트](https://cubism.live2d.com/editor/js/download.js)

따라서 이번 조사에서는 **설치 파일을 다운로드하지 않았고**, 그 파일의 SHA-256도 생성하지 않았다. 이미 다운로드했다거나 설치 준비 파일이 있다고 표시하지 않는다. 사용권 동의를 받기 전까지 준비해 둔 것은 공식 페이지·버전 근거·다운로드 조건·가져오기/내보내기 절차다. 다음 실제 다운로드의 지정 저장 위치는 `tools/live2d/downloads/`이며, 동의 후 파일을 확보하는 시점에 실제 파일명·공식 최종 URL·바이트 크기·SHA-256을 기록하면 된다. 설치 실행과 체험판 활성화는 다운로드와 별도 단계다.

FREE는 상시 무료지만 모델당 텍스처 1장·최대 2048px, ArtMesh 100개, 동작 파라미터 30개, 디포머 50개, 파츠 30개 등의 제한이 있다. 제한을 초과한 데이터는 저장할 수 없으므로 실제 PSD와 리깅 구성이 한도 안에 들어가는지 확인해야 한다. FREE의 상업 사용 조건도 사용 주체에 따라 달라진다. 이를 이유로 PRO가 반드시 필요하다고 미리 단정하거나 사용자의 사업 규모를 추정하지 않는다. [공식 FREE·PRO 비교](https://www.live2d.com/en/cubism/comparison/)

## PSD에서 모델로 넘어가는 실제 경로

공식 Editor는 PSD를 Modeling 화면에 끌어놓거나 File → Open으로 열어 새 모델을 만들 수 있다. 최하위 레이어가 ArtMesh로 변환되고 원래 캔버스에 배치된다. 가져온 직후의 메쉬는 최소 정점으로 구성되므로, PSD가 열렸다는 사실만으로 자연스러운 변형 메쉬나 리깅이 완성된 것은 아니다. [공식 PSD 가져오기](https://docs.live2d.com/en/cubism-editor-manual/psd-import/)

Editor의 Automatic Mesh generator는 선택한 ArtMesh에 정점 밀도 등의 설정을 적용한다. 공식 GUI 경로와 단축키 `Ctrl+Shift+A`가 제공된다. 메쉬 생성 다음에는 디포머 계층·파라미터 키폼·눈·입·머리·팔의 실제 변형을 만들고 검사해야 한다. 자동 메쉬가 얼굴 표정이나 한국어 입 모양을 자동 리깅한다는 뜻은 아니다. [공식 AutoMesh 안내](https://docs.live2d.com/en/cubism-editor-manual/mesh-edit/)

Cubism용 PSD는 RGB·8bit/channel과 실제 PSD 구조가 필요하다. 공식적으로 정상 동작을 확인한 제작 프로그램은 Photoshop과 CLIP STUDIO PAINT이며, 다른 도구로 작성한 PSD는 실제 Editor에서 가져오기·레이어 위치·알파·색·그룹을 확인해야 한다. 직접 작성한 진짜 레이어 PSD도 이 가져오기 검증 전에는 “Cubism 가져오기 검증 완료”로 표시하지 않는다. [공식 PSD 주의사항](https://docs.live2d.com/en/cubism-editor-manual/precautions-for-psd-data/)

가져오기와 리깅이 끝난 모델은 Editor에서 `.cmo3`로 저장한다. 애니메이션 편집 원본은 `.can3`다. 실행용 `.moc3`·`.model3.json`·텍스처는 텍스처 아틀라스를 준비한 뒤 File → Export embedded file → Export as MOC3 file로 내보낸다. MotionSync·물리 등의 설정은 해당 내보내기 옵션과 실제 모델 설정에 맞춰 함께 생성한다. [공식 파일 종류](https://docs.live2d.com/en/cubism-editor-manual/file-type-and-extension/), [공식 실행 에셋 내보내기](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/)

## 명령줄과 외부 API의 한계

공식 포럼의 직원 답변은 **2024년 11월에 `.cmo3` → `.moc3` 명령줄 내보내기를 지원하지 않는다고 명시**했다. 질문은 2024년 10월 게시물이다. 현재 공개 정식 외부 API 목록에도 PSD 가져오기·AutoMesh 실행·새 모델 직렬화·MOC3 내보내기를 수행하는 명령은 확인되지 않는다. 과거 답변을 현재 모든 내부 기능의 존재 여부에 대한 절대적인 증명으로 확대하지 않지만, 검증된 공식 CLI 저작 경로가 있다고 보고할 근거는 없다. [공식 포럼 직원 답변](https://community.live2d.com/discussion/comment/3837), [공식 외부 API 목록](https://docs.live2d.com/en/cubism-editor-manual/external-application-integration-api-list/)

정식 외부 API는 실행 중인 Editor와 WebSocket·UTF-8 JSON으로 통신하며 기본 포트는 22033이다. Editor에서 연결을 켜고 외부 앱을 허용한 뒤 기존 모델의 정보·파라미터 값을 조회하거나 설정할 수 있다. `NotifyMocFileExported`, `NotifyMotionFileExported`, `NotifyMotionSyncFileExported`는 **내보내기가 발생했을 때 받을 알림을 설정하는 기능**이며 내보내기 실행 명령이 아니다. Editor가 없으면 이 API만으로 저작 서버를 대신할 수 없다. [공식 외부 API 통신·인증](https://docs.live2d.com/en/cubism-editor-manual/external-application-integration-api/), [API 기능 목록](https://docs.live2d.com/en/cubism-editor-manual/external-application-integration-api-list/)

기존 파라미터 값을 외부에서 보내고 Editor의 애니메이션 타임라인 녹화 기능으로 키를 넣는 보조 자동화는 공식적으로 설명되어 있다. 따라서 모델이 먼저 리깅되어 있으면 반복 파라미터 검수나 모션 녹화를 돕는 경로는 있다. 새 눈·입 메쉬와 키폼을 처음부터 만들어 주는 API로 혼동하지 않는다. [외부 연동·타임라인 녹화](https://docs.live2d.com/en/cubism-editor-manual/external-application-integration/)

5.4 alpha의 공식 문서에는 파츠·디포머·파라미터 편집 API 확장이 소개되어 있다. 그러나 alpha2 문서의 사용 가능 기한은 **2026-10-18**이며 데이터와 동작 보장에도 별도 제한을 명시한다. 확인일인 2026-11-04에는 이 만료된 평가판을 현재 이용 가능한 정식 저작 경로로 가정할 수 없다. 향후 유효한 배포판과 해당 버전 API를 실제로 확보·검증할 때만 적용 범위를 다시 판정해야 한다. [공식 5.4 alpha2 문서](https://cubism.live2d.com/editor-alpha/doc/manual/alpha2/en/index.html)

## SDK만으로 가능한 것과 남는 작업

Cubism SDK의 공식 역할은 **Editor에서 만든 모델·애니메이션을 애플리케이션에서 표시하고 제어하는 것**이다. Web Framework의 `CubismMoc.create(mocBytes, ...)`도 기존 `.moc3` 바이트를 `Live2DCubismCore.Moc.fromArrayBuffer`로 읽어 런타임 객체를 만드는 함수다. 함수 이름의 `create`가 PSD에서 새로운 `.moc3`나 `.cmo3` 파일을 저작한다는 의미가 아니다. [SDK 공식 소개](https://www.live2d.com/en/sdk/about/), [공식 Web Framework MOC 로더](https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/model/cubismmoc.ts)

현재 실제로 수행 가능한 범위는 다음과 같다.

| 작업 | 현재 범위 |
|---|---|
| 승인 얼굴 기반 여성 원화·남녀 레이어 PSD 제작 | 이미지·레이어 작성 도구로 진행 가능. 실제 생성한 PSD 구조와 알파를 확인하고 Editor 가져오기는 별도 미검증으로 기록 |
| 좌표·피벗·레이어 순서·파라미터·모션 규격 작성 | 진행 가능. 실제 리깅된 ID와 예정 ID를 구분 |
| 실제 전용 `.cmo3` 저작 | 이 컴퓨터에서 실행 가능한 Editor를 찾지 못해 차단. SDK 빌드로 대체할 수 없음 |
| `.can3` 애니메이션 원본 제작 | 실제 모델과 Editor 애니메이션 작업 환경 필요 |
| 실제 `.moc3`·MotionSync 설정 내보내기 | 모델 저작·아틀라스·내보내기 가능한 Editor가 필요 |
| `.motion3.json`·`.exp3.json` 작성 | 실제 모델 ID·범위가 있으면 JSON을 생성할 수 있으나, 모델 없이 예정 ID만 넣은 파일은 검수된 전용 모션이 아님 |
| 기존 모델 파라미터 검수 자동화 | Editor와 허용된 외부 API가 준비되면 검토 가능. 현재 연결·실행 안 함 |
| 최종 눈·입·고개·손·합성·음성 검수 | 내보낸 전용 모델이 있어야 실제 검수 가능 |

실제 파일 형식의 PSD 제작, 예정 파라미터 설계, 웹용 런타임 작성은 계속할 수 있다. 그 산출물을 리깅 원본·실행 모델 제작 완료로 바꾸어 보고하지 않는다. 이 문서의 정확한 차단 사유는 **실행·내보내기할 수 있는 공식 저작 도구를 확인하지 못했고, 공식 SDK에 그 저작 경로가 제공된다는 근거도 없다는 것**이다.

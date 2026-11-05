# Live2D · CLOVA 연결 조사

확인일: 2026-11-03 (Asia/Seoul). 공개 공식 문서와 공식 소스의 조사 결과다. SDK 바이너리 실행, 전용 모델의 로드, 모바일 실행을 검증한 기록이 아니다.

## 확인한 제품과 버전

| 구성 | 확인 결과 | 적용 기준 |
|---|---|---|
| Cubism SDK for Web | 공식 변경 기록의 최신 정식 항목은 `5-r.5`, 2026-04-02 | 배포 패키지의 Core·Framework·Samples를 같은 릴리스로 확보 |
| Cubism SDK MotionSync Plugin for Web | 공식 변경 기록의 최신 정식 항목은 `5-r.3`, 2026-10-15. Web R5 변경 대응이 명시됨 | Web R5와 함께 검증할 후보 조합. 해당 조합의 로컬 실행은 아직 하지 않음 |
| Cubism Core | 전용 바이너리 구성 요소 | Web SDK 공식 패키지에서 확보. 공개 Framework 저장소만으로 대체하지 않음 |
| MotionSync Core | 공식 저장소에 포함되지 않음 | MotionSync Plugin 공식 배포 패키지에서 확보 |
| 모델 | Cubism Editor에서 제작·내보낸 실행 에셋 필요 | `.model3.json`, `.moc3`, 텍스처, 모델에 맞는 `.motionsync3.json` 필요 |

출처: [Web Samples 변경 기록](https://github.com/Live2D/CubismWebSamples/blob/develop/CHANGELOG.md), [Web Framework 변경 기록](https://github.com/Live2D/CubismWebFramework/blob/develop/CHANGELOG.md), [MotionSync 변경 기록](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/develop/CHANGELOG.md), [MotionSync README](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/develop/README.md).

공식 Web Framework R5에는 WebGL2 요구와 새 업데이트 순서 제어가 들어간다. 과거 WebGL1 예제나 구버전 Pixi 래퍼의 호환성을 가정하지 않는다. R5의 `CubismUpdateScheduler`와 Plugin R3의 `CubismMotionSyncUpdater`를 기준으로 입 파라미터 제어 순서를 설정하고 실제 모델에서 확인해야 한다. [Web Framework 변경 기록](https://github.com/Live2D/CubismWebFramework/blob/develop/CHANGELOG.md), [Plugin R3 변경 기록](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/CHANGELOG.md)

MotionSync 매뉴얼 첫 페이지에는 2023년 베타 설명이 남아 있다. 현재 버전 판정은 같은 페이지가 가리키는 공식 CHANGELOG와 릴리스 태그를 함께 확인했다. 문서의 과거 날짜만으로 최신 패키지가 베타라고 판단하지 않는다. [공식 MotionSync 매뉴얼](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-motionsync-plugin-for-web/)

## 실재 API와 오디오 경로

Plugin `5-r.3`의 `Framework/src/live2dcubismmotionsync.ts`에서 확인한 API는 다음과 같다.

```ts
CubismMotionSync.startUp(option);
CubismMotionSync.initialize();
CubismMotionSync.create(model, settingsBuffer, settingsBuffer.byteLength, sampleRate);
motionSync.setSoundBuffer(processIndex, samples, startIndex);
motionSync.updateParameters(model, deltaTimeSeconds);
motionSync.release();
CubismMotionSync.dispose();
CubismMotionSync.cleanUp();
```

위 코드는 API 목록이며 이 프로젝트에서 해당 SDK가 설치·실행되었다는 뜻이 아니다. `create`에는 실제 Cubism 모델과 Editor가 내보낸 설정이 필요하다. `setSoundBuffer`는 해당 태그에서 `Array<number>`를 받는다. 실제 연동 시 공급한 PCM의 샘플레이트, 시작 인덱스, 재생 위치를 일치시켜야 한다. [공식 API 구현](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/Framework/src/live2dcubismmotionsync.ts)

MotionSync는 분석 결과를 모델 파라미터에 직접 쓴다. 발화 중 입 파라미터는 MotionSync가 전담하고, 대기 모션·표정 모션은 그 파라미터를 덮어쓰지 않도록 모델과 업데이트 순서를 구성한다. 중단·무음·학생 답변에서는 해당 면접관의 입을 닫고, 재생 위치가 바뀌면 분석 시작 위치도 갱신해야 한다. 이는 공식 API를 장면 요구에 적용한 설계 판단이며 전용 모델 실측 결과가 아니다. [공식 API 구현](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/Framework/src/live2dcubismmotionsync.ts), [공식 모델 예제의 스케줄러 연결](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/Samples/TypeScript/Demo/src/lappmotionsyncmodel.ts)

Plugin R2부터 입력 PCM 공급 인터페이스가 분리되었다. 학생 마이크 예제를 그대로 활성화할 필요가 없다. 면접관 출력 음성만 디코딩하여 현재 발화자의 MotionSync에 전달하는 경로를 사용한다. 공식 파일 예제는 `LAppWavFileHandler`를 사용하므로 기존 MP3 주소를 WAV 파일인 것처럼 전달하면 안 된다. MP3를 유지한다면 브라우저에서 디코딩한 PCM을 별도 공급하고 실제 재생 위치와 연결해야 한다. MP3 디코딩 가능 여부와 WebView 오디오 동작은 기기별 검증 대상이다. [Plugin 변경 기록](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/develop/CHANGELOG.md), [공식 오디오 파일 예제](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/Samples/TypeScript/Demo/src/lappmotionsyncaudiomanager.ts)

## CLOVA Voice 연결과 기존 코드 점검

기존 `server/providers/clova-tts.ts`는 서버에서 `https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts`로 요청한다. Client ID·Secret을 서버 환경변수에서 읽는다. 현재 음성 설정은 `primary=vdaeseong`, `secondary=vmikyung`, 출력은 MP3다. 실제 계정 값이나 키는 조사하지 않았고 이번 조사에서 유료 API를 호출하지 않았다.

CLOVA TTS Premium의 공식 응답은 MP3 또는 WAV 음성 바이너리다. 표준 응답에 발음별 입 모양 타임라인이 있다고 가정하지 않는다. WAV 샘플레이트 옵션은 WAV 출력에만 적용된다. 실제 합성된 음성을 디코딩하여 MotionSync로 분석하는 경로가 필요하다. [TTS Premium API](https://api.ncloud-docs.com/docs/ai-naver-clovavoice-ttspremium), [인증·기본 URL](https://api.ncloud-docs.com/docs/ai-naver-clovavoice)

**기존 음성 영구 캐시는 정책 확인이 필요하다.** 현재 provider는 `SpeechAudioCache`와 `data/audio`에 생성 결과를 저장·재사용한다. 공개 이용 정책은 CLOVA Voice를 실시간 API 호출로 이용하고, 저장·편집·재사용이 필요하면 CLOVA Dubbing을 사용하도록 안내한다. 따라서 기존 캐시가 허용된다는 전제로 이번 장면의 운영을 승인할 수 없다. 별도 계약이 있다면 그 범위를 확인하고, 없다면 음성 저장·사전 생성·재사용 경로를 실시간 호출 방식으로 재설계해야 한다. 모델·텍스처 캐시는 생성 음성의 재사용과 별개다. 이 조사에서는 기존 파일을 삭제하거나 면접 엔진의 캐시 구조를 변경하지 않았다. [공식 이용 정책](https://guide.ncloud-docs.com/docs/clovavoice-policy), [공식 문제 해결 안내](https://guide.ncloud-docs.com/docs/en/clovavoice-troubleshoot)

## 라이선스와 획득 경로

SDK 개발 검증과 서비스 공개 라이선스는 구분한다. 공식 안내는 SDK 사용권 동의를 전제로 개발을 시작할 수 있다고 설명하며, 공개 시 사업자 규모와 용도에 따른 Release License를 별도로 규정한다. AI·챗봇 인터페이스의 분류와 Expandable Application 해당 여부도 확인 대상이다. 이 프로젝트의 매출·배포 형태·개별 계약이 제공되지 않았으므로 면제를 확정하지 않는다. [SDK Release License](https://www.live2d.com/en/sdk/license/)

MotionSync의 CRI Lipsync는 Live2D가 라이선스한 구성으로, 공식 매뉴얼은 별도 CRI 로열티와 로고 표시가 필요 없다고 설명한다. 이것이 Live2D 사용권·공개 라이선스까지 면제한다는 뜻은 아니다. 공개 소스, Core, 샘플 모델은 서로 다른 라이선스를 확인해야 한다. 샘플 `Kei` 모델을 전용 면접관 납품으로 사용할 수는 없다. [MotionSync 라이선스 설명](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-motionsync-plugin-for-web/), [공식 저장소 LICENSE](https://github.com/Live2D/CubismWebMotionSyncComponents/blob/5-r.3/LICENSE.md)

획득 순서:

1. [Web SDK 공식 다운로드](https://www.live2d.com/en/sdk/download/web/)에서 해당 사용권을 확인하고 Core 포함 배포 패키지를 받는다.
2. [MotionSync 공식 다운로드](https://www.live2d.com/en/sdk/download/motionsync/)에서 별도 MotionSync Core 포함 패키지를 받는다.
3. 버전·파일 해시·Editor 내보내기 대상 버전을 기록하고 같은 조합을 웹·WebView에서 검증한다.
4. 전용 면접관 원화·리깅을 Editor에서 제작하여 실행 에셋을 내보낸다. SDK는 사진에서 `.moc3`를 자동 생성하는 도구가 아니다.

다운로드 페이지는 사용권 동의를 요구한다. 이번 조사에서는 사용자를 대신해 사용권에 동의하거나 전용 Core 패키지를 받지 않았다. [Web SDK 다운로드 안내](https://www.live2d.com/en/sdk/download/web/), [MotionSync 다운로드 안내](https://www.live2d.com/en/sdk/download/motionsync/)

## 현재 차단·미검증 항목

| 항목 | 상태 | 정확한 사유 |
|---|---|---|
| 전용 Live2D 면접관 2인 실행 | 차단됨 | 조사 시점의 프로젝트 에셋 검색에서 전용 `.moc3`·`.model3.json`·MotionSync 설정을 찾지 못함 |
| 편집 원본 납품 | 차단됨 | 조사 시점의 프로젝트 검색에서 전용 PSD·`.cmo3`·`.can3`를 찾지 못함. 런타임 코드로 생성했다고 주장할 수 없음 |
| Core 실행 | 차단됨 | 제공받아 검증한 Cubism Core·MotionSync Core 패키지 없음 |
| Editor 제작 환경 | 미확인 | 표준 Program Files 두 경로에서 Live2D/Cubism 디렉터리를 찾지 못함. 다른 위치의 설치 유무까지 단정하지 않음 |
| 한국어 립싱크 정확도 | 미검증 | 전용 입 모양 리깅과 실제 CLOVA 출력의 합성 검수가 필요 |
| Expo WebView·30FPS·장시간 메모리·발열 | 미검증 | 실제 모바일 기기와 완성 모델·카메라·녹음·분석의 동시 실행을 측정하지 않음 |
| CLOVA 저장·재사용 허용 | 차단됨 | 공개 정책과 기존 영구 캐시가 충돌. 별도 계약 또는 저장·재사용 없는 경로 필요 |

SDK 소스의 존재, TypeScript 검사 통과, 정적 이미지 표시, 오디오 상태 테스트는 실제 전용 모델 제작·리깅·MotionSync 구동·모바일 검수 완료를 대신하지 않는다.

## 이번 작업에서 실제 추가한 SDK 연결 파일

- `scripts/setup-live2d-sdk.mjs`: 공식 Framework `5-r.5`·Plugin `5-r.3` 소스의 태그와 커밋을 검증하여 로컬 빌드한다. Core·전용 모델은 다운로드하지 않는다.
- `integrations/live2d/renderer.mjs`: 실제 공식 SDK 클래스를 이용한 모델·텍스처·레이어 렌더 어댑터와 출력 PCM의 MotionSync 연결 코드.
- `integrations/live2d/README.md`: 설치·에셋·어댑터 계약·모션 재생의 미구현 범위.
- `public/live2d/runtime/renderer.mjs`, `shaders/`, `licenses/`, `provenance.json`: 실제 생성한 번들·공식 셰이더·출처와 해시. 전용 Core와 모델은 포함하지 않는다.

2026-11-03에 수행한 확인은 JS 구문 검사와 실제 공식 소스 번들 생성이다. Core 없는 Node 환경에서 번들을 import하면 공식 Framework의 Core 상수 접근 때문에 `Live2DCubismCore is not defined`로 차단되는 것도 확인했다. 이는 Core 미제공의 확인이며 모델 실행 성공 테스트가 아니다. Core 스크립트는 동적 import 전에 로드해야 한다. 프로젝트의 기존 음성 URL이 `blob:`인 경우는 오디오 입력에 한해 같은 출처 blob을 지원한다. 실제 한국어 립싱크·무음 임계값·300초 제한·기기 성능은 전용 모델과 실제 출력으로 검수해야 한다.

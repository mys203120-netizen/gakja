# Live 면접 음성·아바타 통합 현황

2026-10-21. 기준 설계: `gakjaon-realtime-live2d-integration-plan.md`.

## 적용한 범위

- 기존 사람 비율의 클레이 3D PNG 5종을 유지한다. 사용자 선택에 따라 실제 Live2D 모델 구매·다운로드는 하지 않았다. 저장소에는 Cubism Core, `.moc3`, `.model3.json`, motion 자산이 없다.
- 질문 TTS와 RTC 출력은 같은 `HTMLAudioElement`와 출력 소유자를 사용한다. `MediaElementAudioSourceNode`를 요소당 한 번 만들고 destination에 연결하는 경로도 하나다. 마이크 입력을 입 모양에 사용하지 않는다.
- 실제 출력 파형에서 RMS를 계산하고 noise gate/attack/release를 적용한다. 매 프레임 수치는 React state를 거치지 않는 avatar signal에 전달한다. 현재 발화자만 출력 신호를 받으며 무음·일시정지·종료 시 0으로 돌아간다. 기존 PNG의 입 위치를 인물별로 측정하고 원본 입술 주변 텍스처만 canvas로 국소 합성해 벌어짐을 표현한다. 무음에는 canvas를 숨겨 원본을 그대로 표시하며, 눈·머리·의상과 PNG 파일은 바꾸지 않는다. 작은 출력 점은 제거했다.
- `idle/listening/thinking/speaking` 공통 인터페이스와 선택적 Live2D runtime 어댑터가 있다. 모델이 제공되면 runtime은 실제 Cubism ID handle과 파라미터 범위를 돌려줘야 한다. motion 업데이트 후 측정한 `ParamMouthOpenY`를 적용한다. runtime·모델·WebGL 오류는 PNG로 돌아가며 오디오를 소유하거나 종료하지 않는다.
- Safari에서 AudioContext가 `suspended` 또는 `interrupted` 상태가 되면 다음 명시적 시작 동작에서 같은 context를 재개한다.

## Realtime 연결과 답변 저장

서버 환경에 `REALTIME_INTERVIEW_ENABLED=true`를 설정하면 인증된 학생의 Live 면접에서 사용할 수 있다. 기본값은 꺼짐이며 OpenAI 서버 키가 있어야 한다. 프런트에 영구 API 키를 보내지 않는다. 별도 브라우저 플래그는 필요 없다.

1. 기존 서버가 만든 **현재 미응답 질문**으로 질문마다 짧은 RTC call을 만든다. 모델은 `gpt-realtime-2.1`, 음성은 `marin`이다. 로컬 SDK 6.49.0에 `calls.create`가 없어 공식 multipart calls API를 서버에서 호출한다.
2. 학생 활성 상태·학교 자료 접근·소유 session/turn·generation·새 attempt·paused/processing·타이머 lease를 검사한다. provider 협상 후 다시 검사한다. 동일 generation의 pause→resume도 `activeSince`가 바뀌면 거절한다. 같은 attempt 재사용 및 분당 6회 초과는 과금 요청 전에 막는다. 기존 일일 AI 한도도 적용한다.
3. 서버가 승인한 한 질문을 읽는 `response.create`만 한 번 보낸다. `conversation:none`, `input:[]`, tools 없음, 자동 response 생성·interrupt 꺼짐으로 다음 질문의 작성 주체는 기존 면접 서버에 남긴다.
4. provider response ID와 앱 session/turn/generation/attempt/question digest metadata를 대조한다. 중복 event ID는 무시한다. 질문 전사가 승인한 문장과 일치하고 `response.done=completed`와 **실제 `output_audio_buffer.stopped`**가 모두 확인되어야 답변 녹음으로 이동한다.
5. RTC에는 원래 마이크 track의 **clone**만 연결한다. 질문을 듣는 동안 clone은 비활성이다. 기존 durable recorder가 실제로 capture를 시작할 때 clone을 활성화한다. RTC 입력 전사는 화면의 미리보기 자막으로만 사용한다.
6. 기존 recorder 원본 → 기기 recovery writer → 업로드 영수증 → 기존 STT/문장 정리 → `answer_recording` 계약을 유지한다. RTC 자막이 답변·준비 현황·리포트·다음 질문을 직접 생성하지 않는다. 퀴즈 전용 RTC 전사 API를 호출하지 않는다.
7. RTC 실패 시 같은 승인 질문을 기존 TTS로 들려주며 해당 방의 RTC 경로를 끈다. 연결 실패 후에도 원래 recorder track은 RTC가 종료하지 않는다. late/old response는 현재 질문으로 승격하지 않는다.
8. 일시정지·화면 이탈·종료·동의 변경은 local clone/channel/peer를 닫고 owned call DELETE를 보낸다. 종료 중인 연결을 학생별로 보관하므로 먼저 일시정지한 뒤 로그아웃해도 종료 확인을 기다린다. 두 차례 remote hangup 실패는 로그아웃을 막고 재시도할 수 있다. 답변 저장 실패도 기존대로 로그아웃을 막는다.

단일 call lease는 최대 4분이다. 앱 heartbeat는 8초마다 현재 질문/소유권/lease를 다시 검사한다. 답변 종료 후 마지막 자막은 최대 1.8초 수집하고 연결을 닫는다. 이 자막 지연은 durable 녹음 저장을 대신하거나 지연시키지 않는다.

## 서버의 orphan 정리

- persistent Node Next 서버는 `src/instrumentation.ts`에서 unref singleton 작업을 시작한다. 시작 직후 및 매 60초마다 4분을 넘긴 `interview_realtime` connected 기록을 찾아 서버에 저장된 call ID만 hangup한다. 이전 실행이 끝나기 전 중복 실행하지 않는다. 일시적 실패는 다음 주기에 재시도한다. 사용자 요청이 없어도 실행된다.
- 프로세스가 내려가거나 serverless 인스턴스가 정지된 동안에는 해당 메모리 timer가 실행될 수 없다. **serverless 운영에서는 배포 플랫폼의 외부 작업 실행기에 아래 명령을 매분 등록해야 한다.** 이 작업에서 외부 자동화는 생성하지 않았다.

```sh
node scripts/cleanup-interview-realtime.mjs
```

명령은 서버 환경변수 또는 프로젝트 `.env.local`/`.env`를 사용한다. 한 번에 100건까지 처리하고 수치만 출력한다. API 키, 학생 정보, call ID를 출력하지 않는다. provider 오류는 connected 상태로 남겨 다음 실행에서 재시도한다. 여러 인스턴스가 같은 call을 정리해도 hangup 404/409를 종료된 것으로 처리한다.

## 나중에 실제 Live2D 자산을 연결할 때

```dotenv
NEXT_PUBLIC_LIVE2D_ENABLED=true
NEXT_PUBLIC_LIVE2D_RUNTIME_URL=/licensed-live2d/runtime.js
NEXT_PUBLIC_LIVE2D_MODEL_A=/licensed-live2d/a/model.model3.json
NEXT_PUBLIC_LIVE2D_MODEL_B=/licensed-live2d/b/model.model3.json
# C, D, E도 동일한 형식
```

사용 권한이 확인된 모델/텍스처/moc3/motion 파일과 브라우저 runtime bridge가 필요하다. runtime은 `window.gakjaLive2D.mount(canvas, modelUrl, signal)` 계약을 구현한다. 현재 runtime/모델이 없으므로 이 플래그는 켜지 않는다. 현재 입 움직임은 PNG 텍스처를 사용하는 2D canvas 합성이며, 실제 Cubism 모델 로딩·눈깜박임·고개 motion을 구현 완료나 실기기 검증 완료로 주장하지 않는다.

## 검증 기록

- 직접 관련 자동 회귀 86개 통과: 출력 RMS/단일 graph/중단 복귀, 고정 얼굴 5종·국소 입 합성·무음 원본 복귀, Live 설정·녹음 recovery·로그아웃·Enter 전송 설정, RTC 서버 scope·중복·쿼터·lease·변경 경합, 클라이언트 출력 drain·전사 일치·입력 clone·종료 영수증, 주기 정리와 운영 명령. 앱 TypeScript 검사 통과.
- **실제 provider 1회**: `gpt-realtime-2.1` calls HTTP 201, 한국어 승인 질문 정확 전사, response metadata 일치, RTP 271개/32,855 bytes, 실제 buffer stopped, remote hangup 200. 격리된 Node/werift recvonly 검사로 사용자 마이크 입력 없음. 증거 `.local/rtc-smoke/result-1.json`.
- **실제 앱 인증·DB 경유 1회**: fixture 학생 로그인 → 소유 지원처의 video 방 → resume → `/api/interviews/realtime` 200 → 앱이 돌려준 responseEvent 1회 → 실제 `RealtimeInterviewEvents.accept`의 played 확인 → DELETE 200 → usage completed → 면접 suspend/DB paused. RTP 452개/50,371 bytes. 잘못된 generation 409 및 다른 attempt DELETE 404도 추가 과금 없이 확인. 증거 `.local/rtc-smoke/app-result-1.json`.
- 실제 학생 마이크의 양방향 음성·카메라 녹화, 물리 iPhone Safari의 잠금/복귀/자동재생, 실제 Live2D render는 이번 환경에서 실기기 검증하지 않았다. 브라우저 clone 활성화와 기존 녹음 저장 연결은 자동 통합 테스트 범위다. 사용자의 하린 계정으로 녹음하거나 훈련 기록을 만들지 않았다.

### 기존 인물의 실제 입 움직임 브라우저 확인

2026-10-21 추가 검증. 계정·마이크·DB 저장 없이 실제 `LiveInterviewerStage`/`Interviewer`/`InterviewerAudioOutput`과 로컬 한국어 WAV를 연결한 임시 화면으로 확인했다. 데스크톱 확대 화면과 모바일 390px에서 원본 인물 5종의 입 경계가 맞고, 발화자만 움직이는 것을 확인했다.

- A 실제 출력 파형에서 입 값 0.45, B에서 0.8을 확인했다. B가 발화할 때 A/C/D/E는 값 0이고 canvas가 숨겨졌다.
- C: 양수 프레임 732개, peak 0.995. D: 855개, peak 0.997. E: 1,022개, peak 0.994. 같은 재생에서 나머지 네 인물의 양수 프레임은 모두 0이었다. 이는 수동 최대열림 버튼과 구분하여 `actual-output-rms`로 누적한 값이다.
- 재생 종료 및 정지 후 모든 mouth canvas의 `hidden=true`, 입 값 0으로 복귀했다. 콘솔 오류 없이 반복 재생과 발화자 전환을 확인했다.
- 확대 화면을 눈으로 확인했으며 얼굴·의상은 원본을 유지하고, 입 주변의 사각 패치 경계나 배경 이동은 보이지 않았다. 원본 PNG는 수정하지 않았다.

증거는 Git에 포함하지 않는 `.local/interaction-polish-2026-10-21/`의 `mouth-speaking-a.png`~`mouth-speaking-e.png`, `mouth-c-proof.json`, `mouth-d-proof.json`, `mouth-e-proof.json`, `mouth-stopped.png`에 남겼다. 임시 QA route와 공개 WAV는 검증 후 삭제했다. 이 추가 검증은 **실제 브라우저의 앱 음성 출력 → RMS → 인물 입 렌더링** 범위이며, 실시간 AI 면접·학생 마이크 입력을 새로 수행한 검증으로 간주하지 않는다.

## 확인한 공식 자료

- [OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime)
- [Realtime calls API](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)
- [gpt-realtime-2.1 모델](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime conversations / 수동 응답 제어](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Live2D Web 음성 lip sync](https://docs.live2d.com/en/cubism-sdk-tutorials/native-lipsync-from-wav-web/)
- [Live2D 파라미터](https://docs.live2d.com/en/cubism-sdk-manual/parameters/)
- [Web Audio 파형 분석](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData)
- [Safari interrupted AudioContext 재개](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari)

Next instrumentation 구현은 설치된 Next의 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`를 확인했다.

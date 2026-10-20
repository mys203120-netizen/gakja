# Live 면접 음성·아바타 통합 현황

2026-10-21. 기준 설계: `gakjaon-realtime-live2d-integration-plan.md`.

## 적용한 범위

- 기존 사람 비율의 클레이 3D PNG 5종을 유지한다. 사용자 선택에 따라 실제 Live2D 모델 구매·다운로드는 하지 않았다. 저장소에는 Cubism Core, `.moc3`, `.model3.json`, motion 자산이 없다.
- 질문 TTS와 RTC 출력은 같은 `HTMLAudioElement`와 출력 소유자를 사용한다. `MediaElementAudioSourceNode`를 요소당 한 번 만들고 destination에 연결하는 경로도 하나다. 마이크 입력을 입 모양에 사용하지 않는다.
- 실제 출력 파형에서 RMS를 계산하고 noise gate/attack/release를 적용한다. 매 프레임 수치는 React state를 거치지 않는 avatar signal에 전달한다. 현재 발화자만 출력 신호를 받으며 무음·일시정지·종료 시 0으로 돌아간다. 기존 PNG의 입 위치를 인물별로 측정하고 원본 입술 주변 텍스처만 canvas로 국소 합성해 벌어짐을 표현한다. 무음에는 mouth canvas를 숨겨 원본을 그대로 표시한다. PNG 파일 자체와 인물의 정체성·의상은 유지한다.
- PNG 대체 렌더러도 상태에 따라 실제 동작한다. 듣기는 작은 끄덕임, 생각하기는 작은 기울임·시선 이동, 활동 중에는 인물별 시차를 둔 눈깜박임을 원본 눈 영역에 합성한다. 입은 이 타이머에 연결하지 않는다. idle과 동작 줄이기 설정에서는 눈·고개 동작을 멈추며, idle의 지속 rAF도 중지한다.
- `idle/listening/thinking/speaking` 공통 인터페이스와 선택적 Live2D runtime 어댑터가 있다. 모델이 제공되면 runtime은 실제 Cubism ID handle과 파라미터 범위를 돌려줘야 한다. motion 업데이트 후 측정한 `ParamMouthOpenY`를 적용한다. runtime·모델·WebGL 오류는 PNG로 돌아가며 오디오를 소유하거나 종료하지 않는다.
- Safari에서 AudioContext가 `suspended` 또는 `interrupted` 상태가 되면 다음 명시적 시작 동작에서 같은 context를 재개한다.

## Realtime 연결과 답변 저장

서버 환경에 `REALTIME_INTERVIEW_ENABLED=true`를 설정하면 인증된 학생의 Live 면접에서 사용할 수 있다. 기본값은 꺼짐이며 OpenAI 서버 키가 있어야 한다. 프런트에 영구 API 키를 보내지 않는다. 별도 브라우저 플래그는 필요 없다.

1. 기존 서버가 만든 **현재 미응답 질문**으로 질문마다 짧은 RTC call을 만든다. 모델은 `gpt-realtime-2.1`, 음성은 `marin`이다. 로컬 SDK 6.49.0에 `calls.create`가 없어 공식 multipart calls API를 서버에서 호출한다.
2. 학생 활성 상태·학교 자료 접근·소유 session/turn·generation·새 attempt·paused/processing·타이머 lease를 검사한다. provider 협상 후 다시 검사한다. 동일 generation의 pause→resume도 `activeSince`가 바뀌면 거절한다. 같은 attempt 재사용 및 분당 6회 초과는 과금 요청 전에 막는다. 기존 일일 AI 한도도 적용한다.
3. 서버가 승인한 한 질문의 낭독은 `conversation:none`, `input:[]`로 한 번 요청한다. tools와 자동 response 생성은 끄고 server VAD의 interrupt는 켠다. 학생의 명시적 반복·질문 의미 확인·잠시 기다려 달라는 요청에는 같은 서버가 제공한 제한된 clarification 응답 계약으로 실제 provider 음성을 요청한다. 현재 질문을 반복하거나 표현을 설명하는 짧은 응답만 허용하며, 답안 내용·힌트·평가·새 꼬리질문은 금지한다. 학생이 통상적인 답변을 하는 중에는 자동 맞장구나 답안 도움을 내지 않는다. 한 call에서 최대 6회이며 다음 질문 작성 주체는 기존 면접 서버다.
4. provider response ID와 앱 session/turn/generation/attempt/question digest metadata를 대조한다. 중복 event ID와 동일 입력 item의 반복 완료 이벤트를 무시한다. 정상 낭독은 전사가 승인 문장과 일치하고 `response.done=completed`와 **실제 `output_audio_buffer.stopped`**를 모두 확인한다. 학생의 VAD speech_started로 낭독을 끊으면 cancel과 output clear를 보내고 같은 turn에서 듣기로 이동한다. 이 취소는 RTC 오류나 질문 재생 실패로 처리하지 않는다.
5. RTC에는 원래 마이크 track의 **clone**만 연결한다. 끼어들기를 허용하는 RTC 경로는 기기 recovery writer와 durable recorder를 먼저 시작한 뒤 질문을 재생하고 clone을 활성화한다. 따라서 질문 중 학생 발화도 같은 녹음 시도에 남는다. 질문·응답 출력 중에는 무음 자동 종료를 보류한다. RTC 입력 전사는 미리보기 및 현재 질문 내 대화 요청에만 사용한다.
6. 기존 recorder 원본 → 기기 recovery writer → 업로드 영수증 → 기존 STT/문장 정리 → `answer_recording` 계약을 유지한다. RTC 자막이 답변·준비 현황·리포트·다음 질문을 직접 생성하지 않는다. 퀴즈 전용 RTC 전사 API를 호출하지 않는다.
7. RTC 실패 시 같은 승인 질문을 기존 TTS로 들려주며 해당 방의 RTC 경로를 끈다. 연결 실패 후에도 원래 recorder track은 RTC가 종료하지 않는다. late/old response는 현재 질문으로 승격하지 않는다.
8. 일시정지·화면 이탈·종료·동의 변경은 local clone/channel/peer를 닫고 owned call DELETE를 보낸다. 종료 중인 연결을 학생별로 보관하므로 먼저 일시정지한 뒤 로그아웃해도 종료 확인을 기다린다. 두 차례 remote hangup 실패는 로그아웃을 막고 재시도할 수 있다. 답변 저장 실패도 기존대로 로그아웃을 막는다.

단일 call lease는 최대 4분이다. 앱 heartbeat는 8초마다 현재 질문/소유권/lease를 다시 검사한다. 답변 종료에서는 clone을 비활성화하고 server VAD 자동 commit과 마지막 자막을 최대 1.8초 기다린다. 별도 `input_audio_buffer.commit`을 다시 보내지 않는다. 이미 VAD commit을 확인한 종료 중의 빈 버퍼 오류만 무시하며, 다른 오류는 기존 복구 경로로 처리한다. 이 자막 지연은 durable 녹음 저장을 대신하거나 지연시키지 않는다.

## 발급·정리 및 사용량 계측 계약

- provider Location의 call ID를 받은 즉시, SDP 본문 읽기·취소 확인 전에 소유 usage row에 `issued`로 기록한다. scope를 재검증하고 서버 sideband를 시작한 뒤 SDP를 반환한다. 브라우저가 SDP를 적용하고 채널을 연 뒤 heartbeat의 `accountingReady`를 확인해야만 질문 생성을 요청할 수 있다. sideband 준비를 SDP 반환 전에 기다려 생기는 협상 교착을 피한다. 준비 실패 시 같은 질문의 기존 TTS로 돌아가고 durable 마이크는 유지한다.
- 원격 종료 전에 `cleanup_pending`을 기록한다. 취소/협상 오류/종료 실패 시 call ID를 지우거나 `failed`로 덮어쓰지 않는다. hangup 성공 또는 404/409 확인 후에만 `completed`로 바꾼다. 이전 버전의 call ID가 있는 `failed` 기록도 만료 정리 대상이다.
- `202610210004_realtime_interview_accounting.sql`이 필요하다. 영구 키를 브라우저로 넘기지 않는 OpenAI SDK `OpenAIRealtimeWS({callID})`와 명시적인 Node `ws` 의존성으로 Authorization 헤더를 쓰는 sideband를 연결한다. provider `response.done` 및 전사 완료 usage를 수집한다. `(usage_id,response_id)` 고유키와 단일 SQL 문으로 이벤트 중복을 제거하고 토큰 합계를 증가시킨다. 전사 usage는 별도 `transcription:item_id` 식별자로 구분한다. 브라우저 제출 토큰 수나 자막 길이로 사용량을 계산하지 않는다.
- SDK의 error emitter에는 연결 장애와 복구 가능한 provider 오류가 모두 들어온다. VAD가 먼저 취소한 응답에 대한 `response_cancel_not_active` 같은 client-event 오류로 관측 채널을 닫지 않는다. 열린 연결의 provider 오류 뒤에도 사용량 수집을 이어가며, 실제 소켓 실패·닫힘에만 관측을 종료한다.
- provider가 보고한 입력/출력·오디오·캐시 토큰을 원본별로 보관한다. 최종 session usage가 온 경우에만 finalization을 complete로 기록하며, 단절·누락 시 incomplete로 남긴다. 부분 usage는 0원 또는 완전한 사용량으로 표시하지 않는다.
- 서버의 발급 시점부터 종료 확인까지 `observed_call_ms`를 저장한다. 이는 서버가 관측한 연결 수명이며 실제 음성 발화 시간이나 provider 청구 시간을 확정하는 값이 아니다. 금액은 임의 환산하지 않는다. 연결 횟수 제한과 이 계측은 별개다.

## 서버의 orphan 정리

- persistent Node Next 서버는 `src/instrumentation.ts`에서 unref singleton 작업을 시작한다. 시작 직후 및 매 60초마다 cleanup_pending과 4분을 넘긴 connected/issued/failed 기록을 찾아 서버에 저장된 call ID만 hangup한다. 이전 실행이 끝나기 전 중복 실행하지 않는다. 일시적 실패는 다음 주기에 재시도한다. 사용자 요청이 없어도 실행된다.
- 프로세스가 내려가거나 serverless 인스턴스가 정지된 동안에는 해당 메모리 timer가 실행될 수 없다. **serverless 운영에서는 배포 플랫폼의 외부 작업 실행기에 아래 명령을 매분 등록해야 한다.** 이 작업에서 외부 자동화는 생성하지 않았다.

```sh
node scripts/cleanup-interview-realtime.mjs
```

명령은 서버 환경변수 또는 프로젝트 `.env.local`/`.env`를 사용한다. 한 번에 100건까지 처리하고 수치만 출력한다. API 키, 학생 정보, call ID를 출력하지 않는다. provider 오류는 cleanup_pending 상태로 남겨 다음 실행에서 재시도한다. 여러 인스턴스가 같은 call을 정리해도 hangup 404/409를 종료된 것으로 처리한다. usage 합계는 종료 상태 변경으로 초기화하지 않는다.

## 나중에 실제 Live2D 자산을 연결할 때

```dotenv
NEXT_PUBLIC_LIVE2D_ENABLED=true
NEXT_PUBLIC_LIVE2D_RUNTIME_URL=/licensed-live2d/runtime.js
NEXT_PUBLIC_LIVE2D_MODEL_A=/licensed-live2d/a/model.model3.json
NEXT_PUBLIC_LIVE2D_MODEL_B=/licensed-live2d/b/model.model3.json
# C, D, E도 동일한 형식
```

사용 권한이 확인된 모델/텍스처/moc3/motion 파일과 브라우저 runtime bridge가 필요하다. runtime은 `window.gakjaLive2D.mount(canvas, modelUrl, signal)` 계약을 구현한다. 현재 runtime/모델이 없으므로 이 플래그는 켜지 않는다. 현재 입·눈 움직임은 PNG 텍스처의 2D canvas 합성이고 고개 동작은 작은 이미지 pose 변형이다. 실제 Cubism 모델 로딩·Cubism motion·실기기 검증 완료로 주장하지 않는다.

## 검증 기록

2026-10-21 추가 회귀: 협상 취소와 hangup 실패가 겹친 경우의 issued/cleanup_pending/재정리, 이전 failed call 정리, VAD 자동 commit 뒤 정상 종료·빈 버퍼 오류 범위, 질문 및 clarification 끼어들기, provider 음성 응답의 turn/입력 item 한정, 동일 전사 완료 중복, durable 녹음 선행·단일 제출, 서버 sideband usage 중복 제거·최종 누락 표시, 5종 상태별 눈·고개 동작과 reduced-motion을 자동 검사한다. 아래 실제 provider·브라우저 기록은 이전 구현의 범위이며 새 양방향 기능의 물리 마이크 검증으로 간주하지 않는다.

### 새 양방향 경로의 실제 provider 확인

최대 3회로 제한한 격리 점검에서 첫 시도는 sideband 협상 순서, 두 번째는 VAD 취소 경합 뒤 관측 종료 문제를 드러냈으며 각각 수정했다. 마지막 시도는 실제 `startInterviewRealtime`/heartbeat/close 서버 함수, 로컬 PostgreSQL의 임시 소유 학생·session·turn, werift WebRTC와 OS가 만든 합성 한국어 WAV를 사용해 통과했다. 기존 3100/3117 서버 환경과 하린 계정은 변경하지 않았다.

- 승인 질문 재생 중 합성 음성을 보내 실제 server VAD speech_started와 질문 취소를 확인했다. 수동 commit 없이 자동 확정됐고, 전사 `질문의 뜻을 다시 설명해 주세요.`를 production 요청 분류기가 인식했다.
- 같은 turn의 clarification metadata로 실제 provider 음성 응답과 buffer drain을 확인했다. 실제 응답은 짧은 대기 안내였으며, 새 질문·답안 도움을 만들지 않았다. 이후 지침은 명시적인 반복·뜻 확인 요청이 함께 있으면 단순 대기 안내보다 먼저 처리하도록 보강했다.
- RTP 549개, provider call 201, 원격 hangup 200을 확인했다. 서버 sideband는 중복 제거된 usage 이벤트 4개와 입력 369·출력 417 토큰을 DB에 남겼다. 최종 session usage 이벤트가 없었으므로 finalization은 `incomplete`로 유지했다. 금액으로 임의 환산하지 않았다.
- 사용량 SQL의 별도 PostgreSQL 회귀에서는 동일 완료 이벤트 5회가 한 번만 증가하고, 전사 usage가 별도 집계되며 cleanup_pending/completed 전환으로 토큰이 초기화되지 않음을 확인했다.
- 임시 학생·면접·사용량 행은 원격 종료 확인 후 삭제했다. 실제 학생의 마이크, 모바일 잠금 복귀, 카메라 녹화는 이 검증에 포함하지 않았다. durable 녹음·중복 제출·fallback 연동은 별도의 자동 통합 회귀로 검증했다.

로컬 증거는 Git에 넣지 않는 `.local/rtc-smoke/current-server-result.json`이며, 실패 재현 요약은 `current-server-first-result.json`과 `current-server-second-result.json`에 남긴다. 영구 키·SDP·call ID·사용자 녹음은 출력하지 않았다.

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

## 2026-10-21 진단·종료·입 출력 회귀 보강

- 첫 진단은 질문과 글 답변을 먼저 보여주며 음성으로 전환할 수 있다. 면접관 무대는 실전 Live에만 표시한다. 음성·글 모두 기존의 같은 질문/활동/지원처 근거 저장 경로를 사용한다.
- 면접 방 종료와 차시 전체 응답을 구분한다. 고정된 `questionQueue`가 비어 있거나 중복되거나, 한 root라도 유효한 제출 답변이 없으면 진단·혼합 차시를 완료로 표시하지 않는다. 초안·공백·무효 답변·꼬리질문만의 답변은 누락된 본질문을 대신하지 못한다. 답변의 짧음만으로 실력 점수나 준비 완료를 추정하지 않는다.
- 저장 후 종료는 원본/답변의 DB 저장 영수증을 확보한 뒤 응답하고 AI 리포트는 Next `after`에서 정리한다. 실패하거나 60초 넘게 중단된 피드백은 소유한 리포트에서 다시 요청할 수 있다. 최근 실행의 중복 요청은 차단하며, 이전 리포트 revision/실행의 늦은 결과는 새 기록을 덮지 못한다.
- 실제 Chromium에서 파일 오디오는 입이 움직였으나 RTC 형태의 `srcObject` MediaStream은 기존 MediaElementAudioSource 분석값이 계속 0인 문제를 재현했다. RTC는 MediaStreamAudioSource로 관찰하고, 관찰 노드는 출력 destination에 연결하지 않아 중복 재생을 만들지 않는다. UI 단계나 늦은 자막은 실제 재생 중인 발화 상태를 덮지 않는다.
- `node tests/interviewer-output-browser.mjs`는 실제 오디오 요소→RMS→기존 PNG 캔버스 픽셀 변화를 검증했다. 최종 로컬 검증에서 파일 오디오 184프레임 중 118프레임, RTC 형태 MediaStream 44프레임에 입 움직임을 측정했고, 비발화자는 0, 재생 종료 후 입 값도 0이었다. 마이크·사용자 계정·외부 AI 호출은 사용하지 않았다. 실제 모바일 기기의 권한/출력 조건을 새로 검증한 결과는 아니다.

## 확인한 공식 자료

- [OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime)
- [Realtime calls API](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)
- [gpt-realtime-2.1 모델](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Realtime conversations / 수동 응답 제어](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime VAD 자동 확정·끼어들기](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Realtime client events / 빈 버퍼 commit](https://developers.openai.com/api/reference/resources/realtime/client-events)
- [WebRTC 서버 sideband 제어와 사용량 수집](https://developers.openai.com/api/docs/guides/realtime-server-controls)
- [Live2D Web 음성 lip sync](https://docs.live2d.com/en/cubism-sdk-tutorials/native-lipsync-from-wav-web/)
- [Live2D 파라미터](https://docs.live2d.com/en/cubism-sdk-manual/parameters/)
- [Web Audio 파형 분석](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData)
- [Safari interrupted AudioContext 재개](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state#resuming_interrupted_play_states_in_ios_safari)

Next instrumentation 구현은 설치된 Next의 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`를 확인했다.

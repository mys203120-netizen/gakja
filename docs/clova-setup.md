# CLOVA 연결 값 발급 안내

공식 문서 확인일: 2026-11-02. 실제 계정의 이용 권한·플랜·할당량은 키를 넣은 후 호출해 확인해야 합니다. 이번 작업에서 클라우드 계정을 만들거나 유료 상품을 신청하지 않았습니다.

현재 콘솔에 **장문 인식 / 단문 인식 / 스트리밍 인식** 도메인 생성 메뉴가 각각 보이면, 이 앱에는 **스트리밍 인식 도메인**을 생성합니다. 실시간으로 마이크 PCM을 보내는 gRPC 방식이며, 현재 공식 스트리밍 빌더도 같은 gRPC API와 `semanticEpd` 설정을 안내합니다. [스트리밍 인식 빌더](https://guide.ncloud-docs.com/docs/clovaspeech-builder-streaming), [지원 음성 형식](https://guide.ncloud-docs.com/docs/clovaspeech-spec)

| 생성 항목 | 이번 앱에 사용할 값 |
|---|---|
| 도메인 유형 | **스트리밍 인식** |
| 인식 언어 | 언어 선택 항목이 있으면 **한국어**. 앱의 요청값은 `transcription.language=ko` |
| 플랜 | 플랜 선택 항목이 있으면 **Basic**. Free는 실시간 gRPC 미지원 |
| 파파고 번역 | **선택하지 않음**. 한국어 답변을 한국어로 전사하므로 추가 번역 기능 불필요 |
| 저장 위치 | 도메인 생성 화면에서 요구하는 Object Storage 버킷·결과 저장 경로를 설정. 입력 저장 경로도 표시되면 함께 지정 |

도메인 유형은 생성 후 변경할 수 없다는 공식 안내가 있습니다. [도메인 생성·추가 기능](https://guide.ncloud-docs.com/docs/clovaspeech-domain), [gRPC 언어·인증 명세](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc)

| 프로젝트 변수 | 어디서 확인/발급하는가 | 실제 API에 쓰는 곳 |
|---|---|---|
| `CLOVA_SPEECH_SECRET_KEY` | NAVER Cloud 콘솔 → Menu → All Services → AI Services → CLOVA Speech → **스트리밍 인식 유형의 Domain** → 해당 도메인의 **빌더 실행** → 설정 → **연동 정보** → Secret Key 생성/복사 | gRPC 메타데이터 `authorization: Bearer <Secret Key>` |
| `CLOVA_SPEECH_DOMAIN_ID` | 같은 도메인의 식별 정보에서 실제 Domain ID 확인. 화면에 이름/코드만 있고 ID가 없으면 발급 계정 담당자 또는 NAVER Cloud 지원에 확인 | 현재 recognize 스트림에서는 사용하지 않음. 공식 `active-calls` 진단 API의 `/api/v1/{domainId}/active-calls` 식별자용 |
| `CLOVA_SPEECH_GRPC_HOST` | 발급받는 값 아님 | 공식 기본값 `clovaspeech-gw.ncloud.com` |
| `CLOVA_SPEECH_GRPC_PORT` | 발급받는 값 아님 | TLS 포트 `50051` |
| `CLOVA_VOICE_CLIENT_ID` | 콘솔 → Menu → All Services → AI·NAVER API → AI·NAVER API → **Application 등록** → 서비스 **CLOVA Voice - Premium** 선택 → 등록한 Application의 **인증 정보** | `X-NCP-APIGW-API-KEY-ID` 헤더 |
| `CLOVA_VOICE_CLIENT_SECRET` | 위와 **같은 Application의 인증 정보** → Client Secret 복사/재발급 | `X-NCP-APIGW-API-KEY` 헤더 |
| `CLOVA_VOICE_SPEAKER` | 키 발급 대상 아님. 공식 Voice Premium 목소리 목록에서 선택 | 기본 `vdaeseong` — 대성(Pro), 한국어 남성 |
| `CLOVA_VOICE_SECOND_SPEAKER` | 키 발급 대상 아님. 공식 Voice Premium 목소리 목록에서 선택 | 기본 `vmikyung` — 미경(Pro), 한국어 여성 |
| `CLOVA_VOICE_PRIMARY_SPEED` | 발급받는 값 아님. 정수 `-5~10` | 주 면접관 기본 `0`. 공통 `CLOVA_VOICE_SPEED`보다 우선 |
| `CLOVA_VOICE_SECOND_SPEED` | 발급받는 값 아님. 정수 `-5~10` | 보조 면접관 기본 `-1`. 공통 `CLOVA_VOICE_SPEED`보다 우선 |
| `CLOVA_VOICE_SPEED` | 발급받는 값 아님. 정수 `-5~10` | 역할별 값이 없을 때 사용하는 기존 공통 설정. 모두 미설정이면 주 `0`·보조 `-1` |
| `CLOVA_VOICE_PITCH` | 발급받는 값 아님. 정수 `-5~5` | 기본 `1`. 양수 방향이 낮은 음높이 |

STT 도메인 Secret과 TTS Application의 Client Secret은 서로 다른 값입니다. 일반 NAVER Developers 애플리케이션 키나 Ncloud 계정의 Access Key/Secret Key를 대신 넣지 않습니다. TTS는 위 두 헤더를 붙여 `https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts`를 서버에서 호출합니다. [Voice 발급 절차](https://guide.ncloud-docs.com/docs/clovavoice-start)

면접관 음성은 대성(Pro)·미경(Pro)을 사용합니다. `.env.local`에서 `CLOVA_VOICE_PRIMARY_SPEED=0`, `CLOVA_VOICE_SECOND_SPEED=-1`로 각각 지정하며 음높이는 `CLOVA_VOICE_PITCH=1`을 유지합니다. 역할별 속도 → 기존 공통 속도 → 역할 기본값 순서로 적용됩니다. CLOVA의 속도 `0`은 원음 속도이고 음수는 빠르게, 양수는 느리게 합성하는 방향입니다. ‘차분한 면접 톤’은 이번 앱의 선택·설정 의도이며, 공식 감정 분류명이 아닙니다. 두 목소리와 파라미터 범위는 공식 목록에서 확인했으며 실제 계정으로 비민감한 질문 음성 2종의 MP3 합성을 확인했습니다. TTS 캐시는 실제 speaker·speed·pitch·volume·format을 포함하므로 이전 `nara` 음성이나 다른 속도의 음성이 재사용되지 않습니다. `.env.local`을 수정한 뒤 실행 중인 서버를 다시 시작해야 새 설정이 적용됩니다. [TTS Premium API·목소리·속도·음높이](https://api.ncloud-docs.com/docs/ai-naver-clovavoice-ttspremium)

첫 발화는 짧은 ‘안녕하세요.’와 구체적인 질문으로 시작합니다. ‘학생부에 기록된 활동부터 질문드리겠습니다’ 같은 진행 예고는 생성 지침과 발화 검증에서 제외하며, 검수 실패 시 같은 근거로 정해진 횟수 안에서 다시 생성합니다.

## Speech 도메인 준비 시 확인할 점

도메인 생성 가이드는 Object Storage 버킷과 입력/결과 저장 경로 설정을 설명합니다. 스트리밍 빌더 가이드는 스트림 종료까지의 인식 결과가 고객 Object Storage에 자동 저장된다고 명시합니다. **로컬 앱의 `data/` 저장과 CLOVA 도메인의 결과 저장은 별개**입니다. 콘솔에서 해당 도메인의 저장 경로를 설정하면 되며, 이 앱의 `.env.local`에 Object Storage Access Key/Secret Key를 추가하지 않습니다. 도메인별로 저장 경로를 지정하는 구조이며, 공식 문서가 도메인마다 새 버킷 하나를 만들라고 요구하는 것은 아닙니다. [도메인 생성 안내](https://guide.ncloud-docs.com/docs/clovaspeech-domain), [스트리밍 결과 저장 안내](https://guide.ncloud-docs.com/docs/clovaspeech-builder-streaming)

공식 영문 릴리스 노트는 **2023-12-21 장문 도메인 안의 실시간 스트리밍 제공**, **2025-11-20 별도 Streaming 2.0 서비스 출시**를 구분합니다. gRPC API 페이지에는 현재도 ‘Basic 장문 인식 플랜’이라는 이전 구성의 표현이 남아 있습니다. 이를 새 콘솔에서 장문 도메인을 생성하라는 지시로 해석하지 않습니다. 릴리스 노트와 현재 스트리밍 빌더의 API 연결을 함께 대조한 결과, **이번에 새로 만들 도메인은 스트리밍 인식**으로 안내합니다. 이 구세대 표현에 대한 설명은 공식 문서 간 대조에 따른 해석이며, 기존 장문 도메인의 이전 스트리밍 기능이 종료되었다는 뜻은 아닙니다. [공식 릴리스 노트](https://guide.ncloud-docs.com/docs/en/clovaspeech-releasenote), [현재 스트리밍 빌더](https://guide.ncloud-docs.com/docs/clovaspeech-builder-streaming), [gRPC 인증 페이지](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc)

앱은 `NestService.recognize`, TLS `clovaspeech-gw.ncloud.com:50051`, Bearer Secret, 한국어 `ko`, 16kHz·16bit·mono PCM, `semanticEpd`를 사용합니다. 현재 공식 스트리밍 API 계약과 대조했으며 도메인 선택 안내 정정 때문에 provider 코드를 바꿀 필요는 없습니다. Secret을 설정한 뒤 실제 인식 성공 여부는 한 턴 음성으로 검증합니다. [실시간 스트리밍 API](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc)

`DOMAIN_ID`는 도메인 이름이나 사용자가 입력한 도메인 코드와 동일하다고 추정하지 않습니다. 공개 가이드에서 구체적인 ID 발급 화면까지 확정할 수 없어 위 표에 확인 경로와 한계를 표시했습니다. 공식 recognize 요청에는 `domainId` 필드가 없습니다. 이 구현은 사용하지 않는 필드를 임의로 전송하지 않으며, 이 값만 비어 있어도 면접 시작을 막지 않습니다. [gRPC Config·Recognize·active-calls 명세](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc)

## 로컬 파일에 입력

1. 루트의 `.env.example`을 `.env.local`로 복사합니다.
2. OpenAI 키와 Speech Secret, Voice Client ID/Secret을 채웁니다. 실제 값은 채팅에 보내지 않아도 됩니다.
3. 호스트/포트/목소리는 기본값으로 시작할 수 있습니다.
4. 서버를 다시 실행합니다. 준비 화면에서 누락 변수 이름을 확인할 수 있습니다.
5. 마이크·카메라 권한을 허용하고 한 턴을 진행해 실제 음성을 확인합니다. `어`, `음`이 포함된 답변으로 원문 전사 보존 범위도 확인합니다.

현재 gRPC 스트림에는 문서에 없는 filler 보존 옵션을 보내지 않습니다. 금칙어 필터를 요청하지 않으며 `useDomainForbiddens=false`로 설정합니다. 엔진이 실제 음성의 추임새를 누락할 수 있으므로 집계는 **전사에서 관찰된 횟수**입니다. 없는 추임새를 AI가 복원하지 않습니다. [Config JSON 필드](https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-grpc)

OpenAI는 `OPENAI_API_KEY`와 해당 프로젝트에서의 `gpt-6-luna`, `gpt-6.1-terra` 접근 권한이 필요합니다. 서버는 Responses API 및 Structured Outputs를 사용하며 계정에서 모델이 거부되면 다른 모델로 자동 교체하지 않습니다. Luna는 기본 질문에서 `reasoning.effort=none`, 답변에 따른 후속 판단은 `low`, Terra 종료 평가는 `medium`을 사용합니다. 일반 처리는 `service_tier=default`로 지정합니다. [Luna 모델](https://developers.openai.com/api/docs/models/gpt-6-luna), [Terra 모델](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

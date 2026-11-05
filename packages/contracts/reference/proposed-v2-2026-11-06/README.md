# 제안 계약 v2 — 앱에 아직 적용하지 않음

이 폴더는 각자의답 서비스 이관을 위한 **PROPOSED 명세와 합성 검증 예시**다. 실제 앱 코드·기존 MD·개인 기록을 변경하지 않는다. `schema_version=proposed-v2-2026-11-06`은 검토용 버전이다. 검토 후 운영용 버전과 호환 어댑터를 결정해야 한다.

## 파일

| 파일 | 책임 |
|---|---|
| `answer-submission.schema.json` | 텍스트/확정전사참조/확인된 정상무응답 중 정확히 하나 |
| `evidence-ref.schema.json` | 학생부·대학자료·실제답변·학생확인별 불변 버전·UTF-16 구간·인용/해시 |
| `playback-event.schema.json` | 실제 재생 시작·완료·중단·실패 관찰; TTS 생성완료와 분리 |
| `interview-decision.schema.json` | 미완결과 평가된 답변의 구분, action/trigger/function 독립 축 |
| `evaluation-scope-approval.schema.json` | 일반 기록 일관성·객관지식·미승인 scope와 세션/질문/답변/manifest 결합 |
| `examples.json` | 개인정보 없는 정상 형태 예시 |
| `fixtures.json` | 통과·거부를 명시한 합성 형태 검증 사례 |
| `runtime-source-fixtures.json` | UTF-16 및 실제 인용/해시 검사의 별도 예시 |
| `validate_contracts.py` | jsonschema 검증 + 독립 source-span 예시 검증 |
| `validation-results.json` | 실제 실행 결과 및 미실행 범위 |

## 이전 Pydantic export 문제를 해결하는 방법

이전 제출 모델은 Pydantic의 사용자 정의 validator에만 "텍스트 XOR 전사 ID"를 넣어 생성된 JSON Schema에는 그 조건이 빠졌다. 여기서는 각 variant에 `kind`의 `const`, 필수 필드, `additionalProperties:false`를 두고 **스키마 자체에 `oneOf`**를 선언한다. 답변 누락, text와 transcript 동시입력, 공백 텍스트를 JSON Schema 단계에서 거부한다. 각 object가 필요한 필드를 모두 명시하므로 `allOf`와 `additionalProperties`의 결합 함정도 피한다.

공백 정의는 Python/ECMAScript의 `\s` 차이를 피하도록 코드포인트 집합으로 고정한다. JSON Schema 문자열 길이는 Unicode 코드포인트 수이고 근거 offset은 **UTF-16 code unit**이다. 둘을 혼동하지 않는다. 예시 `발표😀`는 길이 3 코드포인트 / 4 UTF-16 code unit이다. 정규화된 문자열의 offset을 원본에 적용하지 않는다. NFC 정규화는 검색용 파생값에만 적용한다.

권고 운영 방식은 이 계약 또는 동등한 단일 원본에서 TS와 Python 어댑터를 생성하고 동일 fixture를 모두 실행하는 것이다. **현재 Python jsonschema만 검증했으며 Ajv·Pydantic·앱의 공유 의미 일치까지 확인했다고 주장하지 않는다.** 런타임에 Pydantic을 쓰면 이 XOR를 표현한 discriminated union을 쓰고 export 결과의 동일 fixture 통과를 추가 gate로 둔다. Zod refinement 역시 export 시 사라질 수 있어 결과물을 직접 검증해야 한다.

## 반드시 추가해야 할 서버 검사

형태 통과는 진실·권한·의미·상태 승인이 아니다. 다음은 DB/서버 책임이다.

1. **모든 요청:** 인증 주체에서 owner를 도출하고 session/turn/answer/target의 소유권과 연결을 조회한다. 클라이언트의 임의 owner는 제출 스키마에서 받지 않는다. optimistic revision+idempotency key+request digest를 함께 검사한다. 같은 키/같은 내용은 동일 결과, 다른 내용은 충돌이다.
2. **확정 전사:** 해당 turn/owner의 immutable transcript revision인지, provider capture가 확정됐는지, 원문이 비어 있지 않은지 검사한다. 빈 확정 전사는 일반 답변으로 승인하지 않는다. 정상 무음 증거가 있으면 `confirmed_non_answer`로 명시 전환하고, 장치/STT 실패 또는 관찰 불충분이면 재수집으로 돌린다.
3. **정상 무응답:** `student_confirmed` 값만 신뢰하면 안 된다. `capture_evidence_revision_id`가 서버가 기록한 마이크 활성·정상 provider 종료·유효한 발화 관찰·무음 판정과 결합되어야 한다. STT 종료만으로 무음이 증명되지 않는다. "기억이 나지 않습니다"는 텍스트/전사 답변이며 의미 코어에서 `unavailable`로 해석한다. 이 variant는 임의 침묵 추정용이 아니다.
4. **근거:** 실제 불변 source의 해시, offset 순서/범위, UTF-16 surrogate 경계, 정확 인용, quote 해시, source kind별 foreign key를 확인한다. `source_version_id`가 `record_version_id` 등 특정 문서 버전과 일치하는지도 검사한다. 대학자료 `official`은 사용자가 보내거나 LLM이 주장할 수 있는 승인 근거가 아니다. source registry의 공식 출처 판정과 대조한다. 학생 진술·학생 확인은 문서 사실이나 객관적 진리로 승격하지 않는다.
5. **재생:** event_id 중복수신에 receipt를 반환하고 이미 저장된 이벤트는 중복처리하지 않는다. 동일 event_id 다른 내용은 충돌이다. `(session_id, playback_attempt_id, sequence)` 유일성, 질문/utterance 해시 일치, started→terminal 순서, 같은 clock의 monotonic 증가, duration/position 일관성을 검사한다. 재연결로 clock_id가 바뀌면 시간을 직접 빼지 않는다. `client_occurred_at`은 감사 정보일 뿐 신뢰할 수 있는 세션 타이머가 아니다. 서버에서 observed_at을 추가한다. TTS ready는 제시·재생 증거가 아니다. 브라우저 playback은 시스템 관찰 증거이며 사람이 실제로 들었다는 물리적 증명까지는 아니다.
6. **의미 결정:** 서버가 answer revision·question version·policy/manifest를 실제 pending 요청과 결합한다. `trigger_kind`는 설명 가능한 제안 분류이지 사실 증명이 아니다. 예를 들어 met+new_claim+FOLLOW_UP는 형태상 허용하지만 추가 확인 가치·근거·단일 요구는 정책/의미 검수 대상이다. `same_requirement`를 F로 제출하는 구조는 차단한다. 동일 의미 재진술은 기능·깊이·조건·평가 단위를 보존하는지 확인한다. 실제 F2 상한·잔여시간·제시 이력은 서버가 최종 승인한다. model의 CLOSING은 종료 권한이 아니다.
7. **평가 scope:** 이 객체는 공개 클라이언트 제출 payload가 아닌 서버 내부 승인 산출물이다. 승인자·승인 revision·question contract·source manifest·answer revision의 실제 registry와 대조한다. 일반 scope는 과학적 정오 판정 권한이 없다. objective_knowledge는 packet 존재뿐 아니라 승인상태·내용해시·전제/적용범위·실제 주장구간·정정 revision을 확인한다. `all_core_claims_reviewed` 문자열만으로 전체 검수가 되었다고 인정하지 않는다. scope가 none인 문항은 보류한다.

## 기존 엔진과의 매핑

`record_consistency_only`는 기존 gate의 같은 scope를 보존한다. `objective_knowledge`와 `none`은 검토용 표준화 이름이며 기존 코덱과 마이그레이션 매핑이 필요하다. `none`은 학술 지식이 불필요하다는 의미가 아니라 **정당한 평가 scope 승인 없음**을 뜻한다.

`CLARIFICATION`은 모델용 `ASK_SAME_REQUIREMENT`, `FOLLOW_UP`은 `ASK_NEW_SUBPOINT`와 호환 어댑터로 연결한다. `trigger_kind`(왜 추가 확인하는가)와 `primary_function`(무엇을 요구하는가)을 분리한다. 새 주장 때문에 질문을 했더라도 질문이 근거를 요구하면 `EVIDENCE`일 수 있다. `VERIFY_CLAIM` 경계와 예시는 MD9·10 공동 개정 후 배포한다. 현행 label을 이 제안 때문에 즉시 덮어쓰지 않는다.

이 계약은 서버가 enriched한 내부 결정 envelope다. OpenAI Structured Outputs로 그대로 전송하기 전에 모델이 생성할 필드와 서버가 넣을 ID/hash/승인 필드를 분리한 provider schema를 생성해야 한다. 공급자마다 지원하는 JSON Schema 부분집합이 달라 실제 모델에서의 지원을 별도 검증한다. 모델이 source offset·승인자·manifest hash를 생성하도록 만들지 않는다.

## 재실행

```bash
python3 -m pip install -r requirements.txt
python3 build_contracts.py
python3 validate_contracts.py
```

합성 fixture는 운영 테스트1202개·실제45회 의미 QA를 대신하지 않는다. exact quote/UTF-16 예시는 순수 함수 검사이며 DB 권한·음성 E2E·모델 품질 시험이 아니다.

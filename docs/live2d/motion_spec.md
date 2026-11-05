# 면접관 모션·표정 제작 규격

작성일: 2026-11-04, Asia/Seoul.

실제 제작한 파일은 `public/live2d/production/motions/` 아래 남녀 각각 **motion3 6개 + exp3 3개**, 총 18개다. 숫자 곡선·메타데이터·표정 데이터가 들어 있으며 생성 스크립트로 다시 만들 수 있다. 빈 설정이나 샘플 캐릭터의 모션을 이름만 바꾼 파일이 아니다. 실제 모델·리깅·`.can3`·`.moc3`는 이 산출물에 포함되지 않는다.

현재 파일은 **전용 모델에 연결하기 전의 제작 데이터**다. 참조 ID가 실제 모델에 존재하는지, 그 값이 어떤 모습으로 변형되는지는 아직 검증하지 못했다. 얼굴과 현재 원화는 사용자 승인 상태를 따른다. 이 작업은 추가 얼굴 보정이나 네 가지 시각 보정의 재승인을 요구하지 않는다.

## 파일과 사용 조건

두 폴더 `interviewer-1/`, `interviewer-2/`는 같은 ID 규격을 따르지만 별도 파일·지속 시간·강도를 가진다. `catalog.json`에 실제 파일명·해시·계획 파라미터와 미검증 상태를 기록한다. 다음 시간은 오디오 길이를 대신하지 않으며 실제 음성은 재생 이벤트와 재생 위치로 관리한다.

| 파일명 — 두 면접관 각각 존재 | 남성 / 여성 지속 시간 | 연출·사용 조건 |
|---|---|---|
| `Greeting.motion3.json` | 3.20 / 3.45초 | 인사 발화 시작에 1회. 잠깐 정지한 뒤 작은 고개·몸 변화 후 중립 복귀 |
| `QuestionStart.motion3.json` | 2.40 / 2.65초 | 해당 면접관 질문의 실제 `playing`에 1회. 작은 좌우/상하/기울임 값만 사용, 손 제스처 0 |
| `Listening.motion3.json` | 8.20 / 9.10초 | 학생 답변 또는 상대 면접관 발화 시작에 선택적으로 1회. 고개 X/Y/Z는 모두 0, 아주 작은 몸통 자세 변화만 존재 |
| `SmallNod.motion3.json` | 2.60 / 2.80초 | 승인된 비평가적 전환에서만 선택적으로 1회. 자동 정답 반응이나 경청 반복 루프에 사용하지 않음 |
| `ReturnToNeutral.motion3.json` | 1.40 / 1.60초 | 취소·전환 시 중립 목표. 아래의 현재 자세 인계 조건이 필요 |
| `Closing.motion3.json` | 3.40 / 3.70초 | 실제 마무리 발화 시작에 1회. 짧고 작은 고개·몸 변화 후 정지 |
| `Neutral.exp3.json` | fade-in 0.45 / fade-out 0.55초 | 기본 경청·대기. 눈썹/눈 미소 채널을 중립값으로 둠 |
| `SoftSmile.exp3.json` | 동일 | 인사·마무리에서만 낮은 강도의 눈 주변 표정. 입 모양은 바꾸지 않음 |
| `Attentive.exp3.json` | 동일 | 경청에 선택적으로 적용하는 미세한 눈썹 변화. 평가·감정 판정과 연결하지 않음 |

여성의 모션 강도는 남성 곡선값의 0.88배이며 좌우 변화의 부호와 시간도 다르다. 표정 강도는 0.92배다. 이는 제작 초기값이며 성별에 따른 성격·역할 차이를 추정한 값이 아니다. 두 사람을 같은 시각에 같은 루프로 실행하지 않는다.

고개 파라미터 값의 부호가 실제 위/아래 움직임과 어떻게 대응하는지는 리깅에 달려 있다. `SmallNod`라는 파일명을 붙였다는 사실만으로 실제 모델에서 자연스러운 끄덕임이 구현됐다고 판단하지 않는다.

## JSON 형식

motion3은 `Version: 3`, `Fps: 30`, `Loop: false`, `AreBeziersRestricted: true`다. 각 곡선은 `Target: Parameter`이며 시작점과 실제 종점이 존재한다. 모든 구간은 제한된 cubic Bezier를 사용한다.

```text
[시작시각, 시작값,
 1, 제어점1시각, 시작값, 제어점2시각, 끝값, 끝시각, 끝값,
 ...]
```

시간 제어점은 구간의 1/3과 2/3에 두고 값 제어점은 양 끝값과 같게 둔다. 이렇게 제작한 구간에는 값의 초과 진동이 없고 각 구간 끝의 변화율이 0으로 연결된다. 모든 시간은 증가하며 마지막 종점은 `Meta.Duration`과 같다. 시작·끝은 중립이고 충분한 정지 구간을 포함한다. 곡선·구간·점 개수는 실제 배열에서 산출하여 메타데이터에 기록한다. 모션의 fade-in은 0.40초, fade-out은 0.55초다. ReturnToNeutral은 0.65/0.45초다.

표정은 `Type: Live2D Expression`, `Parameters`의 `Id/Value/Blend`를 사용한다. 이 패키지는 `Blend: Overwrite`로 눈썹과 눈 미소의 독립 채널만 제어한다. 눈 깜빡임의 `ParamEyeLOpen/ParamEyeROpen`, 입 열림·입꼬리·모음 채널은 표정에 없다.

형식 근거는 [공식 motion3 파서](https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismmotionjson.ts), [공식 구간 파서·평가 구현](https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismmotion.ts), [공식 exp3 파서](https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismexpressionmotion.ts)다. 공개 소스의 형식을 확인했으며 이 작업에서 공식 SDK 파서나 실제 모델로 재생한 것은 아니다.

## 입과 손의 분리

모든 motion3에서 허용하는 ID는 다음 7개뿐이다.

```text
ParamAngleX, ParamAngleY, ParamAngleZ,
ParamBodyAngleX, ParamBodyAngleY, ParamBodyAngleZ,
ParamQuestionGesture
```

`ParamQuestionGesture`는 모든 점·제어점에서 정확히 0이다. 손목·펜·책상 접촉이 승인되기 전까지 손 제스처를 실행하지 않는다. 입 관련 파라미터, `Model/LipSync` 곡선, 음성·사용자 이벤트는 없다. 따라서 이 파일만으로 면접관이 발화하지 않으며 학생 음성을 입력받는 경로도 없다.

MotionSync를 연결할 때는 실제 내보낸 설정의 `CubismParameters` 전체 목록을 읽고 이 7개 및 표정의 6개 채널과 겹치지 않는지 추가 검사한다. 파라미터 이름에 `Mouth`가 없더라도 실제 입 매핑에 들어 있는 채널은 일반 모션이 쓰면 안 된다.

## 현재 런타임과 연결 전 조건

검토한 현재 `lib/live2d/director.ts`는 고개·시선·눈 깜빡임·호흡·진폭 기반 입 값을 매 프레임 만든다. `integrations/live2d/renderer.mjs`는 그 값을 적용하고 실제 MotionSync 설정에 등록된 입 채널을 분리한다. **현재 어댑터는 이번 motion3/exp3 파일을 로드하거나 재생하는 모션/표정 관리자를 연결하지 않았다.** 따라서 파일 생성과 상태 타입의 존재를 실제 모델 동작 연결 완료로 표시하지 않는다. 이 작업은 앱 코드·장면 manifest를 변경하지 않았다.

모델 연결 시 필요한 소유권 규칙은 다음과 같다.

1. 발화 중 입은 실제 출력 오디오를 공급받는 MotionSync가 전담한다. 일반 모션·표정·학생 마이크는 입 채널을 쓰지 않는다.
2. 머리/몸 모션 재생 중 그 모션의 ID는 director의 같은 ID 쓰기에서 제외한다. 별도 합성 정책 없이 두 절대값을 더하거나 마지막 쓰기로 덮지 않는다.
3. 눈 깜빡임·시선·호흡은 director가 유지한다. 이번 모션은 해당 채널을 포함하지 않는다. 표정은 눈썹·별도 눈 미소 채널만 쓴다.
4. 물리 설정도 모션·입 소유 채널을 덮지 않는지 실제 내보내기와 함께 검사한다. 마지막 모델 갱신 전에 각 시스템의 쓰기가 한 번씩 정해진 순서로 끝나야 한다.
5. 모션 종료·중단 시 현재 자세를 캡처하거나 이전 모션을 fade-out하며 ReturnToNeutral로 인계한다. 그 뒤 director에 제어권을 돌려준다.

ReturnToNeutral의 0 곡선은 **중립 목표**를 표현한다. 이 파일이 임의의 현재 자세를 자동으로 알아내지는 못한다. 현재 자세 캡처·이전 모션 블렌딩 없이 첫 프레임에 0을 덮어쓰면 순간 이동이 발생할 수 있다. 입은 취소·정지 시 즉시 닫되 머리·몸의 복귀는 해당 인계 규칙으로 처리해야 한다.

학생 답변에 Listening을 루프 재생하거나 SmallNod를 일정 간격으로 반복하지 않는다. 인사·질문·종료 모션의 재생 완료를 오디오 완료·학생 녹음 시작 신호로 사용하지 않는다. `turnId/speakerId`와 실제 음성 종료·취소를 계속 기준으로 삼는다.

## 재생성·검사와 수행 결과

```text
node scripts/prepare-interviewer-motions.mjs
node scripts/prepare-interviewer-motions.mjs --check
node scripts/prepare-interviewer-motions.mjs --self-test
```

첫 명령은 현재 생성 규격의 18개 파일과 catalog를 기록한다. `--check`는 저장된 JSON을 다시 읽어 형식·곡선 범위·입/눈 깜빡임 채널 배제·손 0·참조/해시를 검사한다. `--self-test`는 파일을 바꾸지 않고 생성 데이터와 손상 사례를 검사한다.

이번 수행 결과는 다음과 같다.

- 저장된 18개 JSON과 두 독립 면접관 목록: 검사 통과
- 증가하는 시간·제한된 Bezier 시간/값 제어점·실제 메타데이터 개수: 검사 통과
- 입 곡선 0개, 눈 깜빡임 채널 표정 0개, 손 제스처 비영점 0개: 검사 통과
- 틀린 점 개수, 역행/중복 제어점 시각, 중복 ID, 입 채널 삽입, 손 움직임, 중립 시작점 손상, 범위 초과, Listening의 고개 변화, 표정의 입/깜빡임 삽입, 비정상 숫자 등 손상 사례 12개: 모두 거부
- 스크립트 문법과 ESLint: 통과

위 결과는 숫자 데이터·파일 무결성 검증이다. 실제 모델 ID/범위, Cubism Editor 가져오기·SDK 파서 실행·모델 재생, 취소/재개 시 자세, 한국어 음성 립싱크, 웹·모바일의 자연스러움은 아직 미검증이다. 이 파일을 `.can3` 편집 원본이나 리깅 완료 결과로 계산하지 않는다.

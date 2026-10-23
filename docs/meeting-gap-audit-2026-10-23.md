# 2026-10-23 회의록 요구사항 미반영 검수

검수 대상은 1·2차 통합 회의록과 3차 회의록이며, 앞서 진행한 UI 개선을 포함한 현재 작업 폴더의 코드를 기준으로 했다. 이번에는 제품 코드를 수정하지 않았다.

- [1·2차 통합 회의록](<C:/Users/MaYunsong/.codex/attachments/75639c79-ce9b-4625-aba7-26716a736b24/붙여넣은 텍스트.txt>)
- [3차 회의록](<C:/Users/MaYunsong/.codex/attachments/232f89c2-533b-4d1b-99f9-9b990dddfddb/붙여넣은 텍스트.txt>)
- [직전 시각 QA와 반영 범위](C:/Users/MaYunsong/Documents/각자의답/docs/visual-qa-2026-10-23.md)

판정은 UI → API → 데이터/AI 호출 흐름을 따라 확인했다. ‘부분’은 관련 기능은 있지만 요구한 조건이나 연결이 빠진 경우다. 회의에서 미확정으로 남긴 세부 기준은 구현 누락과 구분했다. 3차에서 구체화한 내용은 우선 적용했다. 특히 분석 MD는 수동 제작을 줄이고 자동 생성하는 방향으로 해석했다.

## 결론

홈·메뉴·대시보드·캘린더 기록·리포트 지표 선택·면접 화면은 상당 부분 반영됐다. 그러나 **생기부 자동 분석, 영역별 커리큘럼, 연습/실전 분리, 답변 종료와 평가·반복학습 연결**은 회의의 목표 상태에 도달하지 않았다. 화면 검사 통과만으로 회의록 전체가 구현됐다고 볼 수 없다.

우선 처리 순서는 다음을 권한다. 이는 회의 우선순위를 바탕으로 한 제안이며 확정 일정은 아니다.

1. 원본 생기부 업로드 → 분석 → 중요도 → 분석 MD → 기존 AI 문맥 연결.
2. 하루 한 생기부 영역을 중심으로 커리큘럼·자동 편성 기준 개편.
3. 5초 침묵 자동 제출 대체, 발화 중 마이크 정책, 원전사 기준 평가 입력 정리.
4. 연습/실전 상태와 도움·재시도·압박·꼬리질문 정책을 UI와 서버에 함께 적용.
5. 질문별 평가·즉시 피드백·반복 빈도 연결, 비언어 분석 및 퀴즈 개편.

## 1. 생기부·커리큘럼

| ID / 우선순위 | 판정 | 회의 요구와 현재 차이 | 코드 근거 |
| --- | --- | --- | --- |
| A01 / 최상 | 미반영 | 학생이 원본 생기부를 올려 AI 분석과 분석 MD 생성을 시작하는 경로가 없다. 현재 등록은 **운영자만 검수 완료된 가이드북 HTML 한 파일을 올리는 방식**이다. 채팅 첨부는 승인 생기부로 전환되는 입력이 아니다. | [운영자 권한·HTML 등록](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/imports/route.ts:12), [파일 제한·파싱](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/imports/route.ts:21) |
| A02 / 최상 | 부분 | S/A 등 중요도·판정 사유·학교별 기준 버전의 저장 구조와 기존 분석 자료 활용은 있다. 다만 값은 외부에서 만든 HTML에서 들어오며, **AI가 자동 판정한 분석 MD를 질문·평가에 연결하는 흐름**이 없다. | [중요도 계약](C:/Users/MaYunsong/Documents/각자의답/packages/content-contracts/src/index.ts:40), [현재 AI 문맥](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:178), [등록 데이터 저장](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/imports/route.ts:65) |
| A03 / 최상 | 미반영 + 기준 결정 대기 | 운영자가 제공할 분석·질문·평가·피드백·커리큘럼 가이드라인을 별도로 연결하는 흐름이 없다. 현재는 코드에 고정된 지침이다. 외부 기준 버전 기록은 있지만 운영 지침 본문의 적용과 다르다. **구체 지침 내용은 운영자 준비 사항**이다. | [고정 AI 지침](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:240), [실제 instructions 구성](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:289), [외부 기준 버전](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/imports/route.ts:62) |
| A04 / 최상 | 미반영 | 세특·자율·동아리·진로 등 **하루 한 생기부 영역**을 묶고 그날 복습 범위를 안내하는 구조가 없다. 현재는 여러 학교의 질문을 진단·회상·퀴즈·집중·연결면접 등 기능별 슬롯에 배분한다. | [질문 분류 구조](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:12), [기능별 슬롯](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:122), [질문 선정](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:143) |
| A05 / 최상 | 부분 | 학교별 면접일·가용 시간·기존 수행 기록을 반영하는 자동 일정은 있다. **활동 분량·S/A 중요도·생기부 영역·운영자 커리큘럼 지침**을 입력으로 쓰는 편성은 없다. ‘연습 → 실전 → 종합 리포트 → 최종 보완’의 단계 전환도 실전 상태 부재로 완성되지 않았다. | [자동 계획 입력](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training-store.ts:86), [고정 시간 배분](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:113), [수행 기반 가중치](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:146) |
| A06 / 상 | 부분 | 학생의 날짜 이동·합치기·밀기·분산·되돌리기는 있다. **같은 날 퀘스트 순서를 직접 지정하는 기능**은 없다. | [수정 요청 계약](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/calendar-edit.ts:4), [날짜만 변경하는 저장](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/calendar-edit-store.ts:51) |
| A07 / 상 | 부분 | 도움 사용·시간 초과·퀴즈 오답·학생 선택에 따른 반복학습은 있다. **면접 AI 평가 결과가 질문별 재출제 빈도로 연결되지 않으며**, 학생이 그 자동 반복의 주기·중지를 직접 조절하는 설정도 없다. | [면접 반복 판단 입력](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/training-review-evidence.ts:22), [자동 보완 트리거](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/training-review.ts:219), [기존 퀴즈 간격](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/quiz/route.ts:278) |

**이미 있는 부분:** 기본 일일 진단·회상·집중·연결면접은 `kind:'video'`로 시작하고 채팅은 필수 슬롯이 아니다. 따라서 ‘화상 훈련 편성 자체가 없다’고 판정하지 않았다. 다만 날짜 이동이나 수동 일정이 시간을 모두 채운 뒤에도 매 학습일 화상을 최소 1개 보장하는 별도 조건은 없다. [훈련 시작](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/training-run.tsx:72), [남은 시간 조건](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/hybrid-training.ts:104).

## 2. 연습·실전 면접과 음성 동작

| ID / 우선순위 | 판정 | 회의 요구와 현재 차이 | 코드 근거 |
| --- | --- | --- | --- |
| B01 / 상 | 미반영 | **연습/실전을 구분하는 세션 상태가 없다.** `chat/video`, 학교/일반 자료 범위, 진단/회상 목적만 구분한다. 실전 화상만 허용·도움 차단 정책도 UI와 서버에 없다. | [시작 계약](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:25), [설정 저장](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:167), [서버 도움 조건](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/interview-assistance.ts:7) |
| B02 / 상 | 부분 | 압박 토글은 있다. 그러나 퀘스트에 따른 일반/압박 배치와 연습/실전별 선택 정책은 없다. 꼬리질문을 켜면 **일반·압박 모두 최대 2회**, 답변이 충분한지를 판정해서 생략하는 분기는 없다. 일반 모드의 정확한 최종 횟수는 미정이다. | [압박 설정](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/interview-setup.tsx:123), [최대 횟수](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:167), [꼬리질문 생성 조건](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:365) |
| B03 / 상 | 부분 | 버튼으로 여는 텍스트 도움 시트는 있다. **캐릭터 음성 호출 → 면접관 교체 → 음성 힌트 대화 → 면접관 복귀**는 없다. 도움 응답을 ‘완성 답변이 아닌 힌트’로 제한하는 전용 계약도 없다. 이름·디자인은 미정 사항이다. | [현 도움 진입](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:327), [텍스트 도움](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/learning-help.tsx:138), [음성 역할 제한](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/realtime-interview.ts:75) |
| B04 / 최상 | 부분, 기존 방식 잔존 | 수동 ‘답변 마침’ 버튼은 추가·강조됐으나 **5초 침묵 자동 제출이 그대로 유지**된다. 맥락 기반 종료 판정은 없다. ‘잠깐 생각할게요’ 버튼도 남아 30초간 자동 마침만 유예한다. | [기본 5초](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/live-interview-turn.ts:33), [침묵 종료](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-recorder.ts:119), [자동 제출](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-controller.ts:219), [남아 있는 버튼](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:390) |
| B05 / 최상 | 부분 | 원전사 보존과 반복·습관어 삭제 방지는 구현됐다. 다만 **질문별 평가와 최종 리포트에는 표시용 `answer`를 전달**하며 원전사·수정본·발화 출처를 구분한 평가 근거가 빠진다. 자동 정리는 단어 보존 검증을 거치므로 ‘원전사가 요약·삭제된다’고 판정한 것은 아니다. | [원전사 보존](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/interview-transcription.ts:53), [정리 검증](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/transcript-cleanup-rules.ts:24), [평가 입력](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:362), [리포트 입력 구조](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:471) |
| B06 / 상 | 경로별 부분 | 일반 TTS는 질문 종료 후 녹음한다. 그러나 **Realtime 경로는 질문 전 녹음 시작·`allowBargeIn:true`**로 면접관 발화 중에도 입력을 받고 끼어들기를 허용한다. ‘발화 중 마이크 차단’과 충돌한다. 해당 경로 활성화 여부에 따라 실제 동작은 다르다. | [경로 분기](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-controller.ts:248), [입력 허용](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:145), [재생 중 입력](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/realtime-interview.ts:125) |
| B07 / 중 | 부분 | 별도 녹음 시작 클릭 없이 질문에서 답변으로 이어진다. 다만 일반 TTS 첫 질문은 **3초 준비 카운트다운**이 있으며 최종 STT는 녹음 후 배치 처리한다. ‘질문 직후 즉시 STT’와 완전히 같지는 않다. 일반 TTS에는 독립적인 질문 재청취 동작도 부족하다. | [준비 시간](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:173), [저장 후 STT](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-controller.ts:220), [Realtime 재청취](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/realtime-interview.ts:34) |
| B08 / 상 | 부분 | 같은 질문 재녹음 구현은 있지만 **오류·시작 전 복구 상태에서만 버튼이 노출**된다. 정상 답변 중이나 도움 이후에 처음부터 다시 답할 수 있는 일반적인 재시도 흐름은 부족하다. | [재녹음 구현](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-controller.ts:142), [버튼 노출 조건](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:388) |
| B09 / 상 | 부분 + 기준 결정 대기 | 짧고 구체적인 한국어 등 고정 지시는 있으나 운영자 질문 가이드라인 적용과 질문별 길이 제한은 없다. **학교 인재상 명칭을 직접 말하는 템플릿이 남아 있고 면접에도 사용**된다. | [직접 언급 템플릿](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/school-talent-model.ts:59), [인재상 문항 편성](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:420), [원 질문 사용](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:58) |

## 3. 평가·영상·리포트

| ID / 우선순위 | 판정 | 회의 요구와 현재 차이 | 코드 근거 |
| --- | --- | --- | --- |
| C01 / 상 | 부분 | 질문·회차별 영상 저장과 리포트 연결은 있다. **면접 전체 종료 후에만 재생**하는 제약은 없다. 저장·복구 과정에서 로컬 녹화 재생이 가능하고 미디어 조회 API도 세션 완료 여부를 제한하지 않는다. 종료 화면 자체는 질문 목록 대신 리포트 이동 버튼을 제공한다. | [질문별 저장](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/media/route.ts:130), [종료 전 재생](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:373), [조회 조건](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/media/route.ts:43), [종료 화면](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/live-interview-session.tsx:375) |
| C02 / 상 | 미반영 | **시선·몸짓·반복 행동·면접 태도의 영상 분석과 비언어 지표**가 없다. 현재 분석은 음성 시간·공백과 원전사의 습관어·반복 표현이다. 발화 분석 전체가 없다는 뜻은 아니다. | [현재 분석 구조](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/speech-analysis.ts:34), [분석 입력](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/media/route.ts:129), [현재 4개 지표](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/speech-growth.tsx:79) |
| C03 / 상 | 부분, 현 지침과 충돌 | Chat의 ‘질문마다’ 피드백은 있다. Live는 반환 피드백을 표시하지 않고 다음 질문으로 넘어간다. 회의의 **직관적 점수·별점, 생기부 근거 답변 예시**도 미완성이다. 현재 지침은 점수를 만들지 않고 완성형 답변 예시를 쓰지 않도록 명시한다. 요구사항 합의 후 지침과 데이터 구조를 함께 바꿔야 한다. | [질문별 평가 호출](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/interviews/route.ts:361), [Live 다음 진행](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/client/live-interview-controller.ts:224), [예시 금지 지침](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:255) |
| C04 / 상 | 부분 | 날짜→훈련→질문→답변·영상은 연결됐다. 그러나 **선택한 질문의 AI 피드백이 질문 내부에 연결되지 않는다.** 리포트 `sections`에 turn별 feedback을 복사하지 않으며 UI에는 별도 ‘면접 전체 피드백’만 있다. | [리포트 sections](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:471), [전체 피드백](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records.tsx:191), [질문 내부 내용](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records.tsx:194) |
| C05 / 중 | 부분 + 기본 방식 결정 대기 | 기록 영역 통합 열람·전체 JSON 내보내기·계정 HTML 백업은 있다. **선택 날짜/훈련 단위 리포트 다운로드**는 연결되지 않았다. 열람과 다운로드 중 무엇을 기본으로 할지는 아직 결정 사항이 아니다. | [전체 JSON 내보내기](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records.tsx:85), [전체 자료 export](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/app/api/student-records/export/route.ts:7), [계정 HTML 다운로드](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/account-data.tsx:123) |

근거 없는 칭찬 방지, 승인 자료와 학생 진술 구분, 사실 창작 방지 지침은 이미 있다. 이 항목을 ‘AI 피드백 전체 미구현’으로 분류하지 않았다. [현행 지침](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/ai.ts:245).

## 4. 채팅·퀴즈·남은 UI

| ID / 우선순위 | 판정 | 회의 요구와 현재 차이 | 코드 근거 |
| --- | --- | --- | --- |
| D01 / 중 | 미반영, 대체 명칭 결정 대기 | 변경하기로 한 **‘첫 진단’이 훈련 제목·시작 버튼·기록에 그대로 남아 있다.** 새 명칭은 미정이지만 기존 명칭 제거는 아직 이루어지지 않았다. | [훈련 버튼](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/training-hub.tsx:105), [단계 제목](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/training-run.tsx:35), [기록 명칭](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records.tsx:52) |
| D02 / 중 | 부분 | 답변 편집기에서 도움 시트를 열 수 있고, 규칙 기반 말투 정리와 학생이 보탠 문장을 초안에 적용할 수 있다. 그러나 **AI 도움 채팅의 제안을 현재 면접 답변에 바로 적용하는 연결**은 없다. `LearningHelp`에는 답변 적용 콜백이 없다. AI 비서 자체의 문장 정리와 면접 답변 편집기를 구분해야 한다. | [면접 편집기 연결](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/interview.tsx:225), [도움 컴포넌트 계약](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/learning-help.tsx:13), [기존 규칙 기반 적용](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/practice-writing-help.tsx:18) |
| D03 / 중 | 부분 | 4지선다·정답 검수·10초/무제한 선택은 있다. 그러나 **퀴즈에 Q&A·답변 녹음이 계속 병렬 제공**되며 객관식이 없으면 Q&A를 기본 추천한다. 학교 인재상 문항도 객관식이 아니라 `short_speech/self_check`로 만들어진다. 회의의 ‘빠른 선택형 독립 학습’으로 전면 개편되지는 않았다. | [현재 모드·fallback](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/quiz-v3.tsx:60), [3개 모드 UI](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/quiz-v3.tsx:77), [학교 문항 구조](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/lib/school-quiz.ts:33) |
| D04 / 중 | 부분 | 결과의 풀이 수·정답 수·다시 볼 답변 수는 있다. **최종 점수·취약 영역·개선점 요약이 우선되는 결과 구조**는 미완성이다. ‘답변 돌아보기’가 접기 버튼이 아닌 섹션 제목이라 취약 답변 상세가 처음부터 나오며, 취약 답변이 없을 때도 저장한 답변을 모두 펼친다. | [현재 결과 수치](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/quiz-v3.tsx:569), [상세 기본 노출](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/quiz-v3.tsx:579) |
| D05 / 중 | 부분 | 면접 리포트의 재연습 행동은 정리됐지만 **답변 비교에는 ‘다음 학습 이어서’와 ‘이 질문 다시 말하기’가 함께 남아** 있다. 퀴즈 결과에도 재연습·관련 자료·내 말로 다시 설명 등이 병존한다. 전 화면의 중복 행동 통합은 끝나지 않았다. | [비교 화면](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records.tsx:291), [퀴즈 결과 행동](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/quiz-v3.tsx:575) |
| D06 / 중 | 부분 | 완료 날짜 표시는 있지만 **캐릭터 도장이 아닌 Check 아이콘**이다. 진행 중인 기록 날짜에는 작은 점도 표시한다. ‘완료한 날만 캐릭터 도장’이라는 세부 시각 요구와는 차이가 있다. | [캘린더 날짜 표시](C:/Users/MaYunsong/Documents/각자의답/apps/web/src/components/records-calendar.tsx:50) |

### 실제 화면·데이터 추가 확인

2026-10-23 로컬 미리보기에서 합성 테스트 계정으로 읽기 위주 검증을 수행했다. 새 퀴즈·면접 답변을 제출하거나 외부 AI를 호출하지 않았다.

- 고려대학교·건국대학교 두 지원처 모두 현재 퀴즈 풀은 **선택형 0개 / Q&A 16개 / 답변 녹음 16개**였다. 이는 이 계정의 현재 자료 상태이며 모든 학생의 데이터가 같다는 뜻은 아니다.
- 완료된 퀴즈를 열었을 때 ‘답변 돌아보기’를 누르지 않아도 실제 답변·녹음·재연습 행동이 보였다.
- 학교 인재상을 직접 언급하는 장문 질문이 실제 저장 기록에도 있었다.
- [API·브라우저 결과 JSON](C:/Users/MaYunsong/Documents/각자의답/.local/visual-qa-2026-10-23/audit-quiz-readonly.json)
- [현재 퀴즈 화면](C:/Users/MaYunsong/Documents/각자의답/.local/visual-qa-2026-10-23/audit-quiz-home.png) · [현재 퀴즈 결과 화면](C:/Users/MaYunsong/Documents/각자의답/.local/visual-qa-2026-10-23/audit-quiz-result.png)

## 5. 미반영으로 단정하면 안 되는 사항

다음은 이번 검수에서 구현이 확인된 부분이다.

- 홈의 훈련하기/마이 대시보드 진입, 대시보드에 일정·진행률·기록·설정 통합.
- 날짜를 선택한 기록 탐색, 선택 날짜로 복귀, 질문 펼치기, 질문별 녹화 연결.
- 주요 4개 음성 수치와 선택한 상세만 표시하는 리포트 구조.
- 주요 버튼의 진한 초록색, 모바일 내비 이름·입력 중 숨김, 모바일 훈련 시작·답변 마침 버튼.
- 일반 음성 면접의 질문 기본 숨김, 원형 면접관과 발화 효과.
- 원전사 영속 보존, 반복·습관어를 삭제하지 않는 표시용 정리 검증, 실제 음성 기반 발화 분석.
- 지원처·가용 시간 기반 자동 계획, 날짜 변경, 기존 복습 간격 및 학생의 보완 질문 선택.

다음은 **결정 또는 운영 자료 준비가 필요한 사항**이므로 단순한 개발 누락으로 계산하지 않았다.

1. 캐릭터 이름·디자인, 일반 모드의 정확한 꼬리질문 횟수.
2. 최종 답변 종료 판정 방식. 단, 기존 5초 침묵 방식을 수정한다는 방향은 미해결 확정 요구다.
3. 퀴즈 생명·최고 기록 등 최종 게임 규칙. 시간 제한 기능은 이미 있다.
4. 반복 답변 훈련의 새 명칭, 생기부 영역별 상세 커리큘럼.
5. 홈 최종 명칭, 시사·지식 기능 위계, 퀘스트 카드의 최종 기본 정보.
6. 열람/다운로드 기본 방식, 리포트 상단 핵심 지표의 최종 선정.
7. 분석 가이드라인 평가 기준, 면접관 질문 생성 가이드라인의 세부 규칙.
8. 최종 면접 화면 디자인, 일정 변경 후 AI 자동 재편성 세부 규칙.

자연스러운 한국어 TTS 품질과 실제 휴대폰 마이크·카메라 동작은 이번 코드 검수만으로 합격 여부를 판정하지 않았다. 실제 음성 면접 품질 검증이 따로 필요하다.

## 6. 다음 구현의 완료 기준

- **생기부:** 학생 업로드 한 번으로 분석 작업 상태와 결과 MD를 확인하고, 생성 질문/평가가 해당 분석 버전과 활동 근거를 참조해야 한다.
- **커리큘럼:** 하루의 영역·활동 범위가 명확하며, 활동 중요도·분량·지원처·면접일까지의 부담이 편성에 반영되어야 한다. 순서 변경 결과도 다시 접속했을 때 유지되어야 한다.
- **면접 정책:** 연습/실전이 저장된 값으로 구분되고, 실전의 도움 차단은 화면뿐 아니라 API에서도 강제되어야 한다. 충분한 답변에는 불필요한 꼬리질문을 만들지 않아야 한다.
- **음성:** 단순한 5초 침묵 때문에 자동 제출되지 않아야 하며, 승인한 종료 방식으로만 넘어가야 한다. 면접관 발화 중 입력과 질문 종료 후 입력 전환을 각 음성 경로에서 확인해야 한다.
- **평가·리포트:** 원전사와 학생 수정본을 구분한 근거로 평가하고, 질문을 선택하면 해당 질문의 평가가 연결되어야 한다. 확정된 평가 기준에 따른 반복 요청과 학생 조절이 저장되어야 한다.
- **퀴즈:** 실제 발행 데이터에 객관식 문항이 공급되어야 하며, 결과는 요약을 먼저 보여주고 답변 상세는 사용자가 선택했을 때 열려야 한다.

# AI 비서 대화와 첨부 자료

> 현행 계약·검증 갱신: 2026-10-14. [문서 적용 순서](document-authority.md)와 [서비스 PRD v2.2](../확정안/4.%20서비스_PRD_v2.2.md)를 따른다. [개선·검증 요약](learning-remediation.md)과 [후속 QA](../.local/learning-remediation-2026-10-14/report.md)·[화면 보고서](../.local/learning-remediation-2026-10-14/report.html)에 실제 API/저장값·학교 등록·같은 질문의 학습 연결 검증을 기록했다. 아래 이전 테스트와 화면은 당시 범위로 보존한다. 실제 OAuth·Live/STT·장기 회상·88교 전 학과 콘텐츠 품질·운영 보안은 후속 인수 게이트이며, 이번 결과가 모든 기능이나 실제 학습 효과의 완료를 뜻하지 않는다.

## 2026-10-14 학습 도움의 서버 증빙

각자ON은 전체 서비스 이름이며 이 화면은 **AI 비서**다. 비서 대화의 설명·예시 문장은 학생의 실제 제출 답변이나 승인 사실로 자동 저장하지 않는다. 추천 질문은 바로 전송되고, 학생 입력은 오른쪽·AI 응답은 왼쪽에 Markdown을 보존해 표시하는 기존 동작을 유지한다.

면접 도움 요청은 `interviewSessionId,interviewTurnId`, 과제 도움은 `assignmentId,assignmentItemId`, 퀴즈 도움은 `quizSessionId,quizItemIndex`를 함께 전달한다. 서버가 해당 학생의 고정 질문·지원처·발행 버전/공통 revision과 현재 항목을 확인한다. 첫 유효 응답 조각을 노출하기 전에 부분 응답과 도움 증빙을 함께 저장한다. 같은 receipt를 `partial`→`completed` 또는 `interrupted`로 갱신하며, 중단된 부분 답변도 도움을 확인한 시도로 남긴다. 출력 없는 실패는 AI 도움을 만들지 않으며 완료 학습으로 집계하지 않는다.

대화를 열거나 일시정지에서 돌아오기만 한 것은 실제 AI 응답 사용과 다르다. 근거 자료 조회는 자료 도움으로 별도 기록한다. 정상·새 탭·재접속 모두 서버의 시도별 도움 기록을 사용하며 sessionStorage의 값이 증빙을 대체하지 않는다. 첨부는 미검수 참고 자료이며 학교 공식 기준·학생부 사실·승인 정답으로 승격하지 않는다.

대화는 최초 선택한 학생·지원 학교·질문·활동·발행 자료 버전에 고정된다. 이름 변경이나 보관은 이 맥락과 원래 학습 기록을 바꾸지 않는다.

## API 계약

| 요청 | 동작 |
| --- | --- |
| `GET /api/chat` | 활성 대화 목록, 최근 80개 |
| `GET /api/chat?view=archived` | 보관한 대화 목록 |
| `GET /api/chat?threadId=UUID` | 소유한 대화, 메시지, 고정된 자료. 보관한 대화도 읽을 수 있음 |
| `PATCH /api/chat` | `{threadId,action:'rename'\|'archive'\|'restore'\|'delete',title?}` |
| `DELETE /api/chat?threadId=UUID` | 기존 삭제 API와 호환하는 숨김 처리 |
| `POST /api/chat/attachments` | `multipart/form-data`, `files` 또는 `file` 필드. `{attachments:[{id,name,mime,kind,size,createdAt,url}]}` |
| `DELETE /api/chat/attachments?id=UUID` | 아직 보내지 않은 첨부 초안 제거 |
| `GET /api/chat/attachments/UUID` | 본인만 받을 수 있는 원본 다운로드 |

삭제는 `deleted_at`으로 숨긴다. 원래 답변과 그 답변의 학습 근거는 남고, 삭제한 대화의 원본 첨부 다운로드는 차단한다. `restore`로 복원할 수 있다. 보관한 대화에서 새 질문을 보내려면 먼저 복원한다. 응답 작성 중에는 이름 변경·보관·삭제·복원을 거절한다.

## 실제 응답 스트리밍

기존 JSON 전송 API도 유지한다. `POST /api/chat` 본문에 `stream:true`, 선택적으로 `attachmentIds:[UUID]`를 보내면 SSE를 반환한다.

- `start`: `threadId`, 저장한 `userMessage`, 예약한 `assistantId`
- `delta`: 제공자가 보내는 실제 부분 답변 `delta`
- `done`: 엄격한 답변·근거 검증 후 저장한 `message`, `userMessage`, `contextChanged`
- `pending`: 같은 `requestId`의 응답이 아직 진행 중일 때만 반환. 새 제공자 요청을 만들지 않는다.
- `error`: `error`, `code`, `threadId`, `messageId`. 일부 토큰을 받았더라도 완료한 답변으로 바꾸지 않는다.

처음 전송한 응답에서 대화 ID를 받기 전에 끊겨도 같은 `requestId`로 재시도하면 기존 대화를 찾는다. 전송된 부분 답변을 0.5초 간격으로 PostgreSQL에 저장한다. 연결이 끊기거나 검증에 실패하면 부분 답변은 `failed`로 남는다. 2분 이상 남은 예약도 다시 조회할 때 실패 상태로 복구한다. 실패·작성 중 답변을 완료한 학습 결과로 계산해서는 안 된다.

## 첨부 자료

한 번에 3개, 한 개당 15MB. 실제 업로드 바이트 수를 확인하므로 `Content-Length` 없는 요청에도 제한을 적용한다. 확장자·선언된 MIME·파일 시그니처를 확인하며 SVG·HTML·실행 파일은 받지 않는다.

- TXT·MD: UTF-8 원문. 한 문서 최대 10만 자, 한 요청 합계 16만 자.
- DOCX: 제한된 ZIP 해석으로 본문 XML만 텍스트로 읽는다. 압축 해제 크기 제한과 경로 검사를 적용하며 매크로·암호·외부 엔티티 문서는 거절한다. 머리말·꼬리말·이미지·내장 객체는 읽지 않는다.
- PDF: 제공자의 원본 문서 입력으로 전달한다.
- PNG·JPEG·WebP·GIF: 제공자의 이미지 입력으로 전달한다.

전송 메시지에는 첨부 이름·용량·인증된 다운로드 주소를 기록한다. 후속 질문에서는 명시적으로 다시 선택한 파일을 우선하고 최근 첨부 최대 3개를 재로딩한다. 파일은 사용자가 제공한 미검수 참고 자료이며, 승인된 학생부 경험이나 공식 입학 기준으로 편입하지 않는다.

로컬 모드는 공개 폴더 바깥 `.local/private-chat-files`에 원본을 저장한다. Supabase 모드는 개인 `student-chat-files` 버킷과 소유자 정책을 사용한다. 자료 저장이나 제공자의 문서·이미지 처리가 실패하면 명시적 오류를 반환한다. 원문이 제공자에게 전달되므로 앱의 첨부 전송 행동이 확인된 경우에만 요청한다.

## 이전 기능 검증 기록

`node tests/assistant-workspace.mjs`는 첨부 형식 검증 23개를 실행한다. `--postgres`는 로컬 PostgreSQL에만 테스트 학생 2명을 생성해 실제 예약·저장·잠금·복원·SSE·중단·타인 접근 검증 50개를 추가한다. 완료 후 테스트 학생과 메시지·원본 파일을 제거한다. 제공자 어댑터는 검증용이며 실제 외부 AI 요청은 하지 않는다.

Migration: `supabase/migrations/202610120015_assistant_workspace.sql`. 실제 제공자의 파일 이해 정확도, 배포 Supabase 저장 권한, 브라우저 화면은 별도 통합 QA로 확인해야 한다.

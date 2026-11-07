# Authenticated evaluation transport v1

F의 새 command와 기존 E handoff payload, 서버가 별도로 설치하는 reviewer trust의 구조 projection이다. `generated.schemas.json`은 Draft-07이며 전체 Draft 2020-12 지원이나 평가 승인을 뜻하지 않는다. 기존 다섯 제안 envelope, 학생 분석·질문·검수·평가 정본을 대체하지 않는다.

실제 TS caller는 원래 `JSON.stringify` hash·서명, 원문 TEXT/UTF-8 hash, UTF-16 인용·packet·실제 답변·frozen input, 현재 계정·검수자·키·철회와 SQL generation/lease를 추가로 검증한다. 구조 검증만으로 reviewer가 생기거나 작업이 runnable해지지 않는다. Python으로 이 JSON Schema를 읽어도 이 도메인 권한까지 검증한 것으로 표현하지 않는다.

E의 원본 handoff/session과 `evaluationApprovalGranted:false`는 보존한다. F의 소비·승인·job/result/revision과 조회 projection은 별도다. 멱등 fingerprint는 version/session/action/payload를 포함하고 CAS generation·key와 구분한다. consume payload는 handoff와 승인 SHA를 명시하여 승인 변경을 새 입력으로 구분한다.

재생성: `npx tsx scripts/export-authenticated-evaluation-schemas.ts`. 일치 검사: `npm run verify:evaluation-contracts`. 실제 정상·거부와 원문/권한·도메인 검증은 `tests/evaluation-writer`와 기존 평가·검수 suite를 각각 따른다.

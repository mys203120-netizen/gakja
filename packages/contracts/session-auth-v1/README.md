# Authenticated session v1

새 인증 세션의 runtime은 `authenticated-session-runtime-v1`, owner.mode는 `authenticated`다. 기존 `session-runtime-v1`·local owner와 저장 bytes를 바꾸지 않는다. DB scope/row revision/writer generation/operation token은 이 runtime의 논리 epoch와 별도 권위다.

`generated.schemas.json`은 command/envelope 및 알려진 session/runtime 구조의 Draft-07 projection이다. command의 payload는 각 실제 action의 현행 validator가 추가로 검사한다. 원래 JSON text의 SHA, context `JSON.stringify` pin, owner binding과 현행 질문·원문·승인 의미 검증은 TS codec/caller가 추가로 검사한다. JSON Schema 통과가 도메인 승인이나 전체 Draft2020-12 지원은 아니다. 알 수 없는 기존 runtime metadata를 projection으로 재직렬화하지 않는다.

새 transport의 sessionJson/contextJson은 원본 text와 별도 raw SHA를 가진다. JSONB는 조회용 projection이며 정본·서명·기존 hash 입력의 대체물이 아니다. 생성은 새 인증 세션에만 적용하고 기존 파일을 일괄 변환하지 않는다. codec은 권한을 발급하지 않으며 A/B가 현재 확인한 owner를 decode의 필수 인자로 받는다.

재생성/검사: `npx tsx scripts/export-authenticated-session-schemas.ts [--check]`. 정상·거부와 bytes/ID/UTF-16 보존 fixture는 `tests/session-writer/authenticated-session.unit.test.ts`에서 실행한다.

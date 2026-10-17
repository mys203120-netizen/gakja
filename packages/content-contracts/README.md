# 콘텐츠 계약 1.2.0

> 현행 계약·검증 갱신: 2026-10-14. 아래 새 적용 규칙은 기존 발행본을 보존한다. [개선·검증 요약](../../docs/learning-remediation.md)과 [후속 QA](../../.local/learning-remediation-2026-10-14/report.md)·[화면 보고서](../../.local/learning-remediation-2026-10-14/report.html)에 계약·API·저장값·학습 연결의 확인 범위와 잔여 인수 게이트를 기록했다. 이전 테스트는 당시 범위로 유지하며 실제 OAuth·Live/STT·장기 회상·88교 전 학과 콘텐츠 품질·운영 보안의 완료를 선언하지 않는다.

## 2026-10-14 지원처·과거 발행본 호환

현행 제품 결정은 [서비스 PRD v2.2](../../확정안/4.%20서비스_PRD_v2.2.md), 문서 역할은 [적용 순서](../../docs/document-authority.md)를 따른다. 신규 입력은 외부 검수된 FINAL 가이드북 HTML 한 파일이며 기존 두 책/발행본을 삭제하지 않는다.

`SupportTarget.interview_stage?: string`는 선택 필드이며 명시한 값은 비어 있지 않은 문자열이어야 한다. 학습 연결의 `learningTargetIdentityMatches`는 대학·캠퍼스·학과·학년도·전형을 확인하고 단계가 양쪽에서 알려졌을 때만 비교한다. 누락/미정/확인 필요는 그 자체로 변경의 증거가 아니다. 공식 학교 프로필의 `schoolProfileIdentityMatches`는 별도의 엄격한 적용 검사를 유지한다.

원래 리포트·세션·발행본의 질문/원문·지원처 스냅샷은 현재 콘텐츠와 구분한다. 학생 답변·도움 증빙·자기 확인·실제 새 시도는 승인 교재 데이터를 덮어쓰지 않는다. 기존 플래그가 없다는 이유로 독립 수행을 추정하지 않는다. 이번 개정의 회귀 테스트 결과는 코드/통합 검증 기록에서 별도로 확인한다.

서버가 외부 제작 HTML을 검사하고, 검수된 JSON만 DB와 학생 화면에 전달하기 위한 패키지다. 원본 HTML은 비공개 파일로 보존한다.

```ts
import { parseLearningHtml, validateGuidebook } from '@gakja/content-contracts';

const parsed = parseLearningHtml(uploadedFinalGuidebookHtml);
const result = validateGuidebook(parsed.pack, {
  studentId: registeredStudent.id,
  productionJobRef: registeredProduction.job_ref,
  registeredTargetIds: registeredSupportTargets.map(target => target.id),
});
// result.learning, result.documents, result.packageId,
// result.contentVersion, result.learningHash
// parsed.fileHash is the SHA-256 of the actual UTF-8 HTML file.
```

`parseLearningHtml`은 10 MiB 이내 UTF-8 HTML에서 정확히 하나의 `application/json#gakja-learning-pack`을 읽는다. 실행 스크립트·이벤트·iframe·외부 리소스는 거부한다. 같은 종류의 책 본문 `main[data-document-kind]`도 필요하다. 관리자 API는 별도로 업로드 크기를 제한할 수 있다. 파서 결과와 계약 검사는 파일 내용만 검증하므로 업로드·학생 배정·발행 권한, DB에 등록된 지원처의 실제 학교·캠퍼스·학과·전형·연도 일치는 별도로 서버에서 검사한다.

## 외부 최종 가이드북 한 파일

외부 제작·기획 검수를 완료한 HTML에 아래 두 요소를 넣는다. JSON 내용은 `LearningPack` 전체이며, 화면 본문을 읽어 AI가 학습 문제를 새로 생성하지 않는다.

```html
<main data-document-kind="guidebook">최종 교재 본문</main>
<script type="application/json" id="gakja-learning-pack">
  { "schema_version": "1.2.0", "…": "LearningPack의 전체 필수 필드" }
</script>
```

위 JSON은 구조를 설명하는 예시이며 업로드 가능한 완성 데이터가 아니다. 실제 필드와 확정 목차는 `src/index.ts`의 `LearningPack`, `LearningData`, `FINAL_TOC`를 따른다. JSON 문자열의 `<`, `>`, `&`는 각각 `\u003c`, `\u003e`, `\u0026`로 직렬화한다. 안전한 테스트 HTML은 `renderLearningHtml`로 만들 수 있다.

`validateGuidebook`은 다음을 확인한다.

- 문서 종류가 `guidebook`, `package_status`가 `reviewed`인지 확인한다. `provenance.production_ref`, `review_ref`, `reviewed_at`, 계약 버전을 필수로 받는다. 외부 승인 여부의 진위는 기획팀 검수 기록과 대조해야 한다.
- 학생 ID, 서버의 제작 건, 교재에 포함된 지원처 ID, 모든 학습 참조와 SHA-256 해시가 일치해야 한다. 등록된 지원처 중 이번 교재에 포함할 지원처만 명시할 수 있다.
- 모든 활동은 교재에 포함한 **각 지원처마다** `priority_assignments`에 S/A/B/C/F, 판정 사유, 원문 근거 ID와 분석 기준 버전을 갖는다. 이는 면접 준비 우선도이며 학생의 실력 점수가 아니다.
- 지원처별 `talent_tags`, `major_relevance`, `representative_candidate`, `representative_reason`는 선택 필드다. 대표 활동 후보가 `true`이면 사유가 필요하다. 학생부 사실 확인은 공통 활동의 `fact_confirmation`에 유지한다.
- 모의면접에 사용할 검수된 질문과 해당 질문에 연결되어 웹에서 풀 수 있는 검수된 퀴즈가 적어도 하나 필요하다. `choice`는 선택지가 정확히 4개여야 한다. `order`는 교재의 순서 훈련으로 보존하지만 현재 웹 퀴즈에는 나오지 않으므로 순서 항목만으로는 발행할 수 없다. `memory_items[].question_id`와 `activity_ids`로 활동 → 질문 → 퀴즈를 연결한다. 개인 활동을 참조하지 않는 대학·전공 일반 질문도 허용한다.
- 활동 원문·질문 의도·필수 답변 요소·검수된 정답은 외부에서 작성한 데이터를 그대로 사용한다. 개인 경험을 문장 일치로 정오 판정하거나 확인되지 않은 경험을 객관 정답으로 만들지 않는다.

개정판은 `content_version`과 필요한 `document_revision`을 올린다. 동일 활동·질문·퀴즈의 의미가 유지되면 ID를 유지하고, 의미가 달라지면 새 ID를 작성한다. 계약 검사는 기존 DB의 학습 기록을 수정하지 않는다. 서버는 이전 콘텐츠 버전·답변·풀이 스냅샷을 보존한 채 새 버전을 발행해야 한다.

## 기존 가이드북·핸드북 쌍

`validatePair(packs, context)`는 기존 두 파일을 사용하는 시드와 등록 자료의 호환성을 위해 유지한다. 신규 최종 가이드북 업로드에는 `validateGuidebook`을 사용한다.

스키마 1.2.0, 두 책의 패키지·버전·학습 해시·제작 건, 전체 최종 목차 v1.1의 제목·순서·두 단계 위계, 모든 절의 본문 block, ID 중복, 활동·질문·발화본·원문·지원처·암기 참조를 검사한다. 목차는 `document.sections[].children`이고, 본문은 `document.blocks`에서 `section_id`로 연결된다. JSON hash는 객체 키를 재귀 정렬하고 배열 순서를 유지한다.

`createDemoPack(studentId, name, 'environment' | 'biology')`는 가상 학생 데이터와 가상 대학 이름을 명시한 완성 목차의 두 책을 만든다. 각각 8개 활동, 15개 질문(활동·공통 12개와 개념 3개), 답변 설계·발화본·문장별 근거·12개 암기 항목을 포함한다. 암기 `kind`는 `choice`, `order`, `keyword_recall`, `flip_card`다. 계약은 검수된 단답형 `short_answer`와 발화형 `short_speech`도 지원한다. 개인 경험은 `self_check`로 점검하고 객관 개념만 검수된 정답을 사용한다. 테스트 등급·지원처는 실제 판단 기준이나 실제 대학 정보가 아니다.

`renderLearningHtml(pack)`은 검증된 block과 JSON에서 테스트용 HTML을 생성한다. JSON의 `<`, `>`, `&`를 이스케이프한다.

```powershell
npm run typecheck --workspace=@gakja/content-contracts
npm run test --workspace=@gakja/content-contracts
```

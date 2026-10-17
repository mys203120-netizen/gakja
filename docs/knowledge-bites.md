# 지식한입

> 현행 계약·검증 갱신: 2026-10-14. [문서 적용 순서](document-authority.md)와 [서비스 PRD v2.2](../확정안/4.%20서비스_PRD_v2.2.md)를 따른다. [개선·검증 요약](learning-remediation.md)과 [후속 QA](../.local/learning-remediation-2026-10-14/report.md)·[화면 보고서](../.local/learning-remediation-2026-10-14/report.html)에 실제 API/저장값·학교 등록·같은 질문의 학습 연결 검증을 기록했다. 아래 이전 테스트와 화면은 당시 범위로 보존한다. 실제 OAuth·Live/STT·장기 회상·88교 전 학과 콘텐츠 품질·운영 보안은 후속 인수 게이트이며, 이번 결과가 모든 기능이나 실제 학습 효과의 완료를 뜻하지 않는다.

## 2026-10-14 현재 제공 범위

현재 큐레이션은 검증된 영어 영상 21개·6개 분야와 학교 공식 정의 읽기다. 아래의 초기 10개 목록은 2026-10-12의 출처 기록이며 이후 확장 11개를 포함한 현행 카탈로그와 함께 읽는다. 학과 원본 조합 3,934의 모델 연결과 선택 가능 3,884의 실제 학교 등록 범위를 구분한다. 전체 학과별 교육과정·전용 영상·학습 효과를 확인한 자료는 아니다.

학생부 전반 → 학과 기초·인접 개념 → 학교 공식 정의를 하나의 자료 선반에서 제공한다. 실제 활동·확인된 계획·공식 학교 정보·외부 확장 개념을 다른 출처로 유지한다. 학교 정보가 학생의 새 활동으로 추가되거나 검색 결과가 검증된 영상으로 표시되지 않는다.

내 설명·회상·같은 질문 면접·전후 답변은 같은 지원처와 출처를 유지한다. 도움 사용은 시도 단위로 기록하고, 읽음 체크/설명 저장/자가평가로 무도움 성공을 판정하지 않는다. 관련이 없는 다른 활동이나 다른 학교의 답변을 자동 재사용하지 않는다.

`/knowledge`는 발행된 학생부 활동·독서 제목·학습 키워드와 연결된 공개 학습 영상을 보여준다. `/knowledge/[YouTube 영상 ID]`에서 연결 활동을 열고, 영상을 보러 가거나 저장·시청 체크·메모를 남길 수 있다.

추천은 서버 내부의 명시적인 주제 사전으로 계산한다. 활동의 `source_ref_ids`에 연결된 발행 원문 인용도 주제 매칭에 반영하며, 관련 없는 다른 원문은 섞지 않는다. 학생부 원문, 학생 이름, 개인 답변을 외부 서비스에 전송하지 않는다. 제목이나 썸네일을 AI가 생성하지 않는다. 현재 큐레이션과 일치하지 않는 활동은 **더 찾아볼 주제 / YouTube 검색**으로 구분하며, 검색 결과를 검증된 영상처럼 표시하지 않는다. 독후감에 책 제목이 있으면 검색 주제로 보존한다.

## 영상 출처

2026-10-12에 아래 출판자 페이지와 YouTube oEmbed에서 영상 ID·제목·채널·썸네일 URL을 확인했다. 실제 영상은 외부 YouTube에서 재생하며, 앱은 썸네일을 다운로드하거나 재배포하지 않는다. 한국어 짧은 제목은 탐색용 편집 제목이며 원본 제목과 채널을 함께 표시한다. 초기 큐레이션은 영어 영상으로 구성되며 자막 언어·개별 학습 효과를 추정하지 않는다.

| 주제 | 원본 영상 / 출판자 |
|---|---|
| 미세플라스틱 | [3 surprising ways microplastics can enter your body](https://www.youtube.com/watch?v=lQRsqMiBTsI) · [TED-Ed 출판자 페이지](https://www.ted.com/talks/ted_ed_3_surprising_ways_microplastics_can_enter_your_body) |
| 플라스틱 | [What really happens to the plastic you throw away](https://www.youtube.com/watch?v=_6xlNyWPpB8) · [TED-Ed 원본](https://ed.ted.com/lessons/what-really-happens-to-the-plastic-you-throw-away-emma-bryce) |
| 수질·정수 | [How the water you flush becomes the water you drink](https://www.youtube.com/watch?v=SYia4zqcE4g) · [TED-Ed 원본](https://ed.ted.com/lessons/how-the-water-you-flush-becomes-the-water-you-drink-francis-de-los-reyes) |
| 녹지·기후 | [Does planting trees actually cool the planet?](https://www.youtube.com/watch?v=bbxmH_Kj7fk) · [TED-Ed 원본](https://ed.ted.com/lessons/does-planting-trees-actually-fight-climate-change-carolyn-beans) |
| 탄소 순환 | [The carbon cycle](https://www.youtube.com/watch?v=A4cPmHGegKI) · [TED-Ed 원본](https://ed.ted.com/lessons/the-carbon-cycle-nathaniel-manning) |
| 항생제 내성 | [What causes antibiotic resistance?](https://www.youtube.com/watch?v=znnp-Ivj2ek) · [TED-Ed 원본](https://ed.ted.com/lessons/how-antibiotics-become-resistant-over-time-kevin-wu) |
| 생물다양성 | [Why is biodiversity so important?](https://www.youtube.com/watch?v=GK_vRtHJZu4) · [TED-Ed 원본](https://ed.ted.com/lessons/why-is-biodiversity-so-important-kim-preshoff) |
| 효소 | [Enzymes (Updated)](https://www.youtube.com/watch?v=qgVFkRn8f10) · Amoeba Sisters |
| 삼투 | [Osmosis and Water Potential (Updated)](https://www.youtube.com/watch?v=L-osEc07vMs) · Amoeba Sisters |
| 유전자 발현 | [Protein Synthesis: Transcription and Translation (Updated)](https://www.youtube.com/watch?v=oefAI2x2CQM) · Amoeba Sisters |

썸네일: `https://i.ytimg.com/vi/[확인된 ID]/hqdefault.jpg`. 게시자가 영상을 삭제하거나 네트워크가 차단하면 썸네일은 주제·재생 아이콘으로 대체된다. 새 영상을 큐레이션에 추가할 때는 출판자 원본과 oEmbed를 다시 확인한다. YouTube API 키는 현재 구현에 필요하지 않다.

## 저장과 접근 제어

- `/api/knowledge-bites` GET: 로그인한 학생의 발행 자료에 연결된 영상, 이전에 저장한 영상, 자신의 진행 상태만 반환한다. 응답은 `private, no-store`.
- POST `action=save|complete|reflection|explanation|self_check`, `videoId`, `value`, `expectedRevision`: 인증된 학생 자신의 행만 갱신한다. 임의 영상 ID·다른 학생의 학습 영상·staff/admin 저장 요청을 거절한다. `studentId` 같은 추가 입력으로 소유자를 바꿀 수 없다.
- `다 봤어요`는 학생이 직접 누른 체크이며 자동 재생 추적이나 실제 시청 시간 측정으로 표현하지 않는다. 앱 밖에서 영상을 열어도 자동으로 시청 완료 처리하지 않는다.
- `knowledge_bite_progress`에 현재 상태와 연결 활동·발행 버전을 저장하고, `knowledge_bite_revisions`에 변경 이력을 보존한다. 동시 수정은 PostgreSQL 트랜잭션 잠금 및 수정 번호로 보호한다. 동일 내용 재시도는 중복 이력을 만들지 않는다.
- 메모는 최대 4,000자. 임시 입력은 사용자·영상별 세션 저장소에 보존하며 명시적으로 **메모 저장**을 눌렀을 때만 서버에 저장한다. 로그아웃 시 기존 `gakja-` 저장소 정리 대상에 포함된다.
- 발행 자료가 바뀌어도 이전에 저장한 영상의 연결 활동 기록을 보존하며, 현재 활동 추천과 구분한다.

## 확인 명령

현재 약점 추천, 영상 후 자기 설명, 같은 질문 면접·퀴즈 연결, 수정 이력의 질문 맥락은 [지식한입과 계획의 학습 연결](learning-flow-knowledge-planner.md)에 정리했다.

```text
node --import tsx --test tests/knowledge-bites.test.ts
node --import tsx tests/knowledge-bites-api.mts
```

단위 검사 14개는 정확한 활동 연결, 독서 주제와 연결 원문, 영문 짧은 단어 경계, 검색 URL 인코딩, 출처·썸네일 ID, 실제 질문 추천과 복수 약점이 있을 때의 분야 분산을 검증한다. API 검사 49개는 로컬 전용 합성 학생과 임시 콘텐츠만 생성하여 접근 제어·소유권·동시 수정·이력·발행 상태·질문 맥락·자기 설명 이벤트를 검증하고 자신의 UUID 자료만 정리한다. 외부 API 호출이나 실제 학생 자료 변경은 하지 않는다.

## 2026-10-13: 학생부 전반으로 넓힌 추천

영상 사전을 10개에서 **21개, 6개 분야**로 확장했다. 과학·환경뿐 아니라 수학·자료, 학습·사고, 공동체·사회, 인문·예술, 기술·진로를 다룬다. 학과 이름만으로 관심이나 경험을 추정하지 않는다.

- 교과 탐구·실험, 자율·동아리·공동체 활동, 독서의 발행된 본문·역할·과정·배움·연결 원문에서 주제를 찾는다.
- 확인된 진로 목표·학업 계획과 원문 출처가 있는 진로 흐름도 연결한다. 대학 인재상·모범답안·확인되지 않은 목표를 학생 경험으로 처리하지 않는다.
- 활동으로 묶이지 않은 `student_record` 원문도 해당 원문으로 연결한다. 추천 DTO와 저장 이력의 `contexts`는 활동·목표·계획·진로 흐름·학생부 기록을 구분한다. 계획을 과거 활동이나 새 면접 질문으로 만들어내지 않는다.
- 각 영상의 `stretch`는 기록에서 한 단계 넓혀볼 개념이다. 예: 역할 조율 → 경청, 측정값 비교 → 그래프 표현, 환경 실천 → 공동 자원의 선택과 규칙. 새로운 사실이 이미 학생부에 있다고 단정하지 않는다.
- 현재 연습 질문에 연결된 영상을 첫 추천으로 유지한다. 이후 사용 가능한 분야를 번갈아 보여주고, 각 분야 안에서는 현재 질문 → 복습할 질문 → 현재 기록 → 과거 저장 기록의 우선순위를 유지한다. 여러 환경 탐구 약점 때문에 첫 화면 전체가 과학 영상으로 채워지지 않도록 한다. 주제 분야 필터는 실제로 연결된 분야만 표시한다.
- 독서 제목의 검색 링크는 더 넓은 개념 영상이 연결돼도 보존한다. 검증되지 않은 주제는 썸네일 없는 YouTube 검색으로 구분한다.
- 영상 후 내 설명·메모·자기 확인은 원래 저장/수정 이력과 학습 이벤트에 누적한다. 기록 전용 추천은 실제 활동·질문 ID가 없으면 빈 값으로 두며, 원문 출처·기록 종류·확장 개념은 별도로 남긴다.

추가 영상 11개는 2026-10-13에 TED-Ed 출판자 원본의 영상 ID와 YouTube oEmbed 제목·채널·썸네일을 확인했다. oEmbed 결과: `.local/knowledge-videos-verified-2026-10-13.json`.

| 확장 주제 | 출판자 원본 / 확인된 영상 |
|---|---|
| 자료 해석 | [TED-Ed](https://ed.ted.com/lessons/how-to-spot-a-misleading-graph-lea-gaslowitz) · [How to spot a misleading graph](https://www.youtube.com/watch?v=E91bGT9BjYk) |
| 근거 검토 | [TED-Ed](https://ed.ted.com/lessons/5-tips-to-improve-your-critical-thinking-samantha-agoos) · [5 tips to improve your critical thinking](https://www.youtube.com/watch?v=dItUGF8GdTw) |
| 연습과 학습 | [TED-Ed](https://ed.ted.com/lessons/how-to-practice-effectively-for-just-about-anything-annie-bosler-and-don-greene) · [How to practice effectively](https://www.youtube.com/watch?v=f2O6mQkFiiw) |
| 경청과 협업 | [TED-Ed 큐레이션](https://ed.ted.com/best_of_web/foptnjVE) · [Being A Good Listener — The School of Life](https://www.youtube.com/watch?v=-BdbiZcNBXg) |
| 공동 자원 | [TED-Ed](https://ed.ted.com/lessons/what-is-the-tragedy-of-the-commons-nicholas-amendolare) · [What is the tragedy of the commons?](https://www.youtube.com/watch?v=CxC161GvMPc) |
| 정보와 미디어 | [TED-Ed](https://ed.ted.com/lessons/how-to-choose-your-news-damon-brown) · [How to choose your news](https://www.youtube.com/watch?v=q-Y-z6HmRgI) |
| 관찰과 발견 | [TED-Ed](https://ed.ted.com/lessons/how-simple-ideas-lead-to-scientific-discoveries) · [How simple ideas lead to scientific discoveries](https://www.youtube.com/watch?v=F8UFGu2M2gM) |
| 알고리즘 | [TED-Ed](https://ed.ted.com/lessons/your-brain-can-solve-algorithms-david-j-malan) · [What's an algorithm?](https://www.youtube.com/watch?v=6hfOvs8pY1k) |
| 윤리와 선택 | [TED-Ed](https://ed.ted.com/lessons/would-you-sacrifice-one-person-to-save-five-eleanor-nelsen) · [Would you sacrifice one person to save five?](https://www.youtube.com/watch?v=yg16u_bzjPE) |
| 음악 읽기 | [TED-Ed](https://ed.ted.com/lessons/how-to-read-music-tim-hansen) · [How to read music](https://www.youtube.com/watch?v=ZN41d7Txcq0) |
| 시장과 기대 | [TED-Ed](https://ed.ted.com/lessons/what-causes-economic-bubbles-prateek-singh) · [What causes economic bubbles?](https://www.youtube.com/watch?v=I5ZR0jMlxX0) |

하린 테스트 계정의 발행된 합성 학생부를 읽기 전용으로 확인했다. **8개 활동 모두 연결, 13개 영상·5개 분야**. 잔반 프로젝트, 수학 학습 기록, 동아리 역할 조율도 추천에 포함된다. 확인된 통계 학업 계획은 그래프 자료 해석 영상에 계획 출처로 연결된다. 기존 콘텐츠·학교·답변·시청 이력을 수정하지 않았다. 범위 확인: `.local/knowledge-breadth-2026-10-13.json`.

영상 21개가 모든 학생부 주제를 완전히 다루지는 않는다. 현재 공개 영상은 영어 콘텐츠이며, 자막 제공 여부나 학습 효과를 추정하지 않는다. 자동 YouTube 검색 결과를 검증된 영상으로 승격하지 않는다.

## 2026-10-13: 선택한 대학·학과까지 하나의 학습 흐름

`GET /api/knowledge-bites?targetId=지원처ID&questionId=공통질문ID`는 내 발행 학생부와 선택한 대학·학과를 함께 사용한다. 지원처를 지정하지 않으면 계정의 저장된 선택을 우선하고, 없는 경우 내 첫 지원처를 사용한다. 다른 학생의 지원처와 선택 학교에서 사용할 수 없는 질문은 거절한다. 발행 생기부가 아직 없는 신규 계정에도 학교 원문과 학과 학습 렌즈가 제공된다.

- **내 기록**: 교과·동아리·자율·공동체·독서, 확인된 진로 계획과 실제 원문 인용. 기존 연결과 학생별 소유권을 유지한다.
- **학과 연결**: 선택한 대학의 실제 `department_catalog_id`·학과 이름·캠퍼스로 찾은 대학알리미 계열/분류를 사용한다. 간호→항생제·경청·윤리, 경영경제→시장 기대·자료 해석, 전기전자컴퓨터→알고리즘, 음악→악보·연습처럼 기존 검증 영상을 학습 렌즈로 연결한다. 공식 학과 교육과정이나 학생의 과거 경험으로 표현하지 않는다. 수동 입력/미분류 학과도 근거 검토·자료 해석 등 기초 학습을 사용할 수 있다.
- **학교 연결**: 공식 인재상·교육목표·핵심역량의 개별 정의를 원문 읽기 자료로 제공한다. 학교 전체 정의와 학과 추가 정의를 함께 유지하며, 각각의 공식 출처·정의 종류·범위·출처 버전을 보존한다. 대학교 공통 인재상을 학과별 공식 인재상으로 바꾸지 않는다.
- 현재 카탈로그에 직접 대응하지 않는 학과 확장 주제는 **YouTube 검색**으로 구분한다. 검증되지 않은 영상·제목·썸네일·교육과정을 생성하지 않는다.

### 원문 읽기 → 설명 → 퀴즈 → 모의면접 → 비교

`videos` 배열은 기존 호환성을 유지하며 `kind=video|reading`으로 자료 종류를 구분한다. `readings`와 `selectedTarget`도 별도로 제공한다. 읽기 자료는 영상 재생 아이콘이나 가짜 썸네일을 사용하지 않고, 실제 공식 정의와 원문 링크를 보여준다. `내 기록 / 학과 연결 / 학교 연결` 필터와 분야 필터로 한 학습 선반에서 탐색한다.

원문에도 30초 자기 설명, 메모, 스스로 확인, 저장·읽음 체크를 사용할 수 있다. 학교 인재상 질문은 같은 `questionId`, `sourceType=common`, `sourceVersion=commonRevision`, `targetId`를 유지한 채 퀴즈와 모의면접으로 이어진다. 공통 질문에 개인 활동 답변 편집 링크를 만들지 않는다. 개인 경험이 없다면 앞으로 실천할 방법을 설명할 수 있고, 학교 정보가 새 개인 활동으로 추가되지는 않는다. AI 도움과 질문 근거도 개인 발행 버전과 공통 출처 버전을 구분한다.

설명 이벤트에는 질문·출처·공통 revision·지원처·학과/캠퍼스 snapshot이 함께 남는다. 원문 자료 ID는 기존 11자리 저장 제약과 호환되는 `r_` + 9자리 source/target 해시이며, 실제 YouTube ID로 해석하지 않는다. 기존 진행/수정 이력 PostgreSQL 테이블을 재사용한다.

같은 영상도 학교 A → B → A로 바꾸면 이전 학교 A의 설명·메모를 해당 지원처의 마지막 수정 이력에서 복원한다. 현재 main row의 revision을 동시 저장 검사용으로 유지하며, A·B의 원래 수정 이력과 원문 snapshot은 덮어쓰지 않는다. 학과·캠퍼스가 바뀌면 다른 맥락으로 처리한다. PostgreSQL JSONB의 키 재정렬은 같은 맥락을 바꾸지 않는다. 오래된 공통 출처 revision을 보내면 409로 다시 불러오도록 안내한다. 변경된 질문을 새 질문에 붙여서 설명을 재사용하지 않는다.

### 검증

```text
node --import tsx --test tests/knowledge-bites.test.ts tests/knowledge-school-major.test.ts
node --import tsx tests/knowledge-bites-api.mts
node --import tsx tests/knowledge-school-major-api.mts
```

- 기존 학생부 단위 검사 14개와 기존 HTTP/PG 검사 49개 통과.
- 새 대학·학과 단위 검사 6개: JSONB 키 순서, 간호/경영/컴퓨터/음악 렌즈, 타 대학 학과 ID, 미분류 학과, 공식 읽기 질문 범위, 일반 공통 질문의 근거 학습.
- 새 HTTP/PG 검사 21개: 생기부 없는 계정, 원문 자기 설명과 공통 revision, 동일 내용 재시도, 잘못된 revision/다른 학생 목표 차단, 같은 영상 A→B→A 복원, 원래 수정 이력과 이벤트 source snapshot, 공통 revision과 개인 발행 버전 3이 다른 AI 도움 근거 조회. 증거: `.local/knowledge-school-major-api-check.json`.
- 통합 QA 초기 8개 대학·학과 표본 509개 HTTP/PG 검사 및 원문/학과 영상 연결 검사 7개 통과를 기록했다. 이후 같은 작업의 최종 검사 529개·전수 모델 8개는 [학교·학과 검증](school-major-flow-validation.md)에 있다. 원본 3,934개 조합과 선택 가능 3,884개 모집단위는 다른 범위다. 원본 학생 데이터 변경과 유료 AI 호출은 하지 않았다.

공식 학교 원문의 정의 자체는 학교 인재상 자료에서 제공하며, 모든 학과의 공식 교육과정을 별도로 수집했다는 뜻은 아니다. 현재 검증 영상 카탈로그는 21개 영어 영상이다. 주제가 세부 전공과 정확히 일치하지 않으면 명시적인 검색으로 더 찾아볼 수 있다.

# 02_생기부_분석 생성·검수 규격 v0.1 제안

기준: 각자의답 최신 커밋 a666f7a81dd2e80851f8589d135a0aac67c1eae2, MD5 v2.2·MD6 v1.3·MD7 v2.2·MD9/10 v2.3. 작성일 2026-11-06.

이 규격은 현재 TS 분석 엔진을 대체하지 않는다. 현재 FullStudentAnalysis/TargetStudentAnalysis/studentAnalysisCodecV2/StudentObjectiveCandidate를 보존하고 다학생·다지원처·OCR 일반화와 웹 가이드북 조회에 필요한 계약을 추가한다. 제품 승인 전 제안이다.

## 1. 권위와 생성 단위

| 데이터 | 생성 단위 | 권위와 소비자 |
|---|---|---|
| 원본 PDF | owner × record_version | 원문 대조의 시각적 원본, 변경 불가 |
| FullRecordSource | owner × record × extraction_version | 페이지/블록/원문 text·UTF-16 offsets·좌표·hash |
| FullStudentAnalysis | owner × record × extraction × common_policy | 학생 공통 사실·성적·활동·흐름·전범위 처리 |
| TargetStudentAnalysis | common_analysis × target × admission_profile × target_policy | 우선도·지원처 해석·질문목적 |
| StudentObjectiveCandidate | target analysis 내부 stable objective_id | 면접 확인 지점(Probe)의 기반, 질문 내용 자체와 구분 |
| 원문/분석 MD | 해당 JSON revision의 projection | 코드로 렌더하는 검토본, 독립 LLM 생성 금지 |

현재 fullAnalysisIdentity에 target/profile이 포함돼 있다. 신규 common identity에서는 이를 분리한다. 모델·추출기·선택 정책 hash는 원문·결과에 실질적으로 영향을 주는 항목만 포함하고, 목소리나 회차시간을 공통분석 무효화 키로 넣지 않는다. 기존 identity와 revision은 migration mapping으로 보존한다.

## 2. 입력의 사전 조건

- 인증된 owner와 student, 소유권이 검증된 record_version.
- PDF 실제 bytes hash와 일치하는 FullRecordSource.
- 페이지 누락·판독불가·표 구조 오류의 명시 상태. 핵심 오류를 빈값 정상으로 변환하지 않음.
- 실제 extractor lineage: pdfjs native / OpenAI OCR / 혼합 및 page/region별 버전.
- 원문 텍스트를 교정·정규화할 경우 기존 source를 덮어쓰지 않고 새 extraction version. 기존 UTF-16 offset은 해당 canonical pageText에만 유효.
- 개인정보 최소화 model projection은 별도 생성. projection offset과 canonical offset 대응표 필요.
- 정책 rule_id/조항/본문hash/prompt/schema/model snapshot.
- target 작업은 official/참고/미확인의 필드 상태가 있는 profile revision. 학생부 분석과 대학 조회는 병렬 가능.

## 3. 기존 codec에서 반드시 보존할 것

`proof_ref`, `academic_literal`, `interpretation`을 서로 다른 타입으로 유지한다. 인용 dictionary의 사용되지 않은 항목까지 source를 검증한다. 학년/학기/과목/성적체계의 출처와 숫자 literal의 행·열·라벨을 보존한다. source_fragment와 독립 activity를 구별한다.

원문에 존재한다는 판정과 과학적으로 참이라는 판정은 다르다. 학생이 나중에 확인한 주장과 AI 해석도 원문 사실로 승격하지 않는다. 이 차이를 단일 `approved:true`로 축소하지 않는다.

## 4. 공통 분석의 필수 조회 계약

| 영역 | 필수 내용 | 허용 상태 |
|---|---|---|
| coverage | 각 source block/논리 단위가 정확히 한 처리상태를 가짐 | analyzed / excluded_with_reason / needs_review |
| activities | 활동 ID·학년·영역·사실근거·역할·행동·방법·결과·한계·unknowns | 근거 없는 세부값은 unknown |
| academicRecords | 원본 성적값·척도·과목·학기·표 셀·행열 label provenance | unresolved면 비교 불가 |
| trajectories | 학년/활동/교과/진로 변화 관계와 양쪽 근거 | 관찰과 원인해석 별도 |
| wholeRecordAxes | 아래 11개 축별 근거·관찰·준비 지점 | present / no_evidence / needs_review |
| claims | 원문/학생확인/답변/해석 타입과 출처 | verified_in_record ≠ scientifically_verified |
| limitations/QA | 미검토·검사범위·차단사유·승인이력 | 자동검증과 독립의미검수 구분 |

현재 11축은 이미 생성·검증되고 proposal/report에 남는다. 이 목록을 다시 LLM으로 별도 생성하지 말고 검증된 결과를 canonical common projection으로 전달한다.

11축: interest_start, recurring_topic, deepening, cross_subject, grade_year_change, career_change, inquiry_method, community_behavior, strength_evidence, record_gap, fact_check.

원문에 근거가 없는 축은 `no_evidence`로 남긴다. 11축 모두 긍정적인 내용을 채워야 완료되는 모델은 금지한다. 출결·개인 사유 등 민감항목은 면접 적합성 정책에 맞춰 질문 허용범위를 별도 검수한다.

## 5. 지원처 분석과 Probe 호환 확장

현재 StudentObjectiveCandidate의 originKind(activity/academic_record/trajectory/record_gap), knownFacts, unknowns, forbiddenPremises, openCheck, semanticKey, analysisRevision, supportTargetId를 그대로 기반으로 삼는다.

| 보완 필드 제안 | 목적 |
|---|---|
| objective_id (유지) / probe_alias | 새 ID를 중복 발급하지 않고 기존 이력 연결 |
| axis_refs / source_refs | 11축·원문과 확인 지점의 계보 |
| observation | 원문에서 실제 확인한 사실 |
| question_purpose / open_check | 면접에서 아직 확인할 한 지점 |
| admissible_functions | 허용 질문 기능, 실제 발화에 맞는 최종 기능은 별도 |
| forbidden_premises | 단정·왜곡·범위초과 금지 |
| evaluation_scope_template_ref | 일반경험/객관지식의 승인된 요구범위 |
| required_knowledge_refs | 객관 정오가 필요한 경우의 조건부 자료 |
| target_profile_ref | 연도/전형/모집단위·공식 필드 근거 |
| review_status / policy_refs | 생성/검수/격리와 규정 소유권 |

예: 원문상 성적 변화만 확인했으면 원인을 미확인으로 둔다. “성적이 달라졌던 그 시기에 학습 방법을 바꾼 점이 있었나요?”는 후보일 수 있으나, 과목·학기 맥락과 단일 요구를 검수해야 한다. “노력 부족으로 성적이 떨어졌는데”는 금지 전제다. 예시는 실제 학생 자료가 아니다.

## 6. 최초 생성과 심화 보강을 구분

1. 최초 업로드: source 생성/검수 → 초기 v2-compatible common 분석 → target objectives → QA/stage.
2. 기존 common이 있는 경우: seed 사실/성적 원문을 유지 → source batch 소유범위·namespace 검사 → deep synthesis → 11축 및 전체 inventory 검사 → staged revision.
3. `prepare-student-deep-analysis.ts`는 seed가 필요한 현재 심화 보강 도구다. 신규 학생 bootstrap로 그대로 연결하지 않는다.
4. 특정 학생 진로 예시와 고정13/18개 결과문구, plannedCalls5는 일반 작업에서 제거하고 실제 데이터·count로 산출한다.
5. MD 고정 행번호 slice 대신 rule_id로 정책을 선택하고 선택 텍스트 hash를 저장한다.

## 7. 생성·검수·발행의 상태와 관문

| 단계 | 산출물 | 다음 단계 허용 조건 |
|---|---|---|
| S00 계정/지원처 | 소유권·제작건·target | 기본권한/대상 유효. 대학 검증 병렬 시작 |
| S01 원문 | PDF/추출 후보 | 페이지·원문/표·위치 QA, 핵심 판독불가 분리 |
| S02 구조화 | canonical source | 블록/셀/행열·순서·앵커·전체 coverage |
| S03 공통 분석 | common staged revision | 실제 원문/성적 literal·활동·11축·흐름 검수 |
| S04 target 분석 | profile-bound target | 공식/참고/미확인 경계, common hash고정 |
| S05 목적/Probe | objective 후보 | 근거·열린 확인점·금지전제·scope 정합 |
| S06 Q0 콘텐츠 | 승인/격리 후보·참고답변 | 사실성·단일요구·범위·모범답변 허위경험0 |
| S07 조립 | 6목차 manifest | G02전체원문·G04 정확앵커·질문노출registry |
| S08 발행 | publication revision | 전체gate·권한·원자적 pointer·실제 열람 |
| S09 완료 | 알림/운영 이벤트 | publish이후 Outbox, 중복알림 제어 |

실전 start readiness는 질문은행 처리완결 ready와 다르다. mock 노출제외·최근목적이력·검수상태를 적용한 뒤 충분한 적격재고를 검사한다. 단1개 후보가 있다고 완전한 실전모의면접 준비완료로 광고하지 않는다.

## 8. QA와 차단

- 형식: 기존 codec decode 성공, 필수 field, namespace/소유권/버전/FK.
- 원문: quote가 canonical pageText의 정확한 UTF-16 구간이며 hash일치. 반복 숫자/동일문구를 유일하게 binding.
- 성적: 행열/학년/학기/과목/척도 provenance. unresolved 숫자 비교/추세단정 금지.
- coverage: 모든 source 단위가 처리 또는 제외사유 또는 보류로 정확히 분류. 근거미확인 빈값 정상성공 금지.
- 의미: 원문 밖 경험·역할·성과·감정 발명0, 해석/확인/원문 경계 유지. 모델 confidence는 승인 증명 아님.
- Critical: OCR/FACT/ADMISSION/CONTENT/RELATION. 해당 제작건의 차단이력은 재시도 성공으로 지워지지 않으며 수정·재검증·실제 최종승인이 필요.
- 성능: 페이지/analysis batch 재시도는 같은 입력hash의 완료결과 재사용. 공통분석1회와 target확장호출을 별도 계측.

숫자오류0 같은 조건은 검증 corpus의 출시 gate 제안이지 모든 미래 PDF에서 오류가 없다는 보증이 아니다. 대표 native/scanned/mixed·저화질·다페이지·교과표를 holdout으로 구성하고 실패 샘플은 격리·사람검수로 보낸다.

## 9. 활성화·수정·이행

- 공통원문 정정 → 영향받는 common/target/objective/Q0/가이드북을 stale로 표시, 신규 revision만 생성.
- 대학profile 정정 → 해당 target만 재생성, OCR/common 재호출하지 않음.
- 학생 답변메모 수정 → 원문과 과거실전 발화·평가 불변.
- 이미 종료한 세션은 당시 record/target/policy snapshot을 유지. 재평가는 별도 revision.
- active pointer 변경은 expected parent version을 검사하는 DB transaction/CAS로 수행.
- 기존 target-only 활성화가 bank/recovery gate를 어디에서 보장하는지 caller 확인 후 서비스 activation에 통합. 함수 이름만으로 동일 gate라고 가정하지 않음.
- MD/JSON은 같은 projection revision·render hash를 manifest에 기록. 독립 LLM생성 두 정본은 금지.

## 10. 첫 수용 테스트

1. 같은 학생 A지원처 생성 후 B등록: OCR/common 모델호출0, target만 분기.
2. 같은 숫자가 여러 표에 존재: 잘못된셀 binding 거부.
3. unresolved성적행: 추세질문/숫자확정 차단, 다른 검증된 근거는 정책범위내 사용.
4. 11축 중 원문근거없는 축: no_evidence, 허위보완 없음.
5. 재OCR로 pageText 변화: 기존offset 재사용 거부, 과거revision 조회 가능.
6. 역할·경험질문: 승인 record_consistency scope로 정상평가, 학술주장은 검수자료 없으면 보류.
7. 가이드북노출목적과 실전질문목적: 의도alias 포함 제외,연습은 허용.
8. Critical→자동재검수성공: 최종사람승인 전 발행거부.
9. 다른계정 같은파일hash: 개인분석/질문/음성/검색 조회거부.
10. 중복작업·lease만료·다른worker늦은결과: 같은revision중복활성화0.

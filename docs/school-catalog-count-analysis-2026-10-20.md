# 학교 목록 88개 → 80개 원인 확인

확인일: 2026-10-20. 이번 확인은 저장된 데이터·현재 필터·Git 이력을 대조한 결과다. 각 대학의 모집요강을 새로 전수 검증한 결과는 아니다.

원본 8개가 삭제된 것이 아니다. `school-bible.json`과 `school-directory.json`은 모두 88개 학교를 유지한다. 현재 선택 API는 학생부형 면접 준비 범위에 해당하는 80개 학교만 반환한다.

## 변경된 시점과 경로

- 2026-10-17 23:11 KST, 커밋 `71e9d384062ef44efceefbcda36c78a1dfa5275c`: 학생부형 면접에 한정하는 범위가 추가됐다.
- `apps/web/src/lib/school-directory.ts`: 원본을 보존한 `historicalDirectory`에 `schoolHasDocumentInterview()` 필터를 적용한다.
- `apps/web/src/lib/school-interview-scope.ts`: 아래 8개 학교의 제외 분류와 이유가 저장돼 있다. 확인일은 2026-10-17이다.
- `apps/web/src/app/api/schools/catalog/route.ts`: 필터가 적용된 `schoolDirectory`를 반환하므로 가입 화면에도 80개가 표시된다.
- [당시 범위 결정 및 검증 기록](student-record-preparation-2026-10-17.md), [당시 학교별 감사 결과](student-record-flow-audit-2026-10-17.json)에도 같은 80개가 기록돼 있다.

## 제외된 8개 학교

다음은 **현재 앱에 저장된 제외 근거**다. 일부 전형만 지원하는 학교는 별도로 전형·학과 필터를 적용하고 있으며, 아래 표는 학교 전체 선택에서 제외한 경우다.

| 학교 | 현재 코드의 분류 | 저장된 제외 이유 | 저장된 참고 출처 |
| --- | --- | --- | --- |
| 연세대학교 | 제시문 | 활동우수형·국제형·국제인재·기회균형 제시문 면접, 체육인재 확인 면접도 범위 밖 | [입학처 안내](https://admission.yonsei.ac.kr/seoul/admission/html/counsel/dataView.asp?BBS_NO=3500) |
| 부산교육대학교 | 제시문 | 수시 제시문 기반 집단 면접 | [입학처](https://enter.bnue.ac.kr/content/susi01) |
| 경인교육대학교 | 기타 형식 | 공개 공통 문항에 답한 동영상을 제출하는 방식 | [입학처 안내](https://ipsi.ginue.ac.kr/ipsi/CMS/Board/Board.do?board_seq=47508&mCode=MN028&mgr_seq=142&mode=view) |
| 공주교육대학교 | 면접 미실시 | 2027학년도 수시 학생부종합 면접 미실시 | [입학처 요강](https://www.gjue.ac.kr/ipsi/72/pdfViewer/CAT183) |
| 한국에너지공과대학교 | 제시문 | 제시된 과제에 답하는 창의성 면접 | [입학처](https://admission.kentech.ac.kr/ipsi) |
| 영남대학교 | 혼합 형식 | 의예과 제시문·구술 면접 및 군사학과 군 면접 | [입학처](https://enter.yu.ac.kr/) |
| 홍익대학교 | 혼합 형식 | 문제지를 읽고 준비하는 미술 면접과 서류 확인을 함께 실시 | [입학처](https://admission.hongik.ac.kr/) |
| 한국과학기술원 KAIST | 혼합 형식 | 특기자도 적합성·영어 제시문 면접을 포함 | [입학처](https://admission.kaist.ac.kr/undergraduate) |

각 출처의 기존 검증 수준과 원문 대조 범위는 [당시 검증 기록](student-record-preparation-2026-10-17.md)에 남아 있다. 예를 들어 KAIST는 당시 2027 공식 상세 페이지 조회가 실패한 사실을 기록하고 있으며, 이번 분석이 그 확인 상태를 승격하지 않는다.

## 재계산 결과

| 대상 | 현재 수 |
| --- | ---: |
| 원본 바이블 학교 | 88 |
| 원본 학과 공시 학교 | 88 |
| 현재 선택 가능한 학교 | 80 |
| 원본 학교·학과·캠퍼스 조합 | 3,934 |
| 통계용 기타모집단위 및 지원 범위 필터 후 조합 | 3,551 |

현재 80개 학교의 ID는 원본 88개에서 위 8개를 제외한 ID 집합과 정확히 일치한다. 이름 변경·중복 제거·캘린더 누락으로 생긴 차이가 아니다. 원본·과거 지원 정보 접근은 보존돼 있다. 이번 작업에서는 지원 범위나 학교 데이터를 수정하지 않았다.

검증: `node --import tsx --test tests/school-directory.test.mts tests/calendar-presentation.test.ts tests/calendar-source-presentation.test.mts` 28개 통과. `node tests/school-context-render.mjs` 67개 화면 동작 검사 통과.

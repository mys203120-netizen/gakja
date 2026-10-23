# 생기부 원본과 분석 운영

2026-10-23 구현 기준입니다. 기존 PostgreSQL과 `content_versions`를 사용합니다. 추가 저장소 계정이나 API 결제를 자동으로 신청하지 않습니다.

## 배포 순서와 설정

1. `supabase/migrations/202610230001_student_documents.sql`, `202610230002_student_document_guideline_review.sql`, `202610230003_student_document_curriculum_rules.sql`, `202610230004_student_document_ocr_review.sql`을 순서대로 기존 DB에 적용합니다. 앱 bootstrap이 이 테이블을 읽으므로 코드 배포 전에 필요합니다.
2. PDF 텍스트 추출·페이지 렌더는 서버의 `pdf-parse`가, 스캔·혼합 페이지 인식은 `tesseract.js@7.0.0`과 패키지에 포함된 한국어·영문 모델이 수행합니다. OCR에는 추가 환경 변수·유료 API·외부 전송이 없습니다. 파일은 최대 10MB, 60쪽이며 추출문 전체는 120,000자 이하여야 합니다.
3. 자동 분석은 기본 비활성입니다. 아래 서버 환경 변수로 명시적으로 활성화합니다.

```dotenv
STUDENT_DOCUMENT_ANALYSIS_ENABLED=false
# 실제 운영 활성화 시 true로 설정하고 서버의 기존 OPENAI_API_KEY를 사용합니다.
# OPENAI_API_KEY=<서버 비밀 저장소에서 설정>
# STUDENT_DOCUMENT_ANALYSIS_MODEL=<계정에서 사용 가능한 Structured Outputs 모델 ID>
```

`STUDENT_DOCUMENT_ANALYSIS_ENABLED=true`와 `OPENAI_API_KEY`가 모두 있어야 새 분석을 예약합니다. 모델 우선순위는 `STUDENT_DOCUMENT_ANALYSIS_MODEL`, 기존 `OPENAI_MODEL`, 기존 앱 기본값 `gpt-5.6-terra` 순서입니다. `AI_MODE`는 이 기능의 활성화 조건이 아닙니다. 모델 ID의 계정 접근 권한, 해당 모델의 Structured Outputs 지원과 비용은 운영 계정에서 별도 확인해야 합니다. 이번 구현 검증에서는 실제 OpenAI API를 호출하지 않았습니다.

분석 API는 OpenAI Responses의 엄격한 JSON Schema와 `store:false`를 사용합니다. 공급자 정책에 따른 보관 조건까지 없애는 설정은 아닙니다. 업로드 동의 문구에는 원본 고정·비공개 저장과 OpenAI 전송이 표시됩니다. 아직 활성화되지 않은 상태에서도 원본은 보존하고 `unconfigured` 상태를 보여주며, 활성화 후 같은 원본으로 재분석할 수 있습니다.

## 데이터와 처리

- `/student-document`: 학생 본인의 원본 상태, 분석, 원문 인용, PDF/MD 다운로드. 다른 학생 ID를 받지 않습니다.
- `/api/student-document`: GET 상태/소유자 전용 페이지 PNG/다운로드, POST 임시 업로드, PATCH 페이지 확인 후 확정·인식 재시도·정정문 새 버전·재분석. 학생 인증 및 변경 요청의 출처를 확인합니다. 원본을 교체·수정·삭제하는 API는 없습니다.
- 계정당 원본 하나를 DB unique 제약과 행 잠금으로 보장하고, 원본 update는 DB 트리거로 거부합니다. 페이지별 텍스트와 확인 표시, 빈 페이지 여부, 생기부 형태를 검증한 뒤에만 원본을 고정합니다. 검증에 실패해도 임시 추출문을 직접 정정할 수 있습니다.
- 분석은 Next `after()`로 응답 이후 실행됩니다. 배포 플랫폼은 최대 240초 작업을 허용해야 합니다. 5분 이상 중단된 작업은 학생의 재분석 요청에서 실패로 정리하고 새 lease로 재시도합니다. 별도 영구 큐·자동 재시도 워커는 아직 없습니다.
- 분석은 24시간에 최대 3회이며 비활성 상태 요청은 유료 처리 횟수에서 제외합니다. 중복 실행은 하나의 작업으로 합칩니다.
- 스키마, 모든 페이지의 확인 선언, 지원처 일치, 각 원문 인용의 해당 페이지 내 정확한 포함을 검증해야 새 콘텐츠 버전을 발행합니다. 문서 진위나 AI 요약의 모든 의미를 인증하는 검증은 아닙니다. 원문·AI 분석·확인 필요 항목을 분리해 표시합니다.
- 새 버전에는 활동·질문·지원처별 우선도·페이지 근거를 연결합니다. 모범답안이나 검수된 암기 정답은 자동 생성하지 않습니다. 이전 분석 버전과 과거 훈련 기록을 지우지 않습니다.
- 분석 도중 지원처가 달라지면 자동 발행하지 않습니다. 같은 원본으로 현재 지원처를 다시 분석합니다.

## 운영 지침

`/admin/document-guidelines`에서 관리자만 생기부 분석·질문 생성·답변 평가·피드백·커리큘럼의 다섯 지침을 초안·검토 요청·게시 버전으로 저장합니다. 기본 지침은 0차이며, 게시된 지침을 덮어쓰지 않고 다음 버전으로 교체합니다. 분석마다 지원처와 적용 지침의 전체 스냅샷이 보존됩니다. 게시만으로 기존 학생 분석을 일괄 덮어쓰지 않으며 다음 재분석부터 적용됩니다. 질문 문맥에는 적용 지침 스냅샷과 AI 제안 출처를 전달합니다. 질문 생성은 questions, 답변 평가·리포트는 evaluation/feedback 지침을 명시적으로 적용하고 결과에 지침 버전을 기록합니다.

커리큘럼에는 복습·퀴즈 비중, 되돌아보기 시간, 화상 최소 시간, 실전 준비 기간을 숫자 규칙으로 저장합니다. 이 규칙은 최신 게시 버전을 새 미시작 계획에 적용하고 계획에 규칙 및 지침 버전을 함께 남깁니다. 기존 수행 기록과 진행 중 세션은 소급 변경하지 않습니다. 자유 형식 본문을 임의로 실행 가능한 일정 규칙으로 해석하지 않습니다.

## 남은 검증과 지원 범위

- 문자 PDF, 스캔 PDF, 같은 페이지에 문자·이미지가 섞인 PDF를 지원합니다. 짧은 추출문 또는 128px 이상 내장 이미지가 있는 페이지는 전체 페이지를 OCR합니다. 이미지가 서명·사진뿐이어도 보수적으로 OCR 대상으로 잡힐 수 있어, 원본 대조는 필수입니다. 스캔 품질·필기·회전·표 병합 정확도를 보장하지 않습니다. 모든 페이지를 직접 정정할 수 있고 실제로 글자가 없는 페이지는 빈 페이지로 확인할 수 있습니다.
- 표·다단 배치의 텍스트 순서, 한글 글꼴별 추출 품질, 실제 운영 모델의 분석 품질·처리시간·비용은 비식별 검증 문서로 운영 전 확인해야 합니다. 완료율이나 모델 정확도를 실측한 것처럼 표시하지 않습니다.
- 원본을 DB `bytea`에 저장하므로 DB 백업, 접근권한과 저장용량 관리에 포함해야 합니다. 브라우저 공개 DB 접근 권한은 부여하지 않습니다.

## 재현 검증

```sh
node --import tsx --test tests/student-document.test.mts tests/student-document-pdf.test.mts tests/student-onboarding.test.mts
node --import tsx tests/student-document-integration.mts
```

통합 검증은 localhost PostgreSQL에서 UUID가 붙은 별도 스키마만 생성·제거하며 `TEST_DATABASE_URL` 또는 기존 `DATABASE_URL`을 사용합니다. 분석기는 시험용 함수로 주입하고 외부 모델 호출은 금지합니다.


## 로컬 OCR과 정정문

- `student_document_previews`: 계정당 임시 PDF 하나, 24시간 만료. `pending → processing → ready` 후 학생이 확인·정정한 모든 페이지와 고정 동의를 보내야 원본이 만들어집니다. 깨진 PDF·암호화 PDF는 실패 사유와 재업로드를 안내합니다. 인식 실패는 해당 페이지의 `failed`로 남아 수동 입력 또는 재인식이 가능합니다.
- 1회 작업은 최대 3쪽, DB lease는 4분이며 동시에 최대 2개를 처리합니다. 인증된 상태 조회가 다음 묶음을 `after()`로 재개하므로 화면에 돌아오면 이어집니다. 페이지별 OCR은 45초 제한, 렌더 캔버스는 최대 400만 픽셀, PDF 내장 이미지는 최대 1,600만 픽셀로 제한합니다. 상시 백그라운드 큐나 무제한 문서 처리가 아닙니다.
- 75 미만 신뢰도는 재확인 안내 기준이며 정확도 보증이 아닙니다. 높은 신뢰도도 확인 절차를 생략하지 않습니다. 실제 판독 실패·저신뢰 결과를 완료 분석이나 0점으로 바꾸지 않습니다.
- `student_documents.pages`에는 최초 추출문, OCR문, 추출 방법, OCR 신뢰도·실패 상태가 그대로 보존됩니다. `student_document_text_versions`는 학생이 확인한 텍스트와 정정 사유의 불변 버전입니다. 이후 정정도 원본 bytes·해시를 바꾸지 않습니다. 정정은 하루 최대 10개 버전이며 동시 저장은 expectedRevision으로 충돌을 알립니다.
- 분석마다 `text_revision`을 고정하고 해당 텍스트에서만 인용을 검증합니다. 정정 시 기존 실행 lease를 무효화하여 옛 인식문으로 새 결과가 뒤늦게 발행되지 않게 합니다. 정정 저장과 새 분석 요청을 분리하여 인식문 보존이 모델 설정·분석 횟수 제한에 막히지 않습니다. 기존 완료 분석은 당시 인식문 버전과 함께 보존하고, 새 버전과 다르면 화면에 알립니다.
- OCR 또는 학생 정정 근거는 `verification_status=student_reviewed_transcription`, `quote_basis=student_reviewed_transcription`, `text_revision`, `extraction_method`, `student_reviewed`, `ocr_confidence`를 남깁니다. 원 PDF에서 그대로 추출한 경우와 구별합니다. 원문을 보며 확인했다는 선언은 학교 발급 진위·소유권·사실의 독립 검증이 아닙니다.
- 언어 모델은 npm에 설치한 `@tesseract.js-data/kor@1.0.0`, `@tesseract.js-data/eng@1.0.0`의 `4.0.0_best_int`에서 읽습니다. 작업 임시 디렉터리에는 공개 언어 데이터만 복사하며 종료 시 정리합니다. PDF·페이지 픽셀은 이 디렉터리에 쓰지 않습니다. 배포에는 Node worker_threads, WASM, pdf-parse 네이티브 canvas, 로컬 임시 디렉터리 쓰기가 필요합니다. Next standalone으로 배포한다면 언어 데이터 두 패키지를 배포 산출물에도 포함해야 합니다.

임시 PDF의 만료 검사는 인증된 상태 조회·업로드 시 수행하며, 요청이 없는 기간의 물리 삭제에는 운영 스케줄러에서 아래 명령을 정기 실행해야 합니다. 앱이 스케줄러를 자동 설치하지는 않습니다. 고정한 원본·정정 이력은 삭제 대상이 아닙니다.

```sh
node scripts/cleanup-student-document-previews.mjs
node scripts/cleanup-student-document-previews.mjs --apply
```

첫 명령은 삭제 예정 개수만 표시합니다. 두 번째만 만료된 임시 파일을 삭제합니다.

공식 구현 문서: [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [로컬 설치](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [공식 언어 데이터](https://github.com/naptha/tessdata), [pdf-parse API](https://github.com/mehmet-kozan/pdf-parse/blob/main/README.md). Tesseract는 PDF 자체를 입력받지 않으므로 pdf-parse로 각 페이지를 렌더한 이미지에 적용합니다. SSML·클라우드 OCR·문서 진위 검증을 지원한다고 주장하지 않습니다.

## 실제 합성 문서 OCR 검증

`.local/followup-qa-2026-10-23/`에 실제 학생 정보가 없는 2쪽 스캔 PDF와 문자·이미지 혼합 PDF, 원본 PNG, OCR JSON, 재현 스크립트를 보존했습니다. 로컬 한 차례 실행에서 스캔 2쪽은 신뢰도 91/90, 약 5초였고 혼합 문서의 OCR 페이지는 92, 약 3초였습니다. 특정 합성 문서의 결과이며 일반 정확도나 운영 처리시간이 아닙니다. 확인 과정에서 오탈자를 정정하는 흐름은 필수입니다. 모델 API 호출은 하지 않았습니다.

```sh
node --import tsx .local/followup-qa-2026-10-23/run-local-ocr.mts
```

단위 검증은 확인 누락·빈 페이지 모순·OCR 출처와 수정 버전 표시를 확인합니다. 별도 스키마 통합 검증은 중복 원본 확정, 소유권, 페이지 묶음 재개, 실패 페이지 수동 복구, 정정 동시성, 불변 원본/정정 이력, 이전 분석 lease 차단, 만료 임시 파일 삭제를 포함합니다.

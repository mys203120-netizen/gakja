# 윤지우 대학 모의면접 · 로컬 실행

서울시립대학교 융합응용화학과, **2027학년도 학생부종합전형I (면접형)** 대상의 `/interview` 한 화면입니다. 차콜 배경과 `#00EE77`, 실제 장치 제어, CLOVA 스트리밍 음성 인식·음성 합성, OpenAI 질문·종료 평가를 연결합니다.

화면은 중립적인 차콜로 구성하고, `#00EE77`은 민트·시안·블루 그라데이션의 모핑에만 적용합니다. 버튼·내 답변은 보라색, 면접관 말풍선은 앰버색을 사용합니다.

## 실행

청사진 v2 후속 구현: [PR05 계약 대응표·PR06 추출 계획](docs/pr05-domain-contracts.md), [실제 검증 결과·외부 의존](docs/pr05-verification.md). 평가 승인 0개와 검수 대기 상태는 실제 공급 전까지 유지합니다.

1. Node.js 22 이상 LTS를 설치합니다.
2. `.env.local`에 실제 키를 입력합니다. 이 파일은 `.env.example`의 이름을 그대로 사용하며 Git에서 제외됩니다.
3. **`start server.bat`를 더블클릭**합니다. 최초 의존성·모델·학생부 근거 준비 후 실제 서버 health 응답을 확인하고 면접 화면을 엽니다.
4. 중앙 모핑을 누르면 일반 화면에서 **시작 전 확인** 패널이 열립니다. 마이크 권한·입력 반응과 카메라 미리보기를 확인합니다. 카메라는 선택 사항이며 `카메라 없이 진행`할 수 있습니다. 이때 질문·면접 시간은 시작되지 않습니다.
5. 준비가 끝나면 **전체화면으로 면접 시작**을 누릅니다. 전체화면 진입이 확인된 뒤 3초 카운트다운과 첫 질문을 진행하며, 첫 질문 음성이 재생될 때 면접 시간이 시작됩니다. 전체화면 진입에 실패하거나 시작 전에 이탈하면 준비 화면에서 다시 시도합니다.
6. 질문 음성이 끝나면 답변합니다. `다 말했어요` 또는 Space로 제출합니다. 면접 시작 후 Esc·탭 이동 시 일시중단되며 같은 화면에서 이어갑니다.

서버 종료는 실행 콘솔에서 Ctrl+C입니다. 다른 프로그램이 포트를 사용하면 `.env.local`의 `WEB_PORT`와 `REALTIME_PORT`를 변경합니다. 기본 URL은 [http://localhost:3000/interview](http://localhost:3000/interview)입니다. 키를 변경한 후 서버를 다시 시작해야 합니다. 키가 없어도 화면은 열리며 누락 변수명만 표시합니다.

터미널에서는 `npm run dev`로 실행합니다. `npm run start:local`은 브라우저도 엽니다. 별도 Python 설치는 필요하지 않습니다.

## 연결 정보

- [최신 로그 검토·사전 Q0 캐시·단일 실시간 코어 전환](docs/면접_단일코어_전환_및_최신로그_검토.md)
- [질문 전략·자료 연결 아키텍처](docs/AI_면접관_질문전략_자료연결_아키텍처.md)
- [전략 엔진 적용·실제 검증 결과](docs/AI_면접관_전략엔진_적용결과.md)
- [P0 경로·질문 전제·평가 집계·복구 실행 및 검증 결과](docs/P0_실행_검증_결과.md)
- [CLOVA 키 발급·환경변수 매핑](docs/clova-setup.md)
- [MD에서 언급한 누락 자료·외부 시스템·미정 정책](docs/connection-audit.md)
- [최신 실사용 로그 검토와 무응답·시작 흐름 개선](docs/interview-log-review-2026-11-02.md)
- [질문 생성 가이드 적용 근거·남은 자료](docs/question-guideline-application.md)
- `.env.example`: API 키·모델 ID·목소리·포트 계약
- `interview.config.ts`: 고정 지원처·공식 면접 시간에 비례한 주질문 수(10분 4개, 12분 5개)·주질문별 꼬리질문 상한 2회
- `interview-files.mjs`: 준비 스크립트·서버가 공유하는 실제 자료 경로와 가이드 정본 버전

Speech Secret과 Voice Client ID/Secret은 다른 인증 정보입니다. `CLOVA_SPEECH_DOMAIN_ID`는 공식 gRPC recognize 요청의 인증 필드가 아니므로 이 값만 비어 있어도 시작을 막지 않습니다. 실제 도메인의 gRPC 사용 권한이 필요합니다. MediaPipe와 Silero에는 별도 분석 API 키가 없습니다.

## 자료와 저장

`래퍼런스/윤지우학생 생활기록부.pdf`(24쪽)에서 페이지·원문 오프셋을 추적하는 17개 근거 구간을 준비합니다. 연락처·주소·식별번호 등은 질문용 문맥에서 제외합니다. `universities.json`, `departments.json`, `admission_tracks.json`에서 해당 학년도·학교·학과·전형을 ID로 연결합니다. 서울시립대 대상 전형의 공식 시간은 약 12분입니다. 정본은 `각자의답_MD`의 공통 운영 v2.0, 질문·평가 v2.3이며 경로·문서 역할·버전을 검증합니다. 가이드 원문을 읽는 것과 모든 고도화 항목이 구현된 상태는 구분합니다.

`npm run verify:context`는 Source Manifest의 파일 해시·정본 버전·PDF 해시를 확인하고, 캐시의 모든 발췌문을 실제 PDF 페이지·offset·본문과 다시 대조합니다. 기존 파일이 이동하면 `interview-files.mjs`를 수정하고 `npm run prepare:context`로 근거를 재준비합니다.

면접바이블 두 MD는 `npm run prepare:question-references`로 모든 질문 후보와 출처를 보존하고, `npm run analyze:question-references -- --run-live --resume`으로 후보 전부를 문항별 의미 분석합니다. 원문 SHA·페이지·행·구간, 기출/책 예시 구분, 질문 기능·요구별 깊이·꼬리질문 전략을 저장합니다. 직접 질문은 문형 예시로, 복합 질문은 단일 요구 분해 전략으로, 제시문·그림·이전 답변이 필요한 질문은 맥락 의존 전략으로 연결합니다. 행정 안내·예시 답안·사생활 질문·손상 문항도 처리 사유를 기록하고 원문을 보존합니다. 미처리 문항이 있으면 전체 준비 완료로 표시하지 않습니다.

고정 60개 승인 목록은 실행 경로에서 제거했습니다. 전체 분석 자료에서 기능·깊이·주제와 최근 사용 이력을 기준으로 필요한 참고 항목을 최대 3개씩 검색합니다. 이 수는 한 번의 모델 입력 크기이며 전체 자료 활용 상한이 아닙니다. 학생부 사실과 현재 대학 정책은 현재 프로젝트의 검증된 원문에서만 얻습니다. 그림 경로는 `.local/book-analysis/figures`입니다. 원문 추출·해시 검증에는 모델을 호출하지 않으며, 의미 분석은 면접 전 오프라인에서 실행하고 검증된 결과를 재사용합니다. 면접 중 추가 검색 모델을 호출하지 않습니다. [전체 자료·출처·처리 현황 검증](artifacts/book-question-reference-verification.json)에 실제 적용 범위와 미해결 사유를 남깁니다.

현재는 누락 후보 286개를 복원한 총 3,170개를 처리했고, 요구 단위 4,321개의 원문 구간을 보존합니다. 실행 용도는 직접 문형 1,453개·복합 요구 분해 851개·맥락 의존 전략 802개입니다. 준비 안내·자가점검 등 57개와 사생활 질문 7개는 원문과 제한 사유를 남깁니다. 미처리는 0개입니다. 모델 판정 뒤 원문 맥락으로 정정한 37개는 최초 판정 해시와 정정 근거도 보존합니다. 이는 전체 후보에 대한 모델 분석과 원문 검증이며 사람이 전수 검수했다는 뜻은 아닙니다.

추가 전략 계층은 전체 후보를 다시 출처에 연결해 3,106개를 의미 분석하고 64개의 제한을 보존합니다. 전략 카드 7,255개에는 확인 행위·답변 조건·요구 의미·표현 접근·질문 간 관계를 저장합니다. 원문 근거를 연결한 관계 2,234개와 불확실한 관계 872개를 구별하며, 불확실함은 미처리나 임의 확정으로 바꾸지 않습니다. 런타임에는 추상 전략과 조건만 제공하며 책 원문 질문·예시답안·학생 사실·대학 운영 안내를 전달하지 않습니다. `data/prepared/question-strategies/`와 [실제 전략 자료 검증](artifacts/question-strategy-catalog-verification.json)에서 처리 현황을 확인합니다.

`npm run compile:interviewer-policy`는 정본 MD 7개와 실행 규칙 15개·사용자 우선 설정을 명시적으로 연결합니다. 정책·학생 원문·전략 버전이 Q0 캐시 키에 포함되고 세션에 고정됩니다. 정본 변경은 해시와 조항 매핑을 다시 확인해야 하며, 문서를 연결했다는 이유로 모든 조항이 자동 구현됐다고 표시하지 않습니다.

- `data/prepared/student.json`: PDF SHA-256과 원문 근거 캐시
- `data/prepared/source-manifest.json`: 실제 사용 파일·레코드 ID·학년도
- `data/sessions/`: 턴별 원문 전사·실측 지표·종료 평가 JSON
- `data/conversation-logs/`: 세션별 누적 JSONL 대화·반응 판단·실제 재생 이벤트·지연·오류 기록
- `data/audio/`: 서버 전용 질문·연결 멘트 음성 캐시

`data/`와 `.env.local`은 비공개 서버 경로이며 public에 들어가지 않습니다. 영상 프레임은 저장·업로드하지 않고 얼굴 관찰 숫자만 기록합니다. 별도의 로그인·대시보드·리포트 페이지는 없습니다.

## 대화 로그를 이용한 개선

새 면접부터 원문 전사, 생성한 질문·연결 발화, 실제 브라우저 재생 시작·종료, 답변 관련성 판단과 재확인·전환 이유, 공급자별 음성 설정·지연, 종료 평가를 로컬에 기록합니다. 생성된 문장과 실제 재생된 문장은 별도 이벤트입니다. 부분 전사는 수정 이력도 남기며, 키·인증 값과 영상·음성 바이너리는 대화 로그에 넣지 않습니다. 기록 실패는 면접을 중단하지 않고 세션 API의 `logging` 상태로 확인합니다.

```text
npx tsx scripts/review-interview-logs.ts --list
npx tsx scripts/review-interview-logs.ts --latest
npx tsx scripts/review-interview-logs.ts --session <UUID> --full
npm run evaluate:interviewer -- --latest
```

기본 검토는 원문 없이 반복 발화·판정 이유·지연을 집계합니다. `--full`은 선택한 세션의 원문을 표시합니다. 과거 세션은 기존 JSON에서 읽되 당시 저장하지 않은 재생 시각이나 관련성 판단을 만들어내지 않습니다. 테스트 후 개선을 요청하면 해당 로그의 문제 사례를 검토하고 질문 생성 규칙·검수·회귀 사례를 수정하는 방식입니다. 로그 수집 자체가 모델 가중치를 학습시키거나 자동으로 무한 실행하지는 않습니다.

대화 중에는 단일 코어가 최대 한 번의 모델 호출로 관련성·요구 충족·다음 행동·확인 대상·전략을 함께 결정합니다. 주질문 5개와 대체 5개는 학생별 목표를 정한 뒤 생성·독립 전제 검수·TTS를 마쳐 로컬 은행에 저장합니다. 실시간 F는 실제 답변 출처와 사전 검수한 질문 행위 구조를 결합합니다. 명백한 무응답·사과·미완성 파편은 모델 호출 없이 처리합니다. 연결 음성과 F 음성 준비는 병렬화하며 같은 턴의 목소리·속도는 고정합니다. 유효한 부정 답변이나 학생부 밖의 경험을 무조건 오답·허위로 처리하지 않습니다.

실제 코어 출력은 먼저 `answerRelation`으로 현재 질문·확정 대화와의 의미 연결을 표시한 뒤 다음 행동을 결정합니다. 관련 없는 발화는 새 주장이라는 이유로 검증용 F로 바꾸지 않습니다. 연결 관계와 행동이 모순되면 비평가 재확인으로 복구하며, 짧은 판단 근거는 내부 로그에 저장합니다. 사전 학생부 분석으로 학생이 실제 말하지 않은 답변을 채우지 않도록 그 자료를 관련성 판정 입력에서 제외했습니다. 책 질문은 설계·전략 참고로만 사용합니다.

연결 표현은 `server/providers/acknowledgement-phrases.ts`, 새 F 발화는 `server/providers/question-realization.ts`에서 관리합니다. 20개 질문 행위와 인용 생략·짧은 맥락·정확한 인용 방식을 선택하며 내부 근거는 모두 유지합니다. F2는 직전 목표 하나에 고정하지 않고 같은 묶음 목적 안에서 필요한 초점을 선택합니다. 충분한 답변을 같은 요구로 다시 묻는 확장은 서버가 전환시키며, 실제 새 주장·두 진술의 차이에 대한 확인은 별도 구분합니다. 전략 선택의 의미 적합성을 독립 검수한 것으로 표시하지 않습니다. 기존 `follow-up-language.ts` 문형은 과거 기록과 검증 경로의 호환을 위해 유지합니다.

`server/conversation-ledger.ts`는 실제 확정 답변과 확인 대상·정정·미해결 지점을 출처에 연결합니다. 최종 발화와 의도·요구·검수는 불변 승인 계약으로 고정하고 저장·재진술·종료 평가에서 다시 검증합니다. `coreDecision`, 전략 ID, 인용 방식, 전환 사유, 실제 지연이 로그에 남습니다. 품질 CLI는 이 관찰을 집계하며 사람 면접관의 품질 점수로 표시하지 않습니다. 두 로그 CLI의 `--latest`는 자동 검증용 합성 회차를 기본 제외하고 `--include-synthetic`으로 명시적으로 포함할 수 있습니다.

말하지 않고 제출해도 최종 음성 인식 요청이 정상적으로 끝났다면 무응답으로 기록하고 타이머를 계속 진행합니다. 같은 주질문에서 한 번은 짧은 생각 시간 안내와 질문 재진술을 제공하고, 다시 무응답이면 다음 주질문으로 넘어갑니다. 순수 재진술은 평가용 꼬리질문 횟수에 넣지 않으며 해당 답변은 원질문의 평가 근거로 연결합니다. “기억이 나지 않습니다” 같은 명시적인 답변 불가는 중립적으로 전환합니다. 실제 장치·STT 오류나 아직 확정되지 않은 전사는 정상 무응답과 구분합니다.

목소리 속도는 `CLOVA_VOICE_PRIMARY_SPEED=0`, `CLOVA_VOICE_SECOND_SPEED=-1`로 독립 설정합니다. 역할별 설정이 공통 `CLOVA_VOICE_SPEED`보다 우선하며 음수일수록 빠릅니다. 적용에는 서버 재시작이 필요합니다.

## 검증 명령

2026-11-06 변경 지시에 따라 청사진 v2를 최상위 기준으로, 평가범위 공급계약을 보완 명세로 사용합니다. 철회된 4대 정책과 구분한 현재 구현·검증 범위는 [아키텍처 구현 상태](docs/architecture-implementation-status.md)에 기록합니다.

```text
npm run prepare:context
npm run prepare:question-references
npm run analyze:question-references -- --run-live --resume
npm run compile:interviewer-policy
npm run prepare:question-strategies -- --run-live
npm run verify:context
npm run prepare:activities -- --run-live
npm run prepare:interview -- --run-live
npm run prepare:assets
npm run typecheck
npm run lint
npm test
npm run build
```

습관어는 STT 원문에서 실제 관찰된 범위만 셉니다. 의미 있는 용법이 가능한 `그·저·약간·이제` 등은 후보와 확정 횟수를 분리합니다. CPM은 공백·문장부호를 제외한 Unicode 문자·숫자 수/전체 답변 분이며 발화 중 CPM·한국어 어절/분·한글 음절 근사를 구분합니다. 300/350은 사용자 지정 코칭 기준입니다. 짧거나 측정할 수 없는 구간은 null입니다.

웹캠의 시선 이탈 추정과 표정 움직임은 관찰 지표입니다. 측정 불가를 분모에서 제외하며 감정·성격·진실성을 판정하거나 내용 점수에 합산하지 않습니다. 승인된 학생 활동 우선도와 학술 정오 검증 자료는 임의로 채우지 않습니다.

Q0는 사전 준비에서 원문 인용과 독립적인 전제·단일 의도 검수를 통과해야 은행에 게시합니다. 새 실시간 F는 `approved_strategy_ir`의 출처·승인 구조·최종 발화 검사로 표시합니다. 실제 발화에 인용이 없어도 내부 답변 앵커는 유지합니다. 이를 독립 의미 검수 완료로 표시하지 않습니다. 단일 코어의 `coreMs`, `coreModelCalls`, 보정·실패·전환 사유와 Q0의 offline 검수 시간을 구분해 저장합니다.

회차 종합 점수는 실제 브라우저의 질문 재생 시작·종료 기록을 바탕으로 묶음별 100% / 70:30 / 70:15:15를 적용합니다. 평가불능 문항이 하나라도 있는 묶음은 제외하고, 유효 묶음 2개 이상이면서 60% 이상일 때만 동일 비중 평균을 냅니다. 원문 인용이나 정상 제시 기록이 부족하면 점수를 채우지 않고 보류 이유를 저장합니다. 과거 회차에 없던 재생 기록은 만들어내지 않습니다.

실제 API 키와 장치로 질문 → TTS → 답변 → 스트리밍 STT → 연결 멘트 → 다음 질문을 확인해야 음성 경로 전체 검증이 완료됩니다. 특히 추임새가 들어간 답변, 권한 거부 후 복구, 장치 변경, 전체화면 중단/재개를 확인합니다. 키가 없는 환경에서 가짜 음성·전사·답변으로 성공한 것처럼 표시하지 않습니다.

## 꼬리질문 변경 검증

표현을 수정한 질문은 기존 마지막 재검수에서 사실 전제와 원래 요구의 일치를 함께 확인합니다. `same`일 때만 원 계약·최종 문장 해시를 묶어 승인하며, `changed`·`uncertain`·누락은 현재 답변을 보존하고 발화를 차단합니다. 수정 없는 경로의 검수 프롬프트·스키마와 모델 호출 수는 유지합니다.

실패한 실제 재생 이벤트는 다음 `answer-candidate`·`next` 요청에 함께 보내고, 서버 저장 완료 receipt를 받은 ID만 미확인 목록에서 제거합니다. 종료용 전체 백업은 유지합니다. 횟수는 서버의 실제 재생 근거를 기준으로 계산하며, 아직 발행하지 않은 준비된 F도 현재 상한을 다시 검사합니다. 오래된 준비물을 폐기해야 하는 예외 경로에서는 이전 발화 ID를 보존하고 같은 답변으로 최대 한 번 자동 재요청합니다. 정상 경로에 새 HTTP 왕복이나 모델 호출을 추가하지 않습니다.

의미 품질은 면접 중 추가 모델이 아니라 오프라인 출시 게이트로 확인합니다. 후보 결정만으로 승인하지 않고, 표현 수정까지 끝난 최종 질문·실제 대화 이력·검수 결과·요청/응답 모델·reasoning/token 설정을 정확한 보고서 해시에 연결합니다. 원본 보고서에서 결과를 다시 추출하므로 후보 JSON이나 지연 요약만 고쳐 통과시킬 수 없습니다. F2는 실익이 있을 때만 선택하며, 올바른 전환과 F2 검증 범위 부족을 구별합니다.

```text
npm run semantic:identity -- --help
npm run semantic:collect -- --help
npm run semantic:verify -- --help
npm run compare:followup-latency -- --help
```

실제 실행 순서는 다음과 같습니다. 아래 입력 파일은 해당 실행의 gold 자료, 검토 기준, 비밀값 없는 모델 설정, 정책 원문·준비 자료, 실제 재생 보고서입니다.

```text
npm run semantic:identity -- --gold artifacts/gold.json --rubric artifacts/rubric.json --model-config artifacts/models.json --policy data/prepared/interviewer-policy.json --out artifacts/release-identity.json
npm run semantic:collect -- --identity artifacts/release-identity.json --report artifacts/runtime-replay.json --out artifacts/release-candidate.json
npx tsx scripts/verify-semantic-release.ts review-template --candidate artifacts/release-candidate.json --out artifacts/release-reviews.json
npm run compare:followup-latency -- --before artifacts/latency-before.json --after artifacts/latency-after.json --out artifacts/latency-receipt.json
npm run semantic:verify -- --candidate artifacts/release-candidate.json --reviews artifacts/release-reviews.json --latency artifacts/latency-receipt.json --out artifacts/release-receipt.json
```

`review-template`는 미검토·미해결 결과만 만듭니다. 검토자는 최종 발화를 실제 읽고 출처를 표시해야 하며, 모델 검토를 사람 검토로 표시하지 않습니다. `identity --fixture`의 합성 예제는 운영 출시를 승인할 수 없습니다. 실제 모델 재생은 별도 명시적인 오프라인 실행이며, 위 검증 명령이나 일반 빌드가 유료 API를 자동 호출하지 않습니다. 결과 파일은 기존 파일을 덮어쓰지 않습니다.

`semantic:verify`는 의미 검토와 지연 근거를 모두 요구합니다. 지연 보고서는 정상/수정 경로별 최소 20쌍의 같은 입력·모델·동시성·캐시/timeout 설정을 묶고, 실패도 분포에 포함합니다. p50·p95·실패율이나 호출 수가 늘면 통과하지 않으며, 전부 실패한 측정·모의 측정·원본 근거 누락은 미완료입니다. 지연 receipt의 `releaseKey`는 검증할 identity와 같아야 합니다. 근거가 없는 경우 승인 상태를 만들어내지 않습니다. 측정 범위가 코어 결정 이후라면 마이크·STT·TTS·브라우저 전체 지연으로 표시하지 않습니다.

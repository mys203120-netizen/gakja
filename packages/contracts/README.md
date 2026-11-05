# 제안 계약의 보존과 재현 검증

`reference/proposed-v2-2026-11-06`은 사용자가 전달한 `각자의답_부속스키마_52개검증사례.zip`의 16개 파일을 원본 바이트로 보존한다. `import-metadata.json`은 ZIP과 각 파일의 SHA-256을 고정한다. 수신된 `validation-results.json`은 당시 보고서이며 재실행 결과로 덮어쓰지 않는다. 첨부 생성 스크립트도 실행하지 않는다.

이 계약은 **REFERENCE_VALIDATION_ONLY**다. 현재 TS 도메인 codec·세션 API·평가·재생 endpoint의 형식을 교체하거나 승인 권한을 부여하지 않는다. 현재 비교 기준은 아키텍처 청사진 v2와 사용자 확인을 받은 `각자의답_평가범위_검수자료_공급계약.md`이며, 차이는 `policy-compatibility.json`에서 추적한다. 철회된 4대 구현 정책의 완전 재생 전용·1.0배·시간/재고 수치 등을 이 참고 계약의 운영 기본값으로 채택하지 않는다. import metadata의 당시 자료 해시는 수신 이력일 뿐 현재 규범이 아니다.

청사진 v2는 재생 이벤트 receipt와 정상 전달 판정을 구분하고, 재생 완료 또는 별도로 승인된 충분 재생·중단 정책을 요구한다. `completed` 형태 통과만으로 정상 전달·이용권 소비를 확정하지 않으며, 아직 확정되지 않은 충분 재생 기준을 이 패키지가 새로 정하지 않는다.

평가 보완 계약은 정확한 문항별 `QuestionEvaluationSpec` 검수와 실제 종료 입력의 session-bound 승인을 분리한다. 수신 스키마의 `objective_knowledge`/`none`은 기존 gate의 `objective_accuracy_core`/`unresolved`와 명시적인 어댑터가 필요하다. ROLE 라벨·질문 승인·사전 규격 승인으로 실제 세션의 평가 승인을 자동 생성하지 않는다. 52개 형태 사례의 통과는 이 공급 경로나 실제 35개 문항의 내용 검수 완료를 증명하지 않는다.

## 재실행

Node 의존성은 프로젝트 lockfile을 사용한다. Python 검증 의존성은 별도 설치 단계다. Windows 예시:

```powershell
npm ci
py -3.11 -m pip install --target artifacts/contracts-validation-deps -r packages/contracts/requirements-validation.txt
node scripts/verify-proposed-contracts.mjs
```

CI에서는 Python 3.11을 준비하고 `python -m pip install -r packages/contracts/requirements-validation.txt`를 명시적으로 실행한 뒤 같은 Node 명령을 사용한다. 검증기는 의존성을 자동 설치하지 않는다. 새 결과는 Git에서 제외된 `artifacts/proposed-contracts-validation.json`에만 기록한다.

명령은 원본 해시, 5개 스키마, 형태 52건, UTF-16/인용/hash 4건을 검사하고 Python/JavaScript의 건별 결과를 비교한다. Unicode 코드포인트 길이·부정확한 달력 날짜·객체 필드 순서가 다른 중복 배열에 대한 추가 parity 4건도 검사한다. 거부해야 하는 사례를 실제 거부하는 것도 통과에 포함한다.

Python은 `jsonschema 4.26.0`의 Draft 2020-12 검증기를 사용한다. JavaScript는 설치된 Ajv 6의 draft-7 검증기로 **이 파일들이 사용하는 공통 키워드 부분집합**을 검사한다. 변환은 dialect 메타데이터만 바꾸며 미지원 키워드가 추가되면 실패한다. 일반적인 2020-12 Ajv 지원 또는 Pydantic 어댑터 검증으로 부르지 않는다. 날짜 검사는 Python과 같은 달력 범위를 적용하고, 문자열 길이는 코드포인트·근거 위치는 UTF-16 code unit으로 구분한다.

앱 테스트, DB 권한, 실제 기기 재생, 모델 의미 품질, 유료 API 검증은 이 명령의 범위가 아니다. `tests/proposed-contracts.test.ts`는 동일한 원본·JS 형태·구간 검증을 일반 오프라인 테스트에 포함한다.

# 각자의답 · 남녀 면접관 제작 파일

현재 상태: **실제 파츠 PSD와 모션 데이터 제작 / Cubism 리깅·내보내기 미완료**.

## 실제 파일

- `interviewer-1/`: 남성. `artwork_master.psd` 37레이어, `cubism_import.psd` 35아트 레이어.
- `interviewer-2/`: 여성. 같은 두 PSD와 같은 레이어 수.
- 각 인물의 `parts/`: 독립 RGBA PNG와 `manifest.json`. 원래 캔버스 1672×941에 복원할 x/y·순서·역할·L/R 기준이 들어 있다.
- 각 인물의 `layer_manifest.csv`: 파츠 역할과 보완 영역 등의 기록.
- 각 인물의 `psd-verification.json`: 실제 저장 PSD 재읽기 검증 기록.
- 각 인물의 `sources/`: 승인 기준 원화·가려진 피부 밑그림·열린 입 원화와 검사 정보.
- 각 인물의 `references/`: 둥근 입·가로 입의 추가 키포즈 원화. 실제 모델 키폼이나 전체 얼굴 교체용 실행 에셋은 아님.
- `generation-prompts.json`: built-in ImageGen을 사용한 실제 프롬프트와 저장 파일의 연결.
- 각 인물의 `parts-composite.png`, `face-base-isolation.png`: 정적 합성 및 얼굴 기능 파츠를 숨긴 확인 이미지.
- `motions/`: 남녀별 모션6개·표정3개, 총18파일과 catalog. 실제 모델 재생은 미검증.

## 열기·재현

일반 PSD 편집 프로그램에서 PSD를 열어 레이어를 수정할 수 있는 실제 파일 형식이다. Photoshop 검증은 사용자 지시로 제외했다. Cubism 가져오기는 실제 Editor에서 `cubism_import.psd`를 열어 확인해야 한다. 숨긴 참고 레이어가 없는 가져오기 PSD를 사용한다. 리깅 전 자동 생성 메쉬만으로 변형 품질이 완료되었다고 처리하지 않는다.

루트의 아래 스크립트는 파일 생성·검사를 돕는다. GUI나 Computer Use를 실행하지 않는다.

```text
node scripts/source-artwork-inspection.mjs
node scripts/prepare-interviewer-motions.mjs --check
node scripts/verify-interviewer-production.mjs
```

PNG 파츠를 바꾼 후 PSD를 다시 묶으려면 `scripts/build-interviewer-psd.mjs`를 사용한다. ag-psd 별도 설치 방법과 입력 계약은 해당 스크립트의 설명에 있다. 기존 파일 보호가 기본이며 본인이 재생성을 의도한 경우에만 `--overwrite`를 쓴다.

## 정확한 한계

이 디렉터리에는 실제 전용 `.cmo3`, `.can3`, `.moc3`, `.model3.json`, 텍스처 아틀라스, `.motionsync3.json`이 없다. 따라서 아직 실행 가능한 Live2D 모델 패키지가 아니다. 실제 Cubism Editor 저작 경로를 확보하지 못했고 Computer Use를 사용하지 않으므로 리깅·내보내기는 남아 있다.

리깅용 입 2축과 눈·가림 설계: 프로젝트의 `docs/live2d/mouth_rigging_spec.md`. 전체 검수: `docs/live2d/qa_report.md`. 파라미터·모션·웹/앱 연결: 같은 문서 디렉터리의 `parameter_spec.md`, `motion_spec.md`, `runtime_integration.md`.

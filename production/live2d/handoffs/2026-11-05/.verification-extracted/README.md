# 각자의답 · 외부 제작 인계 보관본 (2026-11-05)

이 ZIP은 현재 제작물을 기준선으로 고정한 **비공개 작업 폴더의 인계 준비본**입니다. 외부 전송·연락·발주·공유 권한 변경은 하지 않았습니다. 웹의 public 폴더 밖에 새로 만들었으며 기존 원본·PSD·상세 문서·검사 보고서는 덮어쓰지 않았습니다.

## 시작 위치와 기준선

- 남성: source/public/live2d/production/interviewer-1/
- 여성: source/public/live2d/production/interviewer-2/
- 각각 artwork_master.psd는 **래스터 37레이어**입니다. 모든 원화 저작 과정이 비파괴 조정·벡터·스마트 오브젝트로 남은 원본은 아닙니다.
- 각각 cubism_import.psd는 **독립 아트 35레이어**입니다. 마스터의 숨긴 참고 레이어 Approved_Master_Reference, Mouth_Open_Reference 두 개를 제외했습니다.
- parts/manifest.json과 layer_manifest.csv에 1672×941 기준 캔버스의 실제 x/y·순서·역할·해부학적 L/R 기준이 있습니다. 잘린 PNG를 원점 정보 없이 재배치하지 마세요.
- baseline-initial.json은 코드 수정 전 초기 경로·크기·SHA-256입니다. baseline-manifest.json은 실제 인계 복사본의 기준선입니다. validation/code-revision-diff.json에 허용된 코드 수정과 초기/최종 해시를 구분했습니다.
- validation/production-input-check.json은 현재 파일과 기존 PSD 재읽기 증거의 해시·레이어 분류·참고 제외·모션 목록을 대조한 새 보고서입니다. 기존 상세 검수 결과의 정본은 source/public/live2d/production/<speaker>/psd-verification.json입니다. 그 보고서의 원래 절대 경로는 그대로 보존했으며, 이 인계본에서는 baseline의 상대 경로를 사용하세요.

## 제작 범위와 남은 납품

사용자는 현재 얼굴을 승인했고 앞서 제안한 네 가지 시각 보정은 건너뛰었습니다. 이를 다시 승인받는 작업은 요구하지 않습니다. 새로 분리한 눈·입·안경·팔·손의 기능과 변형 검수는 필요합니다. 실제 Cubism 가져오기·메쉬·디포머·키폼 리깅은 아직 수행되지 않았습니다.

남녀별 motion3 6개와 exp3 3개, 총 **motion3 12개 / exp3 6개**는 전용 모델 매핑·재생 전의 초안 데이터입니다. 파라미터는 계획값이며 일반 모션에 입 채널을 넣지 않았습니다. 손 제스처는 0이고 독립 손·펜 동작은 구현되지 않았습니다. 손과 책상·노트·소매의 가림도 실제 리깅에서 해결해야 합니다.

현재 실제 납품물에는 전용 .cmo3, .can3, .moc3, .model3.json, 텍스처 아틀라스, 모델별 .motionsync3.json과 필요한 최종 물리/추가 설정이 없습니다. 실제 출력 음성과 입 모양의 한국어 합성 검수, 웹·Expo 기기의 카메라·녹음·전사·시선 분석 동시 검수도 없습니다. **30FPS는 초기 목표이며 실측 결과가 아닙니다.** 릴리스 완료로 표시하지 마세요.

공식 Cubism Core·MotionSync Core와 공식 SDK 번들·샘플 모델은 재배포하지 않았습니다. source/public/live2d/runtime/provenance.json은 기존 빌드의 버전·출처 기록일 뿐 실행 파일 제공이 아닙니다. 인계 코드의 SDK 계약과 준비 스크립트를 참고하고 사용권을 확인한 공식 패키지를 별도로 확보해야 합니다.

## 상세 문서 — 원본 파일을 한 세트로 보존

아래 상대 경로가 이 ZIP 안의 실제 상세 문서입니다. 별도 요약 사본을 중복 작성하지 않았습니다.

- source/docs/live2d/qa_report.md — 실제 파츠·PSD·검수 상태와 현재 차단
- source/docs/live2d/mouth_rigging_spec.md — 입 2축·음소 키폼·입안/치아/입술·가림 설계
- source/docs/live2d/parameter_spec.md — 계획 ID/범위·소유권·실제 모델 대조
- source/docs/live2d/motion_spec.md — 모션·표정 목록·사용 조건·중단/인계 규칙
- source/docs/live2d/runtime_integration.md — 기존 출력 오디오·웹·Expo 연결 및 검증 범위
- source/docs/live2d/authoring-tools.md — 실제 저작 도구 확인과 미확보 경로
- source/docs/live2d/sdk-research.md — SDK/Core 버전·공식 출처·라이선스·CLOVA 저장 정책
- source/docs/live2d/production-spec.md — 장면 좌표·책상/손 가림을 포함한 계획 명세
- source/docs/live2d/art-review.md — 이전 정적 원화 검토 기록. 현재 얼굴 승인·4개 보정 건너뛰기는 이 README와 qa_report.md의 사용자 지시를 우선합니다.
- source/integrations/live2d/README.md — 애플리케이션 renderer 계약과 공식 SDK 빌드 절차
- source/examples/expo-scene/README.md — Expo/WebView 예제의 실제 설치·기기 미검증 범위

이 패키지의 source/는 제작물·연결 모듈·예제의 보존본입니다. 학생 자료·계정 키·기존 서비스 전체를 복제하지 않았으므로 source/만으로 완성 면접 서비스를 실행했다고 판단하지 마세요.

## 읽기 전용 확인과 향후 모델 납품 검사

source/에서 다음 모션 검사는 저장된 생성물을 바꾸지 않습니다.

```text
node scripts/prepare-interviewer-motions.mjs --check
node scripts/prepare-interviewer-motions.mjs --self-test
```

향후 실제 모델 폴더의 **정확한 납품 JSON 계약은 source/lib/live2d/delivery-contract.schema.json 한 파일**을 참조하세요. 별도 계약 요약 사본을 만들지 않았습니다. 실제 검사 진입점은 source/scripts/verify-live2d-assets.mjs이며, 구현은 source/lib/live2d/asset-validation.mjs, source/lib/live2d/delivery-validation.mjs 및 source/lib/live2d/core-validation.mjs에 있습니다. 실제 수신 파일은 새 비공개 경로 production/live2d/incoming/DELIVERY_ID/에 두고 새 보고서 경로를 사용하세요. 이 경로는 향후 수신용 예시이며 현재 완성 모델이 있다는 뜻은 아닙니다.

```text
node scripts/verify-live2d-assets.mjs --delivery-root <새 모델 납품 폴더> --report <새 비공개 보고서.json>
node scripts/verify-live2d-assets.mjs --delivery-root <새 모델 납품 폴더> --core <정식 로컬 Core.js> --report <다른 새 보고서.json>
```

실제 QA 증거가 준비된 경우에만 --level3-evidence <실제 QA 증거.json>를 추가합니다. 파일 검사·Core 모델 로드·MotionSync/실기기 QA의 결과 플래그를 구분해야 합니다. Core를 제공하지 않은 검사를 실제 모델 로드 성공으로 계산하지 마세요.

L1 통과는 정적 납품 파일 검증입니다. Core가 없으면 L2는 차단 상태이며, L3는 실제 MotionSync·음성·웹/모바일 검수 실행 증거가 있어야 합니다. 외부 QA dossier 파일을 읽은 사실만으로 이 도구가 L3를 실행했다고 표시하지 않습니다. ready 등록의 정확한 조건은 source/lib/live2d/types.ts와 source/lib/live2d/manifest.ts를 참조하세요. ready에는 전용 모델·정적 검사·Core 모델 로드·보고서 해시 등의 등록 gate가 필요하며, releaseReady에는 실제 MotionSync 검증과 필수 실기기 QA를 추가로 갖춰야 합니다. 기존 source/public/live2d/scene.json은 blocked 그대로 보존했습니다.

validation/external/provenance.json이 있다면 새 비공개 경로에서 만든 런타임 번들의 출처 기록입니다. 실제 번들·셰이더·SDK 소스·Core는 이 인계 ZIP에 포함하지 않았습니다. 이전 public/runtime/provenance.json도 역사적 빌드 기록으로 그대로 보존했습니다.

source/scripts/source-artwork-inspection.mjs는 inspection.json을 쓰고, prepare-interviewer-parts/motions 및 build-interviewer-psd는 생성 작업을 합니다. 기존 인계본의 기준선을 다시 쓰는 명령으로 실행하지 마세요. source/scripts/verify-interviewer-production.mjs와 기존 production/README.md에는 과거 보고서 작성 명령이 남아 있으므로 원본 보존본을 대상으로 재실행하지 마세요. 수정 작업은 새 버전의 복사본에서 시작하고 결과·버전·검수 증거를 새 경로에 저장하세요.

ZIP CRC 검사와 실제 압축 해제 후 모든 상대 경로·파일 길이·SHA-256 대조 결과는 ZIP과 같은 보관 폴더의 archive-verification.json에 있습니다. 이 ZIP은 암호화 ZIP이 아니며, 비공개 보관 위치 자체가 외부 공유를 실행하지는 않습니다.

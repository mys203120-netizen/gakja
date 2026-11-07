# PR07-G 통합 복구 절차

실행 가능한 도구의 책임과 순서를 설명한다. 실제 운영 실행·접근/암호화/보관 위치 승인·RTO/RPO 목표 승인은 별개다. 결과는 Git 제외 recovery-manifest/recovery-verification 및 원래 실패 로그에 남긴다.

## 동결과 내보내기

1. 해당 범위의 유효 operator로 freeze하고 영수증/generation/fence를 확인한다. 신규 HTTP/WSS/provider/worker를 막고 기존 operation을 fence한다. 대기 작업이 새 generation을 자동 채택하지 않는다.
2. DB receipt/revision/write facts/session binding으로 durable 쓰기가 **전혀 없음을** 증명한 경우에만 rollback-empty를 확정하고 동일 local fence lock에서 checkpoint를 복원한다. 불명확한 응답은 receipt 조회로 해결하고 local fallback하지 않는다.
3. 쓰기 이후에는 frozen을 유지하고 exportRecovery/captureRecoveryArchive를 실행한다. C verified metadata/audio/Storage bytes, D run/artifact/alias/dependency/pointer/history, E session/context/pins와 9 child collections, F 14 tables, G 8 evidence collections를 포함한다.
4. raw TEXT UTF-8 SHA, domain snapshot hash, JSONB 보존 projection을 구분하고 모든 object bytes/size/hash를 확인한다. 목적 ID·UTF-16 인용·서명·기존 hash 대상을 바꾸지 않는다. 원래 스키마·실패 보고서도 보존한다.

## 독립 endpoint 복원

1. 소스와 다른 PostgreSQL endpoint와 다른 private Storage endpoint를 명시한다. 같은 endpoint의 다른 bucket/schema는 독립 복구로 집계하지 않는다. 현재 Auth/mapping은 새 환경에서 별도 검증한다. archive 과거 grant가 현재 권한을 발급하지 않는다.
2. restoreRecoveryArchive는 manifest·metadata·모든 bytes를 먼저 검증한다. 누락/변조는 publication 전에 거부한다. 부분 업로드는 ready가 아니며 재실행에서 exact bytes를 확인한 object만 재사용한다.
3. DB와 archive의 logical ref는 보존하고 별도 location mapping으로 physical bucket/key를 연결한다. restored provider는 destination만 읽으며 소스 Storage나 local file로 fallback하지 않는다.
4. 검증한 목록을 0007 atomic publication에 전달한다. restored session/evaluation writer는 read-only, lease와 worker/operator grant는 비활성이다. 과거 권한 이력은 archive 사실로 보존한다.
5. 소스 DB/Storage를 실제 차단한 별도 process에서 current/pinned/historical C/D, E/F confirmed receipt replay와 기존 결과를 읽는다. 신규 session/write/claim/provider는 거부한다. 재내보내기한 TEXT/hash/row projection을 archive와 대조한다.

## 장애와 재개

- prepare/activate crash: local barrier를 유지하고 같은 key/input receipt를 조회한다. 미확인 process/임시 파일/새 data 경로를 자동 병합·삭제하지 않는다.
- provider 대기 중 freeze/철회: operation cancellation 및 최종 SQL guard가 publication을 막아야 한다. 모델 재시도로 검수 결함을 보완하지 않는다.
- commit 응답 유실: 같은 key/hash로 durable receipt를 확인한다. 미확인 상태에서 local writer를 열지 않는다.
- restore 중단: publication 0/ready false를 확인한 뒤 동일 manifest로 재개한다. 다른 manifest로 덮어쓰지 않는다.
- bytes/hash 불일치: source·archive·원래 실패 보고서를 보존하고 개방을 보류한다.
- post-write rollback: writable local 복귀가 아니다. freeze/export/독립 restore 후 소유권을 검증한 read-only compatibility service로 제공한다. 활성 legacy runtime 자동 이관은 지원하지 않는다.

RTO는 실제 훈련의 시작/종료·duration을, RPO는 마지막 confirmed write/checkpoint의 보존 수·hash를 기록한다. 승인된 목표가 없으므로 목표 달성으로 판정하지 않는다. 새 외부 백업 서비스나 실학생 업로드는 추가하지 않는다.

# PR07-G 서비스 연결과 선택 범위 전환

기준은 F `4261acbd0cbc763a838be102b565d66f6f01e036`과 청사진 v2다. G는 PR07의 일곱 번째 단위이며 청사진 G0~G8 전체 완료를 뜻하지 않는다. 운영 migration·배포·실계정 전환·실학생 업로드·유료 호출·실제 평가 승인은 실행 범위에 없다. 실제 결과와 SHA는 Git 제외 `artifacts/pr07g/final-report.json`에서 확인한다. 문서의 명령·예시는 실행 증거가 아니다.

## 실제 연결 지도

| 경계 | G caller | 보존 |
| --- | --- | --- |
| 시작 | run-service-realtime → production-composition → trusted JWT/current PostgresAccountResolver | 설정 없는 mutation 503, 기존 isolated wrapper |
| C/D | scoped request/object/shadow repository → private object verification → scoped shadow reader | 원래 ref/hash·current/pinned/historical, local fallback 금지 |
| 새 입력 | 0008 별도 operator 승인·service-verified run | 기존 synthetic/local-verification-only 행 재라벨·UPDATE 금지 |
| E | scoped session service → 현행 classifier/single/realtime core → CAS SQL | 기존 domain/command hash·질문/시간/종료/과금 정책 |
| F | scoped review/supply/consumer → 독립 worker → 기존 parser/aggregation | A/B 별도 주체·서명·승인, immutable E handoff, 보류 F |
| 전환 | 0006 상태/generation/fence/영수증/이력/active operations | ENV·메모리 Map을 권위로 사용하지 않음 |
| 복구 | 0007 exact metadata/byte archive + logical→physical provider | ID·서명 TEXT·domain hash를 위치 때문에 바꾸지 않음 |

opaque service capability는 서버가 보유한다. 요청 body의 kind/role/flag로 만들 수 없다. production은 native provider adapter만 조립하며 rehearsal raw seam은 nonproduction 전용이다. 합성 raw 응답·미디어 성공은 상용 STT/TTS·모델 시험과 구분한다.

`run-service-evaluation-worker.mjs`는 명시적 인증 command 파일의 한 job만 처리하는 내부 진입점이다. request/worker 역할만 받으며 mapping/admin/bypass/Storage credential을 거부한다. 실제 current subject→job grant와 scope/generation/만료를 재검사한 뒤 기존 worker를 호출한다. 전체 pending scan이나 공개 dispatch route는 없다. 이번 실행에서는 native provider를 호출하는 `--run-authorized-job`을 실행하지 않는다.

## 전환과 실제 writer 차단

정확한 owner/student/personal application/support 및 sourceRevision **존재 여부**까지 전환 범위에 포함한다. Auth subject와 각 ID는 별개다. E/F sessionAuthority의 sourceRevision 누락은 grant 제한 없음, 명시 null/string은 정확 일치다. 다른 문서 pin의 null 의미를 합치지 않는다.

상태는 `unprepared → blocking → verified → db-primary → frozen`이며 `restoring/read-only-recovery/local-primary` 경로가 별도로 있다. 유한 operator grant가 전환 명령을 수행하며 사용자·reviewer·worker 권한을 전환 권한으로 복제하지 않는다. 같은 key/input은 저장 영수증 재생, 변경 입력은 충돌이다. E/F는 같은 DB generation을 사용하고 최종 SQL commit까지 공유 잠금을 유지한다. provider 대기 중 DB transaction/client/row lock은 유지하지 않는다.

| DB 상태 | 현재 권한으로 검증한 읽기 | 신규 E/F 쓰기 | worker claim/provider | 전환 동작 |
| --- | --- | --- | --- | --- |
| unprepared/local-primary | 등록된 scope의 검증된 읽기만 | 거부 | 거부 | prepare |
| blocking | 검증된 읽기만 | 거부 | 거부 | checkpoint 검증·새 service input 등록 |
| verified | 검증된 읽기만 | 거부 | 거부 | finite expiry 확인 후 activate |
| db-primary | 허용 | 같은 generation/operation/현재 권한에서만 | finite job·현재 검수·lease/fence에서만 | freeze |
| frozen | 읽기·이미 확정한 receipt replay | 거부 | 거부 | export, 증명된 empty rollback 또는 recover |
| restoring | 새 복원 자료 개방 금지 | 거부 | 거부 | bytes 검증 후 atomic publication |
| read-only-recovery | 새 현재 권한으로 읽기·확정 receipt replay | 거부 | 거부 | 별도 운영 검증까지 유지 |

전환 행이 없는 서비스 범위는 거부한다. 읽기 허용은 인증·현재 귀속·C/D 정확 ref/hash·입력 승인 검사를 생략한다는 의미가 아니다. `local-primary`의 local writer 재개는 DB empty receipt를 확인한 별도 coordinator만 수행한다.

새 인증 세션만 전환한다. 활성 runtime-v1을 번역하지 않는다. active/ending legacy session 또는 queued/running local job이 있으면 scope prepare를 거부하고 기존 경로를 보존한다. 운영 소유 mapping·책임·기간·중단 조건은 별도 공급 대상이다.

`local-writer-fence.ts`는 명시적으로 등록한 root에만 동작한다. 참여 writer의 실제 최종 rename/append와 활성화가 동일한 cross-process 파일 잠금을 사용한다. 기존 프로세스 inventory/중지 확인이 불완전하면 coordinator가 활성화를 거부한다. 중지 확인 후 선택한 복사본의 `data`를 private snapshot으로 옮기고 원래 경로에 일반 파일 barrier를 설치한다. 재시작한 수정 전 F writer도 그 아래 mkdir/rename을 할 수 없다. 원본 worktree의 bytes/ACL은 바꾸지 않는다.

이 차단은 해당 컴퓨터·등록 root에만 성립한다. 다른 PC/경로/미확인 binary를 DB가 자동 차단한다고 주장하지 않는다. crash는 blocked/sealed 상태를 유지한다. 명시적 dead-owner 복구만 허용하며 시간 경과만으로 살아 있는 lock을 빼앗지 않는다. archive를 삭제하거나 빈 source를 자동 생성하지 않는다.

## readiness와 검수

preflight는 `pass/fail/blocked/not-run`을 구분한다. 설정 존재는 접속·승인·실호출 증거가 아니다. 운영 .env를 자동 채택하지 않는다. Auth, mapping, DB 역할, migration/checksum/RLS/FK, private Storage, 승인 입력, 현재 전환 상태, provider 설정, 검수 동기화를 각각 확인한다. DB 접속만으로 전체 ready가 되지 않는다.

검수 trust 관측 시점·철회 동기화·유효기간은 공급된 정책을 사용하고 운영 SLA를 임의로 정하지 않는다. 미공급/잘못된/철회된/전부 보류된 승인은 durable `review_required`, job/점수/모델 호출 없음이다. 질문 승인·A 사전 규격·B 종료 세션 승인은 별개다. 실제 은행의 평가 승인 0개와 pending은 유지한다.

## 검증 범위와 다음 단위

root 전체와 portable은 기존 파일 단위 제외 21개/199사례 차이를 명시한다. root와 B~G nested suite를 합산하지 않는다. 최종 SHA public checkout은 npm ci와 pinned Python을 새 설치하며 private 자료·dependency copy/junction을 사용하지 않는다. private 비교는 기존 112항목(111 전체 동일, 1 기존 strategy generatedAt projection)만 허용한다.

운영 Auth/귀속/Storage/승인 신뢰/보관·암호화/책임자·기간, 실마이크/상용 provider/iOS/Android/W0 실제 API/200% 브라우저/PR04 의미 품질은 별도 관문이다. 다음 단위는 승인된 운영 입력으로 읽기 전용 preflight와 제한 scope의 준비를 검증하는 것이다. G 구현 완료는 운영 활성화 승인이 아니다.

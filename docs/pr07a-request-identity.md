# PR07-A 요청 인증·소유권 경계

청사진 v2와 PR07 준비 문서의 A 범위다. 인증은 실행 문맥이며 기존 domain JSON·runtime-v1·서명·hash 대상에 추가하지 않는다. 실제 운영 제공자/계정/자원 mapping은 아직 연결되지 않았다. 검증 명령·실제 commit/checkout SHA·CI·원본 불변 결과는 Git 제외 `artifacts/pr07a/`에 기록한다.

## 진입점과 부수 효과의 순서

| 진입점 | 인증·권한 후 허용되는 동작 | 개인 자료/쓰기 경계 |
|---|---|---|
| service 시작/health | 최소 app/ok/mode 응답 | 고정 학생 context·session list·startup recovery·worker를 시작하지 않음 |
| status | Bearer 검증→(issuer,subject) mapping→학생/개인 지원처 선택→scoped status | 선택 전 응답은 인증/선택 필요 상태만. 개인 status는 scope 이후만 조회 |
| audio | 인증→서버 audio binding→owner/student/applicationTarget/supportTarget 권한→owned bytes | fallback 전체 탐색 없음. read 전후 권한 확인, private/no-store와 Vary 헤더 |
| session GET | 인증→서버 session binding→권한→read-only 기존 session 조회→owner/context pin 확인 | service는 findSession/recovery/save/evaluation 동기화를 호출하지 않음 |
| prepare/new session/next/answer-candidate/end/closing/retry-evaluation/timings/events | 인증과 기존 리소스 binding 확인 후 명시적503 미지원 | authenticated runtime-v1 새 저장 계약 미준비. writer/provider 호출 없이 거부 |
| realtime-ticket | 인증→session binding→현재 권한 확인→일회성 난수 ticket 발급 | 장기 bearer를 query에 넣지 않음. body identity 변경 거부 |
| WSS upgrade | Host/Origin→ticket 소모→만료/계정 재검사→현재 session metadata와 고정 binding 비교→upgrade | findSession/checkpoint/로그/STT보다 앞에서 권한 확인 |
| WSS message | 고정 주체/세션의 readonly ping/pong | STT/변경 명령은 미지원. 바이너리마다 원격 인증 조회를 하지 않으며 private provider를 호출하지 않음 |
| local HTTP/WSS | 명시적 local composition의 기존 엔진 | 기존 owner와 session owner를 save 전에 대조. 기존 복구·재생·종료 정책 유지 |
| 평가 worker | 서버가 발급한 유한 job ID capability→신뢰 binding→job metadata→frozen snapshot/context→claim | service는 pending 전체 탐색/격리 없음. 모델 전·모든 저장/결과 확정 전 capability/binding 재확인 |
| 공급·registry 준비·평가 worker CLI | 명시적 local composition만 실행 | 운영 권한/승인 mapping 미준비 시 stores/loop/개인 IO 전에 거부. 로그인은 검수 승인 아님 |

## 검증기·mapping·RequestContext

`jose` 6.2.15를 정확히 고정했다. 자체 JWT 암호 구현 없이 `jwtVerify`와 trusted local/remote JWKS를 사용한다. 서버 설정의 issuer/audience/algorithm(RS256/ES256/EdDSA)/키로 서명과 필수 iss/sub/aud/exp, nbf 및 제공된 iat를 검사한다. 임의 jku/x5u/issuer URL을 따라가지 않는다. Remote JWKS는 서버가 지정한 HTTPS URL만 사용하며 timeout5초/cache5분이다. 검증 실패는401, mapping 부재는403, 키/mapping 의존성 장애는503이며 private 경로나 토큰을 응답하지 않는다.

`AccountResolver`는 `(issuer,subject)`를 내부 account/owner와 student/applicationTarget/supportTarget grant로 변환한다. 이메일·이름·PDF hash·요청의 owner/role은 권위가 아니다. `applicationTargetId`는 개인 지원처이며 기존 `supportTargetId`와 다르다. sourceRevision이 지정된 grant는 그 pin을 요구하고 null은 미확인 literal이다. 선택 전 scope=null은 개인 자료 전체 접근이 아니며, 개인 자원은 서버 binding과 실제 grant를 항상 대조한다.

RequestContext는 boundary가 발급하고 principal/account/grant를 복사·freeze한다. 복제/위조 context는 거부한다. mapping revision과 현재 grant를 재확인하고 만료 중의 비동기 조회도 결과 반환 전에 거부한다. 인증 토큰은 context/cache key/로그에 넣지 않는다. 두 계정이 같은 source hash·지원처 표시명·음성 ID를 써도 실행 cache/single-flight는 계정·owner·학생·개인 지원처·source/resource pin으로 구분한다. 영속 bank key와 domain hash는 바꾸지 않는다.

운영 composition에는 실제 AccountResolver와 ServiceRequestResources가 필요하다. 환경 변수만 채워도 로컬 학생 자료를 자동 귀속하거나 test resolver를 설치하지 않는다. 합성 resolver/resources는 programmatic test composition에서만 허용하며 NODE_ENV=production에서는 거부한다. 운영 미설정 상태의 거부 시험과 두 합성 계정의 정상 조회 시험은 별개다.

## 실행 모드

| 설정 | 결과 |
|---|---|
| API mode 미설정/빈 값/service | service. 운영 verifier/mapping/resource가 없으면 개인 IO 전 거부 |
| 명시적 local-development + 비production | 기존 단일 owner 로컬 엔진 |
| local-development + NODE_ENV=production | 시작/실행 거부 |
| LOCAL_INTERVIEW_OWNER_ID만 설정 | service 인증이나 계정 mapping을 켜지 않음 |
| Next production build | 웹 산출물 생성일 뿐 로컬 API identity를 선택하지 않음 |
| npm test/portable | `tests/local-composition.mjs`로 기존 local 회귀를 명시. 새 service 검사는 독립적으로 service를 선택 |

`npm run dev`/`start:local`은 local composition이다. `npm run dev:realtime`은 명시적 local wrapper이고, `npm run prepare:evaluation-scopes -- coverage`도 local CLI wrapper다. 별도 개발 CLI는 `node --import tsx scripts/run-local-cli.mjs prepare-approved-knowledge.ts ...`처럼 실행한다. explicit service/production 설정을 로컬 wrapper가 덮어쓰지 않는다.

운영 서비스 진입 명령은 `npm run service:realtime` 또는 `node --import tsx scripts/run-service-realtime.mjs`다. 이 retained entry는 legacy realtime 모듈을 import하지 않는다. 인증 모듈이 빠진 rollback에서도 시작 실패로 닫힌다. 현재 실제 운영 mapper가 없으므로 이 명령으로 인증된 면접 저장을 제공하지 않는다.

## runtime-v1·WebSocket·worker 보존

runtime-v1의 owner.mode=local-development는 과거 데이터의 계약으로 유지한다. authenticated context로 강제 cast하거나 기존 JSON을 다시 쓰지 않는다. 신뢰 binding으로 명시 허용한 legacy 자료만 읽고 authenticated 새 세션/저장은503이다. 실계정 writer는 PR07-E/F의 버전 계약·권한 저장이 준비된 뒤 별도로 연결한다.

WebSocket은 인증된 HTTP ticket endpoint로 발급한 256bit 난수를 사용한다. 최대30초, 인증 만료 이하, 일회성, owner/session/source binding이다. upgrade 뒤 principal 만료 시 종료하고 최대5초 간격과 control message에서 계정 grant·현재 resource metadata를 재확인한다. 소유권 이전/삭제/매핑 장애도 연결을 종료한다. 연결 후 message의 세션/owner/scope 변경은 거부한다. 이 단계의 authenticated socket은 readonly이며 기존 STT/TTS/턴/answer 계약을 새로운 가짜 성공으로 대신하지 않는다.

내부 worker는 브라우저 RequestContext를 재사용하지 않는다. 기존 job의 supportTargetId는 도메인 전형 ID이며 개인 applicationTargetId가 아니다. 현재 job에는 개인 지원처 필드가 없으므로 운영 resolver가 그 연결을 입증하는 단계는 미연결 상태로 남고, 이번 합성 권한은 명시 job ID와 정확한 frozen context를 기준으로 제한한다. 서버 발급 capability의 subject/만료/명시 job 목록과 신뢰 resolver를 대조한다. 다른 owner·student·target·session·source/snapshot/context/pipeline/model binding을 거부한다. provider 대기 중 만료/철회되면 결과·실패·usage 저장을 권한 없이 계속하지 않는다. 기존 실제 A/B 검수 gate와 모델 전/확정 전 재검사는 유지한다. 로그인/worker 권한이 질문/평가 승인을 만들지 않는다.

## 검증과 남은 운영 조건

실제 서명 토큰, 두 계정 정상 조회, 교차/위조 scope, source/cache/동시성, 실제 HTTP/WSS upgrade/message, 만료·매핑/resource 권한 변경, startup IO tripwire, 정상 signed A/B worker와 잘못된 binding, CLI·안전 rollback을 공개 portable 회귀에 포함한다. 기존 private 제외 manifest는 확대하지 않는다. 최종 실행 결과·source/commit SHA·새 설치·원격 CI는 artifacts 보고서로 연결한다.

실제 제공자 연결, 운영 계정/자원 mapping, 브라우저 credential UI, DB/RLS·Storage·writer, W0 실계정 API는 미완료다. 실제 평가 승인0/대기35는 새 coverage로 다시 확인하며 합성 승인 fixture를 실제 재고에 더하지 않는다. W0 실제200%·편집/키보드·모션, G1 실장치/상용 미디어, PR04 의미 품질도 별도 관문이다.

공식 검증기 자료: [jose](https://github.com/panva/jose), [trusted remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md). Draft2020 전체 지원이나 다사용자 운영 완료를 이 변경으로 주장하지 않는다.

## 롤백·PR07-B 시작 조건

구현 변경을 revert할 때 retained service entry 커밋은 유지한다. 운영 entry를 옛 `realtime.ts`로 바꾸거나 전체 branch를 과거 공개 로컬 엔진으로 돌리지 않는다. 운영 ingress도 인증 구현이 검증될 때까지 차단한다. retained entry에서 인증 모듈 없는 실제 startup이 실패하고 private marker가 생기지 않는 회귀를 유지한다. 로컬 회귀의 복구는 분리된 구현 커밋 단위이며 원본 worktree reset/clean·force push·private 데이터 복원 쓰기가 필요하지 않다.

PR07-B는 실제 Auth issuer/audience/key 신뢰·운영 subject→account/owner/student/applicationTarget mapping의 책임과 데이터가 정해지고, A의 정확한 SHA 재현/CI 및 두 계정 격리 증거가 확보된 뒤 시작한다. 그때 격리 DB에서 소유권 FK/RLS·service role 최소 권한을 시험한다. 현재 로그인만으로 기존 로컬 학생을 귀속하거나 실제 migration/운영 Auth 설정을 변경하지 않는다.

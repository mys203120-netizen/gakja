-- Public, explicitly synthetic fixtures. No production identities or approvals.
INSERT INTO gakja.accounts(account_id, owner_id) VALUES
  ('account-a','owner-a'), ('account-b','owner-b'), ('account-c','owner-c');
INSERT INTO gakja.principals(issuer, subject, account_id) VALUES
  ('https://issuer-a.example','shared','account-a'),
  ('https://issuer-b.example','shared','account-b'),
  ('https://issuer-a.example','c','account-c');
INSERT INTO gakja.students(owner_id, student_id, display_name, source_sha256) VALUES
  ('owner-a','student-a','Same synthetic name',repeat('f',64)),
  ('owner-b','student-b','Same synthetic name',repeat('f',64)),
  ('owner-c','student-c','Same synthetic name',repeat('f',64));
INSERT INTO gakja.target_profiles VALUES ('domain-track','profile-r1','university-synthetic','department-synthetic','track-synthetic',2027);
INSERT INTO gakja.application_targets VALUES
  ('owner-a','student-a','app-a','domain-track','profile-r1','Same target'),
  ('owner-a','student-a','app-a2','domain-track','profile-r1','Same target'),
  ('owner-b','student-b','app-b','domain-track','profile-r1','Same target'),
  ('owner-c','student-c','app-c','domain-track','profile-r1','Same target');
INSERT INTO gakja.access_grants(account_id, owner_id, student_id, application_target_id, support_target_id, source_present, source_revision) VALUES
  ('account-a','owner-a','student-a','app-a','domain-track',false,NULL),
  ('account-a','owner-a','student-a','app-a2','domain-track',true,NULL),
  ('account-b','owner-b','student-b','app-b','domain-track',true,NULL),
  ('account-c','owner-c','student-c','app-c','domain-track',true,'source-r1');
INSERT INTO gakja.session_bindings(owner_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,context_snapshot_sha256,frozen_source_sha256) VALUES
  ('owner-a','11111111-1111-4111-8111-111111111111','student-a','app-a','domain-track',false,NULL,repeat('1',64),repeat('f',64)),
  ('owner-b','22222222-2222-4222-8222-222222222222','student-b','app-b','domain-track',true,NULL,repeat('2',64),repeat('f',64)),
  ('owner-c','33333333-3333-4333-8333-333333333333','student-c','app-c','domain-track',true,'source-r1',repeat('3',64),repeat('f',64));
INSERT INTO gakja.audio_bindings VALUES
  ('owner-a','same-audio.mp3','student-a','app-a','domain-track',false,NULL,encode(sha256(convert_to('explicit-synthetic-audio','UTF8')),'hex')),
  ('owner-b','same-audio.mp3','student-b','app-b','domain-track',true,NULL,encode(sha256(convert_to('explicit-synthetic-audio','UTF8')),'hex')),
  ('owner-c','same-audio.mp3','student-c','app-c','domain-track',true,'source-r1',encode(sha256(convert_to('explicit-synthetic-audio','UTF8')),'hex'));
INSERT INTO gakja.job_bindings(owner_id,job_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,source_sha256,snapshot_sha256,context_snapshot_sha256,pipeline_version,model) VALUES
  ('owner-a',repeat('a',64),'11111111-1111-4111-8111-111111111111','student-a','app-a','domain-track',false,NULL,repeat('d',64),repeat('e',64),repeat('1',64),'explicit-synthetic-pipeline','explicit-synthetic-model'),
  ('owner-b',repeat('b',64),'22222222-2222-4222-8222-222222222222','student-b','app-b','domain-track',true,NULL,repeat('d',64),repeat('e',64),repeat('2',64),'explicit-synthetic-pipeline','explicit-synthetic-model'),
  ('owner-c',repeat('c',64),'33333333-3333-4333-8333-333333333333','student-c','app-c','domain-track',true,'source-r1',repeat('d',64),repeat('e',64),repeat('3',64),'explicit-synthetic-pipeline','explicit-synthetic-model');
INSERT INTO gakja.worker_job_grants VALUES
  ('worker-a','owner-a',repeat('a',64),true,'2099-01-01T00:00:00Z'),
  ('worker-b','owner-b',repeat('b',64),true,'2099-01-01T00:00:00Z');

-- Original byte hash, existing snapshotHash(JSON.parse(raw)) and JSONB projection are separate.
-- The two domain_sha256 constants below were calculated by server/session-runtime.ts snapshotHash;
-- neither is computed from JSONB nor substituted for the original bytes hash.
WITH inputs(owner_id, student_id, present, revision) AS (VALUES
  ('owner-a','student-a',false,NULL::text), ('owner-b','student-b',true,NULL::text), ('owner-c','student-c',true,'source-r1')),
bytes AS (SELECT convert_to(E'{"b":2,"a":"한글🙂","nullable":null}\r\n','UTF8') AS raw)
INSERT INTO gakja.common_versions(owner_id, student_id, kind, revision, version_id, source_present, source_revision, content_sha256, domain_sha256, original_ref, original_bytes, projection)
SELECT owner_id, student_id, 'full-student-analysis', 'analysis-r1', 'same-common-version', present, revision,
  encode(sha256(raw),'hex'), '1ac006afba16ca46168f8476ee1d844f53fb8c983a272bed964e6cef9b3a3f06', 'synthetic://original-common', raw, convert_from(raw,'UTF8')::jsonb FROM inputs CROSS JOIN bytes;
WITH inputs(owner_id, student_id, app, present, source_revision) AS (VALUES
  ('owner-a','student-a','app-a',false,NULL::text), ('owner-b','student-b','app-b',true,NULL::text), ('owner-c','student-c','app-c',true,'source-r1')),
bytes AS (SELECT convert_to(E'{"z":"합성🙂","missing-field-omitted":true}\n','UTF8') AS raw)
INSERT INTO gakja.target_versions(owner_id, student_id, application_target_id, support_target_id, kind, revision, version_id, source_present, source_revision, content_sha256, domain_sha256, original_ref, original_bytes, projection)
SELECT owner_id, student_id, app, 'domain-track','target-student-analysis','analysis-r1','same-target-version',present,source_revision,
  encode(sha256(raw),'hex'),'96e9a66d4158990a0ffc932ac642b2c8b320a1d398d830042237042962ebda62','synthetic://original-target',raw,convert_from(raw,'UTF8')::jsonb FROM inputs CROSS JOIN bytes;
INSERT INTO gakja.common_pointers SELECT owner_id, student_id, kind, version_id FROM gakja.common_versions;
INSERT INTO gakja.target_pointers SELECT owner_id, student_id, application_target_id, kind, version_id FROM gakja.target_versions;
INSERT INTO gakja.private_objects(owner_id, student_id, application_target_id, support_target_id, object_id, kind, source_present, source_revision, size_bytes, content_sha256, object_ref)
SELECT owner_id, student_id, application_target_id, support_target_id, 'same-object', 'synthetic-audio', source_present, source_revision,
  24, content_sha256, 'synthetic-private://' || owner_id || '/same-object' FROM gakja.audio_bindings;
INSERT INTO gakja.legacy_mappings(owner_id, student_id, application_target_id, support_target_id, resource_kind, legacy_id, source_present, source_revision, original_pin, storage_id, attribution_ref)
SELECT owner_id, student_id, application_target_id, support_target_id, 'target-student-analysis','same-legacy-id',source_present,source_revision,
  'same-original-pin','same-target-version','explicit-synthetic-attribution' FROM gakja.audio_bindings;

INSERT INTO gakja.common_private_objects(owner_id,student_id,object_id,kind,source_present,source_revision,size_bytes,content_sha256,object_ref)
SELECT owner_id,student_id,'same-common-object','synthetic-original',source_present,source_revision,octet_length(original_bytes),content_sha256,
  'synthetic-private://' || owner_id || '/original' FROM gakja.common_versions;
INSERT INTO gakja.common_legacy_mappings(owner_id,student_id,resource_kind,legacy_id,source_present,source_revision,original_pin,storage_id,attribution_ref)
SELECT owner_id,student_id,'full-student-analysis','same-legacy-full-id',source_present,source_revision,'same-original-pin',version_id,
  'explicit-synthetic-attribution' FROM gakja.common_versions;

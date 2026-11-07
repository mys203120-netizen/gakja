-- PR07-F. E's immutable handoff/session facts are references, never F state.
-- Text bytes and existing domain identities remain separate from JSON projections.
CREATE TABLE gakja.evaluation_scopes (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  source_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:'||source_revision END) STORED,
  trust_generation bigint NOT NULL DEFAULT 0 CHECK(trust_generation>=0), registry_generation bigint NOT NULL DEFAULT 0 CHECK(registry_generation>=0),
  current_trust_sha256 text, current_registry_sha256 text, current_registry_receipt_sha256 text,
  PRIMARY KEY(owner_id,student_id,application_target_id,source_pin_key),
  FOREIGN KEY(owner_id,student_id,application_target_id,support_target_id) REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
  CHECK((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE TABLE gakja.evaluation_artifacts (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL, source_pin_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('trust','registry','registry-receipt','bundle','session-receipt','reviewed-context')),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  raw_json text NOT NULL CHECK(octet_length(raw_json) BETWEEN 2 AND 16777216),
  raw_sha256 text NOT NULL CHECK(raw_sha256=gakja.session_text_sha(raw_json)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,student_id,application_target_id,source_pin_key,kind,content_sha256),
  FOREIGN KEY(owner_id,student_id,application_target_id,source_pin_key) REFERENCES gakja.evaluation_scopes(owner_id,student_id,application_target_id,source_pin_key)
);
CREATE TABLE gakja.evaluation_sessions (
  owner_id text NOT NULL, session_id text NOT NULL,
  student_id text NOT NULL, application_target_id text NOT NULL, support_target_id text NOT NULL, source_pin_key text NOT NULL,
  original_context_sha256 text NOT NULL, handoff_intent_id uuid NOT NULL, handoff_payload_sha256 text NOT NULL, frozen_session_sha256 text NOT NULL,
  source_dependencies_json text NOT NULL CHECK(jsonb_typeof(source_dependencies_json::jsonb)='object'),
  source_dependencies_sha256 text GENERATED ALWAYS AS (gakja.session_text_sha(source_dependencies_json)) STORED,
  writer text NOT NULL DEFAULT 'db' CHECK(writer IN ('db','read-only')), fence bigint NOT NULL DEFAULT 1 CHECK(fence>0),
  approval_generation bigint NOT NULL DEFAULT 0 CHECK(approval_generation>=0),
  current_approval_sha256 text, current_bundle_sha256 text, approval_registry_sha256 text,
  approval_revoked boolean NOT NULL DEFAULT false, approval_issued_at timestamptz, approval_accepted_at timestamptz,
  PRIMARY KEY(owner_id,session_id),
  FOREIGN KEY(owner_id,session_id,original_context_sha256) REFERENCES gakja.session_command_sessions(owner_id,session_id,context_sha256),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.session_evaluation_handoffs(owner_id,session_id),
  FOREIGN KEY(owner_id,student_id,application_target_id,source_pin_key) REFERENCES gakja.evaluation_scopes(owner_id,student_id,application_target_id,source_pin_key)
);
CREATE TABLE gakja.evaluation_jobs (
  owner_id text NOT NULL, job_id text NOT NULL CHECK(job_id ~ '^[a-f0-9]{64}$'), session_id text NOT NULL,
  approval_sha256 text NOT NULL, source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_json text NOT NULL CHECK(octet_length(snapshot_json) BETWEEN 2 AND 16777216), snapshot_sha256 text NOT NULL CHECK(snapshot_sha256=gakja.session_text_sha(snapshot_json)),
  context_sha256 text NOT NULL CHECK(context_sha256 ~ '^[a-f0-9]{64}$'), pipeline_version text NOT NULL, model text NOT NULL,
  revision_json text NOT NULL, revision_sha256 text NOT NULL CHECK(revision_sha256 ~ '^[a-f0-9]{64}$'), revision_raw_sha256 text NOT NULL CHECK(revision_raw_sha256=gakja.session_text_sha(revision_json)),
  input_binding_sha256 text NOT NULL CHECK(input_binding_sha256 ~ '^[a-f0-9]{64}$'),
  trust_generation bigint NOT NULL, registry_generation bigint NOT NULL, approval_generation bigint NOT NULL, session_fence bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','review_required')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_retry_at timestamptz, lease_token uuid, worker_id text, lease_until timestamptz, lease_fence bigint NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  error_json text, result_sha256 text,
  PRIMARY KEY(owner_id,job_id), UNIQUE(owner_id,session_id,job_id), UNIQUE(owner_id,job_id,input_binding_sha256),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.evaluation_sessions(owner_id,session_id),
  CHECK((lease_token IS NULL AND worker_id IS NULL AND lease_until IS NULL) OR (status='running' AND lease_token IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE gakja.evaluation_consumptions (
  owner_id text NOT NULL, session_id text NOT NULL, consumption_id uuid NOT NULL DEFAULT gen_random_uuid(),
  approval_key text NOT NULL, approval_sha256 text, state text NOT NULL CHECK(state IN ('review_required','registered')),
  handoff_payload_sha256 text NOT NULL, trust_generation bigint NOT NULL, registry_generation bigint NOT NULL, approval_generation bigint NOT NULL,
  reasons_json text NOT NULL, job_id text, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,session_id,approval_key), UNIQUE(consumption_id), UNIQUE(owner_id,session_id,consumption_id),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.evaluation_sessions(owner_id,session_id),
  FOREIGN KEY(owner_id,session_id,job_id) REFERENCES gakja.evaluation_jobs(owner_id,session_id,job_id),
  CHECK((state='registered' AND job_id IS NOT NULL AND approval_sha256 IS NOT NULL) OR state='review_required')
);
CREATE TABLE gakja.evaluation_consumption_history (
  owner_id text NOT NULL, session_id text NOT NULL, consumption_id uuid NOT NULL, history_sha256 text NOT NULL,
  history_json text NOT NULL CHECK(history_sha256=gakja.session_text_sha(history_json)), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,session_id,consumption_id,history_sha256),
  FOREIGN KEY(owner_id,session_id,consumption_id) REFERENCES gakja.evaluation_consumptions(owner_id,session_id,consumption_id),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.evaluation_sessions(owner_id,session_id)
);
CREATE TABLE gakja.evaluation_command_receipts (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL, source_pin_key text NOT NULL,
  key text NOT NULL CHECK(gakja.is_trimmed_identifier(key) AND length(key)<=160), input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'), session_id text,
  action text NOT NULL, operation_id uuid NOT NULL DEFAULT gen_random_uuid(), result_json text NOT NULL, result_sha256 text NOT NULL CHECK(result_sha256=gakja.session_text_sha(result_json)),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,student_id,application_target_id,source_pin_key,key), UNIQUE(operation_id),
  FOREIGN KEY(owner_id,student_id,application_target_id,source_pin_key) REFERENCES gakja.evaluation_scopes(owner_id,student_id,application_target_id,source_pin_key),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.evaluation_sessions(owner_id,session_id)
);
CREATE TABLE gakja.evaluation_worker_grants (
  owner_id text NOT NULL, job_id text NOT NULL, worker_subject text NOT NULL, active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner_id,job_id,worker_subject), FOREIGN KEY(owner_id,job_id) REFERENCES gakja.evaluation_jobs(owner_id,job_id)
);
CREATE TABLE gakja.evaluation_checkpoints (
  checkpoint_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id text NOT NULL, job_id text NOT NULL, input_binding_sha256 text NOT NULL,
  cluster_id text NOT NULL, input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  checkpoint_json text NOT NULL, checkpoint_sha256 text NOT NULL CHECK(checkpoint_sha256=gakja.session_text_sha(checkpoint_json)), lease_fence bigint NOT NULL,
  UNIQUE(owner_id,job_id,cluster_id,checkpoint_sha256),
  FOREIGN KEY(owner_id,job_id,input_binding_sha256) REFERENCES gakja.evaluation_jobs(owner_id,job_id,input_binding_sha256)
);
CREATE TABLE gakja.evaluation_usage (
  owner_id text NOT NULL, job_id text NOT NULL, input_binding_sha256 text NOT NULL, attempt_id text NOT NULL,
  observation_json text NOT NULL, observation_sha256 text NOT NULL CHECK(observation_sha256=gakja.session_text_sha(observation_json)), lease_fence bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,job_id,attempt_id),
  FOREIGN KEY(owner_id,job_id,input_binding_sha256) REFERENCES gakja.evaluation_jobs(owner_id,job_id,input_binding_sha256)
);
CREATE TABLE gakja.evaluation_results (
  owner_id text NOT NULL, job_id text NOT NULL, input_binding_sha256 text NOT NULL,
  result_json text NOT NULL, result_sha256 text NOT NULL CHECK(result_sha256=gakja.session_text_sha(result_json)), committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,job_id), UNIQUE(owner_id,job_id,input_binding_sha256,result_sha256),
  FOREIGN KEY(owner_id,job_id,input_binding_sha256) REFERENCES gakja.evaluation_jobs(owner_id,job_id,input_binding_sha256)
);
CREATE TABLE gakja.evaluation_result_revisions (
  owner_id text NOT NULL, session_id text NOT NULL, job_id text NOT NULL, revision_id text NOT NULL CHECK(revision_id ~ '^[a-f0-9]{64}$'),
  input_binding_sha256 text NOT NULL, result_sha256 text NOT NULL, reference_json text NOT NULL, reference_sha256 text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,job_id), UNIQUE(owner_id,revision_id),
  FOREIGN KEY(owner_id,job_id,input_binding_sha256,result_sha256) REFERENCES gakja.evaluation_results(owner_id,job_id,input_binding_sha256,result_sha256),
  FOREIGN KEY(owner_id,session_id,job_id) REFERENCES gakja.evaluation_jobs(owner_id,session_id,job_id),
  CHECK(reference_sha256=gakja.session_text_sha(reference_json))
);
CREATE TABLE gakja.evaluation_projection_pointers (
  owner_id text NOT NULL, session_id text NOT NULL, job_id text NOT NULL,
  PRIMARY KEY(owner_id,session_id), FOREIGN KEY(owner_id,session_id) REFERENCES gakja.evaluation_sessions(owner_id,session_id),
  FOREIGN KEY(owner_id,session_id,job_id) REFERENCES gakja.evaluation_jobs(owner_id,session_id,job_id)
);
CREATE TABLE gakja.evaluation_audit_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL, source_pin_key text NOT NULL,
  session_id text, action text NOT NULL, actor_id text, payload_json text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,student_id,application_target_id,source_pin_key) REFERENCES gakja.evaluation_scopes(owner_id,student_id,application_target_id,source_pin_key)
);
CREATE INDEX evaluation_jobs_scope_idx ON gakja.evaluation_jobs(owner_id,session_id,created_at);
CREATE INDEX evaluation_checkpoints_latest_idx ON gakja.evaluation_checkpoints(owner_id,job_id,cluster_id,checkpoint_id DESC);

CREATE FUNCTION gakja.evaluation_current_grant() RETURNS gakja.access_grants LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants;
BEGIN
 PERFORM gakja.session_guard_account();
 SELECT * INTO g FROM gakja.access_grants WHERE account_id=current_setting('gakja.account_id',true) AND owner_id=current_setting('gakja.owner_id',true)
   AND student_id=current_setting('gakja.student_id',true) AND application_target_id=current_setting('gakja.application_target_id',true) AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'evaluation scope denied' USING ERRCODE='42501'; END IF;
 RETURN g;
END $$;
CREATE FUNCTION gakja.evaluation_scope_key(g gakja.access_grants) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN NOT g.source_present THEN 'absent' WHEN g.source_revision IS NULL THEN 'null' ELSE 'string:'||g.source_revision END
$$;
CREATE FUNCTION gakja.evaluation_artifact_json(a gakja.evaluation_artifacts) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('kind',a.kind,'contentSha256',a.content_sha256,'json',a.raw_json,'rawSha256',a.raw_sha256)
$$;
CREATE FUNCTION gakja.evaluation_read_artifact(p_kind text,p_sha text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; a gakja.evaluation_artifacts;
BEGIN
 g:=gakja.evaluation_current_grant();
 SELECT * INTO a FROM gakja.evaluation_artifacts WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id
   AND source_pin_key=gakja.evaluation_scope_key(g) AND kind=p_kind AND content_sha256=p_sha;
 IF NOT FOUND THEN RETURN NULL; END IF; RETURN gakja.evaluation_artifact_json(a);
END $$;
CREATE FUNCTION gakja.evaluation_lock_scope() RETURNS gakja.evaluation_scopes LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; s gakja.evaluation_scopes;
BEGIN
 g:=gakja.evaluation_current_grant();
 INSERT INTO gakja.evaluation_scopes(owner_id,student_id,application_target_id,support_target_id,source_present,source_revision)
   VALUES(g.owner_id,g.student_id,g.application_target_id,g.support_target_id,g.source_present,g.source_revision) ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM gakja.evaluation_scopes WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id
   AND source_pin_key=gakja.evaluation_scope_key(g) FOR UPDATE;
 IF s.support_target_id IS DISTINCT FROM g.support_target_id THEN RAISE EXCEPTION 'evaluation scope changed' USING ERRCODE='42501'; END IF;
 RETURN s;
END $$;
CREATE FUNCTION gakja.evaluation_scope_control() RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; s gakja.evaluation_scopes;
BEGIN
 g:=gakja.evaluation_current_grant();
 SELECT * INTO s FROM gakja.evaluation_scopes WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id AND source_pin_key=gakja.evaluation_scope_key(g);
 RETURN jsonb_build_object('binding',jsonb_build_object('ownerId',g.owner_id,'studentId',g.student_id,'applicationTargetId',g.application_target_id,'supportTargetId',g.support_target_id)||
   CASE WHEN g.source_present THEN jsonb_build_object('sourceRevision',g.source_revision) ELSE '{}'::jsonb END,'serverNow',clock_timestamp(),
   'trustGeneration',coalesce(s.trust_generation,0)::text,'registryGeneration',coalesce(s.registry_generation,0)::text,
   'trust',gakja.evaluation_read_artifact('trust',s.current_trust_sha256),'registry',gakja.evaluation_read_artifact('registry',s.current_registry_sha256),
   'registryReceipt',gakja.evaluation_read_artifact('registry-receipt',s.current_registry_receipt_sha256));
END $$;
CREATE FUNCTION gakja.evaluation_receipt(p_key text,p_input text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; r gakja.evaluation_command_receipts;
BEGIN
 g:=gakja.evaluation_current_grant();
 SELECT * INTO r FROM gakja.evaluation_command_receipts WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id
   AND source_pin_key=gakja.evaluation_scope_key(g) AND key=p_key;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF r.input_sha256 IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'evaluation idempotency input changed' USING ERRCODE='P7201'; END IF;
 RETURN jsonb_build_object('key',r.key,'inputSha256',r.input_sha256,'operationId',r.operation_id::text,'sessionId',r.session_id,'action',r.action,'resultJson',r.result_json,'resultSha256',r.result_sha256,'replay',true,'committedAt',r.committed_at);
END $$;
CREATE FUNCTION gakja.evaluation_record_receipt(s gakja.evaluation_scopes,p jsonb,p_action text,p_result text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.evaluation_command_receipts;
BEGIN
 IF NOT gakja.is_trimmed_identifier(p->>'key') OR length(p->>'key')>160 OR p->>'inputSha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid command key' USING ERRCODE='22023'; END IF;
 INSERT INTO gakja.evaluation_command_receipts(owner_id,student_id,application_target_id,source_pin_key,key,input_sha256,session_id,action,result_json,result_sha256)
   VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,p->>'key',p->>'inputSha256',coalesce(p->>'sessionId',(SELECT session_id FROM gakja.evaluation_jobs WHERE owner_id=s.owner_id AND job_id=p->>'jobId')),p_action,p_result,gakja.session_text_sha(p_result)) RETURNING * INTO r;
 RETURN jsonb_build_object('key',r.key,'inputSha256',r.input_sha256,'operationId',r.operation_id::text,'sessionId',r.session_id,'action',r.action,'resultJson',r.result_json,'resultSha256',r.result_sha256,'replay',false,'committedAt',r.committed_at);
END $$;
CREATE FUNCTION gakja.evaluation_store_artifact(s gakja.evaluation_scopes,p jsonb,p_kind text) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a gakja.evaluation_artifacts;
BEGIN
 IF p->>'kind' IS DISTINCT FROM p_kind OR p->>'contentSha256' !~ '^[a-f0-9]{64}$' OR p->>'rawSha256' IS DISTINCT FROM gakja.session_text_sha(p->>'json')
   OR octet_length(p->>'json') NOT BETWEEN 2 AND 16777216 THEN RAISE EXCEPTION 'review artifact invalid' USING ERRCODE='22023'; END IF;
 PERFORM (p->>'json')::json;
 SELECT * INTO a FROM gakja.evaluation_artifacts WHERE owner_id=s.owner_id AND student_id=s.student_id AND application_target_id=s.application_target_id
   AND source_pin_key=s.source_pin_key AND kind=p_kind AND content_sha256=p->>'contentSha256';
 IF FOUND THEN
   IF a.raw_json IS DISTINCT FROM p->>'json' OR a.raw_sha256 IS DISTINCT FROM p->>'rawSha256' THEN RAISE EXCEPTION 'artifact bytes changed' USING ERRCODE='P7205'; END IF;
 ELSE
   INSERT INTO gakja.evaluation_artifacts(owner_id,student_id,application_target_id,source_pin_key,kind,content_sha256,raw_json,raw_sha256)
     VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,p_kind,p->>'contentSha256',p->>'json',p->>'rawSha256');
 END IF;
END $$;
CREATE FUNCTION gakja.evaluation_check_generations(s gakja.evaluation_scopes,p jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF s.trust_generation::text IS DISTINCT FROM p->>'expectedTrustGeneration' OR s.registry_generation::text IS DISTINCT FROM p->>'expectedRegistryGeneration'
   THEN RAISE EXCEPTION 'review generation changed' USING ERRCODE='P7202'; END IF;
END $$;

CREATE FUNCTION gakja.evaluation_assert_actor(s gakja.evaluation_scopes,p_actor text,p_key text,p_action text,p_principal boolean) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a gakja.evaluation_artifacts; trust jsonb; actor jsonb; key_sha text;
BEGIN
 SELECT * INTO a FROM gakja.evaluation_artifacts WHERE owner_id=s.owner_id AND student_id=s.student_id AND application_target_id=s.application_target_id
   AND source_pin_key=s.source_pin_key AND kind='trust' AND content_sha256=s.current_trust_sha256;
 IF NOT FOUND THEN RAISE EXCEPTION 'trusted reviewer not installed' USING ERRCODE='42501'; END IF;
 trust:=a.raw_json::jsonb;
 SELECT item INTO actor FROM jsonb_array_elements(trust->'reviewers') item WHERE item->>'actorId'=p_actor;
 IF actor IS NULL OR coalesce((actor->>'revoked')::boolean,true) OR NOT (actor->'actions' ? p_action)
   OR clock_timestamp()<(actor->>'notBefore')::timestamptz OR clock_timestamp()>=(actor->>'expiresAt')::timestamptz
   OR p_principal AND (actor->>'issuer' IS DISTINCT FROM current_setting('gakja.issuer',true) OR actor->>'subject' IS DISTINCT FROM current_setting('gakja.subject',true))
   OR actor->>'publicKey' NOT LIKE '-----BEGIN PUBLIC KEY-----%'
   THEN RAISE EXCEPTION 'reviewer not currently authorized' USING ERRCODE='42501'; END IF;
 key_sha:=encode(sha256(decode(regexp_replace(actor->>'publicKey','-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s','','g'),'base64')),'hex');
 IF p_key IS NOT NULL AND key_sha IS DISTINCT FROM p_key THEN RAISE EXCEPTION 'review key changed' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION gakja.evaluation_install_trust(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; prior jsonb; trust jsonb;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 IF s.trust_generation::text IS DISTINCT FROM p->>'expectedTrustGeneration' THEN RAISE EXCEPTION 'trust generation changed' USING ERRCODE='P7202'; END IF;
 trust:=(p->'trust'->>'json')::jsonb;
 IF trust->>'version' IS DISTINCT FROM 'evaluation-review-trust-v1' OR trust->>'ownerId' IS DISTINCT FROM s.owner_id
   OR trust->>'studentId' IS DISTINCT FROM s.student_id OR trust->>'applicationTargetId' IS DISTINCT FROM s.application_target_id
   OR trust->>'supportTargetId' IS DISTINCT FROM s.support_target_id OR trust->>'contentSha256' IS DISTINCT FROM p->'trust'->>'contentSha256'
   OR jsonb_typeof(trust->'reviewers') IS DISTINCT FROM 'array' OR jsonb_array_length(trust->'reviewers') NOT BETWEEN 1 AND 64
   THEN RAISE EXCEPTION 'trust binding invalid' USING ERRCODE='22023'; END IF;
 PERFORM gakja.evaluation_store_artifact(s,p->'trust','trust');
 IF s.current_trust_sha256 IS DISTINCT FROM p->'trust'->>'contentSha256' THEN
   UPDATE gakja.evaluation_scopes SET trust_generation=trust_generation+1,current_trust_sha256=p->'trust'->>'contentSha256'
     WHERE owner_id=s.owner_id AND student_id=s.student_id AND application_target_id=s.application_target_id AND source_pin_key=s.source_pin_key RETURNING * INTO s;
 END IF;
 INSERT INTO gakja.evaluation_audit_events(owner_id,student_id,application_target_id,source_pin_key,action,payload_json)
   VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,'install-trust',p::text);
 RETURN gakja.evaluation_record_receipt(s,p,'install-trust',json_build_object('trustGeneration',s.trust_generation::text,'trustSha256',s.current_trust_sha256)::text);
END $$;
CREATE FUNCTION gakja.evaluation_publish_registry(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; prior jsonb; signed jsonb; registry jsonb;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 PERFORM gakja.evaluation_check_generations(s,p);
 IF current_setting('gakja.reviewer_action',true)<>'publish-spec' THEN RAISE EXCEPTION 'review action denied' USING ERRCODE='42501'; END IF;
 PERFORM gakja.evaluation_assert_actor(s,current_setting('gakja.reviewer_actor',true),current_setting('gakja.reviewer_key',true),'publish-spec',true);
 registry:=(p->'registry'->>'json')::jsonb; signed:=(p->'receipt'->>'json')::jsonb; signed:=coalesce(signed->'receipt',signed);
 IF registry->>'contentSha256' IS DISTINCT FROM p->'registry'->>'contentSha256' OR registry->>'ownerId' IS DISTINCT FROM s.owner_id
   OR registry->>'studentId' IS DISTINCT FROM s.student_id OR signed->>'registrySha256' IS DISTINCT FROM p->'registry'->>'contentSha256'
   OR signed->>'actorId' IS DISTINCT FROM current_setting('gakja.reviewer_actor',true) OR signed->>'action' IS DISTINCT FROM 'publish_scopes'
   OR clock_timestamp()<(signed->>'issuedAt')::timestamptz OR clock_timestamp()>=(signed->>'expiresAt')::timestamptz
   THEN RAISE EXCEPTION 'registry review binding invalid' USING ERRCODE='P7205'; END IF;
 PERFORM gakja.evaluation_store_artifact(s,p->'registry','registry'); PERFORM gakja.evaluation_store_artifact(s,p->'receipt','registry-receipt');
 -- Re-signing the identical A input does not invent a new domain version.
 UPDATE gakja.evaluation_scopes SET registry_generation=registry_generation+CASE WHEN current_registry_sha256 IS DISTINCT FROM p->'registry'->>'contentSha256' THEN 1 ELSE 0 END,
   current_registry_sha256=p->'registry'->>'contentSha256',current_registry_receipt_sha256=p->'receipt'->>'contentSha256'
   WHERE owner_id=s.owner_id AND student_id=s.student_id AND application_target_id=s.application_target_id AND source_pin_key=s.source_pin_key RETURNING * INTO s;
 INSERT INTO gakja.evaluation_audit_events(owner_id,student_id,application_target_id,source_pin_key,action,actor_id,payload_json)
   VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,'publish-spec',current_setting('gakja.reviewer_actor',true),p::text);
 RETURN gakja.evaluation_record_receipt(s,p,'publish-spec',json_build_object('registryGeneration',s.registry_generation::text,'registrySha256',s.current_registry_sha256)::text);
END $$;
-- C/D metadata is an external archival dependency, not an F object restore.
-- Capture it once from the exact E run pin; subsequent export/restore uses the
-- immutable F copy even when the source D run is no longer present.
CREATE FUNCTION gakja.evaluation_source_dependencies(e gakja.session_command_sessions) RETURNS text LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pins jsonb; d jsonb; r gakja.shadow_runs; result jsonb; objects jsonb; edges jsonb; pointers jsonb;
BEGIN
 pins:=e.pins_json::jsonb;
 result:=jsonb_build_object('version','evaluation-source-dependencies-v1','sessionId',e.session_id,'ownerId',e.owner_id,'studentId',e.student_id,
   'applicationTargetId',e.application_target_id,'supportTargetId',e.support_target_id,'state','no-D-pin','D',NULL,'dependencies','[]'::jsonb,'pointers','[]'::jsonb,'objects','[]'::jsonb,
   'policy',jsonb_build_object('archiveRequired',true,'cDMetadataRestored',false,'objectBytesRestored',false,'hashMeaning','Existing C UTF-8 object content SHA256; original D plan domain hash is retained separately.'));
 IF NOT pins ? 'D' THEN RETURN result::text; END IF;
 d:=pins->'D';
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'runId' !~ '^[a-z0-9_-]{8,128}$' OR d->>'generation' !~ '^[0-9]+$' OR d->>'planSha256' !~ '^[a-f0-9]{64}$'
   THEN RAISE EXCEPTION 'source dependency D pin invalid' USING ERRCODE='P7205'; END IF;
 SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=d->>'runId' FOR SHARE;
 IF r.run_id IS NULL OR r.owner_id IS DISTINCT FROM e.owner_id OR r.student_id IS DISTINCT FROM e.student_id OR r.application_target_id IS DISTINCT FROM e.application_target_id
   OR r.support_target_id IS DISTINCT FROM e.support_target_id OR r.plan_sha256 IS DISTINCT FROM d->>'planSha256' OR NOT gakja.shadow_run_authorized(r)
   OR (d->>'generation')::bigint>r.generation OR NOT EXISTS(SELECT 1 FROM gakja.shadow_history h WHERE h.run_id=r.run_id AND h.generation=(d->>'generation')::bigint)
   OR EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id AND (a.owner_id<>e.owner_id OR a.student_id<>e.student_id OR NOT gakja.shadow_artifact_authorized(a)
     OR a.scope_kind='target' AND (a.application_target_id<>e.application_target_id OR a.support_target_id<>e.support_target_id)))
   THEN RAISE EXCEPTION 'source dependency scope or plan changed' USING ERRCODE='P7205'; END IF;
 IF EXISTS(SELECT 1 FROM gakja.shadow_artifacts a LEFT JOIN gakja.storage_uploads u ON u.receipt_id=a.receipt_id WHERE a.run_id=r.run_id AND a.availability='present'
   AND (a.receipt_id IS NULL OR u.receipt_id IS NULL OR u.object_id IS DISTINCT FROM a.object_id OR u.owner_id<>e.owner_id OR u.student_id<>e.student_id
     OR u.expected_size IS DISTINCT FROM a.expected_size OR u.expected_sha256 IS DISTINCT FROM a.expected_sha256
     OR u.scope_kind IS DISTINCT FROM a.scope_kind OR u.scope_kind='target' AND (u.application_target_id<>e.application_target_id OR u.support_target_id<>e.support_target_id)))
   THEN RAISE EXCEPTION 'source dependency object reference missing' USING ERRCODE='P7205'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('artifactId',a.artifact_id,'objectId',u.object_id::text,'receiptId',u.receipt_id::text,'kind',u.kind,
   'bucket',u.bucket,'key',u.final_key,'stagingKey',u.staging_key,'keyPrefix',u.key_prefix,'bytes',u.expected_size::text,'sha256',u.expected_sha256,
   'actualBytes',u.actual_size::text,'actualSha256',u.actual_sha256,'state',u.state,'revision',u.revision::text,'boundRevision',a.bound_object_revision::text)
   ORDER BY a.artifact_id),'[]'::jsonb) INTO objects FROM gakja.shadow_artifacts a JOIN gakja.storage_uploads u ON u.receipt_id=a.receipt_id WHERE a.run_id=r.run_id AND a.availability='present';
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.artifact_id,q.dependency_id),'[]'::jsonb) INTO edges FROM gakja.shadow_dependencies q WHERE q.run_id=r.run_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',q.name,'selection',q.selection,'artifactId',q.artifact_id,'generation',q.generation::text)
   ORDER BY q.name,q.selection),'[]'::jsonb) INTO pointers FROM gakja.shadow_pointers q WHERE q.run_id=r.run_id;
 RETURN (result||jsonb_build_object('state','pinned-D-manifest','D',jsonb_build_object('runId',r.run_id,'pinnedGeneration',d->>'generation','observedGeneration',r.generation::text,
   'planSha256',r.plan_sha256,'originalPlan',r.original_plan,'snapshot',gakja.shadow_snapshot_json(r)),'dependencies',edges,'pointers',pointers,'objects',objects))::text;
END $$;
CREATE FUNCTION gakja.evaluation_lock_session(p_id text,p_create boolean DEFAULT false) RETURNS gakja.evaluation_sessions LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e gakja.session_command_sessions; h gakja.session_evaluation_handoffs; ending gakja.session_end_intents; payload jsonb; scope gakja.evaluation_scopes; f gakja.evaluation_sessions;
BEGIN
 scope:=gakja.evaluation_lock_scope();
 SELECT * INTO e FROM gakja.session_command_sessions WHERE owner_id=scope.owner_id AND session_id=p_id FOR SHARE;
 IF NOT FOUND OR NOT gakja.session_can_read(e) OR e.student_id<>scope.student_id OR e.application_target_id<>scope.application_target_id
   OR e.support_target_id<>scope.support_target_id THEN RAISE EXCEPTION 'evaluation session denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO h FROM gakja.session_evaluation_handoffs WHERE owner_id=e.owner_id AND session_id=e.session_id;
 SELECT * INTO ending FROM gakja.session_end_intents WHERE owner_id=e.owner_id AND session_id=e.session_id;
 IF h.intent_id IS NULL OR ending.intent_id IS NULL THEN RAISE EXCEPTION 'ended handoff required' USING ERRCODE='P7205'; END IF;
 payload:=h.payload_json::jsonb;
 IF h.payload_sha256<>gakja.session_text_sha(h.payload_json) OR h.frozen_session_sha256<>e.session_sha256 OR h.context_sha256<>e.context_sha256
   OR h.committed_revision>e.revision OR h.version<>'session-evaluation-handoff-v1' OR h.state<>'awaiting-evaluation-consumer'
   OR payload->>'acceptedEndIntentId' IS DISTINCT FROM ending.intent_id::text OR payload->>'acceptedEndInputSha256' IS DISTINCT FROM ending.input_sha256
   OR payload->>'frozenSessionSha256' IS DISTINCT FROM e.session_sha256 OR payload->>'contextSnapshotSha256' IS DISTINCT FROM e.context_sha256
   OR payload->>'sessionJson' IS DISTINCT FROM e.session_json OR payload->>'contextJson' IS DISTINCT FROM e.context_json OR payload->>'pinsJson' IS DISTINCT FROM e.pins_json
   OR payload->>'ownerId' IS DISTINCT FROM e.owner_id OR payload->>'studentId' IS DISTINCT FROM e.student_id
   OR payload->>'applicationTargetId' IS DISTINCT FROM e.application_target_id OR payload->>'supportTargetId' IS DISTINCT FROM e.support_target_id
   OR payload->>'evaluationApprovalGranted' IS DISTINCT FROM 'false'
   THEN RAISE EXCEPTION 'immutable handoff changed' USING ERRCODE='P7205'; END IF;
 IF p_create THEN
   IF e.writer<>'db' THEN RAISE EXCEPTION 'read-only E input' USING ERRCODE='P7204'; END IF;
   IF NOT EXISTS(SELECT 1 FROM gakja.evaluation_sessions WHERE owner_id=e.owner_id AND session_id=e.session_id) THEN
     INSERT INTO gakja.evaluation_sessions(owner_id,session_id,student_id,application_target_id,support_target_id,source_pin_key,original_context_sha256,handoff_intent_id,handoff_payload_sha256,frozen_session_sha256,source_dependencies_json)
       VALUES(e.owner_id,e.session_id,e.student_id,e.application_target_id,e.support_target_id,scope.source_pin_key,e.context_sha256,h.intent_id,h.payload_sha256,h.frozen_session_sha256,gakja.evaluation_source_dependencies(e));
   END IF;
 END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=e.owner_id AND session_id=e.session_id FOR UPDATE;
 RETURN f;
END $$;
CREATE FUNCTION gakja.evaluation_session_control_json(f gakja.evaluation_sessions) RETURNS jsonb LANGUAGE sql
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN f.session_id IS NULL THEN NULL ELSE jsonb_build_object('sessionId',f.session_id,'writer',f.writer,'fence',f.fence::text,
   'approvalGeneration',f.approval_generation::text,'approvalSha256',f.current_approval_sha256,'approvalRevoked',f.approval_revoked,'approvalAcceptedAt',f.approval_accepted_at,
   'registrySha256',f.approval_registry_sha256,'receipt',gakja.evaluation_read_artifact('session-receipt',f.current_approval_sha256),
   'bundle',gakja.evaluation_read_artifact('bundle',f.current_bundle_sha256)) END
$$;
CREATE FUNCTION gakja.evaluation_session_control(p_id text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e gakja.session_command_sessions; f gakja.evaluation_sessions;
BEGIN
 PERFORM gakja.evaluation_current_grant(); SELECT * INTO e FROM gakja.session_command_sessions WHERE session_id=p_id;
 IF NOT FOUND OR NOT gakja.session_can_read(e) THEN RETURN NULL; END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=e.owner_id AND session_id=p_id;
 RETURN gakja.evaluation_session_control_json(f);
END $$;
CREATE FUNCTION gakja.evaluation_publish_approval(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; f gakja.evaluation_sessions; prior jsonb; envelope jsonb; signed jsonb;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 PERFORM gakja.evaluation_check_generations(s,p); f:=gakja.evaluation_lock_session(p->>'sessionId',true);
 IF f.writer<>'db' THEN RAISE EXCEPTION 'evaluation writer frozen' USING ERRCODE='P7204'; END IF;
 IF f.approval_generation::text IS DISTINCT FROM p->>'expectedApprovalGeneration' THEN RAISE EXCEPTION 'approval generation changed' USING ERRCODE='P7202'; END IF;
 IF current_setting('gakja.reviewer_action',true)<>'supply-session' THEN RAISE EXCEPTION 'review action denied' USING ERRCODE='42501'; END IF;
 PERFORM gakja.evaluation_assert_actor(s,current_setting('gakja.reviewer_actor',true),current_setting('gakja.reviewer_key',true),'supply-session',true);
 envelope:=(p->'receipt'->>'json')::jsonb; signed:=envelope->'receipt';
 IF signed IS NULL OR signed->>'version' IS DISTINCT FROM 'authenticated-session-evaluation-review-v1' OR signed->>'action' IS DISTINCT FROM 'approve_session_evaluation'
   OR signed->>'actorId' IS DISTINCT FROM current_setting('gakja.reviewer_actor',true) OR signed->>'sessionId' IS DISTINCT FROM f.session_id
   OR signed->>'contextSnapshotSha256' IS DISTINCT FROM f.original_context_sha256 OR signed->>'bundleSha256' IS DISTINCT FROM p->'bundle'->>'contentSha256'
   OR envelope->'proposal'->>'registrySha256' IS DISTINCT FROM s.current_registry_sha256 OR p->>'registrySha256' IS DISTINCT FROM s.current_registry_sha256
   OR clock_timestamp()<(signed->>'issuedAt')::timestamptz OR clock_timestamp()>=(signed->>'expiresAt')::timestamptz
   THEN RAISE EXCEPTION 'session review binding invalid' USING ERRCODE='P7205'; END IF;
 IF f.current_approval_sha256 IS DISTINCT FROM p->'receipt'->>'contentSha256' AND f.approval_issued_at IS NOT NULL AND (signed->>'issuedAt')::timestamptz<=f.approval_issued_at
   THEN RAISE EXCEPTION 'review revision order conflict' USING ERRCODE='P7202'; END IF;
 PERFORM gakja.evaluation_store_artifact(s,p->'bundle','bundle'); PERFORM gakja.evaluation_store_artifact(s,p->'receipt','session-receipt');
 UPDATE gakja.evaluation_sessions SET approval_generation=approval_generation+CASE WHEN current_approval_sha256 IS DISTINCT FROM p->'receipt'->>'contentSha256' OR approval_revoked THEN 1 ELSE 0 END,
   current_approval_sha256=p->'receipt'->>'contentSha256',current_bundle_sha256=p->'bundle'->>'contentSha256',approval_registry_sha256=s.current_registry_sha256,
   approval_revoked=false,approval_issued_at=(signed->>'issuedAt')::timestamptz,
   approval_accepted_at=CASE WHEN current_approval_sha256 IS DISTINCT FROM p->'receipt'->>'contentSha256' OR approval_revoked THEN clock_timestamp() ELSE approval_accepted_at END
   WHERE owner_id=f.owner_id AND session_id=f.session_id RETURNING * INTO f;
 INSERT INTO gakja.evaluation_audit_events(owner_id,student_id,application_target_id,source_pin_key,session_id,action,actor_id,payload_json)
   VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,f.session_id,'supply-session',current_setting('gakja.reviewer_actor',true),p::text);
 RETURN gakja.evaluation_record_receipt(s,p,'supply-session',gakja.evaluation_session_control_json(f)::text);
END $$;

CREATE FUNCTION gakja.evaluation_withdraw_approval(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; f gakja.evaluation_sessions; prior jsonb;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 PERFORM gakja.evaluation_check_generations(s,p); f:=gakja.evaluation_lock_session(p->>'sessionId',false);
 IF f.session_id IS NULL THEN RAISE EXCEPTION 'approval missing' USING ERRCODE='42501'; END IF;
 IF f.writer<>'db' THEN RAISE EXCEPTION 'evaluation writer frozen' USING ERRCODE='P7204'; END IF;
 IF f.approval_generation::text IS DISTINCT FROM p->>'expectedApprovalGeneration' THEN RAISE EXCEPTION 'approval generation changed' USING ERRCODE='P7202'; END IF;
 IF current_setting('gakja.reviewer_action',true)<>'withdraw' THEN RAISE EXCEPTION 'review action denied' USING ERRCODE='42501'; END IF;
 PERFORM gakja.evaluation_assert_actor(s,current_setting('gakja.reviewer_actor',true),current_setting('gakja.reviewer_key',true),'withdraw',true);
 UPDATE gakja.evaluation_sessions SET approval_generation=approval_generation+1,approval_revoked=true WHERE owner_id=f.owner_id AND session_id=f.session_id RETURNING * INTO f;
 INSERT INTO gakja.evaluation_audit_events(owner_id,student_id,application_target_id,source_pin_key,session_id,action,actor_id,payload_json)
   VALUES(s.owner_id,s.student_id,s.application_target_id,s.source_pin_key,f.session_id,'withdraw',current_setting('gakja.reviewer_actor',true),p::text);
 RETURN gakja.evaluation_record_receipt(s,p,'withdraw',gakja.evaluation_session_control_json(f)::text);
END $$;

CREATE FUNCTION gakja.evaluation_job_id(p_session text,p_owner text,p_source text,p_pipeline text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT gakja.session_text_sha('['||to_json(p_session)::text||','||to_json(p_owner)::text||','||to_json(p_source)::text||','||to_json(p_pipeline)::text||']')
$$;
CREATE FUNCTION gakja.evaluation_job_json(j gakja.evaluation_jobs) RETURNS text LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN j.job_id IS NULL THEN NULL ELSE json_build_object('version',1,'id',j.job_id,'sessionId',j.session_id,'ownerId',j.owner_id,
   'pipelineVersion',j.pipeline_version,'model',j.model,'sourceSha256',j.source_sha256,'snapshotSha256',j.snapshot_sha256,'contextSnapshotSha256',j.context_sha256,
   'status',j.status,'attempts',j.attempts,'createdAt',j.created_at,'updatedAt',j.updated_at,'nextRetryAt',j.next_retry_at,
   'lease',CASE WHEN j.lease_token IS NULL THEN NULL ELSE json_build_object('token',j.lease_token::text,'workerId',j.worker_id,'expiresAt',j.lease_until) END,
   'checkpoints',(SELECT coalesce(json_agg(c.checkpoint_json::json ORDER BY c.cluster_id),'[]'::json) FROM
     (SELECT DISTINCT ON (cluster_id) cluster_id,checkpoint_json FROM gakja.evaluation_checkpoints WHERE owner_id=j.owner_id AND job_id=j.job_id ORDER BY cluster_id,checkpoint_id DESC)c),
   'usage',(SELECT coalesce(json_agg(json_build_object('attemptId',u.attempt_id,'observation',u.observation_json::json) ORDER BY u.recorded_at,u.attempt_id),'[]'::json) FROM gakja.evaluation_usage u WHERE u.owner_id=j.owner_id AND u.job_id=j.job_id),
   'error',j.error_json::json,'resultSha256',j.result_sha256)::text END
$$;
CREATE FUNCTION gakja.evaluation_job_scope(p_id text) RETURNS gakja.evaluation_jobs LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; j gakja.evaluation_jobs; f gakja.evaluation_sessions; e gakja.session_command_sessions;
BEGIN
 g:=gakja.evaluation_current_grant(); SELECT * INTO j FROM gakja.evaluation_jobs WHERE owner_id=g.owner_id AND job_id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=j.owner_id AND session_id=j.session_id;
 SELECT * INTO e FROM gakja.session_command_sessions WHERE owner_id=j.owner_id AND session_id=j.session_id;
 IF f.student_id IS DISTINCT FROM g.student_id OR f.application_target_id IS DISTINCT FROM g.application_target_id OR f.support_target_id IS DISTINCT FROM g.support_target_id
   OR f.source_pin_key IS DISTINCT FROM gakja.evaluation_scope_key(g) OR NOT gakja.session_can_read(e) THEN RETURN NULL; END IF;
 RETURN j;
END $$;
CREATE FUNCTION gakja.evaluation_job_review_current(j gakja.evaluation_jobs,p_writing boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f gakja.evaluation_sessions; s gakja.evaluation_scopes; ar jsonb; br jsonb;
BEGIN
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=j.owner_id AND session_id=j.session_id;
 SELECT * INTO s FROM gakja.evaluation_scopes WHERE owner_id=f.owner_id AND student_id=f.student_id AND application_target_id=f.application_target_id AND source_pin_key=f.source_pin_key;
 IF f.session_id IS NULL OR s.owner_id IS NULL OR s.trust_generation<>j.trust_generation OR s.registry_generation<>j.registry_generation
   OR f.approval_generation<>j.approval_generation OR f.approval_revoked OR f.current_approval_sha256 IS DISTINCT FROM j.approval_sha256
   OR f.approval_registry_sha256 IS DISTINCT FROM s.current_registry_sha256 OR p_writing AND (f.writer<>'db' OR f.fence<>j.session_fence) THEN RETURN false; END IF;
 ar:=(gakja.evaluation_read_artifact('registry-receipt',s.current_registry_receipt_sha256)->>'json')::jsonb; ar:=coalesce(ar->'receipt',ar);
 br:=(gakja.evaluation_read_artifact('session-receipt',f.current_approval_sha256)->>'json')::jsonb->'receipt';
 PERFORM gakja.evaluation_assert_actor(s,ar->>'actorId',NULL,'publish-spec',false);
 PERFORM gakja.evaluation_assert_actor(s,br->>'actorId',NULL,'supply-session',false);
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
CREATE FUNCTION gakja.evaluation_get_job(p_id text,p_worker boolean DEFAULT false) RETURNS text LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j gakja.evaluation_jobs;
BEGIN
 j:=gakja.evaluation_job_scope(p_id); IF j.job_id IS NULL THEN RETURN NULL; END IF;
 IF p_worker AND NOT gakja.evaluation_job_review_current(j,true) THEN RAISE EXCEPTION 'current review required' USING ERRCODE='P7202'; END IF;
 RETURN gakja.evaluation_job_json(j);
END $$;
CREATE FUNCTION gakja.evaluation_consume(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; f gakja.evaluation_sessions; e gakja.session_command_sessions; h gakja.session_evaluation_handoffs;
 prior jsonb; r jsonb; sn jsonb; reference jsonb; c gakja.evaluation_consumptions; j gakja.evaluation_jobs; selected_approval_key text; binding_sha text; history text;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 f:=gakja.evaluation_lock_session(p->>'sessionId',true); PERFORM gakja.evaluation_check_generations(s,p);
 IF f.writer<>'db' THEN RAISE EXCEPTION 'evaluation writer frozen' USING ERRCODE='P7204'; END IF;
 IF f.approval_generation::text IS DISTINCT FROM p->>'expectedApprovalGeneration' THEN RAISE EXCEPTION 'approval generation changed' USING ERRCODE='P7202'; END IF;
 SELECT * INTO h FROM gakja.session_evaluation_handoffs WHERE owner_id=f.owner_id AND session_id=f.session_id;
 IF p->>'handoffIntentId' IS DISTINCT FROM h.intent_id::text OR p->>'handoffPayloadSha256' IS DISTINCT FROM h.payload_sha256
   OR p->>'frozenSessionSha256' IS DISTINCT FROM h.frozen_session_sha256 OR p->>'originalContextSnapshotSha256' IS DISTINCT FROM h.context_sha256
   THEN RAISE EXCEPTION 'handoff input changed' USING ERRCODE='P7205'; END IF;
 IF p->>'state' NOT IN ('review_required','registered') OR jsonb_typeof(p->'reasons') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'consumption state invalid' USING ERRCODE='22023'; END IF;
 selected_approval_key:=coalesce(p->>'approvalSha256','none');
 SELECT * INTO c FROM gakja.evaluation_consumptions WHERE owner_id=f.owner_id AND session_id=f.session_id AND approval_key=selected_approval_key;
 IF FOUND THEN
   IF c.handoff_payload_sha256 IS DISTINCT FROM h.payload_sha256 OR p->>'state'='registered' AND c.job_id IS NOT NULL AND c.job_id IS DISTINCT FROM p->'registration'->>'jobId'
     THEN RAISE EXCEPTION 'consumption input changed' USING ERRCODE='P7205'; END IF;
 END IF;
 IF p->>'state'='registered' THEN
   IF s.current_trust_sha256 IS NULL OR s.current_registry_sha256 IS NULL OR f.approval_revoked OR f.current_approval_sha256 IS DISTINCT FROM p->>'approvalSha256'
     OR f.approval_registry_sha256 IS DISTINCT FROM s.current_registry_sha256 THEN RAISE EXCEPTION 'approved input required' USING ERRCODE='P7202'; END IF;
   r:=p->'registration'; sn:=(r->>'snapshotJson')::jsonb; reference:=(r->>'revisionJson')::jsonb;
   SELECT * INTO e FROM gakja.session_command_sessions WHERE owner_id=f.owner_id AND session_id=f.session_id;
   IF r IS NULL OR r->>'jobId' IS DISTINCT FROM gakja.evaluation_job_id(f.session_id,f.owner_id,r->>'sourceSha256',r->>'pipelineVersion')
     OR r->>'sourceSha256' !~ '^[a-f0-9]{64}$' OR NOT gakja.is_trimmed_identifier(r->>'pipelineVersion') OR NOT gakja.is_trimmed_identifier(r->>'model')
     OR r->>'model' IS DISTINCT FROM h.payload_json::jsonb->>'model' OR r->>'pipelineVersion' IS DISTINCT FROM h.payload_json::jsonb->>'pipelineVersion'
     OR r->>'snapshotSha256' IS DISTINCT FROM gakja.session_text_sha(r->>'snapshotJson') OR sn->>'version' IS DISTINCT FROM '1'
     OR sn->>'ownerId' IS DISTINCT FROM f.owner_id OR sn->>'contextSnapshotSha256' IS DISTINCT FROM r->'reviewedContext'->>'contentSha256'
     OR (r->'reviewedContext'->>'json')::jsonb->'approvedKnowledge'->>'contentSha256' IS DISTINCT FROM f.current_bundle_sha256
     OR (r->'reviewedContext'->>'json')::jsonb->'evaluationScopeRegistry'->>'contentSha256' IS DISTINCT FROM s.current_registry_sha256
     OR (r->'reviewedContext'->>'json')::jsonb->'manifest'->'recordIds'->>'sessionReviewReceiptSha256' IS DISTINCT FROM f.current_approval_sha256
     OR sn->'session'->'runtime'->>'contextSnapshotSha256' IS DISTINCT FROM r->'reviewedContext'->>'contentSha256'
     OR jsonb_set(sn->'session','{runtime,contextSnapshotSha256}',to_jsonb(f.original_context_sha256)) IS DISTINCT FROM e.session_json::jsonb
     OR r->>'revisionRawSha256' IS DISTINCT FROM gakja.session_text_sha(r->>'revisionJson') OR reference->>'contentSha256' IS DISTINCT FROM r->>'revisionSha256'
     OR reference->>'ownerId' IS DISTINCT FROM f.owner_id OR reference->>'sessionId' IS DISTINCT FROM f.session_id
     OR reference->>'receiptSha256' IS DISTINCT FROM f.current_approval_sha256 OR reference->>'originalContextSnapshotSha256' IS DISTINCT FROM f.original_context_sha256
     OR reference->>'receiptIssuedAt' IS DISTINCT FROM (SELECT a.raw_json::jsonb->'receipt'->>'issuedAt' FROM gakja.evaluation_artifacts a
       WHERE a.owner_id=s.owner_id AND a.student_id=s.student_id AND a.application_target_id=s.application_target_id AND a.source_pin_key=s.source_pin_key AND a.kind='session-receipt' AND a.content_sha256=f.current_approval_sha256)
     OR reference->>'reviewedContextSnapshotSha256' IS DISTINCT FROM r->'reviewedContext'->>'contentSha256'
     OR reference->'job'->>'id' IS DISTINCT FROM r->>'jobId' OR reference->'job'->>'sourceSha256' IS DISTINCT FROM r->>'sourceSha256'
     OR reference->'job'->>'snapshotSha256' IS DISTINCT FROM r->>'snapshotSha256' OR reference->'job'->>'pipelineVersion' IS DISTINCT FROM r->>'pipelineVersion'
     OR reference->'job'->>'model' IS DISTINCT FROM r->>'model'
     THEN RAISE EXCEPTION 'evaluation registration input changed' USING ERRCODE='P7205'; END IF;
   PERFORM gakja.evaluation_store_artifact(s,r->'reviewedContext','reviewed-context');
   binding_sha:=gakja.session_text_sha(json_build_array(r->>'jobId',r->>'sourceSha256',r->>'snapshotSha256',r->'reviewedContext'->>'contentSha256',r->>'pipelineVersion',r->>'model',f.current_approval_sha256,r->>'revisionSha256')::text);
   INSERT INTO gakja.evaluation_jobs(owner_id,job_id,session_id,approval_sha256,source_sha256,snapshot_json,snapshot_sha256,context_sha256,pipeline_version,model,
     revision_json,revision_sha256,revision_raw_sha256,input_binding_sha256,trust_generation,registry_generation,approval_generation,session_fence)
     VALUES(f.owner_id,r->>'jobId',f.session_id,f.current_approval_sha256,r->>'sourceSha256',r->>'snapshotJson',r->>'snapshotSha256',r->'reviewedContext'->>'contentSha256',r->>'pipelineVersion',r->>'model',
       r->>'revisionJson',r->>'revisionSha256',r->>'revisionRawSha256',binding_sha,s.trust_generation,s.registry_generation,f.approval_generation,f.fence) ON CONFLICT DO NOTHING;
   SELECT * INTO j FROM gakja.evaluation_jobs WHERE owner_id=f.owner_id AND job_id=r->>'jobId';
   IF j.input_binding_sha256<>binding_sha OR j.snapshot_json IS DISTINCT FROM r->>'snapshotJson' OR j.revision_json IS DISTINCT FROM r->>'revisionJson'
     THEN RAISE EXCEPTION 'existing job input changed' USING ERRCODE='P7205'; END IF;
   IF j.trust_generation<>s.trust_generation OR j.registry_generation<>s.registry_generation OR j.approval_generation<>f.approval_generation OR j.session_fence<>f.fence THEN
     -- A fresh verified consume may reauthorize the identical immutable input;
     -- it preserves completed results/checkpoints and fences the old worker.
     UPDATE gakja.evaluation_jobs SET trust_generation=s.trust_generation,registry_generation=s.registry_generation,approval_generation=f.approval_generation,session_fence=f.fence,
       lease_token=NULL,worker_id=NULL,lease_until=NULL,lease_fence=lease_fence+1,
       status=CASE WHEN status IN ('running','review_required') THEN 'queued' ELSE status END,updated_at=clock_timestamp()
       WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
   END IF;
   IF NOT gakja.evaluation_job_review_current(j,true) THEN RAISE EXCEPTION 'review not currently valid' USING ERRCODE='P7202'; END IF;
   INSERT INTO gakja.evaluation_projection_pointers VALUES(f.owner_id,f.session_id,j.job_id)
     ON CONFLICT(owner_id,session_id) DO UPDATE SET job_id=EXCLUDED.job_id;
 ELSE
   IF p->'registration' IS NOT NULL THEN RAISE EXCEPTION 'waiting cannot create a job' USING ERRCODE='22023'; END IF;
 END IF;
 IF c.consumption_id IS NULL THEN
   INSERT INTO gakja.evaluation_consumptions(owner_id,session_id,approval_key,approval_sha256,state,handoff_payload_sha256,trust_generation,registry_generation,approval_generation,reasons_json,job_id)
     VALUES(f.owner_id,f.session_id,selected_approval_key,p->>'approvalSha256',p->>'state',h.payload_sha256,s.trust_generation,s.registry_generation,f.approval_generation,(p->'reasons')::text,j.job_id) RETURNING * INTO c;
 ELSE
   UPDATE gakja.evaluation_consumptions SET state=p->>'state',trust_generation=s.trust_generation,registry_generation=s.registry_generation,approval_generation=f.approval_generation,
     reasons_json=(p->'reasons')::text,job_id=coalesce(j.job_id,evaluation_consumptions.job_id)
     WHERE owner_id=f.owner_id AND session_id=f.session_id AND approval_key=selected_approval_key RETURNING * INTO c;
 END IF;
 history:=to_jsonb(c)::text;
 INSERT INTO gakja.evaluation_consumption_history(owner_id,session_id,consumption_id,history_sha256,history_json)
   VALUES(c.owner_id,c.session_id,c.consumption_id,gakja.session_text_sha(history),history) ON CONFLICT DO NOTHING;
 RETURN gakja.evaluation_record_receipt(s,p,'consume',json_build_object('consumptionId',c.consumption_id::text,'state',c.state,'jobId',c.job_id)::text);
END $$;
CREATE FUNCTION gakja.evaluation_projection(p_session text,p_job text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e gakja.session_command_sessions; f gakja.evaluation_sessions; j gakja.evaluation_jobs; r gakja.evaluation_results; rev gakja.evaluation_result_revisions; current_review boolean:=false; state text;
BEGIN
 PERFORM gakja.evaluation_current_grant();
 IF p_job IS NOT NULL THEN j:=gakja.evaluation_job_scope(p_job); IF j.job_id IS NULL THEN RETURN NULL; END IF; p_session:=j.session_id; END IF;
 SELECT * INTO e FROM gakja.session_command_sessions WHERE owner_id=current_setting('gakja.owner_id',true) AND session_id=p_session;
 IF NOT FOUND OR NOT gakja.session_can_read(e) OR NOT EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs WHERE owner_id=e.owner_id AND session_id=e.session_id) THEN RETURN NULL; END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=e.owner_id AND session_id=e.session_id;
 IF p_job IS NULL THEN SELECT job.* INTO j FROM gakja.evaluation_projection_pointers ptr JOIN gakja.evaluation_jobs job USING(owner_id,job_id) WHERE ptr.owner_id=e.owner_id AND ptr.session_id=e.session_id; END IF;
 IF j.job_id IS NOT NULL THEN
   current_review:=gakja.evaluation_job_review_current(j,false);
   -- Explicit historical revision reads retain the immutable result bytes;
   -- the ordinary session projection hides them after current review changes.
   IF (current_review OR p_job IS NOT NULL) AND j.status='completed' THEN
     SELECT * INTO r FROM gakja.evaluation_results WHERE owner_id=j.owner_id AND job_id=j.job_id;
     SELECT * INTO rev FROM gakja.evaluation_result_revisions WHERE owner_id=j.owner_id AND job_id=j.job_id;
     IF r.job_id IS NULL OR rev.job_id IS NULL OR r.result_sha256<>j.result_sha256 OR rev.result_sha256<>r.result_sha256 THEN RAISE EXCEPTION 'partial result publication' USING ERRCODE='P7205'; END IF;
   END IF;
 END IF;
 state:=CASE WHEN f.session_id IS NULL THEN 'awaiting-evaluation-consumer' WHEN j.job_id IS NULL OR NOT current_review OR f.writer='read-only' AND j.status<>'completed' THEN 'review_required' ELSE j.status END;
 RETURN jsonb_build_object('version','authenticated-evaluation-projection-v1','sessionId',e.session_id,'state',state,'control',gakja.evaluation_session_control_json(f),'currentApproval',current_review,
   'jobJson',gakja.evaluation_job_json(j),'resultJson',r.result_json,'revisionJson',j.revision_json,'revisionSha256',j.revision_sha256,'revisionRawSha256',j.revision_raw_sha256,'resultRevisionId',rev.revision_id);
END $$;

CREATE FUNCTION gakja.evaluation_grant_worker(p jsonb) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id text; j gakja.evaluation_jobs; expiry timestamptz;
BEGIN
 PERFORM gakja.evaluation_current_grant(); expiry:=(p->>'expiresAt')::timestamptz;
 IF NOT gakja.is_trimmed_identifier(p->>'subjectId') OR jsonb_typeof(p->'jobIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'jobIds') NOT BETWEEN 1 AND 64
   OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '24 hours' THEN RAISE EXCEPTION 'finite worker grant required' USING ERRCODE='22023'; END IF;
 FOR id IN SELECT jsonb_array_elements_text(p->'jobIds') LOOP
   j:=gakja.evaluation_job_scope(id);
   IF j.job_id IS NULL OR NOT gakja.evaluation_job_review_current(j,true) THEN RAISE EXCEPTION 'worker binding denied' USING ERRCODE='42501'; END IF;
   INSERT INTO gakja.evaluation_worker_grants(owner_id,job_id,worker_subject,expires_at) VALUES(j.owner_id,j.job_id,p->>'subjectId',expiry)
     ON CONFLICT(owner_id,job_id,worker_subject) DO UPDATE SET active=true,expires_at=EXCLUDED.expires_at;
 END LOOP; RETURN true;
END $$;
CREATE FUNCTION gakja.evaluation_lock_job(p_id text,p_worker boolean DEFAULT false) RETURNS gakja.evaluation_jobs LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j gakja.evaluation_jobs; f gakja.evaluation_sessions; s gakja.evaluation_scopes; grant_row gakja.evaluation_worker_grants;
BEGIN
 j:=gakja.evaluation_job_scope(p_id); IF j.job_id IS NULL THEN RAISE EXCEPTION 'evaluation job denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=j.owner_id AND session_id=j.session_id;
 SELECT * INTO s FROM gakja.evaluation_scopes WHERE owner_id=f.owner_id AND student_id=f.student_id AND application_target_id=f.application_target_id AND source_pin_key=f.source_pin_key FOR SHARE;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=j.owner_id AND session_id=j.session_id FOR SHARE;
 IF p_worker THEN
   IF p_id IS DISTINCT FROM current_setting('gakja.job_id',true) THEN RAISE EXCEPTION 'worker job mismatch' USING ERRCODE='42501'; END IF;
   SELECT * INTO grant_row FROM gakja.evaluation_worker_grants WHERE owner_id=j.owner_id AND job_id=j.job_id AND worker_subject=current_setting('gakja.worker_subject',true) FOR SHARE;
   IF NOT FOUND OR NOT grant_row.active OR grant_row.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'worker grant expired' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT * INTO j FROM gakja.evaluation_jobs WHERE owner_id=j.owner_id AND job_id=p_id FOR UPDATE;
 IF f.writer<>'db' OR f.fence<>j.session_fence THEN RAISE EXCEPTION 'evaluation writer frozen' USING ERRCODE='P7204'; END IF;
 IF NOT gakja.evaluation_job_review_current(j,true) THEN RAISE EXCEPTION 'current review generation changed' USING ERRCODE='P7202'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION gakja.evaluation_worker(p_id text,p_action text,p jsonb) RETURNS text LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j gakja.evaluation_jobs; cp jsonb; usage_row gakja.evaluation_usage; result_body jsonb;
  raw text; result_hash text; completed text; duration integer; retrying boolean; result_revision text;
BEGIN
 j:=gakja.evaluation_lock_job(p_id,true);
 IF p_action='get' THEN RETURN gakja.evaluation_job_json(j); END IF;
 IF p_action='snapshot' THEN RETURN j.snapshot_json; END IF;
 IF p_action='claim' THEN
   duration:=(p->>'leaseMs')::integer;
   IF duration NOT BETWEEN 1 AND 300000 OR NOT gakja.is_trimmed_identifier(p->>'workerId') THEN RAISE EXCEPTION 'worker claim invalid' USING ERRCODE='22023'; END IF;
   IF j.status NOT IN ('queued','running') OR j.status='queued' AND j.next_retry_at>clock_timestamp()
     OR j.status='running' AND j.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
   UPDATE gakja.evaluation_jobs SET status='running',attempts=attempts+1,updated_at=clock_timestamp(),next_retry_at=NULL,
     lease_token=gen_random_uuid(),worker_id=p->>'workerId',lease_until=clock_timestamp()+duration*interval '1 millisecond',lease_fence=lease_fence+1
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
   RETURN gakja.evaluation_job_json(j);
 END IF;
 IF j.status<>'running' OR j.lease_token::text IS DISTINCT FROM p->>'token' OR j.lease_until<=clock_timestamp()
   THEN RAISE EXCEPTION 'evaluation lease lost' USING ERRCODE='P7203'; END IF;
 IF p_action='completion-metadata' THEN
   RETURN json_build_object('jobJson',gakja.evaluation_job_json(j),'serverNow',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;
 END IF;
 IF p_action='renew' THEN
   duration:=(p->>'leaseMs')::integer; IF duration NOT BETWEEN 1 AND 300000 THEN RAISE EXCEPTION 'lease duration invalid' USING ERRCODE='22023'; END IF;
   UPDATE gakja.evaluation_jobs SET lease_until=clock_timestamp()+duration*interval '1 millisecond',updated_at=clock_timestamp()
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
 ELSIF p_action='checkpoint' THEN
   raw:=p->>'checkpointJson'; cp:=raw::jsonb;
   IF octet_length(raw) NOT BETWEEN 2 AND 16777216 OR cp->>'version' IS DISTINCT FROM j.pipeline_version OR cp->>'inputSha256' !~ '^[a-f0-9]{64}$'
     OR NOT gakja.is_trimmed_identifier(cp->>'clusterId') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.snapshot_json::jsonb->'session'->'turns') t WHERE coalesce(t->>'parentMainQuestionId',t->>'id')=cp->>'clusterId')
     THEN RAISE EXCEPTION 'checkpoint binding invalid' USING ERRCODE='P7205'; END IF;
   INSERT INTO gakja.evaluation_checkpoints(owner_id,job_id,input_binding_sha256,cluster_id,input_sha256,checkpoint_json,checkpoint_sha256,lease_fence)
     VALUES(j.owner_id,j.job_id,j.input_binding_sha256,cp->>'clusterId',cp->>'inputSha256',raw,gakja.session_text_sha(raw),j.lease_fence) ON CONFLICT DO NOTHING;
 ELSIF p_action='usage' THEN
   raw:=p->>'observationJson'; PERFORM raw::json;
   IF NOT gakja.is_trimmed_identifier(p->>'attemptId') OR octet_length(raw) NOT BETWEEN 2 AND 1048576 THEN RAISE EXCEPTION 'usage invalid' USING ERRCODE='22023'; END IF;
   SELECT * INTO usage_row FROM gakja.evaluation_usage WHERE owner_id=j.owner_id AND job_id=j.job_id AND attempt_id=p->>'attemptId';
   IF FOUND AND usage_row.observation_json IS DISTINCT FROM raw THEN RAISE EXCEPTION 'usage attempt changed' USING ERRCODE='P7201'; END IF;
   INSERT INTO gakja.evaluation_usage(owner_id,job_id,input_binding_sha256,attempt_id,observation_json,observation_sha256,lease_fence)
     VALUES(j.owner_id,j.job_id,j.input_binding_sha256,p->>'attemptId',raw,gakja.session_text_sha(raw),j.lease_fence) ON CONFLICT DO NOTHING;
 ELSIF p_action='complete' THEN
   raw:=p->>'resultJson'; result_body:=raw::jsonb;
   IF octet_length(raw) NOT BETWEEN 2 AND 16777216 OR p->>'rawSha256' IS DISTINCT FROM gakja.session_text_sha(raw) OR p->>'resultSha256' IS DISTINCT FROM p->>'rawSha256'
     OR result_body->>'version' IS DISTINCT FROM '1' OR result_body->>'jobId' IS DISTINCT FROM j.job_id
     OR result_body->>'sourceSha256' IS DISTINCT FROM j.source_sha256 OR result_body->>'snapshotSha256' IS DISTINCT FROM j.snapshot_sha256
     OR result_body->>'pipelineVersion' IS DISTINCT FROM j.pipeline_version OR result_body->>'model' IS DISTINCT FROM j.model
     OR result_body->>'completedAt' IS NULL OR jsonb_typeof(result_body->'evaluation') IS DISTINCT FROM 'object'
     OR (result_body->>'completedAt')::timestamptz>clock_timestamp()+interval '2 seconds' OR (result_body->>'completedAt')::timestamptz<clock_timestamp()-interval '30 seconds'
     THEN RAISE EXCEPTION 'evaluation result binding invalid' USING ERRCODE='P7205'; END IF;
   result_hash:=gakja.session_text_sha(raw);
   INSERT INTO gakja.evaluation_results(owner_id,job_id,input_binding_sha256,result_json,result_sha256) VALUES(j.owner_id,j.job_id,j.input_binding_sha256,raw,result_hash);
   result_revision:=gakja.session_text_sha(json_build_array(j.owner_id,j.job_id,result_hash,j.revision_sha256)::text);
   INSERT INTO gakja.evaluation_result_revisions(owner_id,session_id,job_id,revision_id,input_binding_sha256,result_sha256,reference_json,reference_sha256)
     VALUES(j.owner_id,j.session_id,j.job_id,result_revision,j.input_binding_sha256,result_hash,j.revision_json,j.revision_raw_sha256);
   UPDATE gakja.evaluation_jobs SET status='completed',result_sha256=result_hash,error_json=NULL,next_retry_at=NULL,lease_token=NULL,worker_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
 ELSIF p_action='review' THEN
   IF jsonb_typeof(p->'reasons') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'review reasons invalid' USING ERRCODE='22023'; END IF;
   UPDATE gakja.evaluation_jobs SET status='review_required',lease_token=NULL,worker_id=NULL,lease_until=NULL,next_retry_at=NULL,updated_at=clock_timestamp(),
     error_json=json_build_object('code','EVALUATION_REVIEW_REQUIRED','message',(SELECT string_agg(item,',') FROM jsonb_array_elements_text(p->'reasons') item),'retryable',false)::text
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
 ELSIF p_action='fail' THEN
   IF (p->>'maxAttempts')::integer NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'attempt limit invalid' USING ERRCODE='22023'; END IF;
   retrying:=coalesce((p->'error'->>'retryable')::boolean,false) AND j.attempts<(p->>'maxAttempts')::integer;
   UPDATE gakja.evaluation_jobs SET status=CASE WHEN retrying THEN 'queued' ELSE 'failed' END,error_json=(p->'error')::text,
     lease_token=NULL,worker_id=NULL,lease_until=NULL,updated_at=clock_timestamp(),
     next_retry_at=CASE WHEN retrying THEN clock_timestamp()+least(60000,2000*power(2,greatest(0,j.attempts-1))) * interval '1 millisecond' ELSE NULL END
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
 ELSE RAISE EXCEPTION 'unsupported worker action' USING ERRCODE='22023';
 END IF;
 RETURN gakja.evaluation_job_json(j);
END $$;
CREATE FUNCTION gakja.evaluation_retry(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.evaluation_scopes; j gakja.evaluation_jobs; prior jsonb;
BEGIN
 s:=gakja.evaluation_lock_scope(); prior:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256'); IF prior IS NOT NULL THEN RETURN prior; END IF;
 j:=gakja.evaluation_lock_job(p->>'jobId',false);
 IF j.status='failed' THEN
   UPDATE gakja.evaluation_jobs SET status='queued',error_json=NULL,next_retry_at=NULL,lease_token=NULL,worker_id=NULL,lease_until=NULL,updated_at=clock_timestamp()
     WHERE owner_id=j.owner_id AND job_id=j.job_id RETURNING * INTO j;
 END IF;
 RETURN gakja.evaluation_record_receipt(s,p,'retry',json_build_object('jobId',j.job_id,'status',j.status)::text);
END $$;
CREATE FUNCTION gakja.evaluation_freeze(p_id text,p_fence bigint) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f gakja.evaluation_sessions;
BEGIN
 f:=gakja.evaluation_lock_session(p_id,false); IF f.session_id IS NULL THEN RAISE EXCEPTION 'evaluation not registered' USING ERRCODE='42501'; END IF;
 IF f.fence<>p_fence THEN RAISE EXCEPTION 'evaluation fence changed' USING ERRCODE='P7204'; END IF;
 UPDATE gakja.evaluation_sessions SET writer='read-only',fence=fence+1 WHERE owner_id=f.owner_id AND session_id=f.session_id RETURNING * INTO f;
 RETURN gakja.evaluation_session_control_json(f);
END $$;

CREATE FUNCTION gakja.evaluation_dump_rows(p_table text,p_owner text,p_session text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f gakja.evaluation_sessions; filter text; expression text:='to_jsonb(t)'; column_row record; result jsonb;
BEGIN
 IF p_table NOT IN ('session_command_sessions','session_commands','session_command_keys','session_command_semantics','session_command_attempts','session_mandatory_events','session_answer_facts','session_end_intents','session_evaluation_handoffs','session_connection_closes',
   'evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events')
   THEN RAISE EXCEPTION 'unrecognized preservation table' USING ERRCODE='22023'; END IF;
 SELECT * INTO f FROM gakja.evaluation_sessions WHERE owner_id=p_owner AND session_id=p_session;
 IF p_table IN ('evaluation_scopes','evaluation_artifacts') THEN
   filter:='t.owner_id=$1 AND t.student_id=$3 AND t.application_target_id=$4 AND t.source_pin_key=$5';
 ELSIF p_table IN ('evaluation_command_receipts','evaluation_audit_events') THEN
   filter:='t.owner_id=$1 AND t.student_id=$3 AND t.application_target_id=$4 AND t.source_pin_key=$5 AND (t.session_id IS NULL OR t.session_id=$2)';
 ELSIF p_table IN ('evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results') THEN
   filter:='t.owner_id=$1 AND EXISTS(SELECT 1 FROM gakja.evaluation_jobs j WHERE j.owner_id=t.owner_id AND j.job_id=t.job_id AND j.session_id=$2)';
 ELSE filter:='t.owner_id=$1 AND t.session_id=$2'; END IF;
 -- Export bigint columns as strings and timestamptz as exact UTC instants.
 -- Raw canonical JSON TEXT fields are never parsed or normalized here.
 FOR column_row IN SELECT a.attname,a.atttypid FROM pg_attribute a WHERE a.attrelid=to_regclass('gakja.'||p_table) AND a.attnum>0 AND NOT a.attisdropped LOOP
   IF column_row.atttypid='pg_catalog.int8'::regtype THEN expression:=expression||format('||jsonb_build_object(%L,t.%I::text)',column_row.attname,column_row.attname);
   ELSIF column_row.atttypid='pg_catalog.timestamptz'::regtype THEN expression:=expression||format('||jsonb_build_object(%L,CASE WHEN t.%I IS NULL THEN NULL ELSE to_char(t.%I AT TIME ZONE ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'') END)',column_row.attname,column_row.attname,column_row.attname); END IF;
 END LOOP;
 EXECUTE format('SELECT coalesce(jsonb_agg(%s ORDER BY (%s)::text),''[]''::jsonb) FROM gakja.%I t WHERE %s',expression,expression,p_table,filter)
   INTO result USING p_owner,p_session,f.student_id,f.application_target_id,f.source_pin_key;
 RETURN result;
END $$;
CREATE FUNCTION gakja.evaluation_export(p_id text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f gakja.evaluation_sessions; e jsonb; tables jsonb:='{}'::jsonb; manifest jsonb:='[]'::jsonb; t text; rows jsonb;
BEGIN
 f:=gakja.evaluation_lock_session(p_id,false);
 IF f.session_id IS NULL THEN RAISE EXCEPTION 'evaluation preservation missing' USING ERRCODE='42501'; END IF;
 IF f.writer<>'read-only' THEN RAISE EXCEPTION 'freeze F before preservation' USING ERRCODE='P7204'; END IF;
 e:=jsonb_build_object('version','session-preservation-payload-v1',
   'session',gakja.evaluation_dump_rows('session_command_sessions',f.owner_id,p_id)->0,
   'commands',gakja.evaluation_dump_rows('session_commands',f.owner_id,p_id),
   'keys',gakja.evaluation_dump_rows('session_command_keys',f.owner_id,p_id),
   'semantics',gakja.evaluation_dump_rows('session_command_semantics',f.owner_id,p_id),
   'attempts',gakja.evaluation_dump_rows('session_command_attempts',f.owner_id,p_id),
   'events',gakja.evaluation_dump_rows('session_mandatory_events',f.owner_id,p_id),
   'answers',gakja.evaluation_dump_rows('session_answer_facts',f.owner_id,p_id),
   'endIntents',gakja.evaluation_dump_rows('session_end_intents',f.owner_id,p_id),
   'handoffs',gakja.evaluation_dump_rows('session_evaluation_handoffs',f.owner_id,p_id),
   'connectionCloses',gakja.evaluation_dump_rows('session_connection_closes',f.owner_id,p_id));
 FOREACH t IN ARRAY ARRAY['evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events'] LOOP
   rows:=gakja.evaluation_dump_rows(t,f.owner_id,p_id); tables:=tables||jsonb_build_object(t,rows);
   manifest:=manifest||jsonb_build_array(jsonb_build_object('table',t,'rows',jsonb_array_length(rows),'sha256',gakja.session_text_sha(rows::text)));
 END LOOP;
 RETURN jsonb_build_object('version','evaluation-preservation-payload-v1','sessionId',p_id,'ownerId',f.owner_id,'eSession',e,'fTables',tables,'manifest',manifest,
   'sourceDependenciesJson',f.source_dependencies_json,'sourceDependenciesSha256',f.source_dependencies_sha256,'newResultObjects','[]'::jsonb,
   'restorePolicy',jsonb_build_object('eOuterWriter','read-only','fWriter','read-only','canonicalTextChanged',false,'objects','F result/review/context exact TEXT is restored. C/D source object ref/hash metadata is preserved in the immutable F source dependency manifest; its C/D rows and object bytes require separate external archival and are not restored by F.'));
END $$;
CREATE FUNCTION gakja.evaluation_restore_rows(p_table text,p_rows jsonb) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE columns text; values_sql text;
BEGIN
 IF p_table NOT IN ('evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events')
   OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'restoration table invalid' USING ERRCODE='22023'; END IF;
 SELECT string_agg(format('%I',a.attname),',' ORDER BY a.attnum),string_agg(format('r.%I',a.attname),',' ORDER BY a.attnum) INTO columns,values_sql
   FROM pg_attribute a WHERE a.attrelid=to_regclass('gakja.'||p_table) AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='';
 EXECUTE format('INSERT INTO gakja.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::gakja.%I,$1)r',p_table,columns,values_sql,p_table) USING p_rows;
END $$;
CREATE FUNCTION gakja.evaluation_restore(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants; e jsonb; f gakja.evaluation_sessions; t text; row_value jsonb; manifest_item jsonb; actual_rows jsonb;
BEGIN
 g:=gakja.evaluation_current_grant();
 IF p->>'version'<>'evaluation-preservation-payload-v1' OR p->>'ownerId' IS DISTINCT FROM g.owner_id OR p->>'sessionId' IS DISTINCT FROM p->'eSession'->'session'->>'session_id'
   THEN RAISE EXCEPTION 'preservation scope invalid' USING ERRCODE='42501'; END IF;
 f:=jsonb_populate_record(NULL::gakja.evaluation_sessions,p->'fTables'->'evaluation_sessions'->0);
 IF f.session_id IS NULL OR f.session_id IS DISTINCT FROM p->>'sessionId' OR f.owner_id<>g.owner_id OR f.student_id<>g.student_id OR f.application_target_id<>g.application_target_id
   OR f.source_pin_key<>gakja.evaluation_scope_key(g) OR f.writer<>'read-only' THEN RAISE EXCEPTION 'read-only preservation required' USING ERRCODE='P7204'; END IF;
 IF p->>'sourceDependenciesJson' IS DISTINCT FROM f.source_dependencies_json OR p->>'sourceDependenciesSha256' IS DISTINCT FROM gakja.session_text_sha(f.source_dependencies_json)
   OR p->'newResultObjects' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'source dependency preservation changed' USING ERRCODE='P7205'; END IF;
 IF EXISTS(SELECT 1 FROM gakja.evaluation_sessions WHERE owner_id=f.owner_id AND session_id=f.session_id)
   OR EXISTS(SELECT 1 FROM gakja.evaluation_scopes WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id AND source_pin_key=f.source_pin_key)
   THEN RAISE EXCEPTION 'restore requires new owned scope' USING ERRCODE='P7205'; END IF;
 -- E canonical TEXT and all nine child collections stay exact. Only the new
 -- archive's outer E writer selection is read-only; the source E is untouched.
 e:=jsonb_set(p->'eSession','{session,writer}','"read-only"'::jsonb); PERFORM gakja.session_restore(e);
 FOREACH t IN ARRAY ARRAY['evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events'] LOOP
   IF jsonb_typeof(p->'fTables'->t) IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'manifest') m WHERE m->>'table'=t
     AND (m->>'rows')::integer=jsonb_array_length(p->'fTables'->t) AND m->>'sha256'=gakja.session_text_sha((p->'fTables'->t)::text))
     THEN RAISE EXCEPTION 'preservation manifest changed' USING ERRCODE='P7205'; END IF;
   FOR row_value IN SELECT * FROM jsonb_array_elements(p->'fTables'->t) LOOP
     IF row_value->>'owner_id' IS DISTINCT FROM f.owner_id OR row_value ? 'session_id' AND row_value->>'session_id' IS NOT NULL AND row_value->>'session_id' IS DISTINCT FROM f.session_id
       OR row_value ? 'student_id' AND row_value->>'student_id' IS DISTINCT FROM f.student_id
       OR row_value ? 'application_target_id' AND row_value->>'application_target_id' IS DISTINCT FROM f.application_target_id
       OR row_value ? 'source_pin_key' AND row_value->>'source_pin_key' IS DISTINCT FROM f.source_pin_key
       THEN RAISE EXCEPTION 'preservation child scope denied' USING ERRCODE='42501'; END IF;
   END LOOP;
   PERFORM gakja.evaluation_restore_rows(t,p->'fTables'->t);
 END LOOP;
 PERFORM setval(pg_get_serial_sequence('gakja.evaluation_checkpoints','checkpoint_id'),coalesce((SELECT max(checkpoint_id) FROM gakja.evaluation_checkpoints),1),EXISTS(SELECT 1 FROM gakja.evaluation_checkpoints));
 RETURN gakja.evaluation_projection(f.session_id,NULL);
END $$;

CREATE FUNCTION gakja.evaluation_fact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable evaluation fact' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['evaluation_artifacts','evaluation_consumption_history','evaluation_command_receipts','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_audit_events'] LOOP
   EXECUTE format('CREATE TRIGGER evaluation_fact_immutable BEFORE UPDATE OR DELETE ON gakja.%I FOR EACH ROW EXECUTE FUNCTION gakja.evaluation_fact_immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION gakja.evaluation_job_input_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['trust_generation','registry_generation','approval_generation','session_fence','status','attempts','updated_at','next_retry_at','lease_token','worker_id','lease_until','lease_fence','error_json','result_sha256'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['trust_generation','registry_generation','approval_generation','session_fence','status','attempts','updated_at','next_retry_at','lease_token','worker_id','lease_until','lease_fence','error_json','result_sha256'])
   OR OLD.status='completed' AND (NEW.status<>'completed' OR NEW.result_sha256 IS DISTINCT FROM OLD.result_sha256)
   THEN RAISE EXCEPTION 'immutable evaluation job input/result' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER evaluation_job_input_immutable BEFORE UPDATE OR DELETE ON gakja.evaluation_jobs FOR EACH ROW EXECUTE FUNCTION gakja.evaluation_job_input_immutable();
CREATE FUNCTION gakja.evaluation_consumption_input_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','job_id','trust_generation','registry_generation','approval_generation','reasons_json'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','job_id','trust_generation','registry_generation','approval_generation','reasons_json'])
   OR OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN RAISE EXCEPTION 'immutable consumption identity' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER evaluation_consumption_input_immutable BEFORE UPDATE OR DELETE ON gakja.evaluation_consumptions FOR EACH ROW EXECUTE FUNCTION gakja.evaluation_consumption_input_immutable();
CREATE FUNCTION gakja.evaluation_session_input_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['source_dependencies_sha256','writer','fence','approval_generation','current_approval_sha256','current_bundle_sha256','approval_registry_sha256','approval_revoked','approval_issued_at','approval_accepted_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['source_dependencies_sha256','writer','fence','approval_generation','current_approval_sha256','current_bundle_sha256','approval_registry_sha256','approval_revoked','approval_issued_at','approval_accepted_at'])
   THEN RAISE EXCEPTION 'immutable evaluation session source dependency/input' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER evaluation_session_input_immutable BEFORE UPDATE OR DELETE ON gakja.evaluation_sessions FOR EACH ROW EXECUTE FUNCTION gakja.evaluation_session_input_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events'] LOOP
   EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY evaluation_owner_management ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',t);
   EXECUTE format('REVOKE ALL ON gakja.%I FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',t);
 END LOOP;
END $$;
-- Helpers are not public RPCs; role-specific entry points below carry verified
-- backend GUCs and finite capabilities from the TypeScript composition.
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gakja' AND p.proname LIKE 'evaluation\_%' ESCAPE '\' LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION gakja.evaluation_scope_control(),gakja.evaluation_session_control(text),gakja.evaluation_read_artifact(text,text),gakja.evaluation_receipt(text,text),
 gakja.evaluation_publish_registry(jsonb),gakja.evaluation_publish_approval(jsonb),gakja.evaluation_withdraw_approval(jsonb),gakja.evaluation_consume(jsonb),gakja.evaluation_projection(text,text),
 gakja.evaluation_get_job(text,boolean),gakja.evaluation_retry(jsonb),gakja.evaluation_freeze(text,bigint),gakja.evaluation_export(text) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.evaluation_install_trust(jsonb),gakja.evaluation_grant_worker(jsonb),gakja.evaluation_restore(jsonb) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.evaluation_worker(text,text,jsonb) TO gakja_worker;

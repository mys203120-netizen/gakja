-- PR07-E isolated authenticated session writer. B/C/D bytes and checkpoints stay intact.
-- Exact JSON text is authoritative; JSON/JSONB projections never replace its bytes.
CREATE FUNCTION gakja.session_text_sha(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog AS $$ SELECT encode(sha256(convert_to(value,'UTF8')),'hex') $$;

CREATE TABLE gakja.session_command_sessions (
  owner_id text NOT NULL, session_id text NOT NULL CHECK (session_id ~ '^[a-f0-9-]{36}$'),
  student_id text NOT NULL, application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text, source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  creation_key text NOT NULL CHECK (gakja.is_trimmed_identifier(creation_key) AND length(creation_key)<=160),
  creation_input_sha256 text NOT NULL CHECK (creation_input_sha256 ~ '^[a-f0-9]{64}$'),
  writer text NOT NULL DEFAULT 'db' CHECK (writer IN ('db','read-only','local')),
  writer_generation bigint NOT NULL DEFAULT 1 CHECK (writer_generation>0), writer_token uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0), created boolean NOT NULL DEFAULT false,
  session_json text NOT NULL CHECK (octet_length(session_json) BETWEEN 2 AND 16777216),
  session_sha256 text NOT NULL CHECK (session_sha256=gakja.session_text_sha(session_json)),
  context_json text NOT NULL CHECK (octet_length(context_json) BETWEEN 2 AND 16777216),
  context_sha256 text NOT NULL CHECK (context_sha256=gakja.session_text_sha(context_json)),
  pins_json text NOT NULL CHECK (octet_length(pins_json) BETWEEN 2 AND 1048576),
  pins_sha256 text NOT NULL CHECK (pins_sha256=gakja.session_text_sha(pins_json)),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,session_id), UNIQUE(session_id), UNIQUE(owner_id,session_id,context_sha256),
  UNIQUE(owner_id,student_id,application_target_id,creation_key),
  FOREIGN KEY(owner_id,student_id,application_target_id,support_target_id)
    REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  CHECK (NOT created OR revision>0), CHECK (writer<>'local' OR (NOT created AND revision=0))
);
CREATE TABLE gakja.session_commands (
  owner_id text NOT NULL, session_id text NOT NULL, operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  original_key text NOT NULL, kind text NOT NULL CHECK (kind IN ('create','answer','next','event','capture','recover','closing','end-accept','end-finalize')),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'), semantic_key text NOT NULL,
  semantic_sha256 text NOT NULL CHECK (semantic_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed')),
  expected_revision bigint NOT NULL CHECK (expected_revision>=0), writer_generation bigint NOT NULL CHECK(writer_generation>0),
  writer_token uuid NOT NULL, operation_token uuid NOT NULL DEFAULT gen_random_uuid(),
  result_json text, result_sha256 text, committed_revision bigint, committed_session_sha256 text, committed_at timestamptz,
  PRIMARY KEY(owner_id,session_id,operation_id), UNIQUE(operation_id), UNIQUE(owner_id,session_id,original_key),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.session_command_sessions(owner_id,session_id),
  CHECK (gakja.is_trimmed_identifier(original_key) AND length(original_key)<=160 AND gakja.is_trimmed_identifier(semantic_key) AND length(semantic_key)<=512),
  CHECK ((status='pending' AND result_json IS NULL AND result_sha256 IS NULL AND committed_revision IS NULL AND committed_at IS NULL AND committed_session_sha256 IS NULL)
    OR (status='committed' AND result_json IS NOT NULL AND result_sha256=gakja.session_text_sha(result_json) AND committed_revision>0
      AND committed_session_sha256 ~ '^[a-f0-9]{64}$' AND committed_at IS NOT NULL))
);
CREATE TABLE gakja.session_command_keys (
  owner_id text NOT NULL, session_id text NOT NULL, key text NOT NULL, input_sha256 text NOT NULL,
  operation_id uuid NOT NULL, PRIMARY KEY(owner_id,session_id,key),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_command_semantics (
  owner_id text NOT NULL, session_id text NOT NULL, kind text NOT NULL, semantic_key text NOT NULL, operation_id uuid NOT NULL,
  PRIMARY KEY(owner_id,session_id,kind,semantic_key),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_command_attempts (
  owner_id text NOT NULL, session_id text NOT NULL, operation_id uuid NOT NULL, attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation_token uuid NOT NULL, writer_generation bigint NOT NULL, writer_token uuid NOT NULL,
  started_revision bigint NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,session_id,attempt_id),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_mandatory_events (
  owner_id text NOT NULL, session_id text NOT NULL, event_id text NOT NULL, kind text NOT NULL,
  payload_json text NOT NULL, payload_sha256 text NOT NULL CHECK(payload_sha256=gakja.session_text_sha(payload_json)),
  operation_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  PRIMARY KEY(owner_id,session_id,event_id),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_answer_facts (
  owner_id text NOT NULL, session_id text NOT NULL, turn_id text NOT NULL, answer_id text NOT NULL,
  capture_revision bigint NOT NULL CHECK(capture_revision>0), input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  PRIMARY KEY(owner_id,session_id,turn_id,answer_id,capture_revision),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_end_intents (
  owner_id text NOT NULL, session_id text NOT NULL, intent_id uuid NOT NULL,
  input_json text NOT NULL, input_sha256 text NOT NULL CHECK(input_sha256=gakja.session_text_sha(input_json)),
  accepted_revision bigint NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), operation_id uuid NOT NULL,
  PRIMARY KEY(owner_id,session_id), UNIQUE(intent_id),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
CREATE TABLE gakja.session_evaluation_handoffs (
  owner_id text NOT NULL, session_id text NOT NULL, intent_id uuid NOT NULL,
  version text NOT NULL DEFAULT 'session-evaluation-handoff-v1' CHECK(version='session-evaluation-handoff-v1'),
  state text NOT NULL DEFAULT 'awaiting-evaluation-consumer' CHECK(state='awaiting-evaluation-consumer'),
  payload_json text NOT NULL, payload_sha256 text NOT NULL CHECK(payload_sha256=gakja.session_text_sha(payload_json)),
  context_sha256 text NOT NULL, frozen_session_sha256 text NOT NULL CHECK(frozen_session_sha256 ~ '^[a-f0-9]{64}$'), committed_revision bigint NOT NULL CHECK(committed_revision>0), operation_id uuid NOT NULL,
  PRIMARY KEY(owner_id,session_id), UNIQUE(intent_id),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.session_end_intents(owner_id,session_id),
  FOREIGN KEY(owner_id,session_id,context_sha256) REFERENCES gakja.session_command_sessions(owner_id,session_id,context_sha256),
  FOREIGN KEY(owner_id,session_id,operation_id) REFERENCES gakja.session_commands(owner_id,session_id,operation_id)
);
-- Passive connection-close observations do not advance session revision or
-- change canonical/frozen bytes. One server connection can record its first
-- close only once; a stale generation cannot renew the recovery window.
CREATE TABLE gakja.session_connection_closes (
  owner_id text NOT NULL, session_id text NOT NULL, writer_generation bigint NOT NULL CHECK(writer_generation>0),
  connection_token uuid NOT NULL, closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,session_id,writer_generation,connection_token),
  FOREIGN KEY(owner_id,session_id) REFERENCES gakja.session_command_sessions(owner_id,session_id)
);

CREATE FUNCTION gakja.session_can_read(s gakja.session_command_sessions) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT s.owner_id=current_setting('gakja.owner_id',true) AND s.student_id=current_setting('gakja.student_id',true)
    AND s.application_target_id=current_setting('gakja.application_target_id',true)
    AND gakja.can_target(s.owner_id,s.student_id,s.application_target_id,s.source_present,s.source_revision)
$$;
-- FOR SHARE serializes a mutation with B's grant/account revision trigger's
-- UPDATE. A grant update may wait, but cannot commit between this check and our
-- commit. Locks are released before every provider/Storage await in TypeScript.
CREATE FUNCTION gakja.session_guard_account() RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a gakja.accounts;
BEGIN
  SELECT * INTO a FROM gakja.accounts WHERE account_id=current_setting('gakja.account_id',true) FOR SHARE;
  IF NOT FOUND OR NOT a.active OR a.owner_id<>current_setting('gakja.owner_id',true)
    OR a.revision::text<>current_setting('gakja.account_revision',true)
    OR NOT EXISTS(SELECT 1 FROM gakja.principals p WHERE p.account_id=a.account_id AND p.active
      AND p.issuer=current_setting('gakja.issuer',true) AND p.subject=current_setting('gakja.subject',true))
    THEN RAISE EXCEPTION 'session authority denied' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION gakja.session_document_check(p_text text,p_id text,p_owner text,p_context text) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE d json;
BEGIN
  IF octet_length(p_text) NOT BETWEEN 2 AND 16777216 THEN RAISE EXCEPTION 'session size invalid' USING ERRCODE='22023'; END IF;
  d:=p_text::json;
  IF d->>'id' IS DISTINCT FROM p_id OR d->'runtime'->>'version' IS DISTINCT FROM 'authenticated-session-runtime-v1'
    OR d->'runtime'->'owner'->>'id' IS DISTINCT FROM p_owner OR d->'runtime'->'owner'->>'mode' IS DISTINCT FROM 'authenticated'
    OR d->'runtime'->>'contextSnapshotSha256' IS DISTINCT FROM p_context
    OR coalesce(d->>'status','') NOT IN ('active','ending','completed') OR coalesce(d->>'evaluationStatus','') NOT IN ('pending','review_required')
    OR d->'evaluation' IS NOT NULL AND (d->'evaluation')::text<>'null'
    OR d->'runtime'->'evaluationJob' IS NOT NULL OR json_typeof(d->'turns') IS DISTINCT FROM 'array'
    OR coalesce(d->'runtime'->>'epoch','') !~ '^\d+$'
    THEN RAISE EXCEPTION 'authenticated session document invalid' USING ERRCODE='22023'; END IF;
END $$;
CREATE FUNCTION gakja.session_snapshot_json(s gakja.session_command_sessions) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version','authenticated-session-snapshot-v1','binding',
   jsonb_build_object('ownerId',s.owner_id,'studentId',s.student_id,'applicationTargetId',s.application_target_id,'supportTargetId',s.support_target_id,
     'sessionId',s.session_id,'contextSnapshotSha256',s.context_sha256)||CASE WHEN s.source_present THEN jsonb_build_object('sourceRevision',s.source_revision) ELSE '{}'::jsonb END,
   'writer',s.writer,'writerGeneration',s.writer_generation::text,'writerToken',s.writer_token::text,'revision',s.revision::text,'created',s.created,'serverNow',clock_timestamp(),
   'sessionJson',s.session_json,'sessionSha256',s.session_sha256,'contextJson',s.context_json,'contextSnapshotSha256',s.context_sha256,'pinsJson',s.pins_json,'pinsSha256',s.pins_sha256,
   'endIntent',(SELECT jsonb_build_object('intentId',e.intent_id::text,'inputJson',e.input_json,'inputSha256',e.input_sha256,'acceptedRevision',e.accepted_revision::text,'acceptedAt',e.accepted_at) FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id),
   'handoff',(SELECT jsonb_build_object('intentId',h.intent_id::text,'version',h.version,'state',h.state,'payloadJson',h.payload_json,'payloadSha256',h.payload_sha256,
     'contextSnapshotSha256',h.context_sha256,'frozenSessionSha256',h.frozen_session_sha256,'committedRevision',h.committed_revision::text) FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id))
   ||coalesce((SELECT jsonb_build_object('lastDisconnectedAt',max(o.closed_at)) FROM gakja.session_connection_closes o
     WHERE o.owner_id=s.owner_id AND o.session_id=s.session_id AND o.writer_generation=s.writer_generation HAVING count(*)>0),'{}'::jsonb)
$$;
CREATE FUNCTION gakja.session_read(p_id text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT gakja.session_snapshot_json(s) FROM gakja.session_command_sessions s WHERE s.session_id=p_id AND gakja.session_can_read(s)
$$;
CREATE FUNCTION gakja.session_list() RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(gakja.session_snapshot_json(s) ORDER BY s.enrolled_at DESC,s.session_id),'[]'::jsonb)
 FROM (SELECT candidate.* FROM gakja.session_command_sessions candidate WHERE candidate.created AND gakja.session_can_read(candidate)
   ORDER BY candidate.enrolled_at DESC,candidate.session_id LIMIT 256) s
$$;
CREATE FUNCTION gakja.session_find_creation(p_key text,p_input text) RETURNS jsonb LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions;
BEGIN
 SELECT * INTO s FROM gakja.session_command_sessions WHERE owner_id=current_setting('gakja.owner_id',true)
   AND student_id=current_setting('gakja.student_id',true) AND application_target_id=current_setting('gakja.application_target_id',true) AND creation_key=p_key;
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RETURN NULL; END IF;
 IF s.creation_input_sha256<>p_input THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
 RETURN gakja.session_snapshot_json(s);
END $$;
CREATE FUNCTION gakja.session_enroll(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; sid text:=p->>'sessionId'; owner text:=current_setting('gakja.owner_id',true); context_sha text;
BEGIN
 PERFORM gakja.session_guard_account();
 -- The scope lock serializes same-key first enrollment before a row exists.
 PERFORM 1 FROM gakja.application_targets WHERE owner_id=owner AND student_id=current_setting('gakja.student_id',true)
   AND application_target_id=current_setting('gakja.application_target_id',true) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'session scope denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM gakja.session_command_sessions WHERE owner_id=owner AND student_id=current_setting('gakja.student_id',true)
   AND application_target_id=current_setting('gakja.application_target_id',true) AND creation_key=p->>'creationKey';
 IF FOUND THEN
   IF NOT gakja.session_can_read(s) THEN RAISE EXCEPTION 'session scope denied' USING ERRCODE='42501'; END IF;
   IF s.creation_input_sha256 IS DISTINCT FROM p->>'inputSha256' THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
   RETURN gakja.session_snapshot_json(s);
 END IF;
 IF EXISTS(SELECT 1 FROM gakja.session_bindings WHERE session_id=sid) THEN RAISE EXCEPTION 'existing local session cannot enroll' USING ERRCODE='P7102'; END IF;
 IF NOT gakja.can_target(owner,current_setting('gakja.student_id',true),current_setting('gakja.application_target_id',true),p?'sourceRevision',p->>'sourceRevision')
   THEN RAISE EXCEPTION 'session scope denied' USING ERRCODE='42501'; END IF;
 context_sha:=gakja.session_text_sha(p->>'contextJson');
 PERFORM (p->>'contextJson')::json; PERFORM (p->>'pinsJson')::json;
 PERFORM gakja.session_document_check(p->>'sessionJson',sid,owner,context_sha);
 INSERT INTO gakja.session_command_sessions(owner_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,source_sha256,
   creation_key,creation_input_sha256,session_json,session_sha256,context_json,context_sha256,pins_json,pins_sha256)
 SELECT owner,sid,t.student_id,t.application_target_id,t.support_target_id,p?'sourceRevision',p->>'sourceRevision',p->>'sourceSha256',
   p->>'creationKey',p->>'inputSha256',p->>'sessionJson',gakja.session_text_sha(p->>'sessionJson'),p->>'contextJson',context_sha,p->>'pinsJson',gakja.session_text_sha(p->>'pinsJson')
 FROM gakja.application_targets t WHERE t.owner_id=owner AND t.student_id=current_setting('gakja.student_id',true) AND t.application_target_id=current_setting('gakja.application_target_id',true)
 RETURNING * INTO s;
 RETURN gakja.session_snapshot_json(s);
END $$;

CREATE FUNCTION gakja.session_receipt_json(c gakja.session_commands,p_key text,p_input text,p_replay boolean) RETURNS jsonb LANGUAGE sql STABLE
SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('sessionId',c.session_id,'key',p_key,'kind',c.kind,'inputSha256',p_input,'semanticKey',c.semantic_key,'semanticSha256',c.semantic_sha256,
   'operationId',c.operation_id::text,'committedRevision',c.committed_revision::text,'writerGeneration',c.writer_generation::text,'resultJson',c.result_json,
   'resultSha256',c.result_sha256,'sessionSha256',c.committed_session_sha256,'committedAt',c.committed_at,'replay',p_replay)
$$;
CREATE FUNCTION gakja.session_receipt(p jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; k gakja.session_command_keys; c gakja.session_commands;
BEGIN
 SELECT * INTO s FROM gakja.session_command_sessions WHERE session_id=p->>'sessionId';
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RETURN NULL; END IF;
 SELECT * INTO k FROM gakja.session_command_keys WHERE owner_id=s.owner_id AND session_id=s.session_id AND key=p->>'key';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO c FROM gakja.session_commands WHERE operation_id=k.operation_id;
 IF k.input_sha256 IS DISTINCT FROM p->>'inputSha256' OR c.kind IS DISTINCT FROM p->>'kind'
   OR c.semantic_key IS DISTINCT FROM p->>'semanticKey'
   OR c.kind<>'end-accept' AND c.semantic_sha256 IS DISTINCT FROM p->>'semanticSha256'
   THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
 IF c.status<>'committed' THEN RETURN NULL; END IF;
 RETURN gakja.session_receipt_json(c,k.key,k.input_sha256,true);
END $$;
CREATE FUNCTION gakja.session_find_committed(p jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; c gakja.session_commands; existing jsonb;
BEGIN
 existing:=gakja.session_receipt(p);IF existing IS NOT NULL THEN RETURN existing; END IF;
 SELECT * INTO s FROM gakja.session_command_sessions WHERE session_id=p->>'sessionId';
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RETURN NULL; END IF;
 SELECT command.* INTO c FROM gakja.session_command_semantics sm JOIN gakja.session_commands command USING(owner_id,session_id,operation_id)
   WHERE sm.owner_id=s.owner_id AND sm.session_id=s.session_id AND sm.kind=p->>'kind' AND sm.semantic_key=p->>'semanticKey';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.kind<>'end-accept' AND c.semantic_sha256 IS DISTINCT FROM p->>'semanticSha256'
   THEN RAISE EXCEPTION 'session semantic conflict' USING ERRCODE='P7105'; END IF;
 RETURN gakja.session_receipt_json(c,p->>'key',p->>'inputSha256',true);
END $$;
CREATE FUNCTION gakja.session_lock(p_id text) RETURNS gakja.session_command_sessions LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions;
BEGIN
 PERFORM gakja.session_guard_account();
 SELECT * INTO s FROM gakja.session_command_sessions WHERE owner_id=current_setting('gakja.owner_id',true) AND session_id=p_id FOR UPDATE;
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RAISE EXCEPTION 'session scope denied' USING ERRCODE='42501'; END IF;
 RETURN s;
END $$;
CREATE FUNCTION gakja.session_receipt_by_key(p_id text,p_key text,p_input text) RETURNS jsonb LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; k gakja.session_command_keys; c gakja.session_commands;
BEGIN
 SELECT * INTO s FROM gakja.session_command_sessions WHERE session_id=p_id;
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RETURN NULL; END IF;
 SELECT * INTO k FROM gakja.session_command_keys WHERE owner_id=s.owner_id AND session_id=s.session_id AND key=p_key;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF k.input_sha256 IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
 SELECT * INTO c FROM gakja.session_commands WHERE operation_id=k.operation_id;
 IF c.status<>'committed' THEN RETURN NULL; END IF;
 RETURN gakja.session_receipt_json(c,p_key,p_input,true);
END $$;
CREATE FUNCTION gakja.session_observe_connection_closed(p_id text,p_generation bigint,p_token uuid) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; observed_at timestamptz;
BEGIN
 s:=gakja.session_lock(p_id);
 IF NOT s.created THEN RAISE EXCEPTION 'session not created' USING ERRCODE='P7102'; END IF;
 IF s.writer_generation IS DISTINCT FROM p_generation THEN RAISE EXCEPTION 'connection writer stale' USING ERRCODE='P7103'; END IF;
 SELECT closed_at INTO observed_at FROM gakja.session_connection_closes WHERE owner_id=s.owner_id AND session_id=s.session_id
   AND writer_generation=p_generation AND connection_token=p_token;
 IF NOT FOUND THEN
   INSERT INTO gakja.session_connection_closes(owner_id,session_id,writer_generation,connection_token)
     VALUES(s.owner_id,s.session_id,p_generation,p_token) RETURNING closed_at INTO observed_at;
 END IF;
 RETURN to_jsonb(observed_at);
END $$;
CREATE FUNCTION gakja.session_check_precondition(s gakja.session_command_sessions,p jsonb) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
 IF s.writer<>'db' THEN RAISE EXCEPTION 'session writer frozen' USING ERRCODE='P7104'; END IF;
 IF s.writer_generation::text IS DISTINCT FROM p->>'writerGeneration' OR s.writer_token::text IS DISTINCT FROM p->>'writerToken'
   THEN RAISE EXCEPTION 'session writer stale' USING ERRCODE='P7103'; END IF;
 IF s.revision::text IS DISTINCT FROM p->>'expectedRevision' THEN RAISE EXCEPTION 'session revision conflict' USING ERRCODE='P7102'; END IF;
END $$;
CREATE FUNCTION gakja.session_intent_json(c gakja.session_commands,p jsonb,p_attempt uuid) RETURNS jsonb LANGUAGE sql STABLE
SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('sessionId',c.session_id,'key',p->>'key','kind',c.kind,'inputSha256',p->>'inputSha256','semanticKey',c.semantic_key,'semanticSha256',c.semantic_sha256,
   'expectedRevision',c.expected_revision::text,'writerGeneration',c.writer_generation::text,'writerToken',c.writer_token::text,
   'operationId',c.operation_id::text,'attemptId',p_attempt::text,'operationToken',c.operation_token::text)
$$;
CREATE FUNCTION gakja.session_semantic_receipt(s gakja.session_command_sessions,p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c gakja.session_commands; k gakja.session_command_keys; prior_command gakja.session_commands;
BEGIN
 SELECT command.* INTO c FROM gakja.session_command_semantics sm JOIN gakja.session_commands command USING(owner_id,session_id,operation_id)
   WHERE sm.owner_id=s.owner_id AND sm.session_id=s.session_id AND sm.kind=p->>'kind' AND sm.semantic_key=p->>'semanticKey';
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF c.kind<>'end-accept' AND c.semantic_sha256 IS DISTINCT FROM p->>'semanticSha256'
   THEN RAISE EXCEPTION 'session semantic conflict' USING ERRCODE='P7105'; END IF;
 SELECT * INTO k FROM gakja.session_command_keys WHERE owner_id=s.owner_id AND session_id=s.session_id AND key=p->>'key';
 IF FOUND THEN
   IF k.input_sha256 IS DISTINCT FROM p->>'inputSha256' THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
   IF k.operation_id<>c.operation_id THEN
     SELECT * INTO prior_command FROM gakja.session_commands WHERE operation_id=k.operation_id;
     IF prior_command.status<>'pending' OR prior_command.kind<>c.kind OR prior_command.semantic_key<>c.semantic_key
       OR c.kind<>'end-accept' AND prior_command.semantic_sha256<>c.semantic_sha256 THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
     UPDATE gakja.session_command_keys SET operation_id=c.operation_id WHERE owner_id=s.owner_id AND session_id=s.session_id AND key=k.key;
   END IF;
 ELSE
   INSERT INTO gakja.session_command_keys VALUES(s.owner_id,s.session_id,p->>'key',p->>'inputSha256',c.operation_id);
 END IF;
 RETURN gakja.session_receipt_json(c,p->>'key',p->>'inputSha256',true);
END $$;

CREATE FUNCTION gakja.session_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(OLD)-ARRAY['writer','writer_generation','writer_token','revision','created','session_json','session_sha256']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['writer','writer_generation','writer_token','revision','created','session_json','session_sha256'])
   OR (OLD.created AND NOT NEW.created) OR NEW.revision NOT IN (OLD.revision,OLD.revision+1)
   OR NEW.writer_generation NOT IN (OLD.writer_generation,OLD.writer_generation+1)
   OR ((NEW.writer_token IS DISTINCT FROM OLD.writer_token) IS DISTINCT FROM (NEW.writer_generation=OLD.writer_generation+1))
   OR (NEW.revision=OLD.revision AND NEW.session_json IS DISTINCT FROM OLD.session_json)
   OR (OLD.writer<>'db' AND (NEW.revision<>OLD.revision OR NEW.session_json IS DISTINCT FROM OLD.session_json OR NEW.writer<>OLD.writer))
   OR (EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=OLD.owner_id AND h.session_id=OLD.session_id AND h.committed_revision<=OLD.revision)
       AND NEW.session_json IS DISTINCT FROM OLD.session_json)
   THEN RAISE EXCEPTION 'immutable session snapshot or fence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_snapshot_immutable BEFORE UPDATE ON gakja.session_command_sessions FOR EACH ROW EXECUTE FUNCTION gakja.session_snapshot_immutable();
CREATE FUNCTION gakja.session_command_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status='committed' OR
   (to_jsonb(OLD)-ARRAY['status','expected_revision','writer_generation','writer_token','operation_token','result_json','result_sha256','committed_revision','committed_session_sha256','committed_at']) IS DISTINCT FROM
   (to_jsonb(NEW)-ARRAY['status','expected_revision','writer_generation','writer_token','operation_token','result_json','result_sha256','committed_revision','committed_session_sha256','committed_at'])
   THEN RAISE EXCEPTION 'immutable session command or receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_command_immutable BEFORE UPDATE OR DELETE ON gakja.session_commands FOR EACH ROW EXECUTE FUNCTION gakja.session_command_immutable();
CREATE FUNCTION gakja.session_fact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable session fact' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['session_command_semantics','session_command_attempts','session_mandatory_events','session_answer_facts','session_end_intents','session_evaluation_handoffs','session_connection_closes'] LOOP
   EXECUTE format('CREATE TRIGGER session_fact_immutable BEFORE UPDATE OR DELETE ON gakja.%I FOR EACH ROW EXECUTE FUNCTION gakja.session_fact_immutable()',t);
 END LOOP;
END $$;
CREATE FUNCTION gakja.session_alias_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE before_command gakja.session_commands; after_command gakja.session_commands;
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-'operation_id') IS DISTINCT FROM (to_jsonb(NEW)-'operation_id')
   THEN RAISE EXCEPTION 'immutable session key' USING ERRCODE='23514'; END IF;
 SELECT * INTO before_command FROM gakja.session_commands WHERE operation_id=OLD.operation_id;
 SELECT * INTO after_command FROM gakja.session_commands WHERE operation_id=NEW.operation_id;
 IF before_command.status<>'pending' OR after_command.status<>'committed' OR before_command.owner_id<>after_command.owner_id OR before_command.session_id<>after_command.session_id
   OR before_command.kind<>after_command.kind OR before_command.semantic_key<>after_command.semantic_key
   OR after_command.kind<>'end-accept' AND before_command.semantic_sha256<>after_command.semantic_sha256
   THEN RAISE EXCEPTION 'invalid committed semantic alias' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER session_alias_immutable BEFORE UPDATE OR DELETE ON gakja.session_command_keys FOR EACH ROW EXECUTE FUNCTION gakja.session_alias_immutable();
CREATE FUNCTION gakja.session_complete_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.created AND NOT EXISTS(SELECT 1 FROM gakja.session_bindings b WHERE b.owner_id=NEW.owner_id AND b.session_id=NEW.session_id
   AND b.student_id=NEW.student_id AND b.application_target_id=NEW.application_target_id AND b.support_target_id=NEW.support_target_id
   AND b.context_snapshot_sha256=NEW.context_sha256 AND b.frozen_source_sha256=NEW.source_sha256
   AND b.source_present=NEW.source_present AND b.source_revision IS NOT DISTINCT FROM NEW.source_revision)
   THEN RAISE EXCEPTION 'created session binding incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER session_complete_binding AFTER INSERT OR UPDATE ON gakja.session_command_sessions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gakja.session_complete_binding();
CREATE FUNCTION gakja.session_begin(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; c gakja.session_commands; k gakja.session_command_keys; receipt jsonb; attempt uuid;
BEGIN
 s:=gakja.session_lock(p->>'sessionId');
 receipt:=gakja.session_receipt(p); IF receipt IS NOT NULL THEN RETURN jsonb_build_object('status','committed','receipt',receipt); END IF;
 receipt:=gakja.session_semantic_receipt(s,p); IF receipt IS NOT NULL THEN RETURN jsonb_build_object('status','committed','receipt',receipt); END IF;
 PERFORM gakja.session_check_precondition(s,p);
 IF p->>'kind' NOT IN ('event','closing') AND EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id)
   THEN RAISE EXCEPTION 'session input frozen' USING ERRCODE='P7104'; END IF;
 IF (p->>'kind'='create')=s.created THEN RAISE EXCEPTION 'session create state conflict' USING ERRCODE='P7102'; END IF;
 IF p->>'kind'='end-finalize' AND NOT EXISTS(SELECT 1 FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id)
   THEN RAISE EXCEPTION 'end intent required before finalization' USING ERRCODE='P7102'; END IF;
 IF EXISTS(SELECT 1 FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id) AND p->>'kind' NOT IN ('end-accept','end-finalize','recover','event','closing')
   THEN RAISE EXCEPTION 'session end accepted' USING ERRCODE='P7104'; END IF;
 SELECT * INTO k FROM gakja.session_command_keys WHERE owner_id=s.owner_id AND session_id=s.session_id AND key=p->>'key';
 IF FOUND THEN
   SELECT * INTO c FROM gakja.session_commands WHERE operation_id=k.operation_id;
   IF k.input_sha256 IS DISTINCT FROM p->>'inputSha256' OR c.kind IS DISTINCT FROM p->>'kind' OR c.semantic_key IS DISTINCT FROM p->>'semanticKey'
     OR c.semantic_sha256 IS DISTINCT FROM p->>'semanticSha256' THEN RAISE EXCEPTION 'session input mismatch' USING ERRCODE='P7101'; END IF;
   IF c.writer_generation<>s.writer_generation OR c.writer_token<>s.writer_token THEN
     IF coalesce((p->>'resume')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'session writer stale' USING ERRCODE='P7103'; END IF;
     UPDATE gakja.session_commands SET writer_generation=s.writer_generation,writer_token=s.writer_token,expected_revision=s.revision,operation_token=gen_random_uuid()
       WHERE operation_id=c.operation_id RETURNING * INTO c;
   ELSIF c.expected_revision<>s.revision THEN RAISE EXCEPTION 'session revision conflict' USING ERRCODE='P7102'; END IF;
 ELSE
   INSERT INTO gakja.session_commands(owner_id,session_id,original_key,kind,input_sha256,semantic_key,semantic_sha256,expected_revision,writer_generation,writer_token)
     VALUES(s.owner_id,s.session_id,p->>'key',p->>'kind',p->>'inputSha256',p->>'semanticKey',p->>'semanticSha256',s.revision,s.writer_generation,s.writer_token) RETURNING * INTO c;
   INSERT INTO gakja.session_command_keys VALUES(s.owner_id,s.session_id,c.original_key,c.input_sha256,c.operation_id);
 END IF;
 INSERT INTO gakja.session_command_attempts(owner_id,session_id,operation_id,operation_token,writer_generation,writer_token,started_revision)
   VALUES(s.owner_id,s.session_id,c.operation_id,c.operation_token,c.writer_generation,c.writer_token,c.expected_revision) RETURNING attempt_id INTO attempt;
 RETURN jsonb_build_object('status','pending','intent',gakja.session_intent_json(c,p,attempt),'snapshot',gakja.session_snapshot_json(s));
END $$;

CREATE FUNCTION gakja.session_store_events(s gakja.session_command_sessions,c gakja.session_commands,p jsonb,p_revision bigint) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event jsonb;
BEGIN
 IF jsonb_typeof(p)<>'array' OR jsonb_array_length(p) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'session required events invalid' USING ERRCODE='22023'; END IF;
 FOR event IN SELECT * FROM jsonb_array_elements(p) LOOP
   IF NOT gakja.is_trimmed_identifier(event->>'eventId') OR length(event->>'eventId')>160 OR NOT gakja.is_trimmed_identifier(event->>'kind') OR length(event->>'kind')>128
     OR event->>'payloadJson' IS NULL OR octet_length(event->>'payloadJson')>1048576 THEN RAISE EXCEPTION 'session event invalid' USING ERRCODE='22023'; END IF;
   PERFORM (event->>'payloadJson')::json;
   INSERT INTO gakja.session_mandatory_events VALUES(s.owner_id,s.session_id,event->>'eventId',event->>'kind',event->>'payloadJson',gakja.session_text_sha(event->>'payloadJson'),c.operation_id,p_revision);
 END LOOP;
END $$;
CREATE FUNCTION gakja.session_validate_intent(s gakja.session_command_sessions,p jsonb) RETURNS gakja.session_commands LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c gakja.session_commands;
BEGIN
 PERFORM gakja.session_check_precondition(s,p);
 SELECT * INTO c FROM gakja.session_commands WHERE owner_id=s.owner_id AND session_id=s.session_id AND operation_id=(p->>'operationId')::uuid FOR UPDATE;
 IF NOT FOUND OR c.status<>'pending' OR c.operation_token::text IS DISTINCT FROM p->>'operationToken'
   OR c.writer_generation<>s.writer_generation OR c.writer_token<>s.writer_token OR c.expected_revision<>s.revision
   OR c.kind IS DISTINCT FROM p->>'kind' OR c.semantic_key IS DISTINCT FROM p->>'semanticKey' OR c.semantic_sha256 IS DISTINCT FROM p->>'semanticSha256'
   OR c.input_sha256 IS DISTINCT FROM p->>'inputSha256' OR c.original_key IS DISTINCT FROM p->>'key'
   OR NOT EXISTS(SELECT 1 FROM gakja.session_command_attempts a WHERE a.operation_id=c.operation_id AND a.attempt_id=(p->>'attemptId')::uuid
     AND a.operation_token=c.operation_token AND a.writer_generation=s.writer_generation AND a.writer_token=s.writer_token)
   THEN RAISE EXCEPTION 'session operation stale' USING ERRCODE='P7103'; END IF;
 IF c.kind NOT IN ('event','closing') AND EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id)
   THEN RAISE EXCEPTION 'session input frozen' USING ERRCODE='P7104'; END IF;
 IF EXISTS(SELECT 1 FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id) AND c.kind NOT IN ('end-accept','end-finalize','recover','event','closing')
   THEN RAISE EXCEPTION 'session end accepted' USING ERRCODE='P7104'; END IF;
 RETURN c;
END $$;
CREATE FUNCTION gakja.session_submission_check(p_before text,p_after text,p_kind text,p_final boolean) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
DECLARE before_records jsonb:=coalesce((p_before::json->'runtime'->'submissionAttempts')::jsonb,'{}'::jsonb);
 after_records jsonb:=coalesce((p_after::json->'runtime'->'submissionAttempts')::jsonb,'{}'::jsonb);
 entry record; prior jsonb; newer jsonb; started timestamptz; deadline timestamptz; current_turn json; scope_key text;
BEGIN
 IF jsonb_typeof(before_records)<>'object' OR jsonb_typeof(after_records)<>'object' THEN RAISE EXCEPTION 'submission records invalid' USING ERRCODE='22023'; END IF;
 FOR entry IN SELECT * FROM jsonb_each(before_records) LOOP
   newer:=after_records->entry.key;
   IF newer IS NULL OR (entry.value-'status') IS DISTINCT FROM (newer-'status')
     OR entry.value->>'status' IN ('expired','cancelled','completed') AND newer->>'status' IS DISTINCT FROM entry.value->>'status'
     THEN RAISE EXCEPTION 'submission deadline identity immutable' USING ERRCODE='P7102'; END IF;
 END LOOP;
 FOR entry IN SELECT * FROM jsonb_each(after_records) LOOP
   newer:=entry.value;prior:=before_records->entry.key;
   IF newer->>'status' NOT IN ('running','expired','cancelled','completed') OR coalesce(newer->>'attemptId','') !~ '^[a-f0-9-]{36}$'
     OR coalesce(newer->>'captureRevision','') !~ '^[1-9][0-9]*$' OR coalesce(newer->>'epoch','') !~ '^\d+$'
     OR entry.key IS DISTINCT FROM (newer->>'turnId')||':'||(newer->>'answerId')||':'||(newer->>'captureRevision')
     THEN RAISE EXCEPTION 'submission scope invalid' USING ERRCODE='22023'; END IF;
   started:=(newer->>'startedAt')::timestamptz;deadline:=(newer->>'deadlineAt')::timestamptz;
   IF started IS NULL OR deadline IS NULL OR deadline<=started OR deadline-started>interval '95 seconds'
     THEN RAISE EXCEPTION 'submission time budget invalid' USING ERRCODE='22023'; END IF;
   IF prior IS NULL AND (started>clock_timestamp()+interval '2 seconds' OR started<clock_timestamp()-interval '95 seconds'
     OR newer->>'epoch' IS DISTINCT FROM p_after::json->'runtime'->>'epoch')
     THEN RAISE EXCEPTION 'submission start must use current server budget' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_final AND p_kind IN ('answer','next') THEN
   current_turn:=p_before::json->'turns'->-1;
   scope_key:=(current_turn->>'id')||':'||(current_turn->>'answerId')||':'||(current_turn->'metadata'->>'answerCaptureRevision');
   newer:=coalesce(after_records->scope_key,before_records->scope_key);
   IF newer IS NOT NULL THEN
     IF newer->>'status'='cancelled' THEN RAISE EXCEPTION 'submission cancelled' USING ERRCODE='P7107'; END IF;
     IF newer->>'status'='expired' OR clock_timestamp()>=(newer->>'deadlineAt')::timestamptz
       THEN RAISE EXCEPTION 'submission time budget expired' USING ERRCODE='P7106'; END IF;
   END IF;
 END IF;
END $$;
CREATE FUNCTION gakja.session_progress(p jsonb,v jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; c gakja.session_commands; receipt jsonb;
BEGIN
 s:=gakja.session_lock(p->>'sessionId');receipt:=gakja.session_receipt(p);
 IF receipt IS NOT NULL THEN RETURN jsonb_build_object('status','committed','receipt',receipt); END IF;
 c:=gakja.session_validate_intent(s,p);
 PERFORM gakja.session_document_check(v->>'sessionJson',s.session_id,s.owner_id,s.context_sha256);
 PERFORM gakja.session_submission_check(s.session_json,v->>'sessionJson',c.kind,false);
 IF c.kind IN ('create','next') AND json_array_length((v->>'sessionJson')::json->'turns')>json_array_length(s.session_json::json->'turns')
   THEN RAISE EXCEPTION 'new question requires final command receipt' USING ERRCODE='P7102'; END IF;
 IF c.kind='event' AND EXISTS(SELECT 1 FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id) AND v->>'sessionJson' IS DISTINCT FROM s.session_json
   THEN RAISE EXCEPTION 'late event cannot alter accepted end snapshot' USING ERRCODE='P7104'; END IF;
 IF c.kind='closing' AND EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id) AND v->>'sessionJson' IS DISTINCT FROM s.session_json
   THEN RAISE EXCEPTION 'frozen closing cannot alter session snapshot' USING ERRCODE='P7104'; END IF;
 IF c.kind='closing' AND ((v->>'sessionJson')::json->'runtime'->>'epoch')::bigint NOT IN ((s.session_json::json->'runtime'->>'epoch')::bigint,(s.session_json::json->'runtime'->>'epoch')::bigint+1)
   OR c.kind<>'closing' AND (v->>'sessionJson')::json->'runtime'->>'epoch' IS DISTINCT FROM s.session_json::json->'runtime'->>'epoch'
   THEN RAISE EXCEPTION 'runtime epoch only changes at recovery commit' USING ERRCODE='P7102'; END IF;
 PERFORM gakja.session_store_events(s,c,v->'events',s.revision+1);
 UPDATE gakja.session_command_sessions SET revision=revision+1,session_json=v->>'sessionJson',session_sha256=gakja.session_text_sha(v->>'sessionJson') WHERE owner_id=s.owner_id AND session_id=s.session_id RETURNING * INTO s;
 UPDATE gakja.session_commands SET expected_revision=s.revision WHERE operation_id=c.operation_id RETURNING * INTO c;
 RETURN jsonb_build_object('status','pending','intent',gakja.session_intent_json(c,p,(p->>'attemptId')::uuid),'snapshot',gakja.session_snapshot_json(s));
END $$;
CREATE FUNCTION gakja.session_commit(p jsonb,v jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; c gakja.session_commands; receipt jsonb; fact jsonb; prior_fact gakja.session_answer_facts; rotate boolean:=coalesce((v->>'rotateWriter')::boolean,false); handoff jsonb; ending jsonb;
BEGIN
 s:=gakja.session_lock(p->>'sessionId');receipt:=gakja.session_receipt(p);IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 receipt:=gakja.session_semantic_receipt(s,p);IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 c:=gakja.session_validate_intent(s,p);
 PERFORM gakja.session_document_check(v->>'sessionJson',s.session_id,s.owner_id,s.context_sha256);PERFORM (v->>'resultJson')::json;
 PERFORM gakja.session_submission_check(s.session_json,v->>'sessionJson',c.kind,true);
 IF c.kind='event' AND EXISTS(SELECT 1 FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id) AND v->>'sessionJson' IS DISTINCT FROM s.session_json
   THEN RAISE EXCEPTION 'late event cannot alter accepted end snapshot' USING ERRCODE='P7104'; END IF;
 IF c.kind='closing' AND EXISTS(SELECT 1 FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id) AND v->>'sessionJson' IS DISTINCT FROM s.session_json
   THEN RAISE EXCEPTION 'frozen closing cannot alter session snapshot' USING ERRCODE='P7104'; END IF;
 IF octet_length(v->>'resultJson') NOT BETWEEN 1 AND 16777216 THEN RAISE EXCEPTION 'result size invalid' USING ERRCODE='22023'; END IF;
 IF rotate<>(c.kind='recover') OR c.kind<>'closing' AND (v->>'sessionJson')::json->'runtime'->>'epoch' IS DISTINCT FROM
   (CASE WHEN c.kind IN ('recover','end-finalize') THEN ((s.session_json::json->'runtime'->>'epoch')::bigint+1)::text ELSE s.session_json::json->'runtime'->>'epoch' END)
   OR c.kind='closing' AND ((v->>'sessionJson')::json->'runtime'->>'epoch')::bigint NOT IN ((s.session_json::json->'runtime'->>'epoch')::bigint,(s.session_json::json->'runtime'->>'epoch')::bigint+1)
   THEN RAISE EXCEPTION 'runtime recovery epoch invalid' USING ERRCODE='P7102'; END IF;
 IF v?'answerFact' THEN
   fact:=v->'answerFact'; SELECT * INTO prior_fact FROM gakja.session_answer_facts WHERE owner_id=s.owner_id AND session_id=s.session_id
     AND turn_id=fact->>'turnId' AND answer_id=fact->>'answerId' AND capture_revision=(fact->>'captureRevision')::bigint;
   IF FOUND AND prior_fact.input_sha256 IS DISTINCT FROM fact->>'inputSha256' THEN RAISE EXCEPTION 'answer revision conflict' USING ERRCODE='P7105'; END IF;
   IF NOT FOUND THEN INSERT INTO gakja.session_answer_facts VALUES(s.owner_id,s.session_id,fact->>'turnId',fact->>'answerId',(fact->>'captureRevision')::bigint,fact->>'inputSha256',c.operation_id,s.revision+1); END IF;
 END IF;
 IF (c.kind='end-accept') IS DISTINCT FROM (v?'endIntent') OR (c.kind='end-finalize') IS DISTINCT FROM (v?'handoff')
   THEN RAISE EXCEPTION 'end atomic records required' USING ERRCODE='22023'; END IF;
 IF v?'endIntent' THEN
   ending:=v->'endIntent';PERFORM (ending->>'inputJson')::json;
   INSERT INTO gakja.session_end_intents VALUES(s.owner_id,s.session_id,(ending->>'intentId')::uuid,ending->>'inputJson',ending->>'inputSha256',s.revision+1,clock_timestamp(),c.operation_id);
 END IF;
 IF v?'handoff' THEN
   handoff:=v->'handoff';PERFORM (handoff->>'payloadJson')::json;
   IF handoff->>'frozenSessionSha256' IS DISTINCT FROM gakja.session_text_sha(v->>'sessionJson') THEN RAISE EXCEPTION 'frozen session pin mismatch' USING ERRCODE='22023'; END IF;
   INSERT INTO gakja.session_evaluation_handoffs(owner_id,session_id,intent_id,payload_json,payload_sha256,context_sha256,frozen_session_sha256,committed_revision,operation_id)
     VALUES(s.owner_id,s.session_id,(handoff->>'intentId')::uuid,handoff->>'payloadJson',handoff->>'payloadSha256',s.context_sha256,handoff->>'frozenSessionSha256',s.revision+1,c.operation_id);
 END IF;
 PERFORM gakja.session_store_events(s,c,v->'events',s.revision+1);
 UPDATE gakja.session_command_sessions SET revision=revision+1,created=created OR c.kind='create',session_json=v->>'sessionJson',session_sha256=gakja.session_text_sha(v->>'sessionJson'),
   writer_generation=writer_generation+CASE WHEN rotate THEN 1 ELSE 0 END,writer_token=CASE WHEN rotate THEN gen_random_uuid() ELSE writer_token END
   WHERE owner_id=s.owner_id AND session_id=s.session_id RETURNING * INTO s;
 IF c.kind='create' THEN
   INSERT INTO gakja.session_bindings(owner_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,context_snapshot_sha256,frozen_source_sha256)
     VALUES(s.owner_id,s.session_id,s.student_id,s.application_target_id,s.support_target_id,s.source_present,s.source_revision,s.context_sha256,s.source_sha256);
 END IF;
 UPDATE gakja.session_commands SET status='committed',writer_generation=s.writer_generation,result_json=v->>'resultJson',result_sha256=gakja.session_text_sha(v->>'resultJson'),
   committed_revision=s.revision,committed_session_sha256=s.session_sha256,committed_at=clock_timestamp() WHERE operation_id=c.operation_id RETURNING * INTO c;
 INSERT INTO gakja.session_command_semantics VALUES(s.owner_id,s.session_id,c.kind,c.semantic_key,c.operation_id);
 RETURN gakja.session_receipt_json(c,p->>'key',p->>'inputSha256',false);
END $$;

CREATE FUNCTION gakja.session_fence(p jsonb,p_mode text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions;
BEGIN
 s:=gakja.session_lock(p->>'sessionId');PERFORM gakja.session_check_precondition(s,p);
 IF p_mode NOT IN ('claim','freeze','local') THEN RAISE EXCEPTION 'writer mode invalid' USING ERRCODE='22023'; END IF;
 IF p_mode='local' AND (s.created OR s.revision<>0 OR EXISTS(SELECT 1 FROM gakja.session_commands c WHERE c.owner_id=s.owner_id AND c.session_id=s.session_id AND c.status='committed'))
   THEN RAISE EXCEPTION 'committed authenticated session cannot become local' USING ERRCODE='P7104'; END IF;
 UPDATE gakja.session_command_sessions SET writer=CASE p_mode WHEN 'freeze' THEN 'read-only' WHEN 'local' THEN 'local' ELSE 'db' END,
   writer_generation=writer_generation+1,writer_token=gen_random_uuid() WHERE owner_id=s.owner_id AND session_id=s.session_id RETURNING * INTO s;
 RETURN gakja.session_snapshot_json(s);
END $$;

-- Immutable event/receipt/end/handoff facts are retained through freeze. Export
-- preserves every exact text field, operation/attempt ID and committed revision.
CREATE FUNCTION gakja.session_export(p_id text) RETURNS jsonb LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions;
BEGIN
 SELECT * INTO s FROM gakja.session_command_sessions WHERE session_id=p_id;
 IF NOT FOUND OR NOT gakja.session_can_read(s) THEN RETURN NULL; END IF;
 IF s.writer<>'read-only' THEN RAISE EXCEPTION 'freeze before preservation' USING ERRCODE='P7104'; END IF;
 RETURN jsonb_build_object('version','session-preservation-payload-v1','session',to_jsonb(s)||jsonb_build_object('writer_generation',s.writer_generation::text,'revision',s.revision::text),
   'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('expected_revision',c.expected_revision::text,'writer_generation',c.writer_generation::text,'committed_revision',c.committed_revision::text) ORDER BY c.operation_id),'[]'::jsonb) FROM gakja.session_commands c WHERE c.owner_id=s.owner_id AND c.session_id=s.session_id),
   'keys',(SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.key),'[]'::jsonb) FROM gakja.session_command_keys k WHERE k.owner_id=s.owner_id AND k.session_id=s.session_id),
   'semantics',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.kind,m.semantic_key),'[]'::jsonb) FROM gakja.session_command_semantics m WHERE m.owner_id=s.owner_id AND m.session_id=s.session_id),
   'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('writer_generation',a.writer_generation::text,'started_revision',a.started_revision::text) ORDER BY a.attempt_id),'[]'::jsonb) FROM gakja.session_command_attempts a WHERE a.owner_id=s.owner_id AND a.session_id=s.session_id),
   'events',(SELECT coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('revision',e.revision::text) ORDER BY e.revision,e.event_id),'[]'::jsonb) FROM gakja.session_mandatory_events e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id),
   'answers',(SELECT coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('capture_revision',a.capture_revision::text,'revision',a.revision::text) ORDER BY a.turn_id,a.answer_id,a.capture_revision),'[]'::jsonb) FROM gakja.session_answer_facts a WHERE a.owner_id=s.owner_id AND a.session_id=s.session_id),
   'endIntents',(SELECT coalesce(jsonb_agg(to_jsonb(e)||jsonb_build_object('accepted_revision',e.accepted_revision::text)),'[]'::jsonb) FROM gakja.session_end_intents e WHERE e.owner_id=s.owner_id AND e.session_id=s.session_id),
   'handoffs',(SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('committed_revision',h.committed_revision::text)),'[]'::jsonb) FROM gakja.session_evaluation_handoffs h WHERE h.owner_id=s.owner_id AND h.session_id=s.session_id),
   'connectionCloses',(SELECT coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('writer_generation',o.writer_generation::text) ORDER BY o.writer_generation,o.connection_token),'[]'::jsonb) FROM gakja.session_connection_closes o WHERE o.owner_id=s.owner_id AND o.session_id=s.session_id));
END $$;
CREATE FUNCTION gakja.session_restore(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.session_command_sessions; t text; field text;
BEGIN
 PERFORM gakja.session_guard_account();
 IF p->>'version'<>'session-preservation-payload-v1' THEN RAISE EXCEPTION 'preservation version invalid' USING ERRCODE='22023'; END IF;
 s:=jsonb_populate_record(NULL::gakja.session_command_sessions,p->'session');
 IF s.writer<>'read-only' OR s.owner_id<>current_setting('gakja.owner_id',true) OR s.student_id<>current_setting('gakja.student_id',true)
   OR s.application_target_id<>current_setting('gakja.application_target_id',true) OR NOT gakja.session_can_read(s)
   THEN RAISE EXCEPTION 'preservation scope denied' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM gakja.session_command_sessions WHERE session_id=s.session_id) OR EXISTS(SELECT 1 FROM gakja.session_bindings WHERE session_id=s.session_id)
   THEN RAISE EXCEPTION 'restore requires absent isolated session' USING ERRCODE='P7102'; END IF;
 PERFORM gakja.session_document_check(s.session_json,s.session_id,s.owner_id,s.context_sha256);
 INSERT INTO gakja.session_command_sessions SELECT s.*;
 -- Every child row must belong to this exact immutable parent scope, checked
 -- before any insertion and again by composite FKs. No arbitrary table name.
 FOREACH field IN ARRAY ARRAY['commands','keys','semantics','attempts','events','answers','endIntents','handoffs','connectionCloses'] LOOP
   IF jsonb_typeof(p->field)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->field) r WHERE r->>'owner_id' IS DISTINCT FROM s.owner_id OR r->>'session_id' IS DISTINCT FROM s.session_id)
     THEN RAISE EXCEPTION 'preservation child scope invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 INSERT INTO gakja.session_commands SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_commands,p->'commands');
 INSERT INTO gakja.session_command_keys SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_command_keys,p->'keys');
 INSERT INTO gakja.session_command_semantics SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_command_semantics,p->'semantics');
 INSERT INTO gakja.session_command_attempts SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_command_attempts,p->'attempts');
 INSERT INTO gakja.session_mandatory_events SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_mandatory_events,p->'events');
 INSERT INTO gakja.session_answer_facts SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_answer_facts,p->'answers');
 INSERT INTO gakja.session_end_intents SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_end_intents,p->'endIntents');
 INSERT INTO gakja.session_evaluation_handoffs SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_evaluation_handoffs,p->'handoffs');
 INSERT INTO gakja.session_connection_closes SELECT * FROM jsonb_populate_recordset(NULL::gakja.session_connection_closes,p->'connectionCloses');
 IF s.created THEN INSERT INTO gakja.session_bindings(owner_id,session_id,student_id,application_target_id,support_target_id,source_present,source_revision,context_snapshot_sha256,frozen_source_sha256)
   VALUES(s.owner_id,s.session_id,s.student_id,s.application_target_id,s.support_target_id,s.source_present,s.source_revision,s.context_sha256,s.source_sha256); END IF;
 RETURN gakja.session_snapshot_json(s);
END $$;

-- Request credentials can invoke finite domain commands, never table UPDATE.
-- Enrollment/restore additionally require a server-minted finite TS capability
-- and the separate mapping role. Ordinary service DTOs cannot mint that object.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['session_command_sessions','session_commands','session_command_keys','session_command_semantics','session_command_attempts','session_mandatory_events','session_answer_facts','session_end_intents','session_evaluation_handoffs','session_connection_closes'] LOOP
   EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY session_owner_management ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',t);
   EXECUTE format('REVOKE ALL ON gakja.%I FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',t);
 END LOOP;
END $$;
CREATE POLICY session_request_read ON gakja.session_command_sessions FOR SELECT TO gakja_request
  USING(gakja.session_can_read(session_command_sessions));
GRANT SELECT ON gakja.session_command_sessions TO gakja_request;
REVOKE ALL ON FUNCTION gakja.session_text_sha(text),gakja.session_can_read(gakja.session_command_sessions),gakja.session_guard_account(),gakja.session_document_check(text,text,text,text),gakja.session_snapshot_json(gakja.session_command_sessions),
 gakja.session_read(text),gakja.session_list(),gakja.session_find_creation(text,text),gakja.session_enroll(jsonb),gakja.session_receipt_json(gakja.session_commands,text,text,boolean),gakja.session_receipt(jsonb),gakja.session_find_committed(jsonb),gakja.session_receipt_by_key(text,text,text),gakja.session_lock(text),gakja.session_observe_connection_closed(text,bigint,uuid),gakja.session_check_precondition(gakja.session_command_sessions,jsonb),
 gakja.session_intent_json(gakja.session_commands,jsonb,uuid),gakja.session_semantic_receipt(gakja.session_command_sessions,jsonb),gakja.session_begin(jsonb),gakja.session_store_events(gakja.session_command_sessions,gakja.session_commands,jsonb,bigint),
 gakja.session_validate_intent(gakja.session_command_sessions,jsonb),gakja.session_submission_check(text,text,text,boolean),gakja.session_progress(jsonb,jsonb),gakja.session_commit(jsonb,jsonb),gakja.session_fence(jsonb,text),gakja.session_export(text),gakja.session_restore(jsonb)
 FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.session_can_read(gakja.session_command_sessions),gakja.session_read(text),gakja.session_list(),gakja.session_find_creation(text,text),gakja.session_receipt(jsonb),gakja.session_find_committed(jsonb),gakja.session_receipt_by_key(text,text,text),gakja.session_observe_connection_closed(text,bigint,uuid),gakja.session_begin(jsonb),gakja.session_progress(jsonb,jsonb),gakja.session_commit(jsonb,jsonb),gakja.session_fence(jsonb,text),gakja.session_export(text) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.session_enroll(jsonb),gakja.session_restore(jsonb) TO gakja_mapping;

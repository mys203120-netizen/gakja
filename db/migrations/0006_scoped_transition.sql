-- PR07-G: append-only migration; earlier migration bytes/checkpoints stay intact.
CREATE TABLE gakja.scoped_transitions (
 transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id text NOT NULL REFERENCES gakja.accounts(account_id),
 owner_id text NOT NULL,student_id text NOT NULL,application_target_id text NOT NULL,support_target_id text NOT NULL,
 source_present boolean NOT NULL,source_revision text,
 state text NOT NULL DEFAULT 'unprepared' CHECK(state IN('unprepared','blocking','verified','db-primary','frozen','restoring','read-only-recovery','local-primary')),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),fence bigint NOT NULL DEFAULT 0 CHECK(fence>=0),expires_at timestamptz CHECK(expires_at IS NULL OR isfinite(expires_at)),
 local_evidence_json text,local_evidence_sha256 text,verification_json text,verification_sha256 text,
 checkpoint_json text,checkpoint_sha256 text,recovery_manifest_sha256 text,primary_generation bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,student_id,application_target_id),
 FOREIGN KEY(owner_id,student_id,application_target_id,support_target_id) REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
 CHECK(source_present OR source_revision IS NULL),CHECK(source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)),
 CHECK(local_evidence_sha256 IS NULL OR local_evidence_sha256=gakja.session_text_sha(local_evidence_json)),
 CHECK(verification_sha256 IS NULL OR verification_sha256=gakja.session_text_sha(verification_json)),
 CHECK(checkpoint_sha256 IS NULL OR checkpoint_sha256=gakja.session_text_sha(checkpoint_json))
);
CREATE TABLE gakja.transition_operator_grants (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),issuer text NOT NULL,subject text NOT NULL,
 actions text[] NOT NULL,expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(transition_id,issuer,subject), FOREIGN KEY(issuer,subject) REFERENCES gakja.principals(issuer,subject),
 CHECK(cardinality(actions)>0 AND actions<@ARRAY['prepare','verify','activate','freeze','rollback-empty','recover','status','export','restore','register-input']::text[])
);
CREATE TABLE gakja.transition_operator_installations (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),key text NOT NULL,input_sha256 text NOT NULL,grant_json text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(transition_id,key)
);
CREATE TABLE gakja.transition_commands (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),key text NOT NULL,operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
 action text NOT NULL,input_sha256 text NOT NULL,result_json text NOT NULL,result_sha256 text NOT NULL,
 committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(transition_id,key),UNIQUE(operation_id),
 CHECK(result_sha256=gakja.session_text_sha(result_json))
);
CREATE TABLE gakja.transition_history (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),event_id bigserial PRIMARY KEY,kind text NOT NULL,
 generation bigint NOT NULL,payload_json text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE gakja.transition_active_operations (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),operation_id text NOT NULL,generation bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN('http','wss','capture','provider','worker','cli')),issuer text NOT NULL,subject text NOT NULL,session_id text,
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),outcome text CHECK(outcome IN('completed','failed','cancelled','fenced')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,PRIMARY KEY(transition_id,operation_id)
);
CREATE TABLE gakja.transition_session_bindings (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),session_id text NOT NULL UNIQUE,
 generation bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(transition_id,session_id),
 FOREIGN KEY(session_id) REFERENCES gakja.session_command_sessions(session_id)
);
CREATE TABLE gakja.transition_write_facts (
 transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),fact_id bigserial PRIMARY KEY,generation bigint NOT NULL,
 kind text NOT NULL,operation_id text,session_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION gakja.transition_current() RETURNS gakja.scoped_transitions LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;g gakja.access_grants;
BEGIN
 g:=gakja.evaluation_current_grant();
 SELECT * INTO s FROM gakja.scoped_transitions WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id;
 IF FOUND AND (s.account_id<>g.account_id OR s.support_target_id<>g.support_target_id OR s.source_present<>g.source_present OR s.source_revision IS DISTINCT FROM g.source_revision)
 THEN RAISE EXCEPTION 'transition binding changed' USING ERRCODE='P7303';END IF;
 RETURN s;
END $$;
CREATE FUNCTION gakja.transition_scope_json(s gakja.scoped_transitions) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('ownerId',s.owner_id,'studentId',s.student_id,'applicationTargetId',s.application_target_id,'supportTargetId',s.support_target_id)||CASE WHEN s.source_present THEN jsonb_build_object('sourceRevision',s.source_revision) ELSE '{}'::jsonb END
$$;
CREATE FUNCTION gakja.transition_snapshot(s gakja.scoped_transitions) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version','scoped-transition-state-v1','transitionId',s.transition_id,'scope',gakja.transition_scope_json(s),'state',s.state,
 'generation',s.generation::text,'fence',s.fence::text,'serverNow',clock_timestamp(),'scopeExpiresAt',s.expires_at,
 'localEvidenceJson',s.local_evidence_json,'localEvidenceSha256',s.local_evidence_sha256,'verificationJson',s.verification_json,'verificationSha256',s.verification_sha256,
 'checkpointJson',s.checkpoint_json,'checkpointSha256',s.checkpoint_sha256,'recoveryManifestSha256',s.recovery_manifest_sha256,'primaryGeneration',s.primary_generation::text,
 'operationId',NULL,'activeOperations',(SELECT count(*) FROM gakja.transition_active_operations WHERE transition_id=s.transition_id AND finished_at IS NULL AND expires_at>clock_timestamp()),
 'writeFacts',(SELECT count(*) FROM gakja.transition_write_facts WHERE transition_id=s.transition_id))
$$;
CREATE FUNCTION gakja.transition_read() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;BEGIN s:=gakja.transition_current();IF s.transition_id IS NULL THEN RETURN NULL;END IF;RETURN gakja.transition_snapshot(s);END $$;
CREATE FUNCTION gakja.transition_require_operator(p_action text) RETURNS gakja.scoped_transitions LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;
BEGIN
 s:=gakja.transition_current();IF s.transition_id IS NULL THEN RAISE EXCEPTION 'transition missing' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR UPDATE;
 PERFORM 1 FROM gakja.transition_operator_grants WHERE transition_id=s.transition_id AND issuer=current_setting('gakja.issuer',true) AND subject=current_setting('gakja.subject',true)
  AND active AND expires_at>clock_timestamp() AND p_action=ANY(actions) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'finite transition operator required' USING ERRCODE='42501';END IF;RETURN s;
END $$;
CREATE FUNCTION gakja.transition_authorize_operator(p_action text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;BEGIN s:=gakja.transition_require_operator(p_action);RETURN gakja.transition_snapshot(s);END $$;
CREATE FUNCTION gakja.transition_guard(p_operation text,p_session text DEFAULT NULL,p_replay boolean DEFAULT false) RETURNS gakja.scoped_transitions LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;a gakja.transition_active_operations;
BEGIN
 IF p_operation NOT IN('read','admit','session-write','review-write','worker-write') THEN RAISE EXCEPTION 'invalid transition operation' USING ERRCODE='22023';END IF;
 s:=gakja.transition_current();IF s.transition_id IS NULL THEN RETURN s;END IF;
 SELECT * INTO s FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR SHARE;
 IF p_operation='read' OR p_replay THEN RETURN s;END IF;
 IF current_setting('gakja.transition_mode',true) IS DISTINCT FROM 'service-g' OR current_setting('gakja.transition_id',true) IS DISTINCT FROM s.transition_id::text
  OR current_setting('gakja.transition_generation',true) IS DISTINCT FROM s.generation::text OR s.state<>'db-primary' OR s.expires_at<=clock_timestamp() OR s.expires_at IS NULL
 THEN RAISE EXCEPTION 'transition generation fenced' USING ERRCODE='P7303';END IF;
 SELECT * INTO a FROM gakja.transition_active_operations WHERE transition_id=s.transition_id AND operation_id=current_setting('gakja.transition_operation',true) AND generation=s.generation
  AND issuer=current_setting('gakja.issuer',true) AND subject=current_setting('gakja.subject',true) AND finished_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'active transition operation required' USING ERRCODE='P7303';END IF;
 IF p_session IS NOT NULL AND p_operation<>'admit' AND NOT EXISTS(SELECT 1 FROM gakja.transition_session_bindings WHERE transition_id=s.transition_id AND session_id=p_session)
 THEN RAISE EXCEPTION 'legacy session excluded' USING ERRCODE='P7304';END IF;
 RETURN s;
END $$;
CREATE FUNCTION gakja.transition_access(p_operation text,p_generation text DEFAULT NULL,p_session text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;
BEGIN
 s:=gakja.transition_current();IF s.transition_id IS NULL THEN RAISE EXCEPTION 'transition not prepared' USING ERRCODE='P7304';END IF;
 SELECT * INTO s FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR SHARE;
 IF p_operation NOT IN('read','admit','session-write','review-write','worker-write') THEN RAISE EXCEPTION 'invalid transition operation' USING ERRCODE='22023';END IF;
 IF p_generation IS NOT NULL AND p_generation<>s.generation::text THEN RAISE EXCEPTION 'transition stale' USING ERRCODE='P7303';END IF;
 IF p_operation<>'read' AND (s.state<>'db-primary' OR s.expires_at IS NULL OR s.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'transition not writable' USING ERRCODE='P7303';END IF;
 IF p_session IS NOT NULL AND p_operation NOT IN('read','admit') AND NOT EXISTS(SELECT 1 FROM gakja.transition_session_bindings WHERE transition_id=s.transition_id AND session_id=p_session)
 THEN RAISE EXCEPTION 'legacy session excluded' USING ERRCODE='P7304';END IF;
 RETURN jsonb_build_object('transitionId',s.transition_id,'generation',s.generation::text,'fence',s.fence::text,'scope',gakja.transition_scope_json(s),'state',s.state,'serverNow',clock_timestamp());
END $$;
CREATE FUNCTION gakja.transition_install_operator(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE g gakja.access_grants;s gakja.scoped_transitions;prior gakja.transition_operator_installations;v jsonb:=p->'grant';
BEGIN
 g:=gakja.evaluation_current_grant();PERFORM 1 FROM gakja.application_targets WHERE owner_id=g.owner_id AND student_id=g.student_id AND application_target_id=g.application_target_id FOR UPDATE;
 IF coalesce(p->>'sourceProofSha256','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'operator source proof required' USING ERRCODE='42501';END IF;
 INSERT INTO gakja.scoped_transitions(account_id,owner_id,student_id,application_target_id,support_target_id,source_present,source_revision)
 VALUES(g.account_id,g.owner_id,g.student_id,g.application_target_id,g.support_target_id,g.source_present,g.source_revision) ON CONFLICT DO NOTHING;
 s:=gakja.transition_current();SELECT * INTO s FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR UPDATE;
 SELECT * INTO prior FROM gakja.transition_operator_installations WHERE transition_id=s.transition_id AND key=p->>'key';
 IF FOUND THEN IF prior.input_sha256 IS DISTINCT FROM p->>'inputSha256' OR prior.grant_json IS DISTINCT FROM v::text THEN RAISE EXCEPTION 'operator installation conflict' USING ERRCODE='P7301';END IF;RETURN gakja.transition_snapshot(s);END IF;
 IF v->>'expiresAt' IS NULL OR NOT isfinite((v->>'expiresAt')::timestamptz) OR (v->>'expiresAt')::timestamptz<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM gakja.principals WHERE issuer=v->>'issuer' AND subject=v->>'subject' AND account_id=g.account_id AND active)
 THEN RAISE EXCEPTION 'operator binding invalid' USING ERRCODE='42501';END IF;
 INSERT INTO gakja.transition_operator_grants VALUES(s.transition_id,v->>'issuer',v->>'subject',ARRAY(SELECT jsonb_array_elements_text(v->'actions')),(v->>'expiresAt')::timestamptz,(v->>'active')::boolean)
 ON CONFLICT(transition_id,issuer,subject) DO UPDATE SET actions=excluded.actions,expires_at=excluded.expires_at,active=excluded.active;
 INSERT INTO gakja.transition_operator_installations VALUES(s.transition_id,p->>'key',p->>'inputSha256',v::text,clock_timestamp());
 INSERT INTO gakja.transition_history(transition_id,kind,generation,payload_json) VALUES(s.transition_id,'operator-installed',s.generation,p::text);
 RETURN gakja.transition_snapshot(s);
END $$;
CREATE FUNCTION gakja.transition_receipt_json(c gakja.transition_commands,p_replay boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version','scoped-transition-receipt-v1','transitionId',c.transition_id,'operationId',c.operation_id,'key',c.key,'action',c.action,'inputSha256',c.input_sha256,'resultJson',c.result_json,'resultSha256',c.result_sha256,'replay',p_replay,'committedAt',c.committed_at)
$$;
CREATE FUNCTION gakja.transition_receipt(p_key text,p_input text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;c gakja.transition_commands;
BEGIN s:=gakja.transition_require_operator('status');SELECT * INTO c FROM gakja.transition_commands WHERE transition_id=s.transition_id AND key=p_key;
 IF NOT FOUND THEN RETURN NULL;END IF;IF c.input_sha256<>p_input THEN RAISE EXCEPTION 'transition idempotency conflict' USING ERRCODE='P7301';END IF;RETURN gakja.transition_receipt_json(c,true);END $$;
CREATE FUNCTION gakja.transition_command(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;c gakja.transition_commands;a text:=p->>'action';v jsonb:=(p->>'payloadJson')::jsonb;e jsonb;result text;
BEGIN
 s:=gakja.transition_require_operator(a);
 SELECT * INTO c FROM gakja.transition_commands WHERE transition_id=s.transition_id AND key=p->>'key';
 IF FOUND THEN IF c.input_sha256 IS DISTINCT FROM p->>'inputSha256' OR c.action<>a THEN RAISE EXCEPTION 'transition idempotency conflict' USING ERRCODE='P7301';END IF;RETURN gakja.transition_receipt_json(c,true);END IF;
 IF p->>'version' IS DISTINCT FROM 'scoped-transition-command-v1' OR coalesce(p->>'key','')!~'^[A-Za-z0-9._:-]{1,160}$' OR coalesce(p->>'inputSha256','')!~'^[a-f0-9]{64}$'
  OR gakja.session_text_sha(p->>'inputJson') IS DISTINCT FROM p->>'inputSha256' OR (p->>'inputJson')::jsonb IS DISTINCT FROM jsonb_build_object('action',a,'expectedGeneration',p->>'expectedGeneration','payloadJson',p->>'payloadJson')
 THEN RAISE EXCEPTION 'transition command bytes invalid' USING ERRCODE='22023';END IF;
 IF s.generation::text IS DISTINCT FROM p->>'expectedGeneration' THEN RAISE EXCEPTION 'transition stale' USING ERRCODE='P7303';END IF;
 IF a='prepare' THEN
  IF s.state NOT IN('unprepared','local-primary') THEN RAISE EXCEPTION 'prepare state invalid' USING ERRCODE='P7302';END IF;
  e:=(v->>'localEvidenceJson')::jsonb;
  IF e->'scope' IS DISTINCT FROM gakja.transition_scope_json(s) OR e->>'inventoryComplete' IS DISTINCT FROM 'true' OR e->>'activeLegacySessions' IS DISTINCT FROM '0' OR e->>'unparticipatingProcesses' IS DISTINCT FROM '0'
   OR e->>'writeBarrierInstalled' IS DISTINCT FROM 'true' OR coalesce(e->>'stoppedParticipantProofSha256','')!~'^[a-f0-9]{64}$'
   OR gakja.session_text_sha(v->>'localEvidenceJson') IS DISTINCT FROM v->>'localEvidenceSha256' OR v->>'checkpointJson' IS NULL OR coalesce(v->>'checkpointSha256','')!~'^[a-f0-9]{64}$'
   OR gakja.session_text_sha(v->>'checkpointJson') IS DISTINCT FROM v->>'checkpointSha256'
   OR v->>'expiresAt' IS NULL OR NOT isfinite((v->>'expiresAt')::timestamptz) OR (v->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'local stop barrier evidence required' USING ERRCODE='P7304';END IF;
  IF EXISTS(SELECT 1 FROM gakja.session_command_sessions x WHERE x.owner_id=s.owner_id AND x.student_id=s.student_id AND x.application_target_id=s.application_target_id AND x.created
    AND NOT EXISTS(SELECT 1 FROM gakja.transition_session_bindings b WHERE b.session_id=x.session_id) AND coalesce(x.session_json::jsonb->>'status','') NOT IN('completed','ended'))
   THEN RAISE EXCEPTION 'active legacy session excluded' USING ERRCODE='P7304';END IF;
  UPDATE gakja.scoped_transitions SET state='blocking',generation=generation+1,fence=fence+1,local_evidence_json=v->>'localEvidenceJson',local_evidence_sha256=v->>'localEvidenceSha256',checkpoint_json=v->>'checkpointJson',checkpoint_sha256=v->>'checkpointSha256',expires_at=(v->>'expiresAt')::timestamptz WHERE transition_id=s.transition_id RETURNING * INTO s;
 ELSIF a='verify' THEN
  e:=(v->>'verificationJson')::jsonb;
  IF s.state<>'blocking' OR e->>'verified' IS DISTINCT FROM 'true' OR e->>'localEvidenceSha256' IS DISTINCT FROM s.local_evidence_sha256 OR e->>'checkpointSha256' IS DISTINCT FROM s.checkpoint_sha256 OR gakja.session_text_sha(v->>'verificationJson') IS DISTINCT FROM v->>'verificationSha256'
   THEN RAISE EXCEPTION 'transition verification invalid' USING ERRCODE='P7304';END IF;
  UPDATE gakja.scoped_transitions SET state='verified',generation=generation+1,verification_json=v->>'verificationJson',verification_sha256=v->>'verificationSha256' WHERE transition_id=s.transition_id RETURNING * INTO s;
 ELSIF a='activate' THEN
  IF s.state<>'verified' OR s.expires_at IS NULL OR NOT isfinite(s.expires_at) OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'activation state invalid' USING ERRCODE='P7302';END IF;
  UPDATE gakja.scoped_transitions SET state='db-primary',generation=generation+1,fence=fence+1,primary_generation=generation+1 WHERE transition_id=s.transition_id RETURNING * INTO s;
 ELSIF a='freeze' THEN
  IF s.state NOT IN('db-primary','verified','blocking') THEN RAISE EXCEPTION 'freeze state invalid' USING ERRCODE='P7302';END IF;
  UPDATE gakja.scoped_transitions SET state='frozen',generation=generation+1,fence=fence+1 WHERE transition_id=s.transition_id RETURNING * INTO s;
  UPDATE gakja.transition_active_operations SET outcome='fenced',finished_at=clock_timestamp() WHERE transition_id=s.transition_id AND finished_at IS NULL;
 ELSIF a='rollback-empty' THEN
  IF s.state<>'frozen' OR EXISTS(SELECT 1 FROM gakja.transition_write_facts WHERE transition_id=s.transition_id) OR EXISTS(SELECT 1 FROM gakja.transition_session_bindings WHERE transition_id=s.transition_id)
   THEN RAISE EXCEPTION 'post-write recovery required' USING ERRCODE='P7304';END IF;
  UPDATE gakja.scoped_transitions SET state='local-primary',generation=generation+1,fence=fence+1 WHERE transition_id=s.transition_id RETURNING * INTO s;
 ELSIF a='recover' THEN
  IF s.state<>'frozen' THEN RAISE EXCEPTION 'recovery requires frozen state' USING ERRCODE='P7302';END IF;
  UPDATE gakja.scoped_transitions SET state='restoring',generation=generation+1,fence=fence+1 WHERE transition_id=s.transition_id RETURNING * INTO s;
 ELSE RAISE EXCEPTION 'unknown transition action' USING ERRCODE='22023';END IF;
 UPDATE gakja.scoped_transitions SET updated_at=clock_timestamp() WHERE transition_id=s.transition_id;
 result:=gakja.transition_snapshot(s)::text;
 INSERT INTO gakja.transition_commands(transition_id,key,action,input_sha256,result_json,result_sha256) VALUES(s.transition_id,p->>'key',a,p->>'inputSha256',result,gakja.session_text_sha(result)) RETURNING * INTO c;
 INSERT INTO gakja.transition_history(transition_id,kind,generation,payload_json) VALUES(s.transition_id,a,s.generation,p->>'inputJson');RETURN gakja.transition_receipt_json(c,false);
END $$;
CREATE FUNCTION gakja.transition_begin_operation(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;a gakja.transition_active_operations;v jsonb;ends timestamptz;
BEGIN
 v:=gakja.transition_access('admit',p->>'generation',NULL);s:=gakja.transition_current();SELECT * INTO s FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR SHARE;
 ends:=least((p->>'expiresAt')::timestamptz,s.expires_at);
 IF ends<=clock_timestamp() OR p->>'expiresAt' IS NULL OR NOT isfinite((p->>'expiresAt')::timestamptz) THEN RAISE EXCEPTION 'operation expiry invalid' USING ERRCODE='P7303';END IF;
 IF p?'sessionId' AND NOT EXISTS(SELECT 1 FROM gakja.transition_session_bindings WHERE transition_id=s.transition_id AND session_id=p->>'sessionId') THEN RAISE EXCEPTION 'legacy operation excluded' USING ERRCODE='P7304';END IF;
 SELECT * INTO a FROM gakja.transition_active_operations WHERE transition_id=s.transition_id AND operation_id=p->>'operationId';
 IF FOUND THEN RAISE EXCEPTION 'operation id cannot be reused' USING ERRCODE='P7301';END IF;
 INSERT INTO gakja.transition_active_operations(transition_id,operation_id,generation,kind,issuer,subject,session_id,expires_at)
 VALUES(s.transition_id,p->>'operationId',s.generation,p->>'kind',current_setting('gakja.issuer',true),current_setting('gakja.subject',true),p->>'sessionId',ends) RETURNING * INTO a;
 RETURN v||jsonb_build_object('operationId',a.operation_id,'kind',a.kind,'expiresAt',a.expires_at);
END $$;
CREATE FUNCTION gakja.transition_finish_operation(p jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;
BEGIN s:=gakja.transition_current();PERFORM 1 FROM gakja.scoped_transitions WHERE transition_id=s.transition_id FOR SHARE;
 UPDATE gakja.transition_active_operations SET outcome=CASE WHEN generation=s.generation AND s.state='db-primary' THEN p->>'outcome' ELSE 'fenced' END,finished_at=clock_timestamp()
 WHERE transition_id=s.transition_id AND operation_id=p->>'operationId' AND generation::text=p->>'generation' AND issuer=current_setting('gakja.issuer',true) AND subject=current_setting('gakja.subject',true) AND finished_at IS NULL;
 RETURN FOUND;END $$;
CREATE FUNCTION gakja.transition_record_write(s gakja.scoped_transitions,p_kind text,p_session text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN IF s.transition_id IS NOT NULL THEN INSERT INTO gakja.transition_write_facts(transition_id,generation,kind,operation_id,session_id) VALUES(s.transition_id,s.generation,p_kind,current_setting('gakja.transition_operation',true),p_session);END IF;END $$;
CREATE FUNCTION gakja.transition_finish_recovery(p_manifest text,p_source_generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;
BEGIN s:=gakja.transition_require_operator('restore');IF s.state NOT IN('unprepared','blocking','verified','frozen','restoring') OR p_manifest!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'restore state invalid' USING ERRCODE='P7304';END IF;
 UPDATE gakja.scoped_transitions SET state='read-only-recovery',generation=greatest(generation,p_source_generation)+1,fence=fence+1,recovery_manifest_sha256=p_manifest,updated_at=clock_timestamp() WHERE transition_id=s.transition_id RETURNING * INTO s;
 UPDATE gakja.transition_operator_grants SET active=false WHERE transition_id=s.transition_id;
 UPDATE gakja.transition_active_operations SET outcome='fenced',finished_at=clock_timestamp() WHERE transition_id=s.transition_id AND finished_at IS NULL;
 RETURN gakja.transition_snapshot(s);END $$;

-- Original RPC names remain stable. Retained cores are private; callers cannot
-- evade G by using an old isolated factory without G generation/operation GUCs.
ALTER FUNCTION gakja.session_enroll(jsonb) RENAME TO session_enroll_pre_g;
CREATE FUNCTION gakja.session_enroll(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;prior jsonb;r jsonb;
BEGIN
 s:=gakja.transition_current();prior:=gakja.session_find_creation(p->>'creationKey',p->>'inputSha256');
 IF prior IS NOT NULL THEN
  IF s.transition_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gakja.transition_session_bindings WHERE transition_id=s.transition_id AND session_id=prior->'binding'->>'sessionId') THEN RAISE EXCEPTION 'legacy enrollment excluded' USING ERRCODE='P7304';END IF;
  RETURN prior;
 END IF;
 s:=gakja.transition_guard('admit');r:=gakja.session_enroll_pre_g(p);
 IF s.transition_id IS NOT NULL THEN INSERT INTO gakja.transition_session_bindings(transition_id,session_id,generation) VALUES(s.transition_id,p->>'sessionId',s.generation);END IF;
 PERFORM gakja.transition_record_write(s,'session-enroll',p->>'sessionId');RETURN r;
END $$;
ALTER FUNCTION gakja.session_begin(jsonb) RENAME TO session_begin_pre_g;
CREATE FUNCTION gakja.session_begin(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN r:=gakja.session_receipt(p);IF r IS NOT NULL THEN PERFORM gakja.transition_guard('read');RETURN jsonb_build_object('status','committed','receipt',r);END IF;
 s:=gakja.transition_guard('session-write',p->>'sessionId');r:=gakja.session_begin_pre_g(p);PERFORM gakja.transition_record_write(s,'session-begin',p->>'sessionId');RETURN r;END $$;
ALTER FUNCTION gakja.session_commit(jsonb,jsonb) RENAME TO session_commit_pre_g;
CREATE FUNCTION gakja.session_commit(p jsonb,v jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN r:=gakja.session_receipt(p);IF r IS NOT NULL THEN PERFORM gakja.transition_guard('read');RETURN r;END IF;
 s:=gakja.transition_guard('session-write',p->>'sessionId');r:=gakja.session_commit_pre_g(p,v);PERFORM gakja.transition_record_write(s,'session-commit',p->>'sessionId');RETURN r;END $$;
ALTER FUNCTION gakja.session_progress(jsonb,jsonb) RENAME TO session_progress_pre_g;
CREATE FUNCTION gakja.session_progress(p jsonb,v jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN s:=gakja.transition_guard('session-write',p->>'sessionId');r:=gakja.session_progress_pre_g(p,v);PERFORM gakja.transition_record_write(s,'session-progress',p->>'sessionId');RETURN r;END $$;
ALTER FUNCTION gakja.session_fence(jsonb,text) RENAME TO session_fence_pre_g;
CREATE FUNCTION gakja.session_fence(p jsonb,p_mode text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN s:=gakja.transition_guard('session-write',p->>'sessionId');r:=gakja.session_fence_pre_g(p,p_mode);PERFORM gakja.transition_record_write(s,'session-fence',p->>'sessionId');RETURN r;END $$;
ALTER FUNCTION gakja.session_observe_connection_closed(text,bigint,uuid) RENAME TO session_observe_connection_closed_pre_g;
CREATE FUNCTION gakja.session_observe_connection_closed(p_id text,p_generation bigint,p_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN s:=gakja.transition_guard('session-write',p_id);r:=gakja.session_observe_connection_closed_pre_g(p_id,p_generation,p_token);PERFORM gakja.transition_record_write(s,'connection-close',p_id);RETURN r;END $$;

DO $wrappers$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['evaluation_install_trust','evaluation_publish_registry','evaluation_publish_approval','evaluation_withdraw_approval','evaluation_consume','evaluation_retry'] LOOP
  EXECUTE format('ALTER FUNCTION gakja.%I(jsonb) RENAME TO %I',n,n||'_pre_g');
  EXECUTE format($body$CREATE FUNCTION gakja.%I(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
   DECLARE s gakja.scoped_transitions;r jsonb;
   BEGIN
    IF p?'key' THEN r:=gakja.evaluation_receipt(p->>'key',p->>'inputSha256');IF r IS NOT NULL THEN PERFORM gakja.transition_guard('read');RETURN r;END IF;END IF;
    s:=gakja.transition_guard('review-write',p->>'sessionId');r:=gakja.%I(p);PERFORM gakja.transition_record_write(s,%L,p->>'sessionId');RETURN r;
   END $fn$ $body$,n,n||'_pre_g',n);
 END LOOP;
END $wrappers$;
ALTER FUNCTION gakja.evaluation_grant_worker(jsonb) RENAME TO evaluation_grant_worker_pre_g;
CREATE FUNCTION gakja.evaluation_grant_worker(p jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r boolean;
BEGIN s:=gakja.transition_guard('worker-write');r:=gakja.evaluation_grant_worker_pre_g(p);PERFORM gakja.transition_record_write(s,'worker-grant');RETURN r;END $$;
ALTER FUNCTION gakja.evaluation_worker(text,text,jsonb) RENAME TO evaluation_worker_pre_g;
CREATE FUNCTION gakja.evaluation_worker(p_id text,p_action text,p jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r text;sid text;
BEGIN SELECT session_id INTO sid FROM gakja.evaluation_jobs WHERE job_id=p_id AND owner_id=current_setting('gakja.owner_id',true);
 s:=gakja.transition_guard('worker-write',sid);r:=gakja.evaluation_worker_pre_g(p_id,p_action,p);PERFORM gakja.transition_record_write(s,'worker-'||p_action,sid);RETURN r;END $$;
ALTER FUNCTION gakja.evaluation_freeze(text,bigint) RENAME TO evaluation_freeze_pre_g;
CREATE FUNCTION gakja.evaluation_freeze(p_id text,p_fence bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;r jsonb;
BEGIN s:=gakja.transition_guard('review-write',p_id);r:=gakja.evaluation_freeze_pre_g(p_id,p_fence);PERFORM gakja.transition_record_write(s,'evaluation-freeze',p_id);RETURN r;END $$;
DO $restore$ DECLARE n text;BEGIN
 FOREACH n IN ARRAY ARRAY['session_restore','evaluation_restore'] LOOP
  EXECUTE format('ALTER FUNCTION gakja.%I(jsonb) RENAME TO %I',n,n||'_pre_g');
  EXECUTE format($body$CREATE FUNCTION gakja.%I(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
   DECLARE s gakja.scoped_transitions;BEGIN s:=gakja.transition_current();IF s.transition_id IS NOT NULL THEN RAISE EXCEPTION 'integrated recovery required' USING ERRCODE='P7304';END IF;RETURN gakja.%I(p);END $fn$ $body$,n,n||'_pre_g');
 END LOOP;
END $restore$;
CREATE FUNCTION gakja.transition_fact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'transition audit fact immutable' USING ERRCODE='23514';END $$;
DO $secure$ DECLARE n text;f record;BEGIN
 FOREACH n IN ARRAY ARRAY['scoped_transitions','transition_operator_grants','transition_operator_installations','transition_commands','transition_history','transition_active_operations','transition_session_bindings','transition_write_facts'] LOOP
  EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY transition_owner_management ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',n);
  EXECUTE format('REVOKE ALL ON gakja.%I FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',n);
 END LOOP;
 FOREACH n IN ARRAY ARRAY['transition_operator_installations','transition_commands','transition_history','transition_session_bindings','transition_write_facts'] LOOP
  EXECUTE format('CREATE TRIGGER transition_fact_immutable BEFORE UPDATE OR DELETE ON gakja.%I FOR EACH ROW EXECUTE FUNCTION gakja.transition_fact_immutable()',n);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gakja' AND (p.proname LIKE 'transition_%' OR p.proname LIKE '%_pre_g') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',f.signature);
 END LOOP;
END $secure$;
GRANT EXECUTE ON FUNCTION gakja.transition_read(),gakja.transition_access(text,text,text),gakja.transition_begin_operation(jsonb),gakja.transition_finish_operation(jsonb),gakja.transition_guard(text,text,boolean) TO gakja_request,gakja_mapping,gakja_worker;
GRANT EXECUTE ON FUNCTION gakja.transition_install_operator(jsonb),gakja.transition_command(jsonb),gakja.transition_receipt(text,text),gakja.transition_authorize_operator(text) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.session_enroll(jsonb),gakja.session_restore(jsonb),gakja.evaluation_install_trust(jsonb),gakja.evaluation_grant_worker(jsonb),gakja.evaluation_restore(jsonb) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.session_begin(jsonb),gakja.session_commit(jsonb,jsonb),gakja.session_progress(jsonb,jsonb),gakja.session_fence(jsonb,text),gakja.session_observe_connection_closed(text,bigint,uuid),gakja.evaluation_publish_registry(jsonb),gakja.evaluation_publish_approval(jsonb),gakja.evaluation_withdraw_approval(jsonb),gakja.evaluation_consume(jsonb),gakja.evaluation_retry(jsonb),gakja.evaluation_freeze(text,bigint) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.evaluation_worker(text,text,jsonb) TO gakja_worker;

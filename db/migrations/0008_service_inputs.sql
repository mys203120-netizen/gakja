-- New G service inputs. Existing C/D originals and all historical rows stay intact.
ALTER TABLE gakja.shadow_runs DROP CONSTRAINT shadow_runs_binding_check;
ALTER TABLE gakja.shadow_runs ADD CONSTRAINT shadow_runs_binding_check CHECK(binding IN('synthetic','local-verification-only','service-verified'));
CREATE TABLE gakja.service_input_approvals (
 run_id text PRIMARY KEY REFERENCES gakja.shadow_runs(run_id), transition_id uuid NOT NULL REFERENCES gakja.scoped_transitions(transition_id),
 owner_id text NOT NULL,student_id text NOT NULL,application_target_id text NOT NULL,support_target_id text NOT NULL,
 plan_sha256 text NOT NULL CHECK(plan_sha256~'^[a-f0-9]{64}$'),plan_json text NOT NULL,plan_raw_sha256 text NOT NULL CHECK(plan_raw_sha256~'^[a-f0-9]{64}$'),
 evidence_json text NOT NULL,evidence_raw_sha256 text NOT NULL CHECK(evidence_raw_sha256~'^[a-f0-9]{64}$'),
 operator_issuer text NOT NULL,operator_subject text NOT NULL,registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION gakja.service_shadow_register_core(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs; item jsonb; alias jsonb; dependency jsonb; pointer jsonb; present boolean; scoped_app text; scoped_support text;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k<>ALL(ARRAY[
    'runId','planSha256','binding','ownerId','studentId','applicationTargetId','supportTargetId','provenanceOwnerId','artifacts','pointers']))
    OR jsonb_typeof(p->'artifacts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'artifacts') NOT BETWEEN 1 AND 512
    OR (p ? 'pointers' AND (jsonb_typeof(p->'pointers') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'pointers')>128))
    OR p->>'ownerId' IS DISTINCT FROM nullif(current_setting('gakja.owner_id',true),'')
    OR p->>'studentId' IS DISTINCT FROM nullif(current_setting('gakja.student_id',true),'')
    OR p->>'applicationTargetId' IS DISTINCT FROM nullif(current_setting('gakja.application_target_id',true),'')
    OR NOT gakja.can_student(p->>'ownerId',p->>'studentId') THEN
    RAISE EXCEPTION 'shadow run denied' USING ERRCODE='42501'; END IF;
  INSERT INTO gakja.shadow_runs(run_id,account_id,owner_id,student_id,application_target_id,support_target_id,plan_sha256,binding,original_plan)
    VALUES(p->>'runId',current_setting('gakja.account_id',true),p->>'ownerId',p->>'studentId',p->>'applicationTargetId',p->>'supportTargetId',p->>'planSha256',p->>'binding',p)
    ON CONFLICT(run_id) DO NOTHING RETURNING * INTO r;
  IF NOT FOUND THEN
    SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p->>'runId' FOR UPDATE;
    IF NOT gakja.shadow_run_authorized(r) OR r.original_plan IS DISTINCT FROM p THEN RAISE EXCEPTION 'shadow plan conflict' USING ERRCODE='23505'; END IF;
    RETURN gakja.shadow_snapshot_json(r);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'artifacts') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k<>ALL(ARRAY[
      'artifactId','role','locatorId','reference','selection','scope','required','sourceRevision','versionId','legacyId','originalPin','dependencies','aliases',
      'availability','objectKind','sizeBytes','rawSha256','domainSha256','mediaType','absenceReason']))
      OR jsonb_typeof(item->'required') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'dependencies') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'dependencies')>512
      OR (item ? 'aliases' AND (jsonb_typeof(item->'aliases') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'aliases')>32))
      OR item->>'availability' NOT IN ('present','absent') OR item->>'scope' NOT IN ('common','target')
      OR (item ? 'sourceRevision' AND jsonb_typeof(item->'sourceRevision') NOT IN ('string','null'))
      OR (item ? 'domainSha256' AND jsonb_typeof(item->'domainSha256') NOT IN ('string','null'))
      OR (item ? 'versionId' AND jsonb_typeof(item->'versionId') NOT IN ('string','null'))
      OR (item ? 'legacyId' AND jsonb_typeof(item->'legacyId') NOT IN ('string','null'))
      OR (item ? 'originalPin' AND jsonb_typeof(item->'originalPin') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'invalid shadow artifact' USING ERRCODE='22023'; END IF;
    IF item->>'availability'='absent' AND ((item->>'required')::boolean OR item->>'absenceReason' IS DISTINCT FROM 'known-absent'
      OR item ?| ARRAY['objectKind','sizeBytes','rawSha256','domainSha256','mediaType'] OR jsonb_array_length(item->'dependencies')<>0) THEN
      RAISE EXCEPTION 'invalid shadow absence' USING ERRCODE='22023'; END IF;
    present:=item->>'availability'='present';
    scoped_app:=CASE WHEN item->>'scope'='target' THEN r.application_target_id ELSE NULL END;
    scoped_support:=CASE WHEN item->>'scope'='target' THEN r.support_target_id ELSE NULL END;
    IF NOT (CASE WHEN item->>'scope'='common' THEN gakja.can_student_version(r.owner_id,r.student_id,item ? 'sourceRevision',item->>'sourceRevision')
      ELSE gakja.can_target(r.owner_id,r.student_id,scoped_app,item ? 'sourceRevision',item->>'sourceRevision') END) THEN
      RAISE EXCEPTION 'shadow artifact denied' USING ERRCODE='42501'; END IF;
    INSERT INTO gakja.shadow_artifacts(run_id,artifact_id,owner_id,student_id,scope_kind,application_target_id,support_target_id,
      role,locator_id,reference,selection,availability,required,object_kind,expected_size,expected_sha256,
      source_present,source_revision,domain_present,domain_sha256,media_type,spec,status)
      VALUES(r.run_id,item->>'artifactId',r.owner_id,r.student_id,item->>'scope',scoped_app,scoped_support,
        item->>'role',item->>'locatorId',item->>'reference',item->>'selection',item->>'availability',(item->>'required')::boolean,
        CASE WHEN present THEN item->>'objectKind' ELSE NULL END,CASE WHEN present THEN (item->>'sizeBytes')::bigint ELSE NULL END,
        CASE WHEN present THEN item->>'rawSha256' ELSE NULL END,item ? 'sourceRevision',item->>'sourceRevision',item ? 'domainSha256',item->>'domainSha256',
        coalesce(item->>'mediaType','none'),item,CASE WHEN present THEN 'planned' ELSE 'absent' END);
    INSERT INTO gakja.shadow_aliases VALUES(r.run_id,item->>'role',item->>'reference',item->>'selection',item->>'artifactId');
    FOR alias IN SELECT value FROM jsonb_array_elements(coalesce(item->'aliases','[]'::jsonb)) LOOP
      IF jsonb_typeof(alias) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(alias) k WHERE k<>ALL(ARRAY['role','reference','selection']))
        OR NOT gakja.is_trimmed_identifier(alias->>'role') OR (alias ? 'reference' AND NOT gakja.is_trimmed_identifier(alias->>'reference'))
        OR (alias ? 'selection' AND alias->>'selection' NOT IN ('current','staged','pinned','historical','revision','review-parent','configured','dependency')) THEN
        RAISE EXCEPTION 'invalid shadow alias' USING ERRCODE='22023'; END IF;
      INSERT INTO gakja.shadow_aliases VALUES(r.run_id,alias->>'role',coalesce(alias->>'reference',''),coalesce(alias->>'selection',''),item->>'artifactId');
    END LOOP;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p->'artifacts') LOOP
    FOR dependency IN SELECT value FROM jsonb_array_elements(item->'dependencies') LOOP
      IF jsonb_typeof(dependency) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(dependency) k WHERE k<>ALL(ARRAY['artifactId','required']))
        OR jsonb_typeof(dependency->'required') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'invalid shadow dependency' USING ERRCODE='22023'; END IF;
      INSERT INTO gakja.shadow_dependencies VALUES(r.run_id,item->>'artifactId',dependency->>'artifactId',(dependency->>'required')::boolean);
      IF (dependency->>'required')::boolean AND EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id AND a.artifact_id=dependency->>'artifactId' AND a.availability='absent') THEN
        RAISE EXCEPTION 'required shadow dependency is absent' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(WITH RECURSIVE reach(parent,child) AS (
      SELECT artifact_id,dependency_id FROM gakja.shadow_dependencies WHERE run_id=r.run_id
      UNION SELECT q.parent,d.dependency_id FROM reach q JOIN gakja.shadow_dependencies d ON d.run_id=r.run_id AND d.artifact_id=q.child)
    SELECT 1 FROM reach WHERE parent=child) THEN RAISE EXCEPTION 'shadow dependency cycle' USING ERRCODE='23514'; END IF;
  FOR pointer IN SELECT value FROM jsonb_array_elements(coalesce(p->'pointers','[]'::jsonb)) LOOP
    IF jsonb_typeof(pointer) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(pointer) k WHERE k<>ALL(ARRAY['name','selection','artifactId']))
      OR NOT gakja.is_trimmed_identifier(pointer->>'name') OR pointer->>'selection' NOT IN ('current','staged','pinned','historical','revision','review-parent','configured','dependency')
      OR NOT EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id AND a.artifact_id=pointer->>'artifactId' AND a.availability='present') THEN
      RAISE EXCEPTION 'invalid shadow pointer plan' USING ERRCODE='22023'; END IF;
  END LOOP;
  INSERT INTO gakja.shadow_history(run_id,generation,event) VALUES(r.run_id,1,'registered');
  RETURN gakja.shadow_snapshot_json(r);
END $$;


CREATE FUNCTION gakja.service_register_shadow_run(p_plan text,p_evidence text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;p jsonb;e jsonb;result jsonb;prior gakja.service_input_approvals;
BEGIN
 s:=gakja.transition_require_operator('register-input');
 IF s.state NOT IN('blocking','verified') OR octet_length(p_plan)>16777216 OR octet_length(p_evidence)>1048576 THEN RAISE EXCEPTION 'service input stage denied' USING ERRCODE='42501';END IF;
 p:=p_plan::jsonb;e:=p_evidence::jsonb;
 IF p->>'binding' IS DISTINCT FROM 'service-verified' OR p->>'ownerId' IS DISTINCT FROM s.owner_id OR p->>'studentId' IS DISTINCT FROM s.student_id OR
 p->>'applicationTargetId' IS DISTINCT FROM s.application_target_id OR p->>'supportTargetId' IS DISTINCT FROM s.support_target_id OR
 e->>'version' IS DISTINCT FROM 'service-input-approval-v1' OR e->>'planSha256' IS DISTINCT FROM p->>'planSha256' OR
 NOT coalesce(e->>'mappingApprovalSha256' ~ '^[a-f0-9]{64}$',false) OR NOT coalesce(e->>'sourceClosureSha256' ~ '^[a-f0-9]{64}$',false) OR
 e->>'provenanceOwnerId' IS DISTINCT FROM coalesce(p->>'provenanceOwnerId',p->>'ownerId') OR
 (e ? 'sourceRevision') IS DISTINCT FROM s.source_present OR e->>'sourceRevision' IS DISTINCT FROM s.source_revision
 THEN RAISE EXCEPTION 'explicit service evidence required' USING ERRCODE='42501';END IF;
 SELECT * INTO prior FROM gakja.service_input_approvals WHERE run_id=p->>'runId';
 IF FOUND THEN IF prior.plan_json IS DISTINCT FROM p_plan OR prior.evidence_json IS DISTINCT FROM p_evidence OR prior.transition_id<>s.transition_id THEN RAISE EXCEPTION 'immutable service input conflict' USING ERRCODE='23505';END IF;
 RETURN gakja.shadow_capture(p->>'runId');END IF;
 -- Existing run IDs cannot be promoted or relabelled. Only this new registration path admits the new binding.
 IF EXISTS(SELECT 1 FROM gakja.shadow_runs WHERE run_id=p->>'runId') THEN RAISE EXCEPTION 'existing run cannot be promoted' USING ERRCODE='23505';END IF;
 result:=gakja.service_shadow_register_core(p);
 INSERT INTO gakja.service_input_approvals VALUES(p->>'runId',s.transition_id,s.owner_id,s.student_id,s.application_target_id,s.support_target_id,
 p->>'planSha256',p_plan,gakja.session_text_sha(p_plan),p_evidence,gakja.session_text_sha(p_evidence),
 current_setting('gakja.issuer',true),current_setting('gakja.subject',true),clock_timestamp());
 RETURN result;
END $$;
CREATE FUNCTION gakja.service_input_status(p_run text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;a gakja.service_input_approvals;
BEGIN s:=gakja.transition_current();SELECT * INTO a FROM gakja.service_input_approvals WHERE run_id=p_run AND transition_id=s.transition_id
 AND owner_id=s.owner_id AND student_id=s.student_id AND application_target_id=s.application_target_id AND support_target_id=s.support_target_id;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('runId',a.run_id,'planSha256',a.plan_sha256,'planRawSha256',a.plan_raw_sha256,'evidenceRawSha256',a.evidence_raw_sha256,'transitionId',a.transition_id::text);
END $$;
CREATE FUNCTION gakja.service_storage_guard() RETURNS gakja.scoped_transitions LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;
BEGIN s:=gakja.transition_current();IF s.transition_id IS NULL THEN RETURN s;END IF;
 IF s.state IN('blocking','verified') THEN RETURN gakja.transition_require_operator('register-input');END IF;
 RETURN gakja.transition_guard('session-write',NULL,false);
END $$;
CREATE FUNCTION gakja.service_register_audio(p jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;a gakja.audio_bindings;
BEGIN s:=gakja.transition_guard('session-write',p->>'sessionId',false);
 IF s.transition_id IS NULL OR NOT coalesce(p->>'audioId' ~ '^[a-f0-9]{64}$',false) OR NOT coalesce(p->>'contentSha256' ~ '^[a-f0-9]{64}$',false) OR
 (p ? 'sourceRevision') IS DISTINCT FROM s.source_present OR p->>'sourceRevision' IS DISTINCT FROM s.source_revision
 THEN RAISE EXCEPTION 'audio authority required' USING ERRCODE='42501';END IF;
 INSERT INTO gakja.audio_bindings(owner_id,resource_id,student_id,application_target_id,support_target_id,source_present,source_revision,content_sha256)
 VALUES(s.owner_id,p->>'audioId',s.student_id,s.application_target_id,s.support_target_id,s.source_present,s.source_revision,p->>'contentSha256')
 ON CONFLICT(owner_id,resource_id) DO NOTHING;
 SELECT * INTO a FROM gakja.audio_bindings WHERE owner_id=s.owner_id AND resource_id=p->>'audioId';
 IF a.student_id IS DISTINCT FROM s.student_id OR a.application_target_id IS DISTINCT FROM s.application_target_id OR a.support_target_id IS DISTINCT FROM s.support_target_id OR
 a.source_present IS DISTINCT FROM s.source_present OR a.source_revision IS DISTINCT FROM s.source_revision OR a.content_sha256 IS DISTINCT FROM p->>'contentSha256'
 THEN RAISE EXCEPTION 'audio immutable binding conflict' USING ERRCODE='23505';END IF;
 PERFORM gakja.transition_record_write(s,'audio-register',p->>'sessionId');RETURN true;
END $$;

ALTER FUNCTION gakja.storage_admit(jsonb) RENAME TO storage_admit_pre_g_inputs;
CREATE FUNCTION gakja.storage_admit(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.storage_admit_pre_g_inputs(p);
 IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'storage_admit',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.storage_admit_pre_g_inputs(jsonb) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.storage_admit(jsonb) TO gakja_mapping;

ALTER FUNCTION gakja.storage_transition(uuid,bigint,text,bigint,text) RENAME TO storage_transition_pre_g_inputs;
CREATE FUNCTION gakja.storage_transition(p_receipt uuid,p_revision bigint,p_action text,p_size bigint DEFAULT NULL,p_sha text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.storage_transition_pre_g_inputs(p_receipt,p_revision,p_action,p_size,p_sha);
 IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'storage_transition',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.storage_transition_pre_g_inputs(uuid,bigint,text,bigint,text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.storage_transition(uuid,bigint,text,bigint,text) TO gakja_mapping;

ALTER FUNCTION gakja.storage_link_audio(uuid,text) RENAME TO storage_link_audio_pre_g_inputs;
CREATE FUNCTION gakja.storage_link_audio(p_receipt uuid,p_audio text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.storage_link_audio_pre_g_inputs(p_receipt,p_audio);
 IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'storage_link_audio',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.storage_link_audio_pre_g_inputs(uuid,text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.storage_link_audio(uuid,text) TO gakja_mapping;

ALTER FUNCTION gakja.storage_link_version(uuid,text,text) RENAME TO storage_link_version_pre_g_inputs;
CREATE FUNCTION gakja.storage_link_version(p_receipt uuid,p_kind text,p_version text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.storage_link_version_pre_g_inputs(p_receipt,p_kind,p_version);
 IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'storage_link_version',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.storage_link_version_pre_g_inputs(uuid,text,text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.storage_link_version(uuid,text,text) TO gakja_mapping;

ALTER FUNCTION gakja.storage_set_media_type(uuid,bigint,text) RENAME TO storage_set_media_type_pre_g_inputs;
CREATE FUNCTION gakja.storage_set_media_type(p_receipt uuid,p_revision bigint,p_media text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.storage_set_media_type_pre_g_inputs(p_receipt,p_revision,p_media);
 IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'storage_set_media_type',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.storage_set_media_type_pre_g_inputs(uuid,bigint,text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.storage_set_media_type(uuid,bigint,text) TO gakja_mapping;

ALTER TABLE gakja.service_input_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE gakja.service_input_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY service_input_owner ON gakja.service_input_approvals TO gakja_owner USING(true) WITH CHECK(true);
CREATE TRIGGER service_input_immutable BEFORE UPDATE OR DELETE ON gakja.service_input_approvals FOR EACH ROW EXECUTE FUNCTION gakja.transition_fact_immutable();
REVOKE ALL ON gakja.service_input_approvals FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
REVOKE ALL ON FUNCTION gakja.service_shadow_register_core(jsonb),gakja.service_storage_guard(),gakja.service_register_shadow_run(text,text),gakja.service_input_status(text),gakja.service_register_audio(jsonb) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.service_register_shadow_run(text,text) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.service_input_status(text),gakja.service_register_audio(jsonb) TO gakja_request;

ALTER FUNCTION gakja.shadow_register_run(jsonb) RENAME TO shadow_register_run_pre_g_inputs;
CREATE FUNCTION gakja.shadow_register_run(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN IF p->>'binding'='service-verified' THEN RAISE EXCEPTION 'explicit service registration required' USING ERRCODE='42501';END IF;
 PERFORM gakja.service_storage_guard();RETURN gakja.shadow_register_run_pre_g_inputs(p);END $$;
REVOKE ALL ON FUNCTION gakja.shadow_register_run_pre_g_inputs(jsonb) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_register_run(jsonb) TO gakja_mapping;

-- Nonsecret migration attestation; no control-table DML is granted to runtime roles.
CREATE FUNCTION gakja.service_migration_status() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'checksum',checksum,'fingerprint',fingerprint) ORDER BY version),'[]'::jsonb) FROM pr07b_control.migrations
$$;
REVOKE ALL ON FUNCTION gakja.service_migration_status() FROM PUBLIC,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.service_migration_status() TO gakja_request;

ALTER FUNCTION gakja.shadow_note_receipt(text,text,uuid) RENAME TO shadow_note_receipt_pre_g_inputs;
CREATE FUNCTION gakja.shadow_note_receipt(p_run text,p_artifact text,p_receipt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_note_receipt_pre_g_inputs(p_run,p_artifact,p_receipt);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_note_receipt',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_note_receipt_pre_g_inputs(text,text,uuid) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_note_receipt(text,text,uuid) TO gakja_mapping;

ALTER FUNCTION gakja.shadow_bind_object(text,text,uuid) RENAME TO shadow_bind_object_pre_g_inputs;
CREATE FUNCTION gakja.shadow_bind_object(p_run text,p_artifact text,p_receipt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_bind_object_pre_g_inputs(p_run,p_artifact,p_receipt);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_bind_object',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_bind_object_pre_g_inputs(text,text,uuid) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_bind_object(text,text,uuid) TO gakja_mapping;

ALTER FUNCTION gakja.shadow_quarantine(text,text) RENAME TO shadow_quarantine_pre_g_inputs;
CREATE FUNCTION gakja.shadow_quarantine(p_run text,p_artifact text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_quarantine_pre_g_inputs(p_run,p_artifact);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_quarantine',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_quarantine_pre_g_inputs(text,text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_quarantine(text,text) TO gakja_mapping;

ALTER FUNCTION gakja.shadow_set_pointer(text,text,text,text,bigint) RENAME TO shadow_set_pointer_pre_g_inputs;
CREATE FUNCTION gakja.shadow_set_pointer(p_run text,p_name text,p_selection text,p_artifact text,p_generation bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_set_pointer_pre_g_inputs(p_run,p_name,p_selection,p_artifact,p_generation);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_set_pointer',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_set_pointer_pre_g_inputs(text,text,text,text,bigint) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_set_pointer(text,text,text,text,bigint) TO gakja_mapping;

ALTER FUNCTION gakja.shadow_cancel_run(text) RENAME TO shadow_cancel_run_pre_g_inputs;
CREATE FUNCTION gakja.shadow_cancel_run(p_run text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_cancel_run_pre_g_inputs(p_run);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_cancel_run',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_cancel_run_pre_g_inputs(text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_cancel_run(text) TO gakja_mapping;

ALTER FUNCTION gakja.shadow_mark_cleaned(text) RENAME TO shadow_mark_cleaned_pre_g_inputs;
CREATE FUNCTION gakja.shadow_mark_cleaned(p_run text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s gakja.scoped_transitions;v jsonb;
BEGIN s:=gakja.service_storage_guard();v:=gakja.shadow_mark_cleaned_pre_g_inputs(p_run);IF s.transition_id IS NOT NULL AND s.state='db-primary' THEN PERFORM gakja.transition_guard('session-write',NULL,false);PERFORM gakja.transition_record_write(s,'shadow_mark_cleaned',NULL);END IF;RETURN v;END $$;
REVOKE ALL ON FUNCTION gakja.shadow_mark_cleaned_pre_g_inputs(text) FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass;
GRANT EXECUTE ON FUNCTION gakja.shadow_mark_cleaned(text) TO gakja_mapping;

-- PR07-G integrated C/D/E/F recovery. Historical migrations stay byte-identical.
-- Provider object bytes are copied and checked by recovery.ts before this atomic
-- publication. Logical refs and canonical/signed TEXT are never rewritten.
CREATE TABLE gakja.transition_recovery_locations (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  object_id uuid NOT NULL REFERENCES gakja.storage_uploads(object_id),
  logical_bucket text NOT NULL, logical_key text NOT NULL,
  physical_bucket text NOT NULL, physical_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>0), content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(owner_id,student_id,application_target_id,object_id),
  UNIQUE(physical_bucket,physical_key),
  CHECK((logical_bucket,logical_key) IS DISTINCT FROM (physical_bucket,physical_key)),
  FOREIGN KEY(owner_id,student_id,application_target_id) REFERENCES gakja.application_targets(owner_id,student_id,application_target_id)
);
CREATE TABLE gakja.transition_recovery_publications (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  metadata_sha256 text NOT NULL CHECK(metadata_sha256=gakja.session_text_sha(metadata_json)),
  metadata_json text NOT NULL, locations_json text NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,student_id,application_target_id),
  FOREIGN KEY(owner_id,student_id,application_target_id) REFERENCES gakja.application_targets(owner_id,student_id,application_target_id)
);
CREATE FUNCTION gakja.transition_recovery_tables() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY['common_versions','target_versions','common_pointers','target_pointers','private_objects','common_private_objects','legacy_mappings','common_legacy_mappings',
 'session_bindings','audio_bindings','job_bindings','worker_job_grants','storage_uploads','storage_audio_links','common_storage_version_links','target_storage_version_links',
 'shadow_runs','shadow_artifacts','shadow_aliases','shadow_dependencies','shadow_pointers','shadow_history','shadow_pointer_history','service_input_approvals',
 'session_command_sessions','session_commands','session_command_keys','session_command_semantics','session_command_attempts','session_mandatory_events','session_answer_facts','session_end_intents','session_evaluation_handoffs','session_connection_closes',
 'evaluation_scopes','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_consumptions','evaluation_consumption_history','evaluation_command_receipts','evaluation_worker_grants','evaluation_checkpoints','evaluation_usage','evaluation_results','evaluation_result_revisions','evaluation_projection_pointers','evaluation_audit_events']::text[]
$$;
CREATE FUNCTION gakja.transition_recovery_preserved_rows(t text,rows jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) FROM (
 SELECT x-CASE t WHEN 'session_command_sessions' THEN ARRAY['writer','writer_generation','writer_token']
   WHEN 'evaluation_sessions' THEN ARRAY['writer','fence'] WHEN 'evaluation_worker_grants' THEN ARRAY['active'] WHEN 'worker_job_grants' THEN ARRAY['active']
   WHEN 'evaluation_jobs' THEN ARRAY['lease_token','worker_id','lease_until','lease_fence'] WHEN 'service_input_approvals' THEN ARRAY['transition_id'] ELSE ARRAY[]::text[] END j
 FROM jsonb_array_elements(rows) x) p
$$;

-- Validate child rows against the archive's selected roots. No owner-wide scan
-- or caller-supplied SQL predicate is exposed to mapping/request roles.
CREATE FUNCTION gakja.transition_recovery_row_allowed(t text,r jsonb,s jsonb,roots jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE root jsonb;
BEGIN
 IF t IN ('shadow_aliases','shadow_dependencies','shadow_pointers','shadow_history','shadow_pointer_history') THEN
   RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(roots->'shadow_runs') q WHERE q->>'run_id'=r->>'run_id');
 END IF;
 IF r->>'owner_id' IS DISTINCT FROM s->>'owner_id' THEN RETURN false; END IF;
 IF r ? 'student_id' AND r->>'student_id' IS DISTINCT FROM s->>'student_id' THEN RETURN false; END IF;
 IF r ? 'application_target_id' AND r->>'application_target_id' IS NOT NULL AND r->>'application_target_id' IS DISTINCT FROM s->>'application_target_id' THEN RETURN false; END IF;
 IF r ? 'account_id' AND r->>'account_id' IS DISTINCT FROM s->>'account_id' THEN RETURN false; END IF;
 IF r ? 'student_id' THEN RETURN true; END IF;
 IF r ? 'session_id' AND r->>'session_id' IS NOT NULL THEN
   RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(roots->'session_command_sessions') q WHERE q->>'owner_id'=r->>'owner_id' AND q->>'session_id'=r->>'session_id');
 END IF;
 IF r ? 'job_id' THEN
   IF t='worker_job_grants' THEN
     RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(roots->'job_bindings') q WHERE q->>'owner_id'=r->>'owner_id' AND q->>'job_id'=r->>'job_id');
   END IF;
   RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(roots->'evaluation_jobs') q WHERE q->>'owner_id'=r->>'owner_id' AND q->>'job_id'=r->>'job_id');
 END IF;
 RETURN false;
END $$;

CREATE FUNCTION gakja.transition_recovery_dump(t text,s jsonb,roots jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rows jsonb;
BEGIN
 IF NOT t=ANY(gakja.transition_recovery_tables()) THEN RAISE EXCEPTION 'recovery table denied' USING ERRCODE='42501'; END IF;
 EXECUTE format('SELECT coalesce(jsonb_agg(j ORDER BY j::text),''[]''::jsonb) FROM (SELECT to_jsonb(r) j FROM gakja.%I r) q WHERE gakja.transition_recovery_row_allowed($1,j,$2,$3)',t)
   INTO rows USING t,s,roots;
 RETURN rows;
END $$;

CREATE FUNCTION gakja.transition_export_recovery() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope_json jsonb; state_json jsonb; roots jsonb:='{}'; tables jsonb:='{}'; rows jsonb; manifest jsonb:='[]'; objects jsonb; t text; evidence jsonb:='{}'; g_evidence jsonb:='{}';
BEGIN
 SELECT to_jsonb(gakja.transition_require_operator('export')) INTO state_json;
 state_json:=state_json||jsonb_build_object('generation',state_json->>'generation','fence',state_json->>'fence','primary_generation',state_json->>'primary_generation');
 IF state_json->>'state'<>'frozen' THEN RAISE EXCEPTION 'freeze before recovery export' USING ERRCODE='P7304'; END IF;
 scope_json:=jsonb_build_object('account_id',current_setting('gakja.account_id',true),'owner_id',current_setting('gakja.owner_id',true),
   'student_id',current_setting('gakja.student_id',true),'application_target_id',current_setting('gakja.application_target_id',true));
 -- Root selections have full student/target fields; children use these exact IDs.
 FOREACH t IN ARRAY ARRAY['shadow_runs','session_command_sessions','evaluation_jobs','job_bindings'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM gakja.%I r WHERE owner_id=$1 AND %s',t,
     CASE WHEN t='evaluation_jobs' THEN 'session_id IN(SELECT session_id FROM gakja.session_command_sessions WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3)' ELSE 'student_id=$2 AND application_target_id=$3' END)
     INTO rows USING scope_json->>'owner_id',scope_json->>'student_id',scope_json->>'application_target_id';
   roots:=roots||jsonb_build_object(t,rows);
 END LOOP;
 FOREACH t IN ARRAY gakja.transition_recovery_tables() LOOP
   rows:=gakja.transition_recovery_dump(t,scope_json,roots); tables:=tables||jsonb_build_object(t,rows);
   manifest:=manifest||jsonb_build_array(jsonb_build_object('table',t,'rows',jsonb_array_length(rows),'sha256',gakja.session_text_sha(rows::text),
     'preservedSha256',gakja.session_text_sha(gakja.transition_recovery_preserved_rows(t,rows)::text)));
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('objectId',u->>'object_id','logicalRef',jsonb_build_object('bucket',u->>'bucket','key',u->>'final_key'),
   'sizeBytes',(u->>'actual_size')::bigint,'contentSha256',u->>'actual_sha256') ORDER BY u->>'object_id'),'[]'::jsonb) INTO objects
   FROM jsonb_array_elements(tables->'storage_uploads') u WHERE u->>'state'='verified';
 -- Current mapping is provenance. Restore never inserts old account/principal,
 -- grant, operator or worker authority as an active permission.
 FOREACH t IN ARRAY ARRAY['accounts','principals','students','target_profiles','application_targets','access_grants','mapping_audit'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM gakja.%I r WHERE %s',t,
     CASE WHEN t IN ('principals','mapping_audit') THEN 'account_id=$1' WHEN t='accounts' THEN 'account_id=$1 AND owner_id=$2'
       WHEN t='students' THEN 'owner_id=$2 AND student_id=$3'
       WHEN t='target_profiles' THEN '(support_target_id,profile_revision) IN(SELECT support_target_id,profile_revision FROM gakja.application_targets WHERE owner_id=$2 AND student_id=$3 AND application_target_id=$4)'
       ELSE 'owner_id=$2 AND student_id=$3 AND application_target_id=$4' END)
     INTO rows USING scope_json->>'account_id',scope_json->>'owner_id',scope_json->>'student_id',scope_json->>'application_target_id';
   evidence:=evidence||jsonb_build_object(t,rows);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['scoped_transitions','transition_operator_grants','transition_commands','transition_history','transition_active_operations','transition_session_bindings','transition_write_facts','transition_operator_installations'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM gakja.%I r WHERE transition_id=$1',t)
     INTO rows USING (state_json->>'transition_id')::uuid;
   g_evidence:=g_evidence||jsonb_build_object(t,rows);
 END LOOP;
 RETURN jsonb_build_object('version','transition-recovery-metadata-v1','scope',scope_json,'transition',state_json,'gEvidence',g_evidence,'checkpointExportedAt',clock_timestamp(),
   'tables',tables,'tableManifest',manifest,'objects',objects,'mappingEvidence',evidence,
   'restorePolicy',jsonb_build_object('canonicalTextChanged',false,'logicalRefsChanged',false,'eWriter','read-only','fWriter','read-only',
     'oldGrantsReactivated',false,'oldLeasesReactivated',false,'readyPublication','atomic-after-all-object-verification'))::text;
END $$;

CREATE FUNCTION gakja.transition_recovery_insert(t text,rows jsonb) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE columns text; values_sql text;
BEGIN
 IF NOT t=ANY(gakja.transition_recovery_tables()) OR jsonb_typeof(rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'recovery table denied' USING ERRCODE='42501'; END IF;
 SELECT string_agg(format('%I',a.attname),',' ORDER BY a.attnum),string_agg(format('r.%I',a.attname),',' ORDER BY a.attnum) INTO columns,values_sql
 FROM pg_attribute a WHERE a.attrelid=to_regclass('gakja.'||t) AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='';
 EXECUTE format('INSERT INTO gakja.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::gakja.%I,$1)r',t,columns,values_sql,t) USING rows;
END $$;

CREATE FUNCTION gakja.transition_restore_recovery(raw_metadata text,metadata_sha text,manifest_sha text,locations jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; s jsonb; state_json jsonb; t text; rows jsonb; r jsonb; m jsonb; location jsonb; object_row jsonb; original_objects jsonb; count_objects integer;
BEGIN
 SELECT to_jsonb(gakja.transition_require_operator('restore')) INTO state_json;
 IF gakja.session_text_sha(raw_metadata) IS DISTINCT FROM metadata_sha OR manifest_sha !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'recovery checksum changed' USING ERRCODE='P7305'; END IF;
 p:=raw_metadata::jsonb; s:=p->'scope';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'version' IS DISTINCT FROM 'transition-recovery-metadata-v1' OR s->>'account_id' IS DISTINCT FROM current_setting('gakja.account_id',true)
   OR s->>'owner_id' IS DISTINCT FROM current_setting('gakja.owner_id',true) OR s->>'student_id' IS DISTINCT FROM current_setting('gakja.student_id',true)
   OR s->>'application_target_id' IS DISTINCT FROM current_setting('gakja.application_target_id',true) OR p->'transition'->>'state' IS DISTINCT FROM 'frozen'
   OR state_json->>'state' NOT IN ('blocking','verified','frozen','unprepared','restoring')
   THEN RAISE EXCEPTION 'recovery scope denied' USING ERRCODE='42501'; END IF;
 IF p->'transition'->>'account_id' IS DISTINCT FROM state_json->>'account_id' OR p->'transition'->>'owner_id' IS DISTINCT FROM state_json->>'owner_id'
   OR p->'transition'->>'student_id' IS DISTINCT FROM state_json->>'student_id' OR p->'transition'->>'application_target_id' IS DISTINCT FROM state_json->>'application_target_id'
   OR p->'transition'->>'support_target_id' IS DISTINCT FROM state_json->>'support_target_id'
   OR p->'transition'->'source_present' IS DISTINCT FROM state_json->'source_present' OR p->'transition'->'source_revision' IS DISTINCT FROM state_json->'source_revision'
   THEN RAISE EXCEPTION 'recovery current mapping differs' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p->'gEvidence') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p->'gEvidence'))<>8
   THEN RAISE EXCEPTION 'recovery G evidence incomplete' USING ERRCODE='P7305'; END IF;
 FOREACH t IN ARRAY ARRAY['scoped_transitions','transition_operator_grants','transition_commands','transition_history','transition_active_operations','transition_session_bindings','transition_write_facts','transition_operator_installations'] LOOP
   IF jsonb_typeof(p->'gEvidence'->t) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'gEvidence'->t) x WHERE x->>'transition_id' IS DISTINCT FROM p->'transition'->>'transition_id')
     THEN RAISE EXCEPTION 'recovery G evidence scope changed' USING ERRCODE='P7305'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM gakja.transition_recovery_publications q WHERE q.owner_id=s->>'owner_id' AND q.student_id=s->>'student_id' AND q.application_target_id=s->>'application_target_id') THEN
   RAISE EXCEPTION 'recovery scope already published' USING ERRCODE='P7305'; END IF;
 -- Exact table/manifest cardinality prevents hidden extra collections or a
 -- missing collection being treated as a successful empty restore.
 IF (SELECT count(*) FROM jsonb_object_keys(p->'tables'))<>cardinality(gakja.transition_recovery_tables()) OR jsonb_array_length(p->'tableManifest')<>cardinality(gakja.transition_recovery_tables())
   THEN RAISE EXCEPTION 'recovery table manifest incomplete' USING ERRCODE='P7305'; END IF;
 FOREACH t IN ARRAY gakja.transition_recovery_tables() LOOP
   rows:=p->'tables'->t;
   IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'tableManifest') x WHERE x->>'table'=t
     AND (x->>'rows')::integer=jsonb_array_length(rows) AND x->>'sha256'=gakja.session_text_sha(rows::text)) THEN RAISE EXCEPTION 'recovery table checksum changed' USING ERRCODE='P7305'; END IF;
   FOR r IN SELECT * FROM jsonb_array_elements(rows) LOOP
     IF NOT gakja.transition_recovery_row_allowed(t,r,s,p->'tables') THEN RAISE EXCEPTION 'recovery child scope denied' USING ERRCODE='42501'; END IF;
   END LOOP;
 END LOOP;
 -- Descriptor list is derived again from preserved C verified rows. A forged
 -- locations list cannot omit a verified source or substitute its hash/size.
 SELECT coalesce(jsonb_agg(jsonb_build_object('objectId',u->>'object_id','logicalRef',jsonb_build_object('bucket',u->>'bucket','key',u->>'final_key'),
   'sizeBytes',(u->>'actual_size')::bigint,'contentSha256',u->>'actual_sha256') ORDER BY u->>'object_id'),'[]'::jsonb) INTO original_objects
 FROM jsonb_array_elements(p->'tables'->'storage_uploads') u WHERE u->>'state'='verified';
 IF p->'objects' IS DISTINCT FROM original_objects OR jsonb_typeof(locations) IS DISTINCT FROM 'array' OR jsonb_array_length(locations)<>jsonb_array_length(original_objects)
   THEN RAISE EXCEPTION 'recovery objects incomplete' USING ERRCODE='P7305'; END IF;
 FOR object_row IN SELECT * FROM jsonb_array_elements(original_objects) LOOP
   SELECT x INTO location FROM jsonb_array_elements(locations) x WHERE x->>'objectId'=object_row->>'objectId';
   IF NOT FOUND OR location-ARRAY['physicalRef'] IS DISTINCT FROM object_row OR jsonb_typeof(location->'physicalRef') IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(location->'physicalRef'))<>2
     OR coalesce(location->'physicalRef'->>'bucket','')!~'^[a-z0-9][a-z0-9_-]{2,62}$'
     OR coalesce(location->'physicalRef'->>'key','')!~('^[a-zA-Z0-9_-]{8,64}/final/'||(object_row->>'objectId')||'$')
     OR location->'physicalRef'=object_row->'logicalRef' THEN RAISE EXCEPTION 'recovery locator mismatch' USING ERRCODE='P7305'; END IF;
 END LOOP;
 -- Insert only after complete validation. PK/FK collisions reject a nonempty
 -- destination; the transaction rolls back every preceding insertion.
 FOREACH t IN ARRAY gakja.transition_recovery_tables() LOOP
   rows:=p->'tables'->t;
   IF t='session_command_sessions' THEN
     SELECT coalesce(jsonb_agg(x||jsonb_build_object('writer','read-only','writer_generation',(x->>'writer_generation')::bigint+1,'writer_token',gen_random_uuid())),'[]'::jsonb) INTO rows FROM jsonb_array_elements(rows) x;
   ELSIF t='evaluation_sessions' THEN
     SELECT coalesce(jsonb_agg(x||jsonb_build_object('writer','read-only','fence',(x->>'fence')::bigint+1)),'[]'::jsonb) INTO rows FROM jsonb_array_elements(rows) x;
   ELSIF t IN ('evaluation_worker_grants','worker_job_grants') THEN
     SELECT coalesce(jsonb_agg(x||jsonb_build_object('active',false)),'[]'::jsonb) INTO rows FROM jsonb_array_elements(rows) x;
   ELSIF t='evaluation_jobs' THEN
     SELECT coalesce(jsonb_agg(x||jsonb_build_object('lease_token',NULL,'worker_id',NULL,'lease_until',NULL,'lease_fence',(x->>'lease_fence')::bigint+1)),'[]'::jsonb) INTO rows FROM jsonb_array_elements(rows) x;
   ELSIF t='service_input_approvals' THEN
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) x WHERE x->>'transition_id' IS DISTINCT FROM p->'transition'->>'transition_id') THEN
       RAISE EXCEPTION 'recovery input transition mismatch' USING ERRCODE='42501'; END IF;
     SELECT coalesce(jsonb_agg(x||jsonb_build_object('transition_id',state_json->>'transition_id')),'[]'::jsonb) INTO rows FROM jsonb_array_elements(rows) x;
   END IF;
   PERFORM gakja.transition_recovery_insert(t,rows);
 END LOOP;
 FOR location IN SELECT * FROM jsonb_array_elements(locations) LOOP
   INSERT INTO gakja.transition_recovery_locations VALUES(s->>'owner_id',s->>'student_id',s->>'application_target_id',manifest_sha,(location->>'objectId')::uuid,
     location->'logicalRef'->>'bucket',location->'logicalRef'->>'key',location->'physicalRef'->>'bucket',location->'physicalRef'->>'key',
     (location->>'sizeBytes')::bigint,location->>'contentSha256');
 END LOOP;
 -- Session association is a domain-independent transition relation, not an
 -- active grant. Rebind it to the destination transition explicitly, retaining
 -- original session IDs/generation/time so creation receipt replay remains a
 -- read. The original G rows remain exact in metadata_json as audit evidence.
 FOR r IN SELECT * FROM jsonb_array_elements(p->'gEvidence'->'transition_session_bindings') LOOP
   IF r->>'transition_id' IS DISTINCT FROM p->'transition'->>'transition_id' OR NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(p->'tables'->'session_command_sessions') q WHERE q->>'session_id'=r->>'session_id')
     THEN RAISE EXCEPTION 'recovery transition session mismatch' USING ERRCODE='42501'; END IF;
   INSERT INTO gakja.transition_session_bindings(transition_id,session_id,generation,created_at)
   VALUES((state_json->>'transition_id')::uuid,r->>'session_id',(r->>'generation')::bigint,(r->>'created_at')::timestamptz);
 END LOOP;
 PERFORM setval(pg_get_serial_sequence('gakja.evaluation_checkpoints','checkpoint_id'),coalesce((SELECT max(checkpoint_id) FROM gakja.evaluation_checkpoints),1),EXISTS(SELECT 1 FROM gakja.evaluation_checkpoints));
 INSERT INTO gakja.transition_recovery_publications(owner_id,student_id,application_target_id,manifest_sha256,metadata_sha256,metadata_json,locations_json)
 VALUES(s->>'owner_id',s->>'student_id',s->>'application_target_id',manifest_sha,metadata_sha,raw_metadata,locations::text);
 PERFORM gakja.transition_finish_recovery(manifest_sha,(p->'transition'->>'generation')::bigint);
 RETURN jsonb_build_object('version','transition-recovery-publication-v1','manifestSha256',manifest_sha,'metadataSha256',metadata_sha,
   'objects',jsonb_array_length(locations),'canonicalTextChanged',false,'logicalRefsChanged',false,'mode','read-only-recovery');
END $$;

CREATE FUNCTION gakja.transition_recovery_locations_read() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM gakja.session_guard_account();
 IF NOT gakja.can_student(current_setting('gakja.owner_id',true),current_setting('gakja.student_id',true)) THEN RAISE EXCEPTION 'recovery read denied' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('objectId',r.object_id::text,'logicalRef',jsonb_build_object('bucket',r.logical_bucket,'key',r.logical_key),
   'physicalRef',jsonb_build_object('bucket',r.physical_bucket,'key',r.physical_key),'sizeBytes',r.size_bytes,'contentSha256',r.content_sha256) ORDER BY r.object_id),'[]'::jsonb)
 FROM gakja.transition_recovery_locations r WHERE r.owner_id=current_setting('gakja.owner_id',true) AND r.student_id=current_setting('gakja.student_id',true) AND r.application_target_id=current_setting('gakja.application_target_id',true));
END $$;
CREATE FUNCTION gakja.transition_reexport_recovery() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE state_json jsonb; s jsonb; roots jsonb:='{}'; tables jsonb:='{}'; rows jsonb; t text; archive gakja.transition_recovery_publications; manifest jsonb:='[]';
BEGIN
 SELECT to_jsonb(gakja.transition_current()) INTO state_json;
 IF state_json->>'state' IS DISTINCT FROM 'read-only-recovery' THEN RAISE EXCEPTION 'recovery is not published' USING ERRCODE='42501'; END IF;
 s:=jsonb_build_object('account_id',current_setting('gakja.account_id',true),'owner_id',current_setting('gakja.owner_id',true),
   'student_id',current_setting('gakja.student_id',true),'application_target_id',current_setting('gakja.application_target_id',true));
 SELECT * INTO archive FROM gakja.transition_recovery_publications p WHERE p.owner_id=s->>'owner_id' AND p.student_id=s->>'student_id' AND p.application_target_id=s->>'application_target_id';
 IF NOT FOUND THEN RAISE EXCEPTION 'recovery archive absent' USING ERRCODE='P7305'; END IF;
 FOREACH t IN ARRAY ARRAY['shadow_runs','session_command_sessions','evaluation_jobs','job_bindings'] LOOP
   EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM gakja.%I r WHERE owner_id=$1 AND %s',t,
     CASE WHEN t='evaluation_jobs' THEN 'session_id IN(SELECT session_id FROM gakja.session_command_sessions WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3)' ELSE 'student_id=$2 AND application_target_id=$3' END)
     INTO rows USING s->>'owner_id',s->>'student_id',s->>'application_target_id';
   roots:=roots||jsonb_build_object(t,rows);
 END LOOP;
 FOREACH t IN ARRAY gakja.transition_recovery_tables() LOOP
   rows:=gakja.transition_recovery_dump(t,s,roots); tables:=tables||jsonb_build_object(t,rows);
   manifest:=manifest||jsonb_build_array(jsonb_build_object('table',t,'rows',jsonb_array_length(rows),'preservedSha256',gakja.session_text_sha(gakja.transition_recovery_preserved_rows(t,rows)::text)));
 END LOOP;
 RETURN jsonb_build_object('version','transition-recovery-reexport-v1','tables',tables,'preservedManifest',manifest,'originalMetadataJson',archive.metadata_json,
   'originalMetadataSha256',archive.metadata_sha256,'manifestSha256',archive.manifest_sha256,'locations',archive.locations_json::jsonb,'transition',state_json);
END $$;
DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['transition_recovery_locations','transition_recovery_publications'] LOOP
   EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY recovery_owner_management ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',t);
   EXECUTE format('CREATE TRIGGER recovery_fact_immutable BEFORE UPDATE OR DELETE ON gakja.%I FOR EACH ROW EXECUTE FUNCTION gakja.evaluation_fact_immutable()',t);
   EXECUTE format('REVOKE ALL ON gakja.%I FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gakja' AND p.proname LIKE 'transition%recovery%' LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,gakja_request,gakja_mapping,gakja_worker,gakja_bypass',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION gakja.transition_export_recovery(),gakja.transition_restore_recovery(text,text,text,jsonb),gakja.transition_reexport_recovery() TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.transition_recovery_locations_read() TO gakja_request;

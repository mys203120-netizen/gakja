-- PR07-D adds only isolated read-shadow metadata; B/C SQL bytes stay immutable.
ALTER TABLE gakja.storage_uploads DROP CONSTRAINT storage_uploads_kind_check;
ALTER TABLE gakja.storage_uploads ADD CONSTRAINT storage_uploads_kind_check CHECK
  (kind IN ('source-pdf','source-markdown','source-json','analysis-json','audio','review-bundle','review-journal','source-image'));
ALTER TABLE gakja.storage_uploads ADD COLUMN media_type text CHECK
  (media_type IS NULL OR (kind='audio' AND media_type IN ('audio/wav','audio/mpeg'))
    OR (kind='source-image' AND media_type IN ('image/png','image/jpeg')));
ALTER TABLE gakja.storage_uploads ADD COLUMN domain_pin_key text GENERATED ALWAYS AS
  (CASE WHEN NOT domain_present THEN 'absent' WHEN domain_sha256 IS NULL THEN 'null' ELSE 'string:'||domain_sha256 END) STORED;
ALTER TABLE gakja.storage_uploads ADD COLUMN binding_media_type text GENERATED ALWAYS AS
  (CASE WHEN kind='audio' THEN coalesce(media_type,'audio/wav') WHEN kind='source-image' THEN media_type ELSE 'none' END) STORED;
ALTER TABLE gakja.storage_uploads ADD CONSTRAINT storage_verified_image_media CHECK
  (state <> 'verified' OR kind <> 'source-image' OR media_type IS NOT NULL);
ALTER TABLE gakja.storage_uploads ADD CONSTRAINT storage_shadow_exact_identity UNIQUE
  (owner_id,student_id,scope_kind,scope_key,receipt_id,object_id,kind,source_pin_key,domain_pin_key,expected_size,expected_sha256,binding_media_type);
CREATE OR REPLACE FUNCTION gakja.storage_identity_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(OLD)-ARRAY['state','revision','actual_size','actual_sha256','verified_at','cleanup_state','scope_key','source_pin_key','domain_pin_key','binding_media_type','media_type'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','revision','actual_size','actual_sha256','verified_at','cleanup_state','scope_key','source_pin_key','domain_pin_key','binding_media_type','media_type']) THEN
    RAISE EXCEPTION 'storage identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.media_type IS DISTINCT FROM NEW.media_type AND
    (OLD.media_type IS NOT NULL OR OLD.state NOT IN ('pending','uploading') OR NEW.media_type IS NULL) THEN
    RAISE EXCEPTION 'storage media is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION 'storage revision must advance once' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION gakja.storage_receipt_json(u gakja.storage_uploads) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('receiptId',u.receipt_id::text,'objectId',u.object_id::text,
    'scope',jsonb_build_object('kind',u.scope_kind,'ownerId',u.owner_id,'studentId',u.student_id)||
      CASE WHEN u.scope_kind='target' THEN jsonb_build_object('applicationTargetId',u.application_target_id,'supportTargetId',u.support_target_id) ELSE '{}'::jsonb END,
    'kind',u.kind,'state',u.state,'revision',u.revision::text,'expectedSize',u.expected_size,'expectedSha256',u.expected_sha256,
    'actualSize',u.actual_size,'actualSha256',u.actual_sha256,'stagingRef',jsonb_build_object('bucket',u.bucket,'key',u.staging_key),
    'finalRef',jsonb_build_object('bucket',u.bucket,'key',u.final_key),'expiresAt',floor(extract(epoch FROM u.expires_at)*1000)::bigint,'cleanupState',u.cleanup_state)||
    CASE WHEN u.source_present THEN jsonb_build_object('sourceRevision',u.source_revision) ELSE '{}'::jsonb END||
    CASE WHEN u.domain_present THEN jsonb_build_object('domainSha256',u.domain_sha256) ELSE '{}'::jsonb END||
    CASE WHEN u.binding_media_type IS DISTINCT FROM 'none' AND u.binding_media_type IS NOT NULL THEN jsonb_build_object('mediaType',u.binding_media_type) ELSE '{}'::jsonb END
$$;
CREATE FUNCTION gakja.storage_set_media_type(p_receipt uuid,p_revision bigint,p_media text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u gakja.storage_uploads;
BEGIN
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt FOR UPDATE;
  IF NOT FOUND OR NOT gakja.storage_can_read(u) THEN RETURN NULL; END IF;
  IF NOT ((u.kind='audio' AND p_media IN ('audio/wav','audio/mpeg')) OR (u.kind='source-image' AND p_media IN ('image/png','image/jpeg'))) THEN
    RAISE EXCEPTION 'storage media denied' USING ERRCODE='22023'; END IF;
  IF u.media_type=p_media OR (u.state='verified' AND u.kind='audio' AND u.media_type IS NULL AND p_media='audio/wav') THEN
    RETURN gakja.storage_receipt_json(u);
  END IF;
  IF u.revision<>p_revision OR u.state NOT IN ('pending','uploading') THEN RETURN NULL; END IF;
  IF u.media_type IS NOT NULL THEN
    IF u.media_type<>p_media THEN RAISE EXCEPTION 'storage media conflict' USING ERRCODE='23505'; END IF;
    RETURN gakja.storage_receipt_json(u);
  END IF;
  UPDATE gakja.storage_uploads SET media_type=p_media,revision=revision+1 WHERE receipt_id=p_receipt RETURNING * INTO u;
  RETURN gakja.storage_receipt_json(u);
END $$;

CREATE TABLE gakja.shadow_runs (
  run_id text PRIMARY KEY CHECK (run_id ~ '^[a-z0-9_-]{8,128}$'),
  account_id text NOT NULL, owner_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL, support_target_id text NOT NULL,
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  binding text NOT NULL CHECK (binding IN ('synthetic','local-verification-only')),
  original_plan jsonb NOT NULL CHECK (jsonb_typeof(original_plan)='object'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','cancelled','cleaned')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id,owner_id) REFERENCES gakja.accounts(account_id,owner_id),
  FOREIGN KEY (owner_id,student_id,application_target_id,support_target_id)
    REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
  UNIQUE (run_id,owner_id,student_id)
);
CREATE TABLE gakja.shadow_artifacts (
  run_id text NOT NULL, artifact_id text NOT NULL CHECK (gakja.is_trimmed_identifier(artifact_id) AND length(artifact_id)<=128),
  owner_id text NOT NULL, student_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('common','target')),
  application_target_id text, support_target_id text,
  scope_key text GENERATED ALWAYS AS (CASE WHEN scope_kind='common' THEN 'common' ELSE 'target:'||application_target_id END) STORED,
  role text NOT NULL CHECK (gakja.is_trimmed_identifier(role) AND length(role)<=128),
  locator_id text NOT NULL CHECK (gakja.is_trimmed_identifier(locator_id) AND length(locator_id)<=256),
  reference text NOT NULL CHECK (gakja.is_trimmed_identifier(reference) AND length(reference)<=4096),
  selection text NOT NULL CHECK (selection IN ('current','staged','pinned','historical','revision','review-parent','configured','dependency')),
  availability text NOT NULL CHECK (availability IN ('present','absent')),
  required boolean NOT NULL,
  object_kind text, expected_size bigint, expected_sha256 text,
  source_present boolean NOT NULL, source_revision text,
  source_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:'||source_revision END) STORED,
  domain_present boolean NOT NULL, domain_sha256 text,
  domain_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT domain_present THEN 'absent' WHEN domain_sha256 IS NULL THEN 'null' ELSE 'string:'||domain_sha256 END) STORED,
  media_type text NOT NULL DEFAULT 'none',
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec)='object'),
  receipt_id uuid, object_id uuid UNIQUE, bound_object_revision bigint,
  status text NOT NULL CHECK (status IN ('planned','staged','bound','quarantined','absent')),
  PRIMARY KEY (run_id,artifact_id),
  UNIQUE (run_id,scope_key,locator_id),
  FOREIGN KEY (run_id,owner_id,student_id) REFERENCES gakja.shadow_runs(run_id,owner_id,student_id),
  FOREIGN KEY (owner_id,student_id,application_target_id,support_target_id)
    REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
  FOREIGN KEY (owner_id,student_id,scope_kind,scope_key,receipt_id,object_id,object_kind,source_pin_key,domain_pin_key,expected_size,expected_sha256,media_type)
    REFERENCES gakja.storage_uploads(owner_id,student_id,scope_kind,scope_key,receipt_id,object_id,kind,source_pin_key,domain_pin_key,expected_size,expected_sha256,binding_media_type),
  CHECK ((scope_kind='common' AND application_target_id IS NULL AND support_target_id IS NULL)
    OR (scope_kind='target' AND application_target_id IS NOT NULL AND support_target_id IS NOT NULL)),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  CHECK ((domain_present OR domain_sha256 IS NULL) AND (domain_sha256 IS NULL OR domain_sha256 ~ '^[a-f0-9]{64}$')),
  CHECK ((receipt_id IS NULL)=(object_id IS NULL)),
  CHECK (bound_object_revision IS NULL OR bound_object_revision>0),
  CHECK ((availability='absent' AND NOT required AND object_kind IS NULL AND expected_size IS NULL AND expected_sha256 IS NULL
      AND NOT domain_present AND domain_sha256 IS NULL AND receipt_id IS NULL AND status='absent' AND spec->>'absenceReason'='known-absent')
    OR (availability='present' AND object_kind IN ('source-pdf','source-markdown','source-json','analysis-json','audio','review-bundle','review-journal','source-image')
      AND expected_size BETWEEN 1 AND 67108864 AND expected_sha256 ~ '^[a-f0-9]{64}$' AND status<>'absent')),
  CHECK (status NOT IN ('staged','bound') OR receipt_id IS NOT NULL),
  CHECK (status<>'bound' OR bound_object_revision IS NOT NULL),
  CHECK ((object_kind='audio' AND media_type IN ('audio/wav','audio/mpeg'))
    OR (object_kind='source-image' AND media_type IN ('image/png','image/jpeg'))
    OR (coalesce(object_kind,'none') NOT IN ('audio','source-image') AND media_type='none'))
);
CREATE UNIQUE INDEX shadow_artifacts_legacy_pin ON gakja.shadow_artifacts
  (run_id,scope_key,role,source_pin_key,(spec->>'legacyId'),
    (CASE WHEN NOT spec ? 'originalPin' THEN 'absent' WHEN spec->'originalPin'='null'::jsonb THEN 'null' ELSE 'string:'||(spec->>'originalPin') END),
    (CASE WHEN NOT spec ? 'versionId' THEN 'absent' WHEN spec->'versionId'='null'::jsonb THEN 'null' ELSE 'string:'||(spec->>'versionId') END))
  WHERE spec->>'legacyId' IS NOT NULL;
CREATE TABLE gakja.shadow_aliases (
  run_id text NOT NULL, role text NOT NULL, reference_key text NOT NULL, selection_key text NOT NULL,
  artifact_id text NOT NULL, PRIMARY KEY (run_id,role,reference_key,selection_key),
  FOREIGN KEY (run_id,artifact_id) REFERENCES gakja.shadow_artifacts(run_id,artifact_id)
);
CREATE TABLE gakja.shadow_dependencies (
  run_id text NOT NULL, artifact_id text NOT NULL, dependency_id text NOT NULL, required boolean NOT NULL,
  PRIMARY KEY (run_id,artifact_id,dependency_id),
  FOREIGN KEY (run_id,artifact_id) REFERENCES gakja.shadow_artifacts(run_id,artifact_id),
  FOREIGN KEY (run_id,dependency_id) REFERENCES gakja.shadow_artifacts(run_id,artifact_id),
  CHECK (artifact_id<>dependency_id)
);
CREATE TABLE gakja.shadow_pointers (
  run_id text NOT NULL, name text NOT NULL CHECK (gakja.is_trimmed_identifier(name) AND length(name)<=128),
  selection text NOT NULL CHECK (selection IN ('current','staged','pinned','historical','revision','review-parent','configured','dependency')),
  artifact_id text NOT NULL, generation bigint NOT NULL CHECK (generation>0),
  PRIMARY KEY (run_id,name,selection),
  FOREIGN KEY (run_id,artifact_id) REFERENCES gakja.shadow_artifacts(run_id,artifact_id)
);
CREATE TABLE gakja.shadow_history (
  run_id text NOT NULL REFERENCES gakja.shadow_runs(run_id), generation bigint NOT NULL,
  event text NOT NULL, artifact_id text, pointer_name text, actor text NOT NULL DEFAULT session_user,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(run_id,generation)
);
CREATE TABLE gakja.shadow_pointer_history (
  run_id text NOT NULL, name text NOT NULL, selection text NOT NULL, generation bigint NOT NULL,
  artifact_id text NOT NULL, run_generation bigint NOT NULL,
  PRIMARY KEY(run_id,name,selection,generation),
  FOREIGN KEY(run_id,artifact_id) REFERENCES gakja.shadow_artifacts(run_id,artifact_id),
  FOREIGN KEY(run_id,run_generation) REFERENCES gakja.shadow_history(run_id,generation)
);
CREATE INDEX shadow_artifacts_lookup ON gakja.shadow_artifacts(run_id,role,reference,selection);
CREATE INDEX shadow_artifacts_receipt ON gakja.shadow_artifacts(receipt_id) WHERE receipt_id IS NOT NULL;

CREATE FUNCTION gakja.shadow_run_authorized(r gakja.shadow_runs) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT r.owner_id=nullif(current_setting('gakja.owner_id',true),'')
    AND r.student_id=nullif(current_setting('gakja.student_id',true),'')
    AND r.application_target_id=nullif(current_setting('gakja.application_target_id',true),'')
    AND gakja.can_student(r.owner_id,r.student_id)
$$;
CREATE FUNCTION gakja.shadow_artifact_authorized(a gakja.shadow_artifacts) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM gakja.shadow_runs r WHERE r.run_id=a.run_id AND gakja.shadow_run_authorized(r))
    AND (CASE WHEN a.scope_kind='common' THEN gakja.can_student_version(a.owner_id,a.student_id,a.source_present,a.source_revision)
      ELSE gakja.can_target(a.owner_id,a.student_id,a.application_target_id,a.source_present,a.source_revision) END)
$$;
CREATE FUNCTION gakja.shadow_object_current(a gakja.shadow_artifacts) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.availability='absent' OR (a.status='bound' AND EXISTS(SELECT 1 FROM gakja.storage_uploads u WHERE u.receipt_id=a.receipt_id
    AND u.object_id=a.object_id AND u.state='verified' AND u.revision=a.bound_object_revision AND gakja.storage_can_read(u)))
$$;
CREATE FUNCTION gakja.shadow_run_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(OLD)-ARRAY['state','generation']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','generation'])
    OR NEW.generation<>OLD.generation+1 THEN RAISE EXCEPTION 'shadow run is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shadow_run_immutable BEFORE UPDATE ON gakja.shadow_runs FOR EACH ROW EXECUTE FUNCTION gakja.shadow_run_immutable();
CREATE FUNCTION gakja.shadow_artifact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(OLD)-ARRAY['status','receipt_id','object_id','bound_object_revision','scope_key','source_pin_key','domain_pin_key'])
    IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','receipt_id','object_id','bound_object_revision','scope_key','source_pin_key','domain_pin_key'])
    OR (OLD.receipt_id IS NOT NULL AND (OLD.receipt_id IS DISTINCT FROM NEW.receipt_id OR OLD.object_id IS DISTINCT FROM NEW.object_id))
    OR (OLD.status='quarantined' AND NEW.status<>'quarantined') THEN
    RAISE EXCEPTION 'shadow artifact identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shadow_artifact_immutable BEFORE UPDATE ON gakja.shadow_artifacts FOR EACH ROW EXECUTE FUNCTION gakja.shadow_artifact_immutable();
CREATE FUNCTION gakja.shadow_advance(p_run text,p_event text,p_artifact text DEFAULT NULL,p_pointer text DEFAULT NULL,p_state text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE value bigint;
BEGIN
  UPDATE gakja.shadow_runs SET generation=generation+1,state=coalesce(p_state,state) WHERE run_id=p_run RETURNING generation INTO value;
  INSERT INTO gakja.shadow_history(run_id,generation,event,artifact_id,pointer_name) VALUES(p_run,value,p_event,p_artifact,p_pointer);
  RETURN value;
END $$;
CREATE FUNCTION gakja.shadow_record_json(a gakja.shadow_artifacts) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (a.spec-'scope')||jsonb_build_object('runId',a.run_id,'scope',jsonb_build_object('kind',a.scope_kind,'ownerId',a.owner_id,'studentId',a.student_id)||
      CASE WHEN a.scope_kind='target' THEN jsonb_build_object('applicationTargetId',a.application_target_id,'supportTargetId',a.support_target_id) ELSE '{}'::jsonb END,
    'status',a.status,'generation',r.generation::text,'snapshotToken',r.generation::text)||
    CASE WHEN a.receipt_id IS NOT NULL THEN jsonb_build_object('receiptId',a.receipt_id::text,'objectId',a.object_id::text) ELSE '{}'::jsonb END||
    CASE WHEN a.bound_object_revision IS NOT NULL THEN jsonb_build_object('objectRevision',a.bound_object_revision::text) ELSE '{}'::jsonb END||
    CASE WHEN a.status='bound' AND u.state='verified' AND u.revision=a.bound_object_revision AND gakja.storage_can_read(u)
      THEN jsonb_build_object('object',gakja.storage_verified_json(u)) ELSE '{}'::jsonb END
  FROM gakja.shadow_runs r LEFT JOIN gakja.storage_uploads u ON u.receipt_id=a.receipt_id WHERE r.run_id=a.run_id
$$;
CREATE FUNCTION gakja.shadow_snapshot_json(r gakja.shadow_runs) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('runId',r.run_id,'planSha256',r.plan_sha256,'binding',r.binding,'ownerId',r.owner_id,'studentId',r.student_id,
    'applicationTargetId',r.application_target_id,'supportTargetId',r.support_target_id,'state',r.state,'generation',r.generation::text,'snapshotToken',r.generation::text,
    'artifacts',coalesce((SELECT jsonb_agg(gakja.shadow_record_json(a) ORDER BY a.artifact_id) FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id),'[]'::jsonb),
    'pointers',coalesce((SELECT jsonb_agg(jsonb_build_object('name',p.name,'selection',p.selection,'artifactId',p.artifact_id,'generation',p.generation::text)
      ORDER BY p.name,p.selection) FROM gakja.shadow_pointers p WHERE p.run_id=r.run_id),'[]'::jsonb),
    'plannedPointers',coalesce(r.original_plan->'pointers','[]'::jsonb))||
    CASE WHEN r.original_plan ? 'provenanceOwnerId' THEN jsonb_build_object('provenanceOwnerId',r.original_plan->'provenanceOwnerId') ELSE '{}'::jsonb END
$$;
CREATE FUNCTION gakja.shadow_capture(p_run text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT gakja.shadow_snapshot_json(r) FROM gakja.shadow_runs r WHERE r.run_id=p_run AND gakja.shadow_run_authorized(r)
    AND NOT EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id AND NOT gakja.shadow_artifact_authorized(a))
$$;

CREATE OR REPLACE FUNCTION gakja.storage_admit(p jsonb) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u gakja.storage_uploads; old_u gakja.storage_uploads; owner_key text; account_key text; app_key text; support_key text;
  object_key uuid := gen_random_uuid(); receipt_key uuid := gen_random_uuid(); duration integer;
BEGIN
  IF jsonb_typeof(p) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k <> ALL(ARRAY[
    'scope','studentId','applicationTargetId','supportTargetId','kind','sourcePresent','sourceRevision','domainPresent','domainSha256',
    'expectedSize','expectedSha256','idempotencyKey','bucket','keyPrefix','expiresInSeconds'])) THEN
    RAISE EXCEPTION 'invalid storage admission' USING ERRCODE='22023';
  END IF;
  owner_key:=nullif(current_setting('gakja.owner_id',true),''); account_key:=nullif(current_setting('gakja.account_id',true),'');
  app_key:=CASE WHEN p->>'scope'='target' THEN p->>'applicationTargetId' ELSE NULL END;
  support_key:=CASE WHEN p->>'scope'='target' THEN p->>'supportTargetId' ELSE NULL END;
  duration:=coalesce((p->>'expiresInSeconds')::integer,900);
  IF p->>'scope' NOT IN ('common','target') OR p->>'kind' NOT IN ('source-pdf','source-markdown','source-json','analysis-json','audio','review-bundle','review-journal','source-image')
    OR jsonb_typeof(p->'sourcePresent') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p->'domainPresent') IS DISTINCT FROM 'boolean'
    OR (p ? 'sourceRevision' AND jsonb_typeof(p->'sourceRevision') NOT IN ('string','null'))
    OR (p ? 'domainSha256' AND jsonb_typeof(p->'domainSha256') NOT IN ('string','null'))
    OR (p->>'scope'='common' AND (p->>'applicationTargetId' IS NOT NULL OR p->>'supportTargetId' IS NOT NULL))
    OR duration NOT BETWEEN 1 AND 900 OR NOT gakja.valid_account(owner_key)
    OR NOT (CASE WHEN p->>'scope'='common' THEN gakja.can_student_version(owner_key,p->>'studentId',(p->>'sourcePresent')::boolean,p->>'sourceRevision')
      ELSE gakja.can_target(owner_key,p->>'studentId',app_key,(p->>'sourcePresent')::boolean,p->>'sourceRevision') END) THEN
    RAISE EXCEPTION 'storage admission denied' USING ERRCODE='42501';
  END IF;
  INSERT INTO gakja.storage_uploads(receipt_id,object_id,account_id,owner_id,student_id,scope_kind,application_target_id,support_target_id,
    kind,source_present,source_revision,domain_present,domain_sha256,expected_size,expected_sha256,bucket,key_prefix,staging_key,final_key,idempotency_key,expires_at)
    VALUES(receipt_key,object_key,account_key,owner_key,p->>'studentId',p->>'scope',app_key,support_key,
      p->>'kind',(p->>'sourcePresent')::boolean,p->>'sourceRevision',(p->>'domainPresent')::boolean,p->>'domainSha256',
      (p->>'expectedSize')::bigint,p->>'expectedSha256',p->>'bucket',p->>'keyPrefix',
      (p->>'keyPrefix')||'/staging/'||object_key::text,(p->>'keyPrefix')||'/final/'||object_key::text,p->>'idempotencyKey',clock_timestamp()+make_interval(secs=>duration))
    ON CONFLICT(owner_id,student_id,scope_key,idempotency_key) DO NOTHING RETURNING * INTO u;
  IF FOUND THEN RETURN gakja.storage_receipt_json(u); END IF;
  SELECT * INTO old_u FROM gakja.storage_uploads WHERE owner_id=owner_key AND student_id=p->>'studentId'
    AND scope_key=CASE WHEN p->>'scope'='common' THEN 'common' ELSE 'target:'||app_key END AND idempotency_key=p->>'idempotencyKey';
  IF old_u.account_id IS DISTINCT FROM account_key OR old_u.kind IS DISTINCT FROM p->>'kind'
    OR old_u.source_present IS DISTINCT FROM (p->>'sourcePresent')::boolean OR old_u.source_revision IS DISTINCT FROM p->>'sourceRevision'
    OR old_u.domain_present IS DISTINCT FROM (p->>'domainPresent')::boolean OR old_u.domain_sha256 IS DISTINCT FROM p->>'domainSha256'
    OR old_u.expected_size IS DISTINCT FROM (p->>'expectedSize')::bigint OR old_u.expected_sha256 IS DISTINCT FROM p->>'expectedSha256'
    OR old_u.bucket IS DISTINCT FROM p->>'bucket' OR old_u.key_prefix IS DISTINCT FROM p->>'keyPrefix'
    OR old_u.support_target_id IS DISTINCT FROM support_key THEN
    RAISE EXCEPTION 'storage idempotency conflict' USING ERRCODE='23505';
  END IF;
  RETURN gakja.storage_receipt_json(old_u);
END $$;

CREATE FUNCTION gakja.shadow_register_run(p jsonb) RETURNS jsonb LANGUAGE plpgsql
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

CREATE FUNCTION gakja.shadow_note_receipt(p_run text,p_artifact text,p_receipt uuid) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs; a gakja.shadow_artifacts; u gakja.storage_uploads;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  SELECT * INTO a FROM gakja.shadow_artifacts WHERE run_id=p_run AND artifact_id=p_artifact FOR UPDATE;
  IF r.run_id IS NULL OR a.artifact_id IS NULL OR NOT gakja.shadow_artifact_authorized(a) THEN RETURN NULL; END IF;
  IF a.availability<>'present' THEN RAISE EXCEPTION 'shadow artifact cannot be staged' USING ERRCODE='23514'; END IF;
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt;
  IF NOT FOUND OR NOT gakja.storage_can_read(u) THEN RETURN NULL; END IF;
  IF a.receipt_id IS NOT NULL THEN
    IF a.receipt_id<>p_receipt THEN RAISE EXCEPTION 'shadow object substitution denied' USING ERRCODE='23505'; END IF;
    RETURN gakja.shadow_record_json(a);
  END IF;
  IF r.state='cleaned' THEN RETURN NULL; END IF;
  -- A lost admission response may only be recovered for cleanup after a run
  -- was cancelled or its artifact quarantined. This never restores read or
  -- publication authority. The exact composite FK still checks every pin.
  UPDATE gakja.shadow_artifacts SET receipt_id=u.receipt_id,object_id=u.object_id,
    status=CASE WHEN r.state<>'open' OR a.status='quarantined' OR u.state IN ('cancelled','expired','rejected')
      THEN 'quarantined' ELSE 'staged' END
    WHERE run_id=p_run AND artifact_id=p_artifact RETURNING * INTO a;
  PERFORM gakja.shadow_advance(p_run,CASE WHEN a.status='quarantined' THEN 'receipt-tracking' ELSE 'receipt' END,p_artifact);
  RETURN gakja.shadow_record_json(a);
END $$;
CREATE FUNCTION gakja.shadow_bind_object(p_run text,p_artifact text,p_receipt uuid) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_run gakja.shadow_runs; a gakja.shadow_artifacts; u gakja.storage_uploads;
BEGIN
  -- Binding has no cleanup side effects. Lock/check the run before the
  -- separately permitted tracking-only receipt recovery can be invoked.
  SELECT * INTO selected_run FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  IF NOT FOUND OR selected_run.state<>'open' OR NOT gakja.shadow_run_authorized(selected_run) THEN RETURN NULL; END IF;
  PERFORM gakja.shadow_note_receipt(p_run,p_artifact,p_receipt);
  SELECT * INTO a FROM gakja.shadow_artifacts WHERE run_id=p_run AND artifact_id=p_artifact FOR UPDATE;
  IF NOT FOUND OR NOT gakja.shadow_artifact_authorized(a) OR NOT EXISTS(SELECT 1 FROM gakja.shadow_runs r WHERE r.run_id=p_run AND r.state='open') THEN RETURN NULL; END IF;
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt;
  IF u.receipt_id IS NULL OR u.state<>'verified' OR NOT gakja.storage_can_read(u) THEN RETURN NULL; END IF;
  IF a.receipt_id IS DISTINCT FROM p_receipt OR a.status='quarantined' THEN RAISE EXCEPTION 'shadow binding conflict' USING ERRCODE='23505'; END IF;
  IF a.status='bound' AND a.bound_object_revision=u.revision THEN RETURN gakja.shadow_record_json(a); END IF;
  UPDATE gakja.shadow_artifacts SET status='bound',bound_object_revision=u.revision WHERE run_id=p_run AND artifact_id=p_artifact RETURNING * INTO a;
  PERFORM gakja.shadow_advance(p_run,'bound',p_artifact);
  RETURN gakja.shadow_record_json(a);
END $$;
CREATE FUNCTION gakja.shadow_quarantine(p_run text,p_artifact text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs; a gakja.shadow_artifacts;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  SELECT * INTO a FROM gakja.shadow_artifacts WHERE run_id=p_run AND artifact_id=p_artifact FOR UPDATE;
  IF r.run_id IS NULL OR a.artifact_id IS NULL OR r.state<>'open' OR a.availability<>'present' OR NOT gakja.shadow_artifact_authorized(a) THEN RETURN NULL; END IF;
  IF a.status<>'quarantined' THEN
    UPDATE gakja.shadow_artifacts SET status='quarantined' WHERE run_id=p_run AND artifact_id=p_artifact RETURNING * INTO a;
    PERFORM gakja.shadow_advance(p_run,'quarantined',p_artifact);
  END IF;
  RETURN gakja.shadow_record_json(a);
END $$;
CREATE FUNCTION gakja.shadow_set_pointer(p_run text,p_name text,p_selection text,p_artifact text,p_generation bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs; a gakja.shadow_artifacts; pointer gakja.shadow_pointers; next_generation bigint;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  IF NOT FOUND OR r.state<>'open' OR NOT gakja.shadow_run_authorized(r) THEN RETURN NULL; END IF;
  SELECT * INTO a FROM gakja.shadow_artifacts WHERE run_id=p_run AND artifact_id=p_artifact;
  IF NOT FOUND OR NOT gakja.shadow_artifact_authorized(a) OR NOT gakja.shadow_object_current(a) OR a.availability<>'present' THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.original_plan->'pointers','[]'::jsonb)) p WHERE p->>'name'=p_name AND p->>'selection'=p_selection)
    OR (a.role<>p_name AND NOT EXISTS(SELECT 1 FROM gakja.shadow_aliases alias WHERE alias.run_id=p_run AND alias.artifact_id=p_artifact AND alias.role=p_name)) THEN RETURN NULL; END IF;
  IF EXISTS(WITH RECURSIVE closure(id) AS (SELECT a.artifact_id UNION SELECT d.dependency_id FROM closure c
      JOIN gakja.shadow_dependencies d ON d.run_id=p_run AND d.artifact_id=c.id)
    SELECT 1 FROM closure c JOIN gakja.shadow_artifacts dependency ON dependency.run_id=p_run AND dependency.artifact_id=c.id
      WHERE NOT gakja.shadow_artifact_authorized(dependency) OR NOT gakja.shadow_object_current(dependency)) THEN RETURN NULL; END IF;
  SELECT * INTO pointer FROM gakja.shadow_pointers WHERE run_id=p_run AND name=p_name AND selection=p_selection FOR UPDATE;
  IF (FOUND AND pointer.generation<>p_generation) OR (NOT FOUND AND p_generation<>0) THEN RETURN NULL; END IF;
  next_generation:=coalesce(pointer.generation,0)+1;
  INSERT INTO gakja.shadow_pointers VALUES(p_run,p_name,p_selection,p_artifact,next_generation)
    ON CONFLICT(run_id,name,selection) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,generation=EXCLUDED.generation;
  PERFORM gakja.shadow_advance(p_run,'pointer',p_artifact,p_name);
  SELECT generation INTO r.generation FROM gakja.shadow_runs WHERE run_id=p_run;
  INSERT INTO gakja.shadow_pointer_history VALUES(p_run,p_name,p_selection,next_generation,p_artifact,r.generation);
  RETURN jsonb_build_object('name',p_name,'selection',p_selection,'artifactId',p_artifact,'generation',next_generation::text);
END $$;
CREATE FUNCTION gakja.shadow_unchanged(p_run text,p_generation bigint) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM gakja.shadow_runs r WHERE r.run_id=p_run AND r.state='open' AND r.generation=p_generation AND gakja.shadow_run_authorized(r)
    AND NOT EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=r.run_id AND (NOT gakja.shadow_artifact_authorized(a) OR NOT gakja.shadow_object_current(a))))
$$;
CREATE FUNCTION gakja.shadow_resolve(p_run text,p_role text,p_reference text DEFAULT NULL,p_selection text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs; a gakja.shadow_artifacts; candidates integer; selected text;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run;
  IF NOT FOUND OR r.state<>'open' OR NOT gakja.shadow_run_authorized(r) THEN RETURN NULL; END IF;
  IF p_reference IS NULL AND p_selection IS NOT NULL THEN
    SELECT artifact_id INTO selected FROM gakja.shadow_pointers WHERE run_id=p_run AND name=p_role AND selection=p_selection;
  END IF;
  IF selected IS NULL THEN
    SELECT count(*),min(artifact_id) INTO candidates,selected FROM gakja.shadow_aliases
      WHERE run_id=p_run AND role=p_role AND reference_key=coalesce(p_reference,'') AND selection_key=coalesce(p_selection,'');
    IF candidates=0 AND p_reference IS NOT NULL AND p_selection IS NULL THEN
      SELECT count(DISTINCT artifact_id),min(artifact_id) INTO candidates,selected FROM gakja.shadow_aliases WHERE run_id=p_run AND role=p_role AND reference_key=p_reference;
    END IF;
    IF candidates>1 THEN RAISE EXCEPTION 'ambiguous shadow selector' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT * INTO a FROM gakja.shadow_artifacts WHERE run_id=p_run AND artifact_id=selected;
  IF NOT FOUND OR a.availability='absent' OR NOT gakja.shadow_artifact_authorized(a) OR NOT gakja.shadow_object_current(a) THEN RETURN NULL; END IF;
  IF EXISTS(WITH RECURSIVE closure(id) AS (SELECT a.artifact_id UNION SELECT d.dependency_id FROM closure c
      JOIN gakja.shadow_dependencies d ON d.run_id=p_run AND d.artifact_id=c.id)
    SELECT 1 FROM closure c JOIN gakja.shadow_artifacts dependency ON dependency.run_id=p_run AND dependency.artifact_id=c.id
      WHERE NOT gakja.shadow_artifact_authorized(dependency) OR NOT gakja.shadow_object_current(dependency)) THEN RETURN NULL; END IF;
  RETURN gakja.shadow_record_json(a);
END $$;
CREATE FUNCTION gakja.shadow_cancel_run(p_run text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  IF NOT FOUND OR NOT gakja.shadow_run_authorized(r) THEN RETURN NULL; END IF;
  IF r.state='open' THEN PERFORM gakja.shadow_advance(p_run,'cancelled',NULL,NULL,'cancelled'); END IF;
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run;
  RETURN gakja.shadow_snapshot_json(r);
END $$;
CREATE FUNCTION gakja.shadow_mark_cleaned(p_run text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r gakja.shadow_runs;
BEGIN
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run FOR UPDATE;
  IF NOT FOUND OR NOT gakja.shadow_run_authorized(r) OR r.state='open' THEN RETURN NULL; END IF;
  -- An interrupted admission may have committed before its response was lost.
  -- Unknown receipt state is not proof that a provider object never existed.
  IF EXISTS(SELECT 1 FROM gakja.shadow_artifacts a WHERE a.run_id=p_run AND a.availability='present' AND a.receipt_id IS NULL) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM gakja.shadow_artifacts a JOIN gakja.storage_uploads u ON u.receipt_id=a.receipt_id
    WHERE a.run_id=p_run AND (u.state NOT IN ('cancelled','expired','rejected') OR u.cleanup_state<>'clean')) THEN RETURN NULL; END IF;
  IF r.state<>'cleaned' THEN PERFORM gakja.shadow_advance(p_run,'cleaned',NULL,NULL,'cleaned'); END IF;
  SELECT * INTO r FROM gakja.shadow_runs WHERE run_id=p_run;
  RETURN gakja.shadow_snapshot_json(r);
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shadow_runs','shadow_artifacts','shadow_aliases','shadow_dependencies','shadow_pointers','shadow_history','shadow_pointer_history'] LOOP
    EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY shadow_owner ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',t);
    EXECUTE format('GRANT SELECT ON gakja.%I TO gakja_request',t);
  END LOOP;
END $$;
CREATE POLICY shadow_request_runs ON gakja.shadow_runs FOR SELECT TO gakja_request USING(gakja.shadow_run_authorized(shadow_runs));
CREATE POLICY shadow_request_artifacts ON gakja.shadow_artifacts FOR SELECT TO gakja_request USING(gakja.shadow_artifact_authorized(shadow_artifacts));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shadow_aliases','shadow_dependencies','shadow_pointers','shadow_history','shadow_pointer_history'] LOOP
    EXECUTE format('CREATE POLICY shadow_request_rows ON gakja.%I FOR SELECT TO gakja_request USING(EXISTS(SELECT 1 FROM gakja.shadow_runs r WHERE r.run_id=%I.run_id AND gakja.shadow_run_authorized(r)))',t,t);
  END LOOP;
END $$;
REVOKE ALL ON gakja.shadow_runs,gakja.shadow_artifacts,gakja.shadow_aliases,gakja.shadow_dependencies,gakja.shadow_pointers,gakja.shadow_history,gakja.shadow_pointer_history FROM gakja_mapping,gakja_worker,gakja_bypass;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gakja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gakja.storage_set_media_type(uuid,bigint,text) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.shadow_register_run(jsonb),gakja.shadow_note_receipt(text,text,uuid),gakja.shadow_bind_object(text,text,uuid),
  gakja.shadow_quarantine(text,text),gakja.shadow_set_pointer(text,text,text,text,bigint),gakja.shadow_cancel_run(text),gakja.shadow_mark_cleaned(text) TO gakja_mapping;
GRANT EXECUTE ON FUNCTION gakja.shadow_capture(text),gakja.shadow_resolve(text,text,text,text),gakja.shadow_unchanged(text,bigint),
  gakja.shadow_run_authorized(gakja.shadow_runs),gakja.shadow_artifact_authorized(gakja.shadow_artifacts),gakja.shadow_object_current(gakja.shadow_artifacts) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.shadow_capture(text) TO gakja_mapping;

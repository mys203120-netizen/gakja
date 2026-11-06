-- C owns only application metadata. Provider storage.* is managed by its API.
-- B metadata is not proof of a completed upload and is never promoted here.
REVOKE INSERT ON gakja.private_objects, gakja.common_private_objects FROM gakja_request;

CREATE TABLE gakja.storage_uploads (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  account_id text NOT NULL, owner_id text NOT NULL, student_id text NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('common','target')),
  application_target_id text, support_target_id text,
  scope_key text GENERATED ALWAYS AS (CASE WHEN scope_kind = 'common' THEN 'common' ELSE 'target:' || application_target_id END) STORED,
  kind text NOT NULL CHECK (kind IN ('source-pdf','source-markdown','source-json','analysis-json','audio','review-bundle')),
  source_present boolean NOT NULL, source_revision text,
  source_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:' || source_revision END) STORED,
  domain_present boolean NOT NULL, domain_sha256 text,
  expected_size bigint NOT NULL CHECK (expected_size BETWEEN 1 AND 67108864),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  actual_size bigint, actual_sha256 text,
  bucket text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9_-]{2,62}$'),
  key_prefix text NOT NULL CHECK (key_prefix ~ '^[a-z0-9_-]{8,64}$'),
  staging_key text NOT NULL UNIQUE, final_key text NOT NULL UNIQUE,
  idempotency_key text NOT NULL CHECK (gakja.is_trimmed_identifier(idempotency_key) AND length(idempotency_key) <= 200),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading','verifying','verified','rejected','cancelled','expired')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at timestamptz NOT NULL, verified_at timestamptz,
  cleanup_state text NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending','clean','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (account_id, owner_id) REFERENCES gakja.accounts(account_id,owner_id),
  FOREIGN KEY (owner_id,student_id) REFERENCES gakja.students(owner_id,student_id),
  FOREIGN KEY (owner_id,student_id,application_target_id,support_target_id)
    REFERENCES gakja.application_targets(owner_id,student_id,application_target_id,support_target_id),
  CHECK ((scope_kind = 'common' AND application_target_id IS NULL AND support_target_id IS NULL)
      OR (scope_kind = 'target' AND application_target_id IS NOT NULL AND support_target_id IS NOT NULL)),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  CHECK ((domain_present OR domain_sha256 IS NULL) AND (domain_sha256 IS NULL OR domain_sha256 ~ '^[a-f0-9]{64}$')),
  CHECK (staging_key = key_prefix || '/staging/' || object_id::text AND final_key = key_prefix || '/final/' || object_id::text),
  CHECK (actual_size IS NULL OR actual_size BETWEEN 1 AND 67108864),
  CHECK (actual_sha256 IS NULL OR actual_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (state <> 'verified' OR (actual_size IS NOT NULL AND actual_sha256 IS NOT NULL
    AND actual_size = expected_size AND actual_sha256 = expected_sha256 AND verified_at IS NOT NULL)),
  UNIQUE (owner_id,student_id,scope_key,idempotency_key),
  UNIQUE (owner_id,student_id,scope_kind,object_id,kind,source_pin_key,expected_sha256),
  UNIQUE (owner_id,student_id,scope_kind,object_id,kind,source_pin_key,expected_sha256,domain_sha256),
  UNIQUE (owner_id,student_id,application_target_id,object_id,kind,source_pin_key,expected_sha256,domain_sha256),
  UNIQUE (owner_id,student_id,application_target_id,support_target_id,object_id,kind,source_pin_key,expected_sha256)
);
CREATE INDEX storage_uploads_scope_idx ON gakja.storage_uploads(owner_id,student_id,scope_kind,application_target_id,object_id);
CREATE INDEX storage_uploads_cleanup_idx ON gakja.storage_uploads(state,cleanup_state,expires_at);
ALTER TABLE gakja.storage_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE gakja.storage_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY storage_owner_management ON gakja.storage_uploads TO gakja_owner USING (true) WITH CHECK (true);
CREATE POLICY storage_request_read ON gakja.storage_uploads FOR SELECT TO gakja_request USING
  ((scope_kind = 'common' AND gakja.can_student_version(owner_id,student_id,source_present,source_revision))
    OR (scope_kind = 'target' AND gakja.can_target(owner_id,student_id,application_target_id,source_present,source_revision)));

-- An opaque ref is issued once. Even a trusted lifecycle function cannot mutate
-- identity, expected bytes or refs after admission. Pointer changes are not part C.
CREATE FUNCTION gakja.storage_identity_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  -- Generated fields in NEW are populated after BEFORE triggers. Their immutable
  -- base fields are compared here; comparing the generated values rejects every UPDATE.
  IF (to_jsonb(OLD) - ARRAY['state','revision','actual_size','actual_sha256','verified_at','cleanup_state','scope_key','source_pin_key'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','revision','actual_size','actual_sha256','verified_at','cleanup_state','scope_key','source_pin_key']) THEN
    RAISE EXCEPTION 'storage identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'storage revision must advance once' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_identity_immutable BEFORE UPDATE ON gakja.storage_uploads FOR EACH ROW EXECUTE FUNCTION gakja.storage_identity_immutable();

CREATE FUNCTION gakja.storage_can_read(u gakja.storage_uploads) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT CASE WHEN u.scope_kind='common' THEN gakja.can_student_version(u.owner_id,u.student_id,u.source_present,u.source_revision)
    ELSE gakja.can_target(u.owner_id,u.student_id,u.application_target_id,u.source_present,u.source_revision) END
$$;
CREATE FUNCTION gakja.storage_receipt_json(u gakja.storage_uploads) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('receiptId',u.receipt_id::text,'objectId',u.object_id::text,
    'scope',jsonb_build_object('kind',u.scope_kind,'ownerId',u.owner_id,'studentId',u.student_id) ||
      CASE WHEN u.scope_kind='target' THEN jsonb_build_object('applicationTargetId',u.application_target_id,'supportTargetId',u.support_target_id) ELSE '{}'::jsonb END,
    'kind',u.kind,'state',u.state,'revision',u.revision::text,'expectedSize',u.expected_size,'expectedSha256',u.expected_sha256,
    'actualSize',u.actual_size,'actualSha256',u.actual_sha256,'stagingRef',jsonb_build_object('bucket',u.bucket,'key',u.staging_key),
    'finalRef',jsonb_build_object('bucket',u.bucket,'key',u.final_key),'expiresAt',floor(extract(epoch FROM u.expires_at)*1000)::bigint,
    'cleanupState',u.cleanup_state) ||
    CASE WHEN u.source_present THEN jsonb_build_object('sourceRevision',u.source_revision) ELSE '{}'::jsonb END ||
    CASE WHEN u.domain_present THEN jsonb_build_object('domainSha256',u.domain_sha256) ELSE '{}'::jsonb END
$$;
CREATE FUNCTION gakja.storage_verified_json(u gakja.storage_uploads) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT (gakja.storage_receipt_json(u) - ARRAY['state','expectedSize','expectedSha256','actualSize','actualSha256','stagingRef','finalRef','expiresAt','cleanupState'])
    || jsonb_build_object('ref',jsonb_build_object('bucket',u.bucket,'key',u.final_key),'sizeBytes',u.actual_size,'contentSha256',u.actual_sha256)
$$;
CREATE FUNCTION gakja.storage_get_receipt(p_receipt uuid) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT gakja.storage_receipt_json(u) FROM gakja.storage_uploads u WHERE u.receipt_id=p_receipt AND gakja.storage_can_read(u)
$$;
CREATE FUNCTION gakja.storage_get_verified(p_object uuid,p_scope text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT gakja.storage_verified_json(u) FROM gakja.storage_uploads u
  WHERE u.object_id=p_object AND (p_scope IS NULL OR p_scope=u.scope_kind) AND gakja.storage_can_read(u)
    AND u.state='verified' AND u.actual_size=u.expected_size AND u.actual_sha256=u.expected_sha256 AND u.verified_at IS NOT NULL
$$;

CREATE FUNCTION gakja.storage_admit(p jsonb) RETURNS jsonb LANGUAGE plpgsql
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
  IF p->>'scope' NOT IN ('common','target') OR p->>'kind' NOT IN ('source-pdf','source-markdown','source-json','analysis-json','audio','review-bundle')
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

CREATE FUNCTION gakja.storage_transition(p_receipt uuid,p_revision bigint,p_action text,p_size bigint DEFAULT NULL,p_sha text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u gakja.storage_uploads; next_state text;
BEGIN
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt FOR UPDATE;
  IF NOT FOUND OR NOT gakja.storage_can_read(u) THEN RETURN NULL; END IF;
  IF p_revision IS NULL AND p_action NOT IN ('cancelled','expired') THEN RETURN NULL; END IF;
  IF p_revision IS NOT NULL AND p_revision<>u.revision THEN RETURN NULL; END IF;
  IF p_action IN ('cleanup_clean','cleanup_failed') THEN
    UPDATE gakja.storage_uploads SET cleanup_state=CASE WHEN p_action='cleanup_clean' THEN 'clean' ELSE 'failed' END,revision=revision+1
      WHERE receipt_id=p_receipt RETURNING * INTO u;
    RETURN gakja.storage_receipt_json(u);
  END IF;
  IF p_action NOT IN ('uploading','verifying','verified','rejected','cancelled','expired') THEN
    RAISE EXCEPTION 'invalid storage action' USING ERRCODE='22023';
  END IF;
  IF p_action='cancelled' THEN
    IF u.state IN ('cancelled','rejected','expired') THEN RETURN gakja.storage_receipt_json(u); END IF;
    next_state:='cancelled';
  ELSIF u.state IN ('cancelled','rejected','expired','verified') THEN RETURN NULL;
  ELSIF u.expires_at<=clock_timestamp() THEN next_state:='expired';
  ELSIF p_action='expired' THEN RETURN NULL;
  ELSIF p_action='uploading' AND u.state IN ('pending','uploading') THEN
    IF u.state='uploading' THEN RETURN gakja.storage_receipt_json(u); END IF;
    next_state:='uploading';
  ELSIF p_action='verifying' AND u.state IN ('pending','uploading','verifying') THEN
    IF u.state='verifying' THEN RETURN gakja.storage_receipt_json(u); END IF;
    next_state:='verifying';
  ELSIF p_action='verified' AND u.state='verifying' THEN
    IF p_size IS DISTINCT FROM u.expected_size OR p_sha IS DISTINCT FROM u.expected_sha256 THEN
      RAISE EXCEPTION 'storage bytes do not match admission' USING ERRCODE='23514';
    END IF;
    UPDATE gakja.storage_uploads SET state='verified',actual_size=p_size,actual_sha256=p_sha,verified_at=clock_timestamp(),revision=revision+1
      WHERE receipt_id=p_receipt RETURNING * INTO u;
    RETURN gakja.storage_receipt_json(u);
  ELSIF p_action='rejected' THEN next_state:='rejected';
  ELSE RETURN NULL;
  END IF;
  UPDATE gakja.storage_uploads SET state=next_state,cleanup_state='pending',revision=revision+1 WHERE receipt_id=p_receipt RETURNING * INTO u;
  RETURN gakja.storage_receipt_json(u);
END $$;

-- New typed links extend B relationships without changing any B migration or
-- payload IDs. Source presence is part of the FK, not nullable FK bypass.
ALTER TABLE gakja.audio_bindings ADD COLUMN storage_source_pin_key text GENERATED ALWAYS AS
  (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:'||source_revision END) STORED;
ALTER TABLE gakja.audio_bindings ADD UNIQUE(owner_id,student_id,application_target_id,support_target_id,resource_id,storage_source_pin_key,content_sha256);
ALTER TABLE gakja.common_versions ADD COLUMN storage_source_pin_key text GENERATED ALWAYS AS
  (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:'||source_revision END) STORED;
ALTER TABLE gakja.common_versions ADD UNIQUE(owner_id,student_id,kind,version_id,storage_source_pin_key,content_sha256,domain_sha256);
ALTER TABLE gakja.target_versions ADD COLUMN storage_source_pin_key text GENERATED ALWAYS AS
  (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:'||source_revision END) STORED;
ALTER TABLE gakja.target_versions ADD UNIQUE(owner_id,student_id,application_target_id,kind,version_id,storage_source_pin_key,content_sha256,domain_sha256);

CREATE TABLE gakja.storage_audio_links (
  owner_id text NOT NULL,student_id text NOT NULL,application_target_id text NOT NULL,support_target_id text NOT NULL,
  resource_id text NOT NULL,object_id uuid NOT NULL,kind text NOT NULL DEFAULT 'audio' CHECK(kind='audio'),
  source_pin_key text NOT NULL,content_sha256 text NOT NULL,
  PRIMARY KEY(owner_id,resource_id),
  FOREIGN KEY(owner_id,student_id,application_target_id,support_target_id,resource_id,source_pin_key,content_sha256)
    REFERENCES gakja.audio_bindings(owner_id,student_id,application_target_id,support_target_id,resource_id,storage_source_pin_key,content_sha256),
  FOREIGN KEY(owner_id,student_id,application_target_id,support_target_id,object_id,kind,source_pin_key,content_sha256)
    REFERENCES gakja.storage_uploads(owner_id,student_id,application_target_id,support_target_id,object_id,kind,source_pin_key,expected_sha256)
);
CREATE TABLE gakja.common_storage_version_links (
  owner_id text NOT NULL,student_id text NOT NULL,version_kind text NOT NULL,version_id text NOT NULL,
  object_id uuid NOT NULL,scope_kind text NOT NULL DEFAULT 'common' CHECK(scope_kind='common'),
  kind text NOT NULL DEFAULT 'analysis-json' CHECK(kind='analysis-json'),source_pin_key text NOT NULL,
  content_sha256 text NOT NULL,domain_sha256 text NOT NULL,
  PRIMARY KEY(owner_id,student_id,version_kind,version_id),
  FOREIGN KEY(owner_id,student_id,version_kind,version_id,source_pin_key,content_sha256,domain_sha256)
    REFERENCES gakja.common_versions(owner_id,student_id,kind,version_id,storage_source_pin_key,content_sha256,domain_sha256),
  FOREIGN KEY(owner_id,student_id,scope_kind,object_id,kind,source_pin_key,content_sha256,domain_sha256)
    REFERENCES gakja.storage_uploads(owner_id,student_id,scope_kind,object_id,kind,source_pin_key,expected_sha256,domain_sha256)
);
CREATE TABLE gakja.target_storage_version_links (
  owner_id text NOT NULL,student_id text NOT NULL,application_target_id text NOT NULL,
  version_kind text NOT NULL,version_id text NOT NULL,object_id uuid NOT NULL,
  scope_kind text NOT NULL DEFAULT 'target' CHECK(scope_kind='target'),
  kind text NOT NULL DEFAULT 'analysis-json' CHECK(kind='analysis-json'),source_pin_key text NOT NULL,
  content_sha256 text NOT NULL,domain_sha256 text NOT NULL,
  PRIMARY KEY(owner_id,student_id,application_target_id,version_kind,version_id),
  FOREIGN KEY(owner_id,student_id,application_target_id,version_kind,version_id,source_pin_key,content_sha256,domain_sha256)
    REFERENCES gakja.target_versions(owner_id,student_id,application_target_id,kind,version_id,storage_source_pin_key,content_sha256,domain_sha256),
  FOREIGN KEY(owner_id,student_id,application_target_id,object_id,kind,source_pin_key,content_sha256,domain_sha256)
    REFERENCES gakja.storage_uploads(owner_id,student_id,application_target_id,object_id,kind,source_pin_key,expected_sha256,domain_sha256)
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['storage_audio_links','common_storage_version_links','target_storage_version_links'] LOOP
    EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY storage_link_owner ON gakja.%I TO gakja_owner USING(true) WITH CHECK(true)',name);
    EXECUTE format('CREATE POLICY storage_link_read ON gakja.%I FOR SELECT TO gakja_request USING(EXISTS(SELECT 1 FROM gakja.storage_uploads u WHERE u.object_id=%I.object_id AND u.state=''verified'' AND gakja.storage_can_read(u)))',name,name);
  END LOOP;
END $$;

CREATE FUNCTION gakja.storage_link_audio(p_receipt uuid,p_audio text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u gakja.storage_uploads;
BEGIN
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt AND state='verified';
  IF NOT FOUND OR NOT gakja.storage_can_read(u) OR u.scope_kind<>'target' OR u.kind<>'audio' THEN RETURN NULL; END IF;
  INSERT INTO gakja.storage_audio_links(owner_id,student_id,application_target_id,support_target_id,resource_id,object_id,source_pin_key,content_sha256)
    VALUES(u.owner_id,u.student_id,u.application_target_id,u.support_target_id,p_audio,u.object_id,u.source_pin_key,u.expected_sha256)
    ON CONFLICT(owner_id,resource_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM gakja.storage_audio_links l WHERE l.owner_id=u.owner_id AND l.resource_id=p_audio AND l.object_id=u.object_id) THEN
    RAISE EXCEPTION 'storage audio link conflict' USING ERRCODE='23505';
  END IF;
  RETURN jsonb_build_object('objectId',u.object_id::text,'scope',u.scope_kind);
END $$;
CREATE FUNCTION gakja.storage_link_version(p_receipt uuid,p_kind text,p_version text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u gakja.storage_uploads;
BEGIN
  SELECT * INTO u FROM gakja.storage_uploads WHERE receipt_id=p_receipt AND state='verified';
  IF NOT FOUND OR NOT gakja.storage_can_read(u) OR u.kind<>'analysis-json' OR NOT u.domain_present OR u.domain_sha256 IS NULL THEN RETURN NULL; END IF;
  IF u.scope_kind='common' THEN
    INSERT INTO gakja.common_storage_version_links(owner_id,student_id,version_kind,version_id,object_id,source_pin_key,content_sha256,domain_sha256)
      VALUES(u.owner_id,u.student_id,p_kind,p_version,u.object_id,u.source_pin_key,u.expected_sha256,u.domain_sha256)
      ON CONFLICT(owner_id,student_id,version_kind,version_id) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM gakja.common_storage_version_links l WHERE l.owner_id=u.owner_id AND l.student_id=u.student_id AND l.version_kind=p_kind AND l.version_id=p_version AND l.object_id=u.object_id) THEN
      RAISE EXCEPTION 'storage version link conflict' USING ERRCODE='23505';
    END IF;
  ELSE
    INSERT INTO gakja.target_storage_version_links(owner_id,student_id,application_target_id,version_kind,version_id,object_id,source_pin_key,content_sha256,domain_sha256)
      VALUES(u.owner_id,u.student_id,u.application_target_id,p_kind,p_version,u.object_id,u.source_pin_key,u.expected_sha256,u.domain_sha256)
      ON CONFLICT(owner_id,student_id,application_target_id,version_kind,version_id) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM gakja.target_storage_version_links l WHERE l.owner_id=u.owner_id AND l.student_id=u.student_id AND l.application_target_id=u.application_target_id AND l.version_kind=p_kind AND l.version_id=p_version AND l.object_id=u.object_id) THEN
      RAISE EXCEPTION 'storage version link conflict' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN jsonb_build_object('objectId',u.object_id::text,'scope',u.scope_kind);
END $$;
CREATE FUNCTION gakja.storage_audio_object(p_audio text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('objectId',u.object_id::text,'scope',u.scope_kind)
  FROM gakja.storage_audio_links l JOIN gakja.storage_uploads u ON u.object_id=l.object_id
  WHERE l.resource_id=p_audio AND u.state='verified' AND gakja.storage_can_read(u)
$$;
CREATE FUNCTION gakja.storage_version_object(p_scope text,p_kind text,p_version text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('objectId',u.object_id::text,'scope',u.scope_kind) FROM gakja.storage_uploads u
  WHERE u.scope_kind=p_scope AND u.state='verified' AND gakja.storage_can_read(u) AND
    ((p_scope='common' AND EXISTS(SELECT 1 FROM gakja.common_storage_version_links l WHERE l.object_id=u.object_id AND l.version_kind=p_kind AND l.version_id=p_version))
    OR (p_scope='target' AND EXISTS(SELECT 1 FROM gakja.target_storage_version_links l WHERE l.object_id=u.object_id AND l.version_kind=p_kind AND l.version_id=p_version)))
$$;
CREATE FUNCTION gakja.storage_legacy_object(p_scope text,p_kind text,p_legacy text,p_original_pin text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('objectId',u.object_id::text,'scope',u.scope_kind) FROM gakja.storage_uploads u
  WHERE u.scope_kind=p_scope AND u.state='verified' AND gakja.storage_can_read(u) AND
    ((p_scope='common' AND EXISTS(SELECT 1 FROM gakja.common_storage_version_links l JOIN gakja.common_legacy_mappings m
       ON m.owner_id=l.owner_id AND m.student_id=l.student_id AND m.resource_kind=l.version_kind AND m.storage_id=l.version_id
       WHERE l.object_id=u.object_id AND m.resource_kind=p_kind AND m.legacy_id=p_legacy AND m.original_pin=p_original_pin
         AND m.source_present=u.source_present AND m.source_revision IS NOT DISTINCT FROM u.source_revision))
    OR (p_scope='target' AND EXISTS(SELECT 1 FROM gakja.target_storage_version_links l JOIN gakja.legacy_mappings m
       ON m.owner_id=l.owner_id AND m.student_id=l.student_id AND m.application_target_id=l.application_target_id AND m.resource_kind=l.version_kind AND m.storage_id=l.version_id
       WHERE l.object_id=u.object_id AND m.resource_kind=p_kind AND m.legacy_id=p_legacy AND m.original_pin=p_original_pin
         AND m.source_present=u.source_present AND m.source_revision IS NOT DISTINCT FROM u.source_revision)))
$$;

REVOKE ALL ON gakja.storage_uploads,gakja.storage_audio_links,gakja.common_storage_version_links,gakja.target_storage_version_links FROM PUBLIC,gakja_mapping,gakja_request,gakja_worker;
GRANT SELECT ON gakja.storage_uploads,gakja.storage_audio_links,gakja.common_storage_version_links,gakja.target_storage_version_links TO gakja_request,gakja_bypass;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gakja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gakja.storage_can_read(gakja.storage_uploads),gakja.storage_get_receipt(uuid),gakja.storage_get_verified(uuid,text),
  gakja.storage_audio_object(text),gakja.storage_version_object(text,text,text),gakja.storage_legacy_object(text,text,text,text) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.storage_admit(jsonb),gakja.storage_transition(uuid,bigint,text,bigint,text),
  gakja.storage_link_audio(uuid,text),gakja.storage_link_version(uuid,text,text),
  gakja.resolve_account(text,text),gakja.valid_account(text) TO gakja_mapping;

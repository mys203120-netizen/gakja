-- PR07-B metadata experiment. No operational Auth, Storage or runtime writer.
-- The runner owns a marked disposable database and applies this as gakja_owner.
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
CREATE SCHEMA gakja AUTHORIZATION gakja_owner;
REVOKE ALL ON SCHEMA gakja FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gakja REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gakja REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gakja REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- Match the boundary's ECMAScript trim check by rejecting, never normalizing.
CREATE FUNCTION gakja.is_trimmed_identifier(value text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog AS $$
  SELECT value <> '' AND value = btrim(value, chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279))
$$;

CREATE TABLE gakja.accounts (
  account_id text PRIMARY KEY CHECK (btrim(account_id) <> ''),
  owner_id text NOT NULL UNIQUE CHECK (btrim(owner_id) <> ''),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (account_id, owner_id)
);
CREATE TABLE gakja.principals (
  issuer text NOT NULL CHECK (btrim(issuer) <> ''),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  account_id text NOT NULL REFERENCES gakja.accounts(account_id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX principals_account_idx ON gakja.principals(account_id);
CREATE TABLE gakja.students (
  owner_id text NOT NULL REFERENCES gakja.accounts(owner_id),
  student_id text NOT NULL CHECK (btrim(student_id) <> ''),
  display_name text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (owner_id, student_id)
);
-- Explicitly common catalog, not a nullable-owner personal table.
CREATE TABLE gakja.target_profiles (
  support_target_id text NOT NULL,
  profile_revision text NOT NULL,
  university_id text NOT NULL, department_id text NOT NULL,
  admission_track_id text NOT NULL, academic_year integer NOT NULL CHECK (academic_year BETWEEN 2000 AND 2200),
  PRIMARY KEY (support_target_id, profile_revision),
  CHECK (btrim(support_target_id) <> '' AND btrim(profile_revision) <> '')
);
CREATE TABLE gakja.application_targets (
  owner_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL CHECK (btrim(application_target_id) <> ''),
  support_target_id text NOT NULL, profile_revision text NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (owner_id, student_id, application_target_id),
  UNIQUE (owner_id, student_id, application_target_id, support_target_id),
  FOREIGN KEY (owner_id, student_id) REFERENCES gakja.students(owner_id, student_id),
  FOREIGN KEY (support_target_id, profile_revision) REFERENCES gakja.target_profiles(support_target_id, profile_revision)
);
CREATE TABLE gakja.access_grants (
  account_id text NOT NULL, owner_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, student_id, application_target_id),
  FOREIGN KEY (account_id, owner_id) REFERENCES gakja.accounts(account_id, owner_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE INDEX grants_scope_idx ON gakja.access_grants(owner_id, student_id, application_target_id) WHERE active;
CREATE TABLE gakja.session_bindings (
  owner_id text NOT NULL, session_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  context_snapshot_sha256 text NOT NULL CHECK (context_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  frozen_source_sha256 text NOT NULL CHECK (frozen_source_sha256 ~ '^[a-f0-9]{64}$'),
  source_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:' || source_revision END) STORED,
  PRIMARY KEY (owner_id, session_id),
  UNIQUE (owner_id, student_id, application_target_id, support_target_id, session_id, context_snapshot_sha256, source_pin_key),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE INDEX sessions_scope_idx ON gakja.session_bindings(owner_id, student_id, application_target_id, session_id);
CREATE TABLE gakja.audio_bindings (
  owner_id text NOT NULL, resource_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (owner_id, resource_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE INDEX audio_scope_idx ON gakja.audio_bindings(owner_id, student_id, application_target_id, resource_id);
CREATE TABLE gakja.job_bindings (
  owner_id text NOT NULL, job_id text NOT NULL CHECK (job_id ~ '^[a-f0-9]{64}$'),
  session_id text NOT NULL, student_id text NOT NULL,
  application_target_id text NOT NULL, support_target_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  context_snapshot_sha256 text NOT NULL CHECK (context_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  pipeline_version text NOT NULL, model text NOT NULL,
  source_pin_key text GENERATED ALWAYS AS (CASE WHEN NOT source_present THEN 'absent' WHEN source_revision IS NULL THEN 'null' ELSE 'string:' || source_revision END) STORED,
  PRIMARY KEY (owner_id, job_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id, session_id, context_snapshot_sha256, source_pin_key)
    REFERENCES gakja.session_bindings(owner_id, student_id, application_target_id, support_target_id, session_id, context_snapshot_sha256, source_pin_key),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE INDEX jobs_scope_idx ON gakja.job_bindings(owner_id, student_id, application_target_id, session_id);
CREATE TABLE gakja.worker_job_grants (
  worker_subject text NOT NULL CHECK (btrim(worker_subject) <> ''),
  owner_id text NOT NULL, job_id text NOT NULL,
  active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL,
  PRIMARY KEY (worker_subject, owner_id, job_id),
  FOREIGN KEY (owner_id, job_id) REFERENCES gakja.job_bindings(owner_id, job_id)
);

CREATE TABLE gakja.common_versions (
  owner_id text NOT NULL, student_id text NOT NULL, kind text NOT NULL,
  revision text NOT NULL, version_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  -- Existing TS codec/domain hash is supplied unchanged; never derived from JSONB.
  domain_sha256 text NOT NULL CHECK (domain_sha256 ~ '^[a-f0-9]{64}$'),
  original_ref text NOT NULL, original_bytes bytea NOT NULL, projection jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (owner_id, student_id, kind, revision),
  UNIQUE (owner_id, student_id, kind, version_id),
  FOREIGN KEY (owner_id, student_id) REFERENCES gakja.students(owner_id, student_id),
  CHECK (encode(sha256(original_bytes), 'hex') = content_sha256),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  CHECK (btrim(kind) <> '' AND btrim(revision) <> '' AND btrim(version_id) <> '')
);
CREATE TABLE gakja.target_versions (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  support_target_id text NOT NULL, kind text NOT NULL, revision text NOT NULL, version_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  -- Existing TS codec/domain hash is supplied unchanged; never derived from JSONB.
  domain_sha256 text NOT NULL CHECK (domain_sha256 ~ '^[a-f0-9]{64}$'),
  original_ref text NOT NULL, original_bytes bytea NOT NULL, projection jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (owner_id, student_id, application_target_id, kind, revision),
  UNIQUE (owner_id, student_id, application_target_id, kind, version_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id),
  CHECK (encode(sha256(original_bytes), 'hex') = content_sha256),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  CHECK (btrim(kind) <> '' AND btrim(revision) <> '' AND btrim(version_id) <> '')
);
CREATE TABLE gakja.common_pointers (
  owner_id text NOT NULL, student_id text NOT NULL, kind text NOT NULL, version_id text NOT NULL,
  PRIMARY KEY (owner_id, student_id, kind),
  FOREIGN KEY (owner_id, student_id, kind, version_id)
    REFERENCES gakja.common_versions(owner_id, student_id, kind, version_id)
);
CREATE TABLE gakja.target_pointers (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  kind text NOT NULL, version_id text NOT NULL,
  PRIMARY KEY (owner_id, student_id, application_target_id, kind),
  FOREIGN KEY (owner_id, student_id, application_target_id, kind, version_id)
    REFERENCES gakja.target_versions(owner_id, student_id, application_target_id, kind, version_id)
);
CREATE TABLE gakja.private_objects (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  support_target_id text NOT NULL, object_id text NOT NULL, kind text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0), content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  object_ref text NOT NULL,
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision))),
  PRIMARY KEY (owner_id, object_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id)
);
CREATE TABLE gakja.legacy_mappings (
  owner_id text NOT NULL, student_id text NOT NULL, application_target_id text NOT NULL,
  support_target_id text NOT NULL, resource_kind text NOT NULL, legacy_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  original_pin text NOT NULL, storage_id text NOT NULL, attribution_ref text NOT NULL,
  PRIMARY KEY (owner_id, student_id, application_target_id, resource_kind, legacy_id, original_pin),
  FOREIGN KEY (owner_id, student_id, application_target_id, support_target_id)
    REFERENCES gakja.application_targets(owner_id, student_id, application_target_id, support_target_id),
  FOREIGN KEY (owner_id, student_id, application_target_id, resource_kind, storage_id)
    REFERENCES gakja.target_versions(owner_id, student_id, application_target_id, kind, version_id),
  CHECK (btrim(attribution_ref) <> ''),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
-- Student-level originals/Full analysis metadata do not require a fake target.
CREATE TABLE gakja.common_private_objects (
  owner_id text NOT NULL, student_id text NOT NULL, object_id text NOT NULL, kind text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0), content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  object_ref text NOT NULL,
  PRIMARY KEY (owner_id, object_id),
  FOREIGN KEY (owner_id, student_id) REFERENCES gakja.students(owner_id, student_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE TABLE gakja.common_legacy_mappings (
  owner_id text NOT NULL, student_id text NOT NULL, resource_kind text NOT NULL, legacy_id text NOT NULL,
  source_present boolean NOT NULL, source_revision text,
  original_pin text NOT NULL, storage_id text NOT NULL, attribution_ref text NOT NULL CHECK (btrim(attribution_ref) <> ''),
  PRIMARY KEY (owner_id, student_id, resource_kind, legacy_id, original_pin),
  FOREIGN KEY (owner_id, student_id) REFERENCES gakja.students(owner_id, student_id),
  FOREIGN KEY (owner_id, student_id, resource_kind, storage_id)
    REFERENCES gakja.common_versions(owner_id, student_id, kind, version_id),
  CHECK ((source_present OR source_revision IS NULL) AND (source_revision IS NULL OR gakja.is_trimmed_identifier(source_revision)))
);
CREATE TABLE gakja.mapping_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES gakja.accounts(account_id),
  revision bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- GUCs carry already-verified backend authority; they are NOT authentication.
-- A holder of raw SQL credentials can set them. No claims-setting RPC is exposed.
CREATE FUNCTION gakja.valid_account(p_owner text) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM gakja.accounts a JOIN gakja.principals p ON p.account_id = a.account_id
    WHERE a.owner_id = p_owner AND a.owner_id = nullif(current_setting('gakja.owner_id', true), '')
      AND a.account_id = nullif(current_setting('gakja.account_id', true), '')
      AND a.revision::text = nullif(current_setting('gakja.account_revision', true), '')
      AND p.issuer = nullif(current_setting('gakja.issuer', true), '')
      AND p.subject = nullif(current_setting('gakja.subject', true), '') AND a.active AND p.active
  )
$$;
CREATE FUNCTION gakja.can_target(p_owner text, p_student text, p_target text, p_present boolean DEFAULT false, p_revision text DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT gakja.valid_account(p_owner)
    AND p_student = nullif(current_setting('gakja.student_id', true), '')
    AND p_target = nullif(current_setting('gakja.application_target_id', true), '')
    AND EXISTS (SELECT 1 FROM gakja.access_grants g
      WHERE g.account_id = current_setting('gakja.account_id', true) AND g.owner_id = p_owner
        AND g.student_id = p_student AND g.application_target_id = p_target AND g.active
        AND (NOT g.source_present OR (g.source_present = p_present AND g.source_revision IS NOT DISTINCT FROM p_revision)))
$$;
CREATE FUNCTION gakja.can_student(p_owner text, p_student text) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT gakja.valid_account(p_owner)
    AND p_student = nullif(current_setting('gakja.student_id', true), '')
    AND EXISTS (SELECT 1 FROM gakja.access_grants g WHERE g.account_id = current_setting('gakja.account_id', true)
      AND g.owner_id = p_owner AND g.student_id = p_student AND g.active
      AND g.application_target_id = nullif(current_setting('gakja.application_target_id', true), ''))
$$;
CREATE FUNCTION gakja.can_student_version(p_owner text, p_student text, p_present boolean, p_revision text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT gakja.can_student(p_owner, p_student) AND EXISTS (
    SELECT 1 FROM gakja.access_grants g WHERE g.account_id = current_setting('gakja.account_id', true)
      AND g.owner_id = p_owner AND g.student_id = p_student AND g.active
      AND g.application_target_id = nullif(current_setting('gakja.application_target_id', true), '')
      AND (NOT g.source_present OR (g.source_present = p_present AND g.source_revision IS NOT DISTINCT FROM p_revision)))
$$;
CREATE FUNCTION gakja.can_job(p_owner text, p_job text) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p_job = nullif(current_setting('gakja.job_id', true), '') AND EXISTS (
    SELECT 1 FROM gakja.worker_job_grants w JOIN gakja.accounts a ON a.owner_id = w.owner_id
    WHERE w.worker_subject = nullif(current_setting('gakja.worker_subject', true), '')
      AND w.owner_id = p_owner AND w.job_id = p_job AND w.active AND w.expires_at > statement_timestamp() AND a.active)
$$;

CREATE FUNCTION gakja.resolve_account(p_issuer text, p_subject text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('accountId', a.account_id, 'ownerId', a.owner_id, 'revision', a.revision::text,
    'grants', COALESCE((SELECT jsonb_agg(jsonb_build_object('studentId', g.student_id,
      'applicationTargetId', g.application_target_id, 'supportTargetId', g.support_target_id) ||
      CASE WHEN g.source_present THEN jsonb_build_object('sourceRevision', g.source_revision) ELSE '{}'::jsonb END
      ORDER BY g.student_id, g.application_target_id)
      FROM gakja.access_grants g WHERE g.account_id = a.account_id AND g.active), '[]'::jsonb))
  FROM gakja.principals p JOIN gakja.accounts a ON a.account_id = p.account_id
  WHERE p.issuer = p_issuer AND p.subject = p_subject AND p.active AND a.active
    AND p_issuer = nullif(current_setting('gakja.issuer', true), '')
    AND p_subject = nullif(current_setting('gakja.subject', true), '')
$$;

-- Narrow discovery returns one authorized binding before target selection.
CREATE FUNCTION gakja.resolve_session_binding(p_resource_id text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('ownerId', s.owner_id, 'studentId', s.student_id,
    'applicationTargetId', s.application_target_id, 'supportTargetId', s.support_target_id,
    'sessionId', s.session_id, 'contextSnapshotSha256', s.context_snapshot_sha256) ||
    CASE WHEN s.source_present THEN jsonb_build_object('sourceRevision', s.source_revision) ELSE '{}'::jsonb END
  FROM gakja.session_bindings s WHERE s.session_id = p_resource_id AND gakja.valid_account(s.owner_id)
    AND (nullif(current_setting('gakja.student_id', true), '') IS NULL OR s.student_id = current_setting('gakja.student_id', true))
    AND (nullif(current_setting('gakja.application_target_id', true), '') IS NULL OR s.application_target_id = current_setting('gakja.application_target_id', true))
    AND EXISTS (SELECT 1 FROM gakja.access_grants g WHERE g.account_id = current_setting('gakja.account_id', true)
      AND g.owner_id = s.owner_id AND g.student_id = s.student_id AND g.application_target_id = s.application_target_id
      AND g.active AND (NOT g.source_present OR (g.source_present = s.source_present AND g.source_revision IS NOT DISTINCT FROM s.source_revision)))
$$;
CREATE FUNCTION gakja.resolve_audio_binding(p_resource_id text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object('ownerId', s.owner_id, 'studentId', s.student_id,
    'applicationTargetId', s.application_target_id, 'supportTargetId', s.support_target_id, 'resourceId', s.resource_id) ||
    CASE WHEN s.source_present THEN jsonb_build_object('sourceRevision', s.source_revision) ELSE '{}'::jsonb END
  FROM gakja.audio_bindings s WHERE s.resource_id = p_resource_id AND gakja.valid_account(s.owner_id)
    AND (nullif(current_setting('gakja.student_id', true), '') IS NULL OR s.student_id = current_setting('gakja.student_id', true))
    AND (nullif(current_setting('gakja.application_target_id', true), '') IS NULL OR s.application_target_id = current_setting('gakja.application_target_id', true))
    AND EXISTS (SELECT 1 FROM gakja.access_grants g WHERE g.account_id = current_setting('gakja.account_id', true)
      AND g.owner_id = s.owner_id AND g.student_id = s.student_id AND g.application_target_id = s.application_target_id
      AND g.active AND (NOT g.source_present OR (g.source_present = s.source_present AND g.source_revision IS NOT DISTINCT FROM s.source_revision)))
$$;
CREATE FUNCTION gakja.resolve_job_binding(p_job_id text) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH candidates AS (
    SELECT jsonb_build_object('jobId', j.job_id, 'ownerId', j.owner_id, 'sessionId', j.session_id,
      'studentId', j.student_id, 'applicationTargetId', j.application_target_id, 'supportTargetId', j.support_target_id,
      'sourceSha256', j.source_sha256, 'snapshotSha256', j.snapshot_sha256,
      'contextSnapshotSha256', j.context_snapshot_sha256, 'pipelineVersion', j.pipeline_version, 'model', j.model) AS binding
    FROM gakja.job_bindings j WHERE j.job_id = p_job_id AND gakja.can_job(j.owner_id, j.job_id)
  ) SELECT CASE WHEN count(*) = 1 THEN jsonb_agg(binding)->0 ELSE NULL END FROM candidates
$$;

CREATE FUNCTION gakja.bump_account_revision() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE id text;
BEGIN
  id := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'mapping reassignment is unsupported';
  END IF;
  UPDATE gakja.accounts SET revision = revision + 1 WHERE account_id = id;
  INSERT INTO gakja.mapping_audit(account_id, revision, actor, action)
    SELECT account_id, revision, session_user, TG_TABLE_NAME || ':' || TG_OP FROM gakja.accounts WHERE account_id = id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER grant_revision AFTER INSERT OR UPDATE OR DELETE ON gakja.access_grants
  FOR EACH ROW EXECUTE FUNCTION gakja.bump_account_revision();
CREATE TRIGGER principal_revision AFTER INSERT OR UPDATE OR DELETE ON gakja.principals
  FOR EACH ROW EXECUTE FUNCTION gakja.bump_account_revision();

CREATE FUNCTION gakja.account_state_revision() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.active IS DISTINCT FROM NEW.active AND NEW.revision = OLD.revision THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  IF NEW.revision <> OLD.revision AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'account revision must advance exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_state_revision BEFORE UPDATE ON gakja.accounts
  FOR EACH ROW EXECUTE FUNCTION gakja.account_state_revision();
CREATE FUNCTION gakja.audit_account_state() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.revision IS DISTINCT FROM NEW.revision THEN
    INSERT INTO gakja.mapping_audit(account_id, revision, actor, action)
      VALUES (NEW.account_id, NEW.revision, session_user, 'accounts:revision');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_state_audit AFTER UPDATE ON gakja.accounts
  FOR EACH ROW EXECUTE FUNCTION gakja.audit_account_state();

-- Every personal table has FORCE RLS; privileged owner/mapper are explicit.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','principals','students','application_targets','access_grants',
    'session_bindings','audio_bindings','job_bindings','worker_job_grants','common_versions','target_versions',
    'common_pointers','target_pointers','private_objects','legacy_mappings','common_private_objects','common_legacy_mappings','mapping_audit']
  LOOP
    EXECUTE format('ALTER TABLE gakja.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gakja.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY trusted_management ON gakja.%I TO gakja_owner, gakja_mapping USING (true) WITH CHECK (true)', t);
  END LOOP;
END
$$;
CREATE POLICY request_students ON gakja.students FOR SELECT TO gakja_request USING (gakja.can_student(owner_id, student_id));
CREATE POLICY request_targets ON gakja.application_targets FOR SELECT TO gakja_request USING
  (gakja.can_student(owner_id, student_id) AND application_target_id = nullif(current_setting('gakja.application_target_id', true), ''));
CREATE POLICY request_sessions ON gakja.session_bindings FOR SELECT TO gakja_request USING
  (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY request_audio ON gakja.audio_bindings FOR SELECT TO gakja_request USING
  (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY worker_jobs ON gakja.job_bindings FOR SELECT TO gakja_worker USING (gakja.can_job(owner_id, job_id));
CREATE POLICY worker_sessions ON gakja.session_bindings FOR SELECT TO gakja_worker USING (EXISTS
  (SELECT 1 FROM gakja.job_bindings j WHERE j.owner_id = session_bindings.owner_id AND j.session_id = session_bindings.session_id AND gakja.can_job(j.owner_id, j.job_id)));
CREATE POLICY common_version_read ON gakja.common_versions FOR SELECT TO gakja_request USING (gakja.can_student_version(owner_id, student_id, source_present, source_revision));
CREATE POLICY common_version_insert ON gakja.common_versions FOR INSERT TO gakja_request WITH CHECK (gakja.can_student_version(owner_id, student_id, source_present, source_revision));
CREATE POLICY target_version_read ON gakja.target_versions FOR SELECT TO gakja_request USING (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY target_version_insert ON gakja.target_versions FOR INSERT TO gakja_request WITH CHECK (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY common_pointer_select ON gakja.common_pointers FOR SELECT TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.common_versions v WHERE v.owner_id = common_pointers.owner_id AND v.student_id = common_pointers.student_id AND v.kind = common_pointers.kind AND v.version_id = common_pointers.version_id));
CREATE POLICY common_pointer_insert ON gakja.common_pointers FOR INSERT TO gakja_request WITH CHECK (EXISTS (SELECT 1 FROM gakja.common_versions v WHERE v.owner_id = common_pointers.owner_id AND v.student_id = common_pointers.student_id AND v.kind = common_pointers.kind AND v.version_id = common_pointers.version_id));
CREATE POLICY common_pointer_update ON gakja.common_pointers FOR UPDATE TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.common_versions v WHERE v.owner_id = common_pointers.owner_id AND v.student_id = common_pointers.student_id AND v.kind = common_pointers.kind AND v.version_id = common_pointers.version_id)) WITH CHECK (EXISTS (SELECT 1 FROM gakja.common_versions v WHERE v.owner_id = common_pointers.owner_id AND v.student_id = common_pointers.student_id AND v.kind = common_pointers.kind AND v.version_id = common_pointers.version_id));
CREATE POLICY common_pointer_delete ON gakja.common_pointers FOR DELETE TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.common_versions v WHERE v.owner_id = common_pointers.owner_id AND v.student_id = common_pointers.student_id AND v.kind = common_pointers.kind AND v.version_id = common_pointers.version_id));
CREATE POLICY target_pointer_select ON gakja.target_pointers FOR SELECT TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.target_versions v WHERE v.owner_id = target_pointers.owner_id AND v.student_id = target_pointers.student_id AND v.kind = target_pointers.kind AND v.version_id = target_pointers.version_id AND v.application_target_id = target_pointers.application_target_id));
CREATE POLICY target_pointer_insert ON gakja.target_pointers FOR INSERT TO gakja_request WITH CHECK (EXISTS (SELECT 1 FROM gakja.target_versions v WHERE v.owner_id = target_pointers.owner_id AND v.student_id = target_pointers.student_id AND v.kind = target_pointers.kind AND v.version_id = target_pointers.version_id AND v.application_target_id = target_pointers.application_target_id));
CREATE POLICY target_pointer_update ON gakja.target_pointers FOR UPDATE TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.target_versions v WHERE v.owner_id = target_pointers.owner_id AND v.student_id = target_pointers.student_id AND v.kind = target_pointers.kind AND v.version_id = target_pointers.version_id AND v.application_target_id = target_pointers.application_target_id)) WITH CHECK (EXISTS (SELECT 1 FROM gakja.target_versions v WHERE v.owner_id = target_pointers.owner_id AND v.student_id = target_pointers.student_id AND v.kind = target_pointers.kind AND v.version_id = target_pointers.version_id AND v.application_target_id = target_pointers.application_target_id));
CREATE POLICY target_pointer_delete ON gakja.target_pointers FOR DELETE TO gakja_request USING (EXISTS (SELECT 1 FROM gakja.target_versions v WHERE v.owner_id = target_pointers.owner_id AND v.student_id = target_pointers.student_id AND v.kind = target_pointers.kind AND v.version_id = target_pointers.version_id AND v.application_target_id = target_pointers.application_target_id));
CREATE POLICY object_read ON gakja.private_objects FOR SELECT TO gakja_request USING (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY object_insert ON gakja.private_objects FOR INSERT TO gakja_request WITH CHECK (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));
CREATE POLICY legacy_read ON gakja.legacy_mappings FOR SELECT TO gakja_request USING (gakja.can_target(owner_id, student_id, application_target_id, source_present, source_revision));

CREATE POLICY common_object_read ON gakja.common_private_objects FOR SELECT TO gakja_request USING (gakja.can_student_version(owner_id, student_id, source_present, source_revision));
CREATE POLICY common_object_insert ON gakja.common_private_objects FOR INSERT TO gakja_request WITH CHECK (gakja.can_student_version(owner_id, student_id, source_present, source_revision));
CREATE POLICY common_legacy_read ON gakja.common_legacy_mappings FOR SELECT TO gakja_request USING (gakja.can_student_version(owner_id, student_id, source_present, source_revision));

GRANT USAGE ON SCHEMA gakja TO gakja_mapping, gakja_request, gakja_worker, gakja_bypass;
GRANT SELECT ON ALL TABLES IN SCHEMA gakja TO gakja_bypass;
GRANT SELECT ON gakja.accounts TO gakja_mapping;
GRANT INSERT (account_id, owner_id, active) ON gakja.accounts TO gakja_mapping;
GRANT UPDATE (active) ON gakja.accounts TO gakja_mapping;
GRANT SELECT, INSERT, UPDATE, DELETE ON gakja.principals, gakja.access_grants, gakja.worker_job_grants TO gakja_mapping;
GRANT SELECT, INSERT ON gakja.students, gakja.application_targets, gakja.session_bindings, gakja.audio_bindings, gakja.job_bindings,
  gakja.common_versions, gakja.target_versions, gakja.private_objects, gakja.legacy_mappings, gakja.common_private_objects, gakja.common_legacy_mappings TO gakja_mapping;
GRANT SELECT, INSERT, UPDATE, DELETE ON gakja.common_pointers, gakja.target_pointers TO gakja_mapping;
GRANT SELECT ON gakja.target_profiles, gakja.mapping_audit TO gakja_mapping;
GRANT SELECT ON gakja.students, gakja.application_targets, gakja.session_bindings, gakja.audio_bindings,
  gakja.common_versions, gakja.target_versions, gakja.common_pointers, gakja.target_pointers, gakja.private_objects, gakja.legacy_mappings, gakja.common_private_objects, gakja.common_legacy_mappings, gakja.target_profiles TO gakja_request;
GRANT INSERT ON gakja.common_versions, gakja.target_versions, gakja.common_pointers, gakja.target_pointers, gakja.private_objects, gakja.common_private_objects TO gakja_request;
GRANT UPDATE, DELETE ON gakja.common_pointers, gakja.target_pointers TO gakja_request;
GRANT SELECT ON gakja.job_bindings, gakja.session_bindings TO gakja_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gakja FROM PUBLIC, gakja_request, gakja_worker, gakja_bypass;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA gakja FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gakja.resolve_account(text,text), gakja.resolve_session_binding(text), gakja.resolve_audio_binding(text),
  gakja.valid_account(text), gakja.can_student(text,text), gakja.can_student_version(text,text,boolean,text), gakja.can_target(text,text,text,boolean,text) TO gakja_request;
GRANT EXECUTE ON FUNCTION gakja.resolve_job_binding(text), gakja.can_job(text,text) TO gakja_worker;

GRANT EXECUTE ON FUNCTION gakja.is_trimmed_identifier(text) TO gakja_request, gakja_mapping;

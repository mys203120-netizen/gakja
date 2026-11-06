import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function schemaFingerprint(client) {
  const { rows } = await client.query(`
    SELECT * FROM (SELECT 'relation' kind, c.relname name,
      jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
        'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text) value
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gakja'
    UNION ALL SELECT 'column',c.relname||'.'||a.attname,
      jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,
        'default',pg_get_expr(d.adbin,d.adrelid))
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='gakja' AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL SELECT 'constraint',c.conname, to_jsonb(pg_get_constraintdef(c.oid,true))
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='gakja'
    UNION ALL SELECT 'policy',p.tablename||'.'||p.policyname,to_jsonb(p)
      FROM pg_policies p WHERE p.schemaname='gakja'
    UNION ALL SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
      jsonb_build_object('definition',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',pg_get_userbyid(p.proowner))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='gakja'
    UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,
      jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='gakja' AND NOT t.tgisinternal
    UNION ALL SELECT 'index',c.relname,to_jsonb(pg_get_indexdef(i.indexrelid))
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gakja'
    UNION ALL SELECT 'schema',n.nspname,jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text)
      FROM pg_namespace n WHERE n.nspname='gakja'
    UNION ALL SELECT 'default-privilege',pg_get_userbyid(d.defaclrole)||'.'||d.defaclobjtype::text,
      jsonb_build_object('schema',n.nspname,'acl',d.defaclacl::text)
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
      WHERE n.nspname='gakja' OR (d.defaclnamespace=0 AND pg_get_userbyid(d.defaclrole)='gakja_owner')
    UNION ALL SELECT 'role',r.rolname,jsonb_build_object('super',r.rolsuper,'inherit',r.rolinherit,'createrole',r.rolcreaterole,
      'createdb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypass',r.rolbypassrls,
      'connectionLimit',r.rolconnlimit,'validUntil',r.rolvaliduntil,'settings',r.rolconfig)
      FROM pg_roles r WHERE r.rolname IN ('gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass')
    UNION ALL SELECT 'membership',parent.rolname||'.'||member.rolname,
      jsonb_build_object('admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
      WHERE parent.rolname IN ('gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass')
        OR member.rolname IN ('gakja_owner','gakja_mapping','gakja_request','gakja_worker','gakja_bypass')
    ) objects ORDER BY kind,name,value::text`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function applyOwnershipMigration(client, file = new URL('../db/migrations/0001_ownership.sql', import.meta.url)) {
  const sql = await readFile(file, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const current = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1', ['0001_ownership']);
  if (current.rowCount) {
    if (current.rows[0].checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].fingerprint !== await schemaFingerprint(client)) throw new Error('MIGRATION_SCHEMA_DRIFT');
    return { version: '0001_ownership', checksum, fingerprint: current.rows[0].fingerprint, applied: false };
  }
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE gakja_owner');
    await client.query(sql);
    await client.query('RESET ROLE');
    const fingerprint = await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)', ['0001_ownership', checksum, fingerprint]);
    await client.query('COMMIT');
    return { version: '0001_ownership', checksum, fingerprint, applied: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

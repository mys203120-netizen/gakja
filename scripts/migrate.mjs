import { loadProjectEnv, projectRoot } from './load-env.mjs';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

loadProjectEnv();
if (!process.env.DATABASE_URL) throw new Error('루트 .env.local에 DATABASE_URL을 설정해 주세요.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
await client.connect();
try {
  await client.query('create table if not exists schema_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())');
  const dir = resolve(projectRoot, 'supabase/migrations');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(dir, name), 'utf8'), checksum = createHash('sha256').update(sql).digest('hex');
    const existing = (await client.query('select checksum from schema_migrations where name=$1', [name])).rows[0];
    if (existing) { if (existing.checksum !== checksum) throw new Error(`이미 적용한 migration이 바뀌었어요: ${name}`); continue; }
    await client.query('begin');
    try { await client.query(sql); await client.query('insert into schema_migrations(name,checksum) values($1,$2)', [name, checksum]); await client.query('commit'); console.log(`Applied ${name}`); }
    catch (error) { await client.query('rollback'); throw error; }
  }
} finally { await client.end(); }

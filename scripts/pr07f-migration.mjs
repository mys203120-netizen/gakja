import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { schemaFingerprint } from './pr07b-migration.mjs';
import { applySessionWriterMigration } from './pr07e-migration.mjs';

/** Append F without rewriting any historical B/C/D/E checkpoint. */
export async function applyEvaluationWriterMigration(client, file = new URL('../db/migrations/0005_evaluation_writer.sql', import.meta.url)) {
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex');
  const versions = ['0001_ownership', '0002_private_storage', '0003_read_shadow', '0004_session_writer'];
  const bases = await Promise.all(versions.map(async version => createHash('sha256').update(await readFile(new URL('../db/migrations/' + version + '.sql', import.meta.url))).digest('hex')));
  const prior = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=ANY($1::text[]) ORDER BY version', [versions]);
  const current = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1', ['0005_evaluation_writer']);
  if (current.rowCount) {
    if (prior.rowCount !== 4 || prior.rows.some((row, i) => row.version !== versions[i] || row.checksum !== bases[i])) throw new Error('PR07F_BASE_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].checksum !== checksum) throw new Error('PR07F_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].fingerprint !== await schemaFingerprint(client)) throw new Error('PR07F_MIGRATION_SCHEMA_DRIFT');
    return { version: '0005_evaluation_writer', checksum, fingerprint: current.rows[0].fingerprint, applied: false, baseChecksums: bases };
  }
  await applySessionWriterMigration(client);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE gakja_owner'); await client.query(await readFile(file, 'utf8')); await client.query('RESET ROLE');
    const fingerprint = await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)', ['0005_evaluation_writer', checksum, fingerprint]);
    await client.query('COMMIT'); return { version: '0005_evaluation_writer', checksum, fingerprint, applied: true, baseChecksums: bases };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

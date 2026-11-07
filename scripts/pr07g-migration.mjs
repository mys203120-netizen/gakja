import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { schemaFingerprint } from './pr07b-migration.mjs';
import { applyEvaluationWriterMigration } from './pr07f-migration.mjs';

/** Historical checkpoints are immutable evidence. Only the latest checkpoint
 * fingerprints the current complete schema; earlier checksums still match bytes. */
export async function applyScopedTransitionMigration(client, file = new URL('../db/migrations/0006_scoped_transition.sql', import.meta.url)) {
  const version = '0006_scoped_transition';
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex');
  const versions = ['0001_ownership', '0002_private_storage', '0003_read_shadow', '0004_session_writer', '0005_evaluation_writer'];
  const baseChecksums = await Promise.all(versions.map(async value => createHash('sha256').update(await readFile(new URL('../db/migrations/' + value + '.sql', import.meta.url))).digest('hex')));
  const prior = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=ANY($1::text[]) ORDER BY version', [versions]);
  const current = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1', [version]);
  if (current.rowCount) {
    if (prior.rowCount !== versions.length || prior.rows.some((row, i) => row.version !== versions[i] || row.checksum !== baseChecksums[i])) throw new Error('PR07G_BASE_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].checksum !== checksum) throw new Error('PR07G_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].fingerprint !== await schemaFingerprint(client)) throw new Error('PR07G_MIGRATION_SCHEMA_DRIFT');
    return { version, checksum, fingerprint: current.rows[0].fingerprint, applied: false, baseChecksums };
  }
  await applyEvaluationWriterMigration(client);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE gakja_owner'); await client.query(await readFile(file, 'utf8')); await client.query('RESET ROLE');
    const fingerprint = await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)', [version, checksum, fingerprint]);
    await client.query('COMMIT'); return { version, checksum, fingerprint, applied: true, baseChecksums };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { schemaFingerprint } from './pr07b-migration.mjs';
import { applyTransitionRecoveryMigration } from './pr07g-recovery-migration.mjs';

/** Append service input admission without changing historical checkpoints. */
export async function applyServiceInputsMigration(client, file = new URL('../db/migrations/0008_service_inputs.sql', import.meta.url)) {
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex');
  const versions = ['0001_ownership','0002_private_storage','0003_read_shadow','0004_session_writer','0005_evaluation_writer','0006_scoped_transition','0007_transition_recovery'];
  const bases = await Promise.all(versions.map(async version => createHash('sha256').update(await readFile(new URL('../db/migrations/' + version + '.sql', import.meta.url))).digest('hex')));
  const prior = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=ANY($1::text[]) ORDER BY version', [versions]);
  const current = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1', ['0008_service_inputs']);
  if (current.rowCount) {
    if (prior.rowCount !== versions.length || prior.rows.some((row, i) => row.version !== versions[i] || row.checksum !== bases[i])) throw new Error('PR07G_SERVICE_INPUTS_BASE_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].checksum !== checksum) throw new Error('PR07G_SERVICE_INPUTS_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].fingerprint !== await schemaFingerprint(client)) throw new Error('PR07G_SERVICE_INPUTS_MIGRATION_SCHEMA_DRIFT');
    return { version: '0008_service_inputs', checksum, fingerprint: current.rows[0].fingerprint, applied: false, baseChecksums: bases };
  }
  await applyTransitionRecoveryMigration(client);
  await client.query('BEGIN');
  try {
    await client.query('GRANT USAGE ON SCHEMA pr07b_control TO gakja_owner');
    await client.query('GRANT SELECT ON pr07b_control.migrations TO gakja_owner');
    await client.query('SET LOCAL ROLE gakja_owner'); await client.query(await readFile(file, 'utf8')); await client.query('RESET ROLE');
    const fingerprint = await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)', ['0008_service_inputs', checksum, fingerprint]);
    await client.query('COMMIT'); return { version: '0008_service_inputs', checksum, fingerprint, applied: true, baseChecksums: bases };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { schemaFingerprint } from './pr07b-migration.mjs';
import { applyPrivateStorageMigration } from './pr07c-migration.mjs';

/** Historical B/C checkpoints remain immutable. After D upgrade only the latest
 * D catalog fingerprint is current; old whole-catalog fingerprints are evidence
 * of their own checkpoint, never rewritten to hide intentional later changes. */
export async function applyReadShadowMigration(client, file = new URL('../db/migrations/0003_read_shadow.sql', import.meta.url)) {
  const checksum = createHash('sha256').update(await readFile(file)).digest('hex');
  const baseFiles = [new URL('../db/migrations/0001_ownership.sql',import.meta.url),new URL('../db/migrations/0002_private_storage.sql',import.meta.url)];
  const bases = await Promise.all(baseFiles.map(async url => createHash('sha256').update(await readFile(url)).digest('hex')));
  const prior = await client.query('SELECT * FROM pr07b_control.migrations WHERE version IN ($1,$2) ORDER BY version',['0001_ownership','0002_private_storage']);
  const current = await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1',['0003_read_shadow']);
  if (current.rowCount) {
    if (prior.rowCount!==2 || prior.rows.some((row,i)=>row.checksum!==bases[i])) throw new Error('PR07D_BASE_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].checksum!==checksum) throw new Error('PR07D_MIGRATION_CHECKSUM_CHANGED');
    if (current.rows[0].fingerprint!==await schemaFingerprint(client)) throw new Error('PR07D_MIGRATION_SCHEMA_DRIFT');
    return {version:'0003_read_shadow',checksum,fingerprint:current.rows[0].fingerprint,applied:false,baseChecksums:bases};
  }
  await applyPrivateStorageMigration(client);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE gakja_owner');
    await client.query(await readFile(file,'utf8'));
    await client.query('RESET ROLE');
    const fingerprint=await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)',['0003_read_shadow',checksum,fingerprint]);
    await client.query('COMMIT');
    return {version:'0003_read_shadow',checksum,fingerprint,applied:true,baseChecksums:bases};
  } catch(error) { await client.query('ROLLBACK');throw error; }
}

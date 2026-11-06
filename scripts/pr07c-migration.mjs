import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applyOwnershipMigration, schemaFingerprint } from './pr07b-migration.mjs';

/** B remains an immutable checkpoint. Its whole-catalog fingerprint is checked
 * before upgrade, while C replay checks the latest catalog rather than treating
 * C's deliberate additions as B drift. B SQL/checksum/ledger are never rewritten. */
export async function applyPrivateStorageMigration(client, file = new URL('../db/migrations/0002_private_storage.sql', import.meta.url)) {
  const sql=await readFile(file,'utf8');
  const checksum=createHash('sha256').update(sql).digest('hex');
  const bSql=await readFile(new URL('../db/migrations/0001_ownership.sql',import.meta.url),'utf8');
  const bChecksum=createHash('sha256').update(bSql).digest('hex');
  const current=await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1',['0002_private_storage']);
  const prior=await client.query('SELECT * FROM pr07b_control.migrations WHERE version=$1',['0001_ownership']);
  if(current.rowCount) {
    if(prior.rowCount!==1 || prior.rows[0].checksum!==bChecksum)throw new Error('PR07C_BASE_MIGRATION_CHECKSUM_CHANGED');
    if(current.rows[0].checksum!==checksum)throw new Error('PR07C_MIGRATION_CHECKSUM_CHANGED');
    if(current.rows[0].fingerprint!==await schemaFingerprint(client))throw new Error('PR07C_MIGRATION_SCHEMA_DRIFT');
    return {version:'0002_private_storage',checksum,fingerprint:current.rows[0].fingerprint,applied:false,baseChecksum:bChecksum};
  }
  await applyOwnershipMigration(client);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE gakja_owner');await client.query(sql);await client.query('RESET ROLE');
    const fingerprint=await schemaFingerprint(client);
    await client.query('INSERT INTO pr07b_control.migrations(version,checksum,fingerprint) VALUES($1,$2,$3)',['0002_private_storage',checksum,fingerprint]);
    await client.query('COMMIT');
    return {version:'0002_private_storage',checksum,fingerprint,applied:true,baseChecksum:bChecksum};
  } catch(error) {await client.query('ROLLBACK');throw error;}
}

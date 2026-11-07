import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { AuthenticatedRequestContext } from '../../server/auth/request-identity';
import type { ObjectStorageProvider } from '../../server/storage/private-object-ports';
import { captureRecoveryArchive, restoreRecoveryArchive, createRestoredObjectProvider, type RecoveryLocation } from '../../server/transition/recovery';
import type { TransitionOperatorAction, TransitionOperatorCapability, TransitionRepository } from '../../server/transition/transition-ports';

export interface RestoredReadEvidence {
  /** Actual attempted source endpoint calls were denied in the restored child. */
  originalDbDeniedAttempts: number; originalStorageDeniedAttempts: number; localFallbackReads: number;
  selections: { selection: 'current' | 'pinned' | 'historical'; originalSha256: string; restoredSha256: string }[];
  receipts: { layer: 'E' | 'F'; originalResultJson: string; restoredResultJson: string; replay: boolean }[];
  results: { originalJson: string; restoredJson: string }[];
  freshWriteRejections: number; freshProviderCalls: number; workerClaims: number;
}
export interface IntegratedRecoveryInput {
  sourcePools: { admin: Pool; mapping: Pool }; restorePools: { admin: Pool; mapping: Pool };
  sourceContext: AuthenticatedRequestContext; restoreContext: AuthenticatedRequestContext;
  sourceTransition: TransitionRepository; restoreTransition: TransitionRepository;
  sourceOperator(action: TransitionOperatorAction): TransitionOperatorCapability;
  restoreOperator(action: TransitionOperatorAction): TransitionOperatorCapability;
  sourceProvider: ObjectStorageProvider; destinationProvider: ObjectStorageProvider;
  readRestored(input: { locations: readonly RecoveryLocation[]; metadataJson: string; manifestSha256: string }): Promise<RestoredReadEvidence>;
  output: string;
}
const policy = { maxMetadataBytes: 128 * 1024 * 1024, maxObjectBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxObjects: 256 };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
interface Metadata {
  version: string; objects: unknown[]; tables: Record<string, Row[]>;
  transition: { state: string; generation: string; fence: string }; checkpointExportedAt: string;
  tableManifest: {table:string;rows:number;sha256:string;preservedSha256:string}[];
  gEvidence: Record<string, unknown[]>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const row = value as Row;return '{'+Object.keys(row).sort().map(k=>JSON.stringify(k)+':'+canonical(row[k])).join(',')+'}';
}
/** Only operational authority projections change. Every raw/domain TEXT, hash,
 * ID, receipt, pointer, dependency, revision and historical row stays exact. */
function preservedRows(table: string, rows: readonly Row[]) {
  const omit: Record<string,string[]> = {
    session_command_sessions: ['writer','writer_generation','writer_token'], evaluation_sessions: ['writer','fence'],
    evaluation_worker_grants: ['active'], worker_job_grants: ['active'],
    evaluation_jobs: ['lease_token','worker_id','lease_until','lease_fence'],
    service_input_approvals: ['transition_id'],
  };
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !(omit[table] ?? []).includes(key)))).map(canonical).sort();
}
async function scopedSql(pool: Pool, context: AuthenticatedRequestContext, sql: string) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const settings={issuer:context.principal.issuer,subject:context.principal.subject,account_id:context.account.accountId,account_revision:context.account.revision,
      owner_id:context.account.ownerId,student_id:context.scope!.studentId,application_target_id:context.scope!.applicationTargetId};
    for(const [key,value] of Object.entries(settings))await client.query('SELECT set_config($1,$2,true)',['gakja.'+key,value]);
    const result=await client.query(sql);await client.query('COMMIT');return result;
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {await client.query('RESET ALL');client.release();}
}

/** Registered inside the G service suite after its real positive HTTP/WSS and
 * independent-worker writes. This is new integrated recovery evidence; it does
 * not relabel F's per-session metadata-only restore as G acceptance. */
export async function runIntegratedRecoveryCases(input: IntegratedRecoveryInput) {
  const phaseStart=performance.now(),startedAt=new Date().toISOString();
  const exported=await input.sourceTransition.exportRecovery(input.sourceContext,input.sourceOperator('export'));
  const metadata=JSON.parse(exported.metadataJson) as Metadata;
  assert.equal(metadata.version,'transition-recovery-metadata-v1');assert.equal(metadata.transition.state,'frozen');
  for(const table of ['storage_uploads','shadow_runs','shadow_artifacts','shadow_dependencies','shadow_pointers','shadow_history','shadow_pointer_history',
    'session_command_sessions','session_commands','session_mandatory_events','session_evaluation_handoffs','evaluation_artifacts','evaluation_sessions','evaluation_jobs','evaluation_results'])
    assert.ok(metadata.tables[table]?.length>0,'positive source preservation collection required: '+table);
  assert.ok(metadata.gEvidence.transition_write_facts.length>0,'must recover actual post-switch DB writes');
  assert.equal(Object.keys(metadata.gEvidence).length,8);
  const archive=await captureRecoveryArchive(exported,input.sourceProvider,policy);
  assert.ok(archive.objects.length>0);assert.equal(archive.objects.length,metadata.objects.length);
  let publicationCalls=0,destinationWrites=0;
  const destination: ObjectStorageProvider={...input.destinationProvider,async upload(...args){destinationWrites++;await input.destinationProvider.upload(...args);}};
  const scope=[input.restoreContext.account.ownerId,input.restoreContext.scope!.studentId,input.restoreContext.scope!.applicationTargetId];
  const countPublished=async()=>Number((await input.restorePools.admin.query('SELECT count(*) n FROM gakja.transition_recovery_publications WHERE owner_id=$1 AND student_id=$2 AND application_target_id=$3',scope)).rows[0].n);
  const publication={async publish(value: Parameters<TransitionRepository['restoreRecovery']>[2]){publicationCalls++;await input.restoreTransition.restoreRecovery(input.restoreContext,input.restoreOperator('restore'),value);}};
  const bucket=process.env.PR07G_TEST_RESTORE_BUCKET!,keyPrefix=process.env.PR07G_TEST_RESTORE_KEY_PREFIX!;
  for(const kind of ['missing','tampered'] as const){
    const invalid=structuredClone(archive);
    if(kind==='missing')invalid.objects.pop();else invalid.objects[0].bytesBase64=Buffer.from('explicit controlled corruption').toString('base64');
    await assert.rejects(restoreRecoveryArchive({archive:invalid,destination,publication,bucket,keyPrefix,policy}),/TRANSITION_RECOVERY_INVALID/u);
    assert.equal(publicationCalls,0);assert.equal(destinationWrites,0);assert.equal(await countPublished(),0);
  }
  let verified=0;
  await assert.rejects(restoreRecoveryArchive({archive,destination,publication,bucket,keyPrefix,policy,async onObjectVerified(){if(++verified===1)throw new Error('G_CONTROLLED_RECOVERY_INTERRUPTION');}}),/G_CONTROLLED_RECOVERY_INTERRUPTION/u);
  assert.equal(publicationCalls,0);assert.equal(await countPublished(),0);
  assert.equal((await input.restorePools.admin.query("SELECT count(*) n FROM gakja.storage_uploads WHERE owner_id=$1 AND student_id=$2 AND (scope_kind='common' OR application_target_id=$3)",scope)).rows[0].n,'0');
  const beforeResumeWrites=destinationWrites;
  const restored=await restoreRecoveryArchive({archive,destination,publication,bucket,keyPrefix,policy});
  assert.equal(publicationCalls,1);assert.equal(await countPublished(),1);
  assert.equal(destinationWrites-beforeResumeWrites,archive.objects.length-1,'resume must verify/reuse the already copied first object');
  const state=await input.restoreTransition.read(input.restoreContext);
  assert.equal(state?.state,'read-only-recovery');assert.ok(BigInt(state!.generation)>BigInt(metadata.transition.generation));
  const reexport=(await scopedSql(input.restorePools.mapping,input.restoreContext,'SELECT gakja.transition_reexport_recovery() value')).rows[0].value as {
    tables:Record<string,Row[]>;originalMetadataJson:string;originalMetadataSha256:string;manifestSha256:string;locations:RecoveryLocation[];
    preservedManifest:{table:string;rows:number;preservedSha256:string}[] };
  assert.equal(reexport.originalMetadataJson,exported.metadataJson);assert.equal(reexport.originalMetadataSha256,exported.metadataSha256);assert.equal(reexport.manifestSha256,archive.manifestSha256);
  assert.deepEqual(Object.keys(reexport.tables).sort(),Object.keys(metadata.tables).sort());
  const tableProofs=[];
  for(const [table,rows] of Object.entries(metadata.tables)){
    const original=preservedRows(table,rows),actual=preservedRows(table,reexport.tables[table]);assert.deepEqual(actual,original,'preserved rows '+table);
    const sourceProof=metadata.tableManifest.find(m=>m.table===table)!,restoredProof=reexport.preservedManifest.find(m=>m.table===table)!;
    assert.equal(restoredProof.rows,sourceProof.rows);assert.equal(restoredProof.preservedSha256,sourceProof.preservedSha256,'SQL exact-value hash proof '+table);
    tableProofs.push({table,rows:rows.length,originalPreservedSha256:sourceProof.preservedSha256,restoredPreservedSha256:restoredProof.preservedSha256});
  }
  for(const table of ['evaluation_worker_grants','worker_job_grants'])assert.ok(reexport.tables[table].every(row=>row.active===false));
  assert.ok(reexport.tables.evaluation_jobs.every(row=>row.lease_token===null&&row.worker_id===null&&row.lease_until===null));
  assert.ok(reexport.tables.session_command_sessions.every(row=>row.writer==='read-only'));
  assert.ok(reexport.tables.evaluation_sessions.every(row=>row.writer==='read-only'));
  assert.equal((await input.restorePools.admin.query('SELECT count(*) n FROM gakja.transition_operator_grants g JOIN gakja.scoped_transitions s USING(transition_id) WHERE g.active AND s.owner_id=$1 AND s.student_id=$2 AND s.application_target_id=$3',scope)).rows[0].n,'0');
  const reader=createRestoredObjectProvider({destination:input.destinationProvider,locations:reexport.locations});
  for(const object of archive.objects)assert.equal(hash(await reader.read(object.logicalRef,{maxBytes:object.sizeBytes})),object.contentSha256);
  const evidence=await input.readRestored({locations:restored.locations,metadataJson:exported.metadataJson,manifestSha256:archive.manifestSha256});
  assert.ok(evidence.originalDbDeniedAttempts>0);assert.ok(evidence.originalStorageDeniedAttempts>0);assert.equal(evidence.localFallbackReads,0);
  for(const selection of ['current','pinned','historical'])assert.ok(evidence.selections.some(row=>row.selection===selection),'restored service must exercise '+selection);
  for(const row of evidence.selections)assert.equal(row.restoredSha256,row.originalSha256);
  for(const layer of ['E','F'])assert.ok(evidence.receipts.some(row=>row.layer===layer),'confirmed receipt replay required: '+layer);
  for(const row of evidence.receipts){assert.equal(row.replay,true);assert.equal(row.restoredResultJson,row.originalResultJson);}
  assert.ok(evidence.results.length>0);for(const row of evidence.results)assert.equal(row.restoredJson,row.originalJson);
  assert.ok(evidence.freshWriteRejections>0);assert.equal(evidence.freshProviderCalls,0);assert.equal(evidence.workerClaims,0);
  const report={version:'pr07g-integrated-recovery-evidence-v1',status:'passed',startedAt,completedAt:new Date().toISOString(),elapsedMs:performance.now()-phaseStart,
    restoreMeasurement:restored.measurement,approvedRtoTarget:null,approvedRpoTarget:null,checkpointExportedAt:metadata.checkpointExportedAt,
    rpoEvidence:'Every committed row at the frozen checkpoint and every verified object was preserved. Post-freeze fresh writes are rejected; no time SLA is asserted.',
    objects:archive.objects.length,bytes:archive.objects.reduce((sum,o)=>sum+o.sizeBytes,0),metadataSha256:exported.metadataSha256,manifestSha256:archive.manifestSha256,
    tableProofs,readOnlyOperationalChanges:{sessionOuterWriter:'read-only; generation incremented; token replaced',evaluationOuterWriter:'read-only; fence incremented',oldGrants:'inactive',oldLeases:'cleared; lease fence incremented',transitionAssociation:'explicit new transition ID; original session ID/generation/time retained',serviceInputAssociation:'explicit new transition ID; original plan/evidence/operator audit bytes retained'},
    originalSignedAndDomainTextChanged:false,logicalStorageRefsChanged:false,missingObjectRejected:true,tamperedObjectRejected:true,interruptedRestoreUnpublished:true,resumedCopyReverified:true,
    physicalLocatorMapping:true,restoredService:evidence,backupOperatingPolicy:{encryption:'not supplied; operating gate blocked',accessAndRetention:'not supplied; operating gate blocked',privateKeysOrCredentialsArchived:false}};
  const output=path.resolve(input.output);assert.ok(output.startsWith(path.resolve('artifacts/pr07g')+path.sep));
  await writeFile(path.join(output,'integrated-recovery.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}

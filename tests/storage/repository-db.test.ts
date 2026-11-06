import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRequestIdentityBoundary, type RequestContext } from '../../server/auth/request-identity';
import { createTrustedJwtVerifier } from '../../server/auth/jose-jwt-verifier';
import { createPostgresAccountResolver, createPostgresRequestAuthority } from '../../server/db/postgres-authority';
import { createPostgresObjectRepository } from '../../server/db/postgres-object-repository';
import { createPrivateObjectService } from '../../server/storage/private-object-service';
import type { ObjectAdmission, ObjectStorageProvider } from '../../server/storage/private-object-ports';
import { testPools, closePools } from './storage-test-database';
import { syntheticBytes, rawHash } from './fixtures';

// Actual PostgreSQL and signed A identities; the body provider in case2 is
// explicitly in-memory. Official Storage API cases run in separate files.
const pools=testPools(1);test.after(()=>closePools(pools));
const pdf=syntheticBytes['source-pdf']();
async function fixture(who:'a'|'b'='a') {
  const issuer=`https://issuer-${who}.example`,keys=await generateKeyPair('ES256');
  const jwk={...await exportJWK(keys.publicKey),kid:'repo-db',alg:'ES256'};
  const identity=createRequestIdentityBoundary({mode:'service',accounts:createPostgresAccountResolver(pools.request),
    verifier:createTrustedJwtVerifier({issuer,audience:'repo-db',algorithms:['ES256'],jwks:{keys:[jwk]}})});
  const token=await new SignJWT().setProtectedHeader({alg:'ES256',kid:'repo-db'}).setIssuer(issuer).setSubject('shared')
    .setAudience('repo-db').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const context=identity.selectScope(await identity.authenticate('Bearer '+token),{applicationTargetId:`app-${who}`});
  const authority=createPostgresRequestAuthority(pools.request,identity);
  const repository=createPostgresObjectRepository({authority,boundary:identity,mappingPool:pools.mapping,bucket:'pr07c-synthetic',keyPrefix:'repo_'+randomUUID().replaceAll('-','')});
  const input:ObjectAdmission={kind:'source-pdf',scope:'common',studentId:`student-${who}`,expectedSize:pdf.length,
    expectedSha256:rawHash(pdf),idempotencyKey:randomUUID(),...(who==='b'?{sourceRevision:null}:{})};
  return {identity,repository,context,input};
}

test('real DB repository binds server refs, preserves source/domain presence and replays the same admission',async()=>{
  const f=await fixture(),input={...f.input,domainSha256:null};
  const value=await f.repository.admit(f.context,input),same=await f.repository.admit(f.context,input);
  assert.equal(value.receiptId,same.receiptId);assert.equal(value.objectId,same.objectId);assert.equal(value.state,'pending');
  assert.deepEqual(value.scope,{kind:'common',ownerId:'owner-a',studentId:'student-a'});
  assert.equal(Object.hasOwn(value,'sourceRevision'),false);assert.equal(Object.hasOwn(value,'domainSha256'),true);assert.equal(value.domainSha256,null);
  assert.equal(value.stagingRef.key.endsWith('/staging/'+value.objectId),true);
  assert.equal(value.finalRef.key.endsWith('/final/'+value.objectId),true);
  assert.equal(await f.repository.getVerified(f.context,{objectId:value.objectId}),null);
  await assert.rejects(f.repository.getReceipt({...f.context} as RequestContext,value.receiptId));
});

test('actual SQL C2 state adapter with explicit in-memory body fault provider finalizes then tombstones without private fallback',async()=>{
  const f=await fixture(),files=new Map<string,Buffer>();
  const provider:ObjectStorageProvider={
    async read(ref){const b=files.get(ref.key);if(!b)throw new Error('missing');return Buffer.from(b);},
    async upload(ref,bytes){if(files.has(ref.key))throw new Error('conflict');files.set(ref.key,Buffer.from(bytes));},
    async copy(from,to){const b=files.get(from.key);if(!b)throw new Error('missing');if(files.has(to.key))throw new Error('conflict');files.set(to.key,Buffer.from(b));},
    async remove(ref){files.delete(ref.key);},
  };
  const service=createPrivateObjectService({repository:f.repository,provider});
  const receipt=await service.admitStudent(f.context,f.input);
  await service.upload(f.context,receipt.receiptId,pdf);
  assert.equal(await f.repository.getVerified(f.context,{objectId:receipt.objectId}),null);
  const complete=await service.complete(f.context,receipt.receiptId);
  assert.equal(complete.state,'verified');assert.deepEqual(await service.read(f.context,{objectId:receipt.objectId}),pdf);
  await service.cancel(f.context,receipt.receiptId);await assert.rejects(service.read(f.context,{objectId:receipt.objectId}));
  const clean=await service.cleanup(f.context,receipt.receiptId);assert.equal(clean.cleanupState,'clean');assert.equal(files.size,0);
});

test('real DB mapping/request pools reset after two owners, preserve literal-null pin and refuse incompatible source',async()=>{
  const a=await fixture(),b=await fixture('b');
  const [ra,rb]=await Promise.all([a.repository.admit(a.context,a.input),b.repository.admit(b.context,{...b.input,scope:'target'})]);
  assert.notEqual(ra.objectId,rb.objectId);assert.equal(Object.hasOwn(rb,'sourceRevision'),true);assert.equal(rb.sourceRevision,null);
  assert.equal(rb.scope.kind,'target');assert.equal(await a.repository.getReceipt(a.context,rb.receiptId),null);
  await assert.rejects(b.repository.admit(b.context,{...b.input,sourceRevision:'wrong-source',idempotencyKey:randomUUID()}));
  for(const pool of [pools.request,pools.mapping]) {
    const result=await pool.query("SELECT coalesce(current_setting('gakja.owner_id',true),'') owner,coalesce(current_setting('gakja.account_id',true),'') account");
    assert.deepEqual(result.rows[0],{owner:'',account:''});
  }
});

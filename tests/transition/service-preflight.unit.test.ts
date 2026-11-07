import test from 'node:test';
import assert from 'node:assert/strict';
import { runServicePreflight } from '../../server/service/preflight';
import { createScopedServiceAuthority,bindScopedComponent } from '../../server/service/scoped-authority';
import { createTransitionServiceAuthority,type TransitionRepository } from '../../server/transition/transition-ports';
import { createRequestIdentityBoundary } from '../../server/auth/request-identity';
import { createScopedSessionService } from '../../server/session-writer/isolated-session-service';
import { createScopedServiceRealtimeServer } from '../../server/request-realtime-server';
import { createRehearsalSessionProviders } from '../../server/service/session-providers';
import { withPinnedProviderModels } from '../../server/providers/provider-model-context';
import { realtimeCoreModel,runtimeFactReviewModel,questionGenerationModel } from '../../server/providers/realtime-model';
const deployment={version:'scoped-service-deployment-v1',responsibility:{environmentId:'explicit-stage',startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',observer:'operator',stopOwner:'operator',recoveryOwner:'operator',storageRetentionOwner:'operator'},bindings:[{ownerId:'owner',studentId:'student',applicationTargetId:'application',supportTargetId:'support',runId:'run_input',plan:{}}]};
const env={INTERVIEW_AUTH_ISSUER:'https://issuer.example',INTERVIEW_AUTH_AUDIENCE:'audience',INTERVIEW_AUTH_JWKS_URL:'https://issuer.example/jwks',INTERVIEW_AUTH_ALGORITHMS:'ES256',INTERVIEW_DB_REQUEST_URL:'postgres://gakja_request:secret@db.example/explicit',INTERVIEW_DB_MAPPING_URL:'postgres://gakja_mapping:secret@db.example/explicit',INTERVIEW_DB_WORKER_URL:'postgres://gakja_worker:secret@db.example/explicit',INTERVIEW_STORAGE_API_URL:'https://storage.example/storage/v1',INTERVIEW_STORAGE_SERVICE_KEY:'secret-service-credential',INTERVIEW_STORAGE_BUCKET:'private-bucket',INTERVIEW_STORAGE_KEY_PREFIX:'private_scope',OPENAI_API_KEY:'secret-model-credential',CLOVA_VOICE_CLIENT_ID:'voice-id',CLOVA_VOICE_CLIENT_SECRET:'voice-secret',CLOVA_SPEECH_SECRET_KEY:'speech-secret'};
test('preflight distinguishes missing, invalid, configured unverified and feature readiness without external calls',async()=>{
 const absent=await runServicePreflight();assert.equal(absent.ready,false);assert.ok(absent.checks.some(value=>value.status==='blocked'));assert.equal(absent.commercialCalls,0);
 const malformed=await runServicePreflight({environment:{...env,INTERVIEW_DB_REQUEST_URL:'postgres://gakja_owner:secret@db.example/explicit'},deployment:{}});assert.equal(malformed.checks.find(value=>value.id==='database-roles')?.status,'fail');assert.equal(malformed.checks.find(value=>value.id==='account-mapping')?.status,'fail');
 const configured=await runServicePreflight({environment:env,deployment});assert.equal(configured.checks.find(value=>value.id==='auth')?.status,'not-run');assert.equal(configured.checks.find(value=>value.id==='review-trust')?.status,'blocked');assert.equal(configured.ready,false);
 assert.ok(!JSON.stringify(configured).includes(env.INTERVIEW_STORAGE_SERVICE_KEY));assert.ok(!JSON.stringify(configured).includes(env.OPENAI_API_KEY));
 const pass=async()=>({status:'pass'as const,evidence:['EXPLICIT_LOCAL_READ_ONLY_EVIDENCE']});
 const probes={auth:pass,'account-mapping':pass,'database-roles':pass,'migrations-rls-fk':pass,storage:pass,providers:pass,'transition-scope':async()=>({status:'pass'as const,evidence:['TRANSITION_DB_PRIMARY_FINITE_WRITE_ENABLED']})};
 const noReview=await runServicePreflight({environment:env,deployment,probes});assert.equal(noReview.ready,true);assert.equal(noReview.featureReadiness.sessionWrites,true);assert.equal(noReview.featureReadiness.evaluation,false);
 const readonly=await runServicePreflight({environment:env,deployment,probes:{...probes,'transition-scope':pass}});assert.equal(readonly.ready,true);assert.equal(readonly.featureReadiness.sessionWrites,false);assert.equal(readonly.featureReadiness.evaluation,false);
});
test('opaque service components reject structural synthetic renaming and rehearsal authority in production',()=>{
 const identity=createRequestIdentityBoundary({mode:'service'}),repository={kind:'postgres-scoped-transition-v1'}as TransitionRepository;
 const transition=createTransitionServiceAuthority({mode:'rehearsal',identity,repository}),authority=createScopedServiceAuthority(transition,'rehearsal');
 assert.throws(()=>createScopedServiceAuthority({kind:'scoped-transition-service-authority-v1'},'production'));
 assert.throws(()=>createScopedServiceAuthority(transition,'production'));
 const resources={kind:'operational'}as Parameters<typeof createScopedServiceRealtimeServer>[0]['resources'];
 assert.throws(()=>createScopedServiceRealtimeServer({authority,identity,resources}));
 assert.throws(()=>createScopedSessionService({authority,identity,providers:{kind:'service-native'}}as Parameters<typeof createScopedSessionService>[0]));
 const audio=bindScopedComponent(authority,{async read(){return null;},async write(){throw new Error('NOT_EXECUTED');}});
 const original=process.env.NODE_ENV;try{Object.assign(process.env,{NODE_ENV:'production'});assert.throws(()=>createRehearsalSessionProviders({authority,audio,raw:{}}as unknown as Parameters<typeof createRehearsalSessionProviders>[0]));}finally{if(original===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Object.assign(process.env,{NODE_ENV:original});}
});
test('service model pins remain isolated across concurrent turns and preserve original caller defaults',async()=>{
 const before=[realtimeCoreModel(),runtimeFactReviewModel(),questionGenerationModel()];
 const one={question:'pin-question-a',realtime:'pin-realtime-a',review:'pin-review-a',evaluation:'pin-eval-a'},two={question:'pin-question-b',realtime:'pin-realtime-b',review:'pin-review-b',evaluation:'pin-eval-b'};
 const results=await Promise.all([one,two].map(value=>withPinnedProviderModels(value,async()=>{await Promise.resolve();return [realtimeCoreModel(),runtimeFactReviewModel(),questionGenerationModel()];})));
 assert.deepEqual(results,[[one.realtime,one.review,one.question],[two.realtime,two.review,two.question]]);assert.deepEqual([realtimeCoreModel(),runtimeFactReviewModel(),questionGenerationModel()],before);
});

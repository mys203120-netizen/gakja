import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { syntheticTextPdf } from './public-pdf.mjs';

const baseline='3204e83ea5bde64c57fe0da57cc7abc8ecca44fb';
const [mode,codeRootArgument,inputRootArgument,outputArgument]=process.argv.slice(2);
const codeRoot=path.resolve(codeRootArgument??''),root=path.resolve(inputRootArgument??''),output=path.resolve(outputArgument??'');
if(!['build','read'].includes(mode)||!codeRootArgument||!inputRootArgument||!outputArgument)throw new Error('PR07D_BASELINE_ARGUMENTS_REQUIRED');
const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:codeRoot,encoding:'utf8'}).trim();
if(actual!==baseline)throw new Error('PR07D_EXACT_C_BASELINE_REQUIRED');
const readFile=fs.promises.readFile.bind(fs.promises),writeFile=fs.promises.writeFile.bind(fs.promises);
const metrics={fixtureFileReads:0,fixtureFileWrites:0,reads:[],writes:[],paidProviderCalls:0};
let observing=false;
const inside=value=>{try{const file=path.resolve(String(value)),relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative)?relative.replaceAll('\\','/'):null;}catch{return null;}};
fs.promises.readFile=async function(file,...args){const relative=inside(file);if(observing&&relative){metrics.fixtureFileReads++;metrics.reads.push(relative);}return readFile(file,...args);};
fs.promises.writeFile=async function(file,...args){const relative=inside(file);if(observing&&relative){metrics.fixtureFileWrites++;metrics.writes.push(relative);}return writeFile(file,...args);};
syncBuiltinESMExports();
const load=relative=>import(pathToFileURL(path.join(codeRoot,relative)).href);
const {interviewConfig}=await load('interview.config.ts');
const {loadInterviewContextAt}=await load('server/data/load-interview-context.ts');
const analysis=await load('server/data/full-student-analysis.ts');
const {analysisDomainFixture}=await load('tests/fixtures/analysis-domain.ts');
const banks=await load('server/data/prepared-question-bank.ts');
const {createQuestionBlueprint,approveQuestionContract}=await load('server/question-objective.ts');
const {speechAudioCacheId}=await load('server/providers/clova-tts.ts');
const questionReview=await load('server/data/question-review-authority.ts');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Existing bank-domain canonicalization only. This builds input fixtures; the
// unchanged C bank loader independently validates its result during reads.
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,stable(entry)])):value;
const bankHash=value=>hash(JSON.stringify(stable(value)));
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\r\n');
const configuration={target:{...interviewConfig.target,studentName:'합성 학생'},files:{...interviewConfig.files,studentPdf:'synthetic/student.pdf'}};
const applyConfig=value=>{interviewConfig.target=value.target;interviewConfig.files=value.files;};
const save=async(reference,bytes)=>{const file=path.resolve(root,reference);if(!inside(file))throw new Error('PR07D_FIXTURE_PATH_INVALID');await fs.promises.mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);};
const sourceRef='data/prepared/record-revisions/public-synthetic/source.json';
const v2Ref='data/prepared/student-analysis-revisions/public-v2/analysis.json';
const v1Ref='data/prepared/student-analysis-revisions/public-v1/analysis.json';
let fixture;
if(mode==='build') {
  if(fs.existsSync(root))throw new Error('PR07D_FIXTURE_ROOT_ALREADY_EXISTS');
  await fs.promises.mkdir(root,{recursive:true});applyConfig(configuration);
  const publicCatalog=role=>JSON.parse(execFileSync('git',['show',`${baseline}:${configuration.files[role]}`],{cwd:codeRoot,maxBuffer:64*1024*1024}));
  const universities=publicCatalog('universitiesJson').filter(row=>row.name===configuration.target.university);
  if(universities.length!==1)throw new Error('PR07D_PUBLIC_UNIVERSITY_SELECTION_INVALID');
  const departments=publicCatalog('departmentsJson').filter(row=>row.university_id===universities[0].id&&row.name===configuration.target.department&&row.campus==='본교');
  if(departments.length!==1)throw new Error('PR07D_PUBLIC_DEPARTMENT_SELECTION_INVALID');
  const normalize=value=>value.normalize('NFKC').replace(/\s+/gu,'');
  const admissionTracks=publicCatalog('admissionTracksJson').filter(row=>row.university_id===universities[0].id&&row.department_id===departments[0].id&&row.academic_year===configuration.target.year&&row.record_type==='department_track'&&row.campus==='본교'&&normalize(row.canonical_track_name??'')===normalize(configuration.target.track));
  if(admissionTracks.length!==1)throw new Error('PR07D_PUBLIC_TRACK_SELECTION_INVALID');
  const catalogs={universitiesJson:universities,departmentsJson:departments,admissionTracksJson:admissionTracks};
  const original=analysisDomainFixture(),lines=original.source.blocks.map(block=>block.text),pdf=syntheticTextPdf(lines),pdfSha=hash(pdf);
  await save(configuration.files.studentPdf,pdf);
  for(const [role,reference]of Object.entries(configuration.files)) {
    if(['studentPdf','preparedStudent','sourceManifest'].includes(role))continue;
    if(role in catalogs)await save(reference,jsonBytes(catalogs[role]));
    else if(reference.endsWith('.md')) {
      // Public policy gates pin exact original bytes. They are reference
      // dependencies, not copied student records or synthesized policy approval.
      await save(reference,execFileSync('git',['show',`${baseline}:${reference}`],{cwd:codeRoot,maxBuffer:64*1024*1024}));
    }
    else {
      const version=interviewConfig.guidelineSourceVersions[role],title=interviewConfig.guidelineSourceTitles[role];
      await save(reference,Buffer.from((version?`# ${title} v${version}`:`# 합성 ${role}`)+'\r\n명시적인 공개 합성 fixture입니다. 학생 원문·개인정보·운영 승인을 포함하지 않습니다.\r\n원문 인용과 한 가지 질문 요구를 검수하고 미확인 상태를 보존합니다.\r\n'));
    }
  }
  const {getDocument}=await import(pathToFileURL(path.join(codeRoot,'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const loading=getDocument({data:new Uint8Array(pdf),verbosity:0});let text;
  try{const page=await(await loading.promise).getPage(1);const content=await page.getTextContent();text=content.items.filter(item=>'str'in item).map(item=>item.str+(item.hasEOL?'\n':' ')).join('').replace(/[ \t]+/gu,' ');}finally{await loading.destroy();}
  const source=structuredClone(original.source);source.pdfSha256=pdfSha;source.recordRevision=pdfSha;source.sourceFile=configuration.files.studentPdf;
  source.pages[0].text=text;source.pages[0].textSha256=hash(text);
  for(const block of source.blocks){block.startOffset=text.indexOf(block.text);if(block.startOffset<0)throw new Error('PR07D_SYNTHETIC_PDF_TEXT_MISMATCH');block.endOffset=block.startOffset+block.text.length;}
  const {contentSha256:_old,...body}=source;void _old;source.contentSha256=hash(JSON.stringify(body));
  await save(sourceRef,jsonBytes(source));await save('data/prepared/full-record-current.json',jsonBytes({path:sourceRef,pdfSha256:pdfSha,contentSha256:source.contentSha256}));
  const evidence=source.blocks.map((block,index)=>({id:'synthetic-legacy-'+index,activityId:'synthetic-legacy-activity',page:1,grade:2,section:'합성 원문',title:'합성 탐구',text:block.text,confirmationStatus:'confirmed_from_record',preparationPriority:null,scientificTruthVerification:'not_independently_verified',
    sourceRef:{file:configuration.files.studentPdf,pdfSha256:pdfSha,page:1,extraction:'explicit-synthetic-fixture',startOffset:block.startOffset,endOffset:block.endOffset}}));
  await save(configuration.files.preparedStudent,jsonBytes({schemaVersion:'verified-pdf-excerpts-v2',studentId:source.studentId,studentName:configuration.target.studentName,sourceFile:configuration.files.studentPdf,pdfSha256:pdfSha,pageCount:1,evidence,extractionStatus:'prepared',limitations:[]}));
  const {buildShadowBookFixture,buildShadowReviewChainFixture}=await import('./book-review-fixtures.mjs');
  const book=await buildShadowBookFixture({codeRoot,root});
  const context=await loadInterviewContextAt(root,{writeManifest:false});
  const v2=analysis.materializeFullStudentAnalysis(context,source,original.wire,{model:'explicit-synthetic-model',generatedAt:'2026-11-07T00:00:00.000Z'});
  const v1=analysis.materializeFullStudentAnalysis(context,source,analysis.decodeStudentAnalysisV2(source,original.wire).wire,{model:'explicit-synthetic-v1-model',generatedAt:'2026-11-07T00:00:00.000Z'});
  const payload={...v2,sourceRevision:source.revision,sourceContentSha256:source.contentSha256};
  await save(v2Ref,jsonBytes(payload));await save('data/prepared/student-analysis-current.json',jsonBytes({path:v2Ref,revision:v2.common.revision,sourceContentSha256:source.contentSha256}));
  await save(v2Ref.replace('analysis.json','analysis-qa.json'),jsonBytes(analysis.analysisQAManifest(payload,source,null)));
  // The historical artifact retains the exact existing v1 fixture shape.
  const historical={...v1,sourceRevision:source.revision,sourceContentSha256:source.contentSha256};
  await save(v1Ref,jsonBytes(historical));
  const fullContext=await loadInterviewContextAt(root,{writeManifest:false});
  if(fullContext.errors.length)throw new Error('PR07D_SYNTHETIC_CONTEXT_NOT_READY');
  const objective=fullContext.studentObjectives.find(value=>value.primaryFunction==='PROCESS');
  if(!objective)throw new Error('PR07D_SYNTHETIC_OBJECTIVE_MISSING');
  const slot={id:'synthetic-shadow-slot',index:1,label:'합성 수행 과정',topicArea:'academic_inquiry',evidenceIds:objective.evidenceIds,activityIds:objective.activityIds,
    primaryFunction:objective.primaryFunction,depth:objective.depth,questionIntent:objective.questionIntent,interviewerId:'interviewer-1',interviewerRole:'academic',schoolConnections:[],objective};
  const plan={policyVersion:'synthetic-shadow-plan-v1',purpose:'candidate_pool',durationSeconds:720,mainQuestionTarget:1,limitations:['Public synthetic fixture, not real question/evaluation approval.'],slots:[slot]};
  const environment={OPENAI_QUESTION_MODEL:'synthetic-shadow-question-review',CLOVA_VOICE_SPEAKER:'synthetic_voice',CLOVA_VOICE_SECOND_SPEAKER:'synthetic_second'};
  const identity=banks.questionBankIdentity(fullContext,{plan,environment}),questionText='전도도를 비교할 때 어떤 순서로 진행했나요?';
  const sourceEvidence=fullContext.student.evidence.find(value=>objective.evidenceIds.includes(value.id));
  if(!sourceEvidence)throw new Error('PR07D_SYNTHETIC_QUESTION_SOURCE_MISSING');
  const draft={acknowledgement:null,acknowledgementQuote:null,questionText,questionKind:'main',parentMainQuestionId:null,evidenceIds:slot.evidenceIds,
    evidenceQuotes:slot.evidenceIds.map(id=>{const evidence=fullContext.student.evidence.find(value=>value.id===id);if(!evidence)throw new Error('PR07D_QUESTION_CITATION_SOURCE_MISSING');return{evidenceId:id,quote:evidence.text,sourceStartOffset:0,sourceEndOffset:evidence.text.length,matchKind:'exact'};}),
    primaryFunction:slot.primaryFunction,questionIntent:objective.questionIntent,targetEvidence:objective.targetEvidence,depth:slot.depth,groundingRationale:'공개 합성 원문의 실제 수행 요구만을 명시적으로 검수한 fixture다.',validationStatus:'approved',validationFailures:[],
    premiseValidation:{version:'question-premise-v1',guidelineVersion:'2.3',status:'approved',method:'bounded_semantic_review',reviewModel:identity.questionModel,questionSha256:hash(questionText),coreIntentCount:1,supportedPremises:[],openChecks:[{questionStartOffset:0,questionEndOffset:questionText.length,kind:'open_check'}]}};
  const session={id:'synthetic-shadow-preparation',turns:[],plan};
  draft.questionReferenceContext={schemaVersion:fullContext.questionReferences.schemaVersion,catalogSha256:fullContext.questionReferences.digest,
    exampleIds:[],purpose:'wording_reference_only',analysisKey:fullContext.questionReferences.analysis.key,referenceUses:[]};
  draft.strategyTrace={catalogDigest:fullContext.questionStrategies.contentSha256,candidateCardIds:[],selectedCardId:null,sourceQuestionIds:[],policyVersion:'explicit-synthetic-no-reference-selection',selectionReason:'합성 원문 질문에는 참고 카드 선택을 선언하지 않는다.'};
  draft.questionBlueprint=createQuestionBlueprint(draft,fullContext,session,{questionId:slot.id});
  draft.approvedQuestion=approveQuestionContract(draft,draft.questionBlueprint,{policyDigest:fullContext.interviewerPolicy.contentSha256,strategyCatalogDigest:fullContext.questionStrategies.contentSha256});
  const {syntheticMp3}=await import('./media-fixtures.ts'),audio=syntheticMp3(),voice=identity.voices.primary,speechHash=speechAudioCacheId(questionText,voice);
  const candidate={id:bankHash({bankKey:identity.key,slotId:slot.id,variant:0}),slotId:slot.id,mainIndex:1,variant:0,createdAt:'2026-11-07T00:00:00.000Z',
    draft,questionSha256:hash(questionText),questionAudioUrl:'/api/audio/'+speechHash,speechHash,audioSha256:hash(audio),voiceSettings:voice};
  await save(`data/audio/${speechHash}.mp3`,audio);
  const bankBody={schemaVersion:banks.QUESTION_BANK_POLICY_VERSION,status:'ready',key:identity.key,createdAt:candidate.createdAt,completedAt:candidate.createdAt,
    plan,target:identity.target,rulesVersion:fullContext.manifest.rulesVersion,activitiesContentSha256:fullContext.preparedActivities?.contentSha256??null,
    questionReferenceDigest:identity.questionReferenceDigest,sourceFingerprint:identity.sourceFingerprint,questionModel:identity.questionModel,voices:identity.voices,
    slots:[{slotId:slot.id,mainIndex:1,candidates:[candidate]}]};
  const bank={...bankBody,contentSha256:bankHash(bankBody)};
  await save(`data/prepared/question-banks/${bank.key}.json`,jsonBytes(bank));
  const diagnostic=await banks.inspectPreparedMainCandidate(fullContext,candidate,{root,plan,environment});
  if(!diagnostic.valid)throw new Error('PR07D_SYNTHETIC_BANK_GATE_'+diagnostic.gate+'_'+(diagnostic.failureCode??'REJECTED'));
  if(!await banks.loadQuestionBank(fullContext,{root,plan,environment}))throw new Error('PR07D_SYNTHETIC_READY_BANK_REJECTED');
  const review=await buildShadowReviewChainFixture({codeRoot,root,context,source,wire:original.wire});
  // Review preparation may save its own current pointer in this new fixture.
  // Publish the declared v2 baseline selection before freezing all inputs.
  await save('data/prepared/student-analysis-current.json',jsonBytes({path:v2Ref,revision:v2.common.revision,sourceContentSha256:source.contentSha256}));
  fixture={version:'pr07d-public-synthetic-fixture-v1',configuration,sourceRef,v2Ref,v1Ref,source,contextInput:context,
    scope:{studentId:source.studentId,supportTargetId:context.school.interview?.id??null,sourceRevision:source.revision},
    plan,environment,bankKey:bank.key,bankContentSha256:bank.contentSha256,speechHash,review,book:{syntheticReviewCalls:book.syntheticReviewCalls,syntheticStrategyCalls:book.syntheticStrategyCalls,paidProviderCalls:0},
    publicSchoolIds:{universityId:universities[0].id,departmentId:departments[0].id,admissionTrackId:admissionTracks[0].id},profileRevision:v2.target.profileRevision,
    classification:'student-and-analysis-synthetic; school catalogs and exact policy MD are existing Git-public reference dependencies',approvedEvaluationCount:0};
  const artifacts=[];
  const add=(artifactId,role,reference,selection,objectKind,extra={})=>{
    const sourcePath=extra.localFile??reference;delete extra.localFile;
    const row={artifactId,role,reference,selection,objectKind,scope:'common',required:true,availability:'present',
      source:{rootId:'fixture',relativePath:sourcePath},classification:'dependency',dependencies:[],...extra};artifacts.push(row);return row;
  };
  for(const [role,reference] of Object.entries(configuration.files))if(role!=='sourceManifest')
    add('input-'+role,'configured-input:'+role,reference,'configured',role==='studentPdf'?'source-pdf':reference.endsWith('.md')?'source-markdown':'source-json',{classification:'selected'});
  add('source','full-record-document',sourceRef,'current','source-json',{domainSha256:source.contentSha256,sourceRevision:source.revision,legacyId:source.sourceDocumentId,
    dependencies:[{artifactId:'input-studentPdf',required:true}]});
  add('source-pointer','full-record-pointer','data/prepared/full-record-current.json','current','source-json',{dependencies:[{artifactId:'source',required:true}]});
  add('analysis-v2','analysis-document',v2Ref,'current','analysis-json',{scope:'target',sourceRevision:source.revision,versionId:payload.common.schemaVersion,legacyId:payload.common.revision,
    dependencies:[{artifactId:'source',required:true}],aliases:['staged','revision','review-parent','historical'].map(selection=>({role:'analysis-document',reference:v2Ref,selection}))});
  add('analysis-v1','analysis-document',v1Ref,'staged','analysis-json',{scope:'target',sourceRevision:source.revision,versionId:historical.common.schemaVersion,legacyId:historical.common.revision,
    dependencies:[{artifactId:'source',required:true}],aliases:['current','revision','review-parent','historical'].map(selection=>({role:'analysis-document',reference:v1Ref,selection}))});
  add('analysis-qa','analysis-qa',path.join(path.dirname(v2Ref),'analysis-qa.json'),'dependency','review-bundle',{scope:'target',sourceRevision:source.revision,
    dependencies:[{artifactId:'analysis-v2',required:true}]});
  add('analysis-pointer','analysis-pointer','data/prepared/student-analysis-current.json','current','source-json',{scope:'target',sourceRevision:source.revision,
    dependencies:[{artifactId:'analysis-v2',required:true}]});
  add('audio','audio',speechHash,'dependency','audio',{scope:'target',sourceRevision:source.revision,mediaType:'audio/mpeg',localFile:`data/audio/${speechHash}.mp3`});
  add('bank','bank-ready',`data/prepared/question-banks/${bank.key}.json`,'current','source-json',{scope:'target',sourceRevision:source.revision,domainSha256:bank.contentSha256,
    dependencies:[{artifactId:'analysis-v2',required:true},{artifactId:'audio',required:true}],aliases:[{role:'bank-ready',reference:`data/prepared/question-banks/${bank.key}.json`,selection:'pinned'}]});
  const absent=(artifactId,role,reference)=>artifacts.push({artifactId,role,reference,selection:'dependency',scope:'target',required:false,availability:'absent',absenceReason:'known-absent',dependencies:[]});
  absent('registry','bank-scope-registry-pointer','data/prepared/evaluation-scope-registry/current.json');
  absent('bank-partial','bank-partial',`data/prepared/question-banks/${bank.key}.partial.json`);
  artifacts.push(...book.artifacts,...review.artifacts);
  fixture.artifacts=artifacts;fixture.provenanceOwnerId='local-development-owner';
  fixture.pointers=[{name:'full-record-pointer',selection:'current',artifactId:'source-pointer'},{name:'analysis-pointer',selection:'current',artifactId:'analysis-pointer'}];
  fixture.historicalCurrentRoot=root+'-historical-current';
  await save('fixture-manifest.json',jsonBytes(fixture));
  await fs.promises.cp(root,fixture.historicalCurrentRoot,{recursive:true,errorOnExist:true,force:false});
  await writeFile(path.join(fixture.historicalCurrentRoot,'data/prepared/student-analysis-current.json'),jsonBytes({path:v1Ref,revision:historical.common.revision,sourceContentSha256:source.contentSha256}));
} else {
  fixture=JSON.parse(await readFile(path.join(root,'fixture-manifest.json'),'utf8'));applyConfig(fixture.configuration);
}
const capture=async operation=>{
  const before={reads:metrics.fixtureFileReads,writes:metrics.fixtureFileWrites};let result;
  try{result={status:'fulfilled',value:await operation()};}catch(error){result={status:'rejected',code:typeof error?.code==='string'?error.code:null,message:error instanceof Error?error.message:'unknown'};}
  return {...result,effects:{fixtureFileReads:metrics.fixtureFileReads-before.reads,fixtureFileWrites:metrics.fixtureFileWrites-before.writes,paidProviderCalls:0}};
};
observing=true;
const result={version:'pr07d-exact-c-local-baseline-v1',codeCommit:actual,configurationKind:'explicit-synthetic-input; C source blobs unchanged',
  source:await capture(()=>analysis.loadFullRecord(root,fixture.source.pdfSha256)),
  context:await capture(()=>loadInterviewContextAt(root,{writeManifest:false})),
  current:await capture(()=>analysis.loadFullStudentAnalysisSnapshot(fixture.contextInput,root)),
  staged:await capture(()=>analysis.loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v2Ref,root)),
  historical:await capture(()=>analysis.loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v1Ref,root,{purpose:'historical-revision'})),
  historicalV2:await capture(()=>analysis.loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.v2Ref,root,{purpose:'historical-revision'})),
  legacyCurrent:await capture(()=>analysis.loadFullStudentAnalysisSnapshot(fixture.contextInput,fixture.historicalCurrentRoot)),
  review:await capture(()=>analysis.loadStagedFullStudentAnalysisSnapshot(fixture.contextInput,fixture.review.child.revisionPath,root)),
  ancestry:await capture(()=>questionReview.resolveQuestionReviewAuthority(fixture.review.reviewContext,fixture.review.objectiveId,fixture.review.questionSha256,fixture.review.reviewModel,root)),
  bank:await capture(async()=>banks.loadQuestionBank(await loadInterviewContextAt(root,{writeManifest:false}),{root,plan:fixture.plan,environment:fixture.environment})),
  metrics};
result.rawArtifacts=[];
for(const artifact of fixture.artifacts.filter(a=>a.availability==='present')) {
  const bytes=await fs.promises.readFile(path.join(root,artifact.source.relativePath));
  result.rawArtifacts.push({role:artifact.role,reference:artifact.reference,sizeBytes:bytes.length,sha256:hash(bytes)});
}
observing=false;
if(metrics.fixtureFileWrites!==0)throw new Error('PR07D_BASELINE_READ_SIDE_EFFECT');
await fs.promises.mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:'completed',codeCommit:actual,mode,fixtureFileReads:metrics.fixtureFileReads,fixtureFileWrites:metrics.fixtureFileWrites,contextErrors:result.context.status==='fulfilled'?result.context.value.errors.length:null,resultFile:output}));

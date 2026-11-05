import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {interviewConfig} from '../interview.config';
import {compileInterviewerPolicy} from '../server/policy/interviewer-policy';
import {captureFullMdPolicyOriginals,fullMdPolicyRoles} from '../server/policy/full-md-policy';
import {compilePolicyClauseRegistry,selectRuntimePolicy,selectSingleCorePolicy,SINGLE_CORE_CANONICAL_POLICY,policyHeadingParentLinks} from '../server/policy/compiled-runtime-policy';
import type {InterviewSession} from '../server/protocol';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const interviewerPolicy=await compileInterviewerPolicy();
 const inputs=await Promise.all(fullMdPolicyRoles.map(async role=>{const path=interviewConfig.files[role];return {role,path,sha256:interviewerPolicy.sourceFiles.find(source=>source.path===path)!.sha256,bytes:await readFile(path)};}));
 return {interviewerPolicy,fullMdPolicyOriginals:captureFullMdPolicyOriginals(inputs,interviewerPolicy),manifest:{files:inputs.map(({role,path,sha256})=>({role,path,sha256})),interviewerPolicy:{contentSha256:interviewerPolicy.contentSha256}}};
}
test('registry partitions every original character in all twelve documents with exact source spans',async()=>{
 const context=await fixture(),registry=compilePolicyClauseRegistry(context);
 assert.equal(registry.coverage.documents,12);assert.equal(registry.coverage.exactSourcePartition,true);
 assert.equal(registry.coverage.coveredCharacters,registry.coverage.originalCharacters);
 assert.equal(registry.coverage.mappedArticles,68);assert.equal(registry.coverage.unknownArticles,0);assert.equal(registry.coverage.semanticCompletenessProven,false);
 for(const doc of context.fullMdPolicyOriginals.documents){const clauses=registry.clauses.filter(c=>c.role===doc.role);let offset=0;let recovered='';for(const clause of clauses){assert.equal(clause.source.startOffset,offset);const text=doc.text.slice(offset,clause.source.endOffset);assert.equal(sha(text),clause.source.textSha256);recovered+=text;offset=clause.source.endOffset;}assert.equal(recovered,doc.text);}
 for(const clause of registry.clauses){assert.ok(clause.handling);assert.ok(clause.testIds.length);await Promise.all([...clause.enforcers,...clause.testIds].map(file=>access(file)));}
});
test('all mapped realtime article instructions stay active while other stages have explicit exclusion reasons',async()=>{
 const context=await fixture(),registry=compilePolicyClauseRegistry(context),selected=selectRuntimePolicy(context);
 for(const clause of registry.clauses.filter(c=>c.stage==='realtime'&&c.instruction)){assert.ok(selected.trace.activeClauseIds.includes(clause.id));assert.ok(selected.instructions.includes(clause.instruction!));}
 assert.ok(selected.trace.omittedClauses.some(c=>c.stage==='evaluation'&&c.reason==='applies_at_evaluation_stage'));
 assert.ok(selected.trace.omittedClauses.some(c=>c.stage==='product'));
 assert.ok(selected.instructions.includes('USER_SINGLE_REALTIME_CORE'));assert.ok(selected.instructions.includes('최대2'));
 assert.ok(selected.instructions.length<15000,'bounded compiled instructions, not 334k full originals');
 for(const doc of context.fullMdPolicyOriginals.documents)assert.ok(!selected.instructions.includes(doc.text));
 assert.deepEqual(selected,selectRuntimePolicy(context));
});
test('conditional excerpts preserve exact normative source and all mandatory rules, even with mixed dialogue signals',async()=>{
 const context=await fixture();
 const session={turns:[{rawTranscript:'앞서 잘못 말했습니다. 정정할게요. 원자료는 기억나지 않는데 질문을 다시 설명해 주세요.',metadata:{primaryFunction:'EVIDENCE'}}]} as unknown as Pick<InterviewSession,'turns'>;
 const base=selectRuntimePolicy(context),selected=selectRuntimePolicy(context,session),registry=compilePolicyClauseRegistry(context);
 assert.deepEqual(selected.trace.activeClauseIds,base.trace.activeClauseIds);assert.equal(selected.trace.originalExcerptClauseIds.length,3);assert.ok(selected.trace.originalExcerptCharacters<=2400);
 for(const id of selected.trace.originalExcerptClauseIds){const clause=registry.clauses.find(c=>c.id===id)!,doc=context.fullMdPolicyOriginals.documents.find(d=>d.role===clause.role)!;assert.ok(selected.instructions.includes(doc.text.slice(clause.source.startOffset,clause.source.endOffset)));}
});
test('updating MD hashes without a reviewed policy mapping cannot silently publish new normative clauses',async()=>{
 const context=await fixture(),doc=context.fullMdPolicyOriginals.documents.find(d=>d.role==='questionGuidelines')!;
 doc.text+='\n### 제99조 (새 필수 규정)\n새로운 요구를 하여야 한다.\n';doc.sha256=sha(doc.text);
 context.manifest.files.find(f=>f.path===doc.path)!.sha256=doc.sha256;context.interviewerPolicy.sourceFiles.find(f=>f.path===doc.path)!.sha256=doc.sha256;
 context.fullMdPolicyOriginals.contentSha256=sha(JSON.stringify({version:context.fullMdPolicyOriginals.version,documents:context.fullMdPolicyOriginals.documents}));
 assert.throws(()=>compilePolicyClauseRegistry(context),/POLICY_MAPPING_REVIEW_REQUIRED/u);
});
test('article child headings inherit the correct parent while sibling articles and appendices end that scope',()=>{
 const links=policyHeadingParentLinks([{id:'doc',title:'# 정본',article:null},{id:'a15',title:'### 제15조 (후속 질문)',article:15},{id:'child',title:'#### 실패 후 복구',article:null},{id:'grandchild',title:'##### 발화 금지',article:null},{id:'a16',title:'### 제16조 (재진술)',article:16},{id:'appendix',title:'## 별표 규범',article:null}]);
 assert.equal(links[2].parentClauseId,'a15');assert.equal(links[2].parentArticleClauseId,'a15');assert.equal(links[3].parentClauseId,'child');assert.equal(links[3].parentArticle,15);
 assert.equal(links[4].parentArticleClauseId,null);assert.equal(links[5].parentArticleClauseId,null);
});
test('normative appendix sections link to governing articles without repeating prompt instructions',async()=>{
 const context=await fixture(),registry=compilePolicyClauseRegistry(context),selected=selectRuntimePolicy(context);
 const section=registry.clauses.find(clause=>clause.role==='questionGuidelines'&&clause.title.includes('6-1. 질문 QA 루브릭'))!;
 assert.ok(section.parentClauseId);assert.equal(section.parentArticleClauseId,null);assert.equal(section.semanticStatus,'linked_normative_section_mapping');assert.equal(section.instruction,null);
 assert.ok(section.governingArticleClauseIds.some(id=>registry.clauses.find(clause=>clause.id===id)?.article===23));
 const ids=new Set(registry.clauses.map(clause=>clause.id));
 for(const clause of registry.clauses){if(clause.parentClauseId)assert.ok(ids.has(clause.parentClauseId));for(const id of clause.governingArticleClauseIds)assert.ok(ids.has(id));if(['operatingGuidelines','questionGuidelines'].includes(clause.role)&&clause.handling!=='reference_material')assert.ok(clause.governingArticleClauseIds.length);}
 assert.ok(selected.instructions.length<8000,'article linkage must stay bounded without copying the source corpus');assert.equal(registry.coverage.mappedArticles,68);assert.ok(registry.coverage.explicitlyLinkedNormativeSections>0);
});

test('single-core canonical rendering accounts for every realtime article exactly once and preserves all overrides',async()=>{
 const context=await fixture(),base=selectRuntimePolicy(context),selected=selectSingleCorePolicy(context),registry=compilePolicyClauseRegistry(context);
 const bindings=selected.trace.canonicalRuleBindings!;
 const sourceIds=bindings.flatMap(binding=>binding.sourceClauseIds);
 const required=registry.clauses.filter(clause=>clause.stage==='realtime'&&clause.instruction).map(clause=>clause.id);
 assert.equal(sourceIds.length,required.length);assert.equal(new Set(sourceIds).size,required.length);
 assert.deepEqual(new Set(sourceIds),new Set(required));
 assert.equal(selected.trace.registrySha256,base.trace.registrySha256,'Renderer changes do not forge a new source registry or mutate bank pins.');
 for(const rule of SINGLE_CORE_CANONICAL_POLICY)assert.equal(selected.fixedInstructions!.split(rule.text).length-1,1);
 for(const rule of context.interviewerPolicy.userOverrides)assert.ok(selected.fixedInstructions!.includes(rule.instruction));
 assert.ok(selected.fixedInstructions!.length<base.fixedInstructions!.length);
 assert.equal(selected.trace.semanticCompletenessProven,false,'Structural accounting is not a quality claim.');
});

test('single-core reusable prefix stays identical when conditional MD excerpts change',async()=>{
 const context=await fixture();
 const session={turns:[{rawTranscript:'정정합니다. 기억나지 않아 질문을 다시 설명해 주세요.',metadata:{primaryFunction:'EVIDENCE'}}]} as unknown as Pick<InterviewSession,'turns'>;
 const base=selectSingleCorePolicy(context),selected=selectSingleCorePolicy(context,session);
 assert.equal(base.fixedInstructions,selected.fixedInstructions);assert.notEqual(base.conditionalInstructions,selected.conditionalInstructions);
 assert.deepEqual(selected.trace.activeClauseIds,base.trace.activeClauseIds);
 const registry=compilePolicyClauseRegistry(context);
 for(const id of selected.trace.originalExcerptClauseIds){const clause=registry.clauses.find(c=>c.id===id)!,doc=context.fullMdPolicyOriginals.documents.find(d=>d.role===clause.role)!;assert.ok(selected.conditionalInstructions!.includes(doc.text.slice(clause.source.startOffset,clause.source.endOffset)));}
});

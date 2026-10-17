import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {schoolDirectory,normalizeSchoolSelection,schoolDirectoryForTarget} from '../apps/web/src/lib/school-directory';
import {schoolTalentForTarget,schoolTalentCoverage,schoolTalentQuestionRows,talentQuestionMatchesTarget} from '../apps/web/src/lib/school-talent-model';
import {schoolQuizItems,schoolQuizTargetIdentity,sameSchoolQuizSource} from '../apps/web/src/lib/school-quiz';
import {buildContentGrowth,growthContextKey} from '../apps/web/src/lib/learning-growth';
import {knowledgeTarget,schoolKnowledgeReadings} from '../apps/web/src/lib/knowledge-target-model';
import {matchKnowledgeVideos,majorKnowledgeTopics} from '../apps/web/src/lib/knowledge-bites-catalog';
import {selectSchoolMajorSamples,matrixSeed,catalogueTarget} from '../.local/school-major-selection.mjs';

const rows=schoolTalentQuestionRows(),samples=selectSchoolMajorSamples();
let checkedTuples=0;
test('all 88 schools and all 3884 selectable public units receive their own sourced university context',()=>{
  const coverage=schoolTalentCoverage();assert.equal(coverage.registeredSchools,88);
  assert.equal(coverage.officialSourceSchools,88,'Every registered school must have a sourced institution definition');
  assert.equal(coverage.needsConfirmationSchools,0);
  const ids=new Set<string>();
  for(const school of schoolDirectory)for(const department of school.departments){
    const target=catalogueTarget(school,department,`${school.id}:${department.id}`);
    const normalized=normalizeSchoolSelection({referenceId:school.id,departmentId:department.id});
    assert.equal(normalized.department?.id,department.id);
    assert.equal(normalized.campus,target.campus);
    assert.equal(schoolDirectoryForTarget(target)?.id,school.id);
    const talent=schoolTalentForTarget(target),snapshot=schoolQuizTargetIdentity(target);
    assert.equal(talent.status,'official_source',`${school.university} / ${department.name}`);
    assert.equal(snapshot?.department_catalog_id,department.id);
    assert.equal(snapshot?.school_reference_id,school.id);
    assert.equal(snapshot?.department_field,department.field);
    assert.ok(talent.profiles.some(profile=>profile.scope==='university'));
    assert.equal(talent.departmentStatus,talent.profiles.some(profile=>profile.scope==='department')?'official_source':'university_shared');
    for(const profile of talent.profiles){
      assert.equal(profile.university,school.canonicalName);
      if(profile.scope==='department')assert.equal(profile.department,department.name);
      assert.ok(new URL(profile.source.url).hostname);
      assert.ok(profile.source.checkedAt);
      if(profile.source.applicableYear!==null)assert.equal(profile.source.applicableYear,2027);
    }
    const eligible=rows.filter(row=>row.school_reference_id===school.id&&talentQuestionMatchesTarget(row.data,target));
    assert.ok(eligible.length>0,`No sourced talent question for ${school.university}/${department.name}`);
    const pool=schoolQuizItems(eligible.map(row=>({...row.data,id:row.id,prompt:row.prompt,common_revision:row.revision,source_snapshot:row.source})),target);
    assert.equal(pool.length,eligible.length);
    assert.ok(pool.every(item=>item.target_snapshot?.department_catalog_id===department.id&&item.source_snapshot.officialPastQuestion===false&&item.modelAnswer===''));
    for(const item of pool){assert.ok(!ids.has(item.id),'Each department question identity must remain distinct');ids.add(item.id);}
    checkedTuples++;
  }
  assert.equal(checkedTuples,3884);
  writeFileSync('.local/school-major-matrix-coverage.json',JSON.stringify({seed:matrixSeed,schools:coverage.registeredSchools,departments:checkedTuples,officialSchools:coverage.officialSourceSchools,officialDepartmentProfiles:coverage.rows.reduce((n,row)=>n+row.departmentProfileCount,0),distinctPracticeItems:ids.size,departmentCatalogueYear:2026,admissionYearTested:2027,departmentScope:'University-wide verified definitions are shared; only separately sourced department definitions are labelled department-specific.',checkedAt:'2026-10-13'},null,2));
});
test('seeded random sampling covers eight actual distinct schools and meaningful fields without invented departments',()=>{
  assert.deepEqual(selectSchoolMajorSamples(matrixSeed).map(row=>[row.school.id,row.department.id]),samples.map(row=>[row.school.id,row.department.id]));
  assert.equal(new Set(samples.map(row=>row.school.id)).size,8);
  assert.deepEqual(samples.map(row=>row.stratum),['humanities','technology','medicine','education','environment','arts','campus','broad']);
  for(const {school,department} of samples)assert.ok(schoolDirectory.find(row=>row.id===school.id)?.departments.some(row=>row.id===department.id&&row.name===department.name));
});
test('every school question rejects another institution and department definitions never leak to another department',()=>{
  for(const row of rows){
    const source=schoolDirectory.find(school=>school.id===row.school_reference_id)!;
    const foreign=schoolDirectory.find(school=>school.canonicalName!==source.canonicalName)!;
    assert.equal(talentQuestionMatchesTarget(row.data,catalogueTarget(foreign,foreign.departments[0])),false);
    if(row.data.talent_profile.scope==='department'){
      const other=source.departments.find(dept=>dept.name!==row.data.talent_profile.department)!;
      assert.equal(talentQuestionMatchesTarget(row.data,catalogueTarget(source,other)),false);
    }
  }
});
test('year- or campus-bound provenance is explicit and cannot silently move to a different scope',()=>{
  for(const row of rows){
    const school=schoolDirectory.find(s=>s.id===row.school_reference_id)!;
    const department=school.departments.find(d=>d.name===row.data.talent_profile.department)||school.departments[0];
    const target=catalogueTarget(school,department);
    if(row.source.applicableYear!==null)assert.equal(talentQuestionMatchesTarget(row.data,{...target,admission_year:row.source.applicableYear+1}),false);
    if(row.data.talent_profile.campus)assert.equal(talentQuestionMatchesTarget(row.data,{...target,campus:'not-the-selected-campus'}),false);
  }
});
test('same question targets and changed department identities remain separate in recall and report comparisons',()=>{
  const {school,department}=samples[0],first=catalogueTarget(school,department,'same-target');
  const other=school.departments.find(d=>d.id!==department.id)!;
  const second=catalogueTarget(school,other,'same-target');
  const question={id:'shared-question',prompt:'지원 이유를 설명해 주세요.',common_revision:1,source_snapshot:{url:school.admissionUrl,officialPastQuestion:false}};
  const a=schoolQuizItems([question],first)[0],b=schoolQuizItems([question],second)[0];
  assert.notEqual(a.id,b.id);assert.equal(sameSchoolQuizSource(a,b),false);
  const before={id:'first',question_id:question.id,script:'합성 첫 답변',target_id:first.id,target_snapshot:a.target_snapshot,common_revision:1,created_at:'2026-10-13T00:00:00Z'};
  const after={...before,id:'second',script:'합성 두 번째 답변에 결과와 한계를 확인했습니다.',target_snapshot:b.target_snapshot,created_at:'2026-10-13T00:01:00Z'};
  assert.notEqual(growthContextKey(before),growthContextKey(after));
  assert.equal(buildContentGrowth([before,after]).comparisons.length,0);
});
test('personal Q&A and the same interview answer compare, while a distinct concept question stays separate',()=>{
  const {school,department}=samples[1],target=catalogueTarget(school,department);
  const before={id:'quiz',question_id:'same-sourced-question',practice_kind:'personal',script:'합성 첫 답변',target_id:target.id,target_snapshot:target,common_revision:1,created_at:'2026-10-13T00:00:00Z'};
  const after={...before,id:'interview',practice_kind:undefined,script:'제가 자료 3개를 비교했고 한계를 확인했습니다.',created_at:'2026-10-13T00:01:00Z'};
  assert.equal(buildContentGrowth([before,after]).comparisons.length,1,'Same Q&A must feed later interview growth');
  assert.equal(buildContentGrowth([before,{...after,practice_kind:'concept'}]).comparisons.length,0);
});
test('every real department has official school readings and honest major learning lenses without fabricated student facts',()=>{
  const readingIds=new Set<string>(),categories=new Set<string>();let tuples=0;
  for(const school of schoolDirectory)for(const department of school.departments){
    const target=catalogueTarget(school,department,`${school.id}:${department.id}`),lens=knowledgeTarget(target);
    const eligible=rows.filter(row=>row.school_reference_id===school.id&&talentQuestionMatchesTarget(row.data,target));
    const questions=eligible.map(row=>({id:row.id,prompt:row.prompt,activityIds:[],sourceKind:'common' as const,commonRevision:row.revision,sourceSnapshot:row.source,targetId:target.id,targetSnapshot:lens.snapshot}));
    const readings=schoolKnowledgeReadings(target,questions),videos=matchKnowledgeVideos({},lens);
    assert.equal(lens.departmentCatalogId,department.id);
    assert.ok(readings.length>0&&videos.length>0,`${school.university}/${department.name} must never have a blank knowledge flow`);
    assert.ok(videos.every(item=>item.activities.length===0&&item.contexts?.every(context=>context.kind==='major'&&context.targetId===target.id)));
    assert.ok(videos.every(item=>majorKnowledgeTopics(lens).includes(item.topic)));
    for(const reading of readings){
      assert.equal(reading.kind,'reading');assert.equal(reading.activities.length,0);assert.equal(reading.thumbnail,'');
      assert.ok(/^r_[A-Za-z0-9_-]{9}$/.test(reading.id));assert.ok(!readingIds.has(reading.id));readingIds.add(reading.id);
      assert.equal(reading.targetSnapshot?.department_catalog_id,department.id);
      assert.ok(reading.sourceSnapshot?.url===reading.url&&reading.url.startsWith('https://'));
      assert.ok(reading.relatedQuestionIds?.length&&reading.relatedQuestionIds.every(id=>eligible.some(row=>row.id===id)));
      if(reading.sourceSnapshot?.scope==='department')assert.equal(reading.sourceSnapshot?.profileId,schoolTalentForTarget(target).profiles.find(profile=>profile.scope==='department')?.id);
    }
    categories.add(`${department.category} | ${department.field}`);tuples++;
  }
  assert.equal(tuples,3884);assert.equal(categories.size,35);
  writeFileSync('.local/school-major-knowledge-coverage.json',JSON.stringify({seed:matrixSeed,schools:88,departmentTuples:tuples,publicCategoryFieldPairs:categories.size,officialReadings:readingIds.size,emptyTargetFlows:0,originalStudentsChanged:0,externalRequests:0,scope:'Curated videos are broad department-category learning lenses, not complete department curricula; official institution readings are individually source-linked.'},null,2));
});
test('changed admissions stage is a different practice context even when the owner target ID stays the same',()=>{
  const {school,department}=samples[2],target={...catalogueTarget(school,department),interview_stage:'1단계'};
  const question={id:'stage-question',prompt:'지원 이유를 설명해 주세요.',common_revision:1,source_snapshot:{url:school.admissionUrl}};
  const first=schoolQuizItems([question],target)[0],second=schoolQuizItems([question],{...target,interview_stage:'2단계'})[0];
  assert.notEqual(first.id,second.id);
  const before={id:'first-stage',question_id:question.id,script:'첫 단계의 합성 답변',target_id:target.id,target_snapshot:first.target_snapshot,common_revision:1,created_at:'2026-10-13T00:00:00Z'};
  const after={...before,id:'second-stage',script:'다음 단계에서 자료 3개의 한계를 확인했습니다.',target_snapshot:second.target_snapshot,created_at:'2026-10-13T00:01:00Z'};
  assert.notEqual(growthContextKey(before),growthContextKey(after));
  assert.equal(buildContentGrowth([before,after]).comparisons.length,0);
});

import {readFileSync,writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {resolve,join} from 'node:path';
import {schoolDirectory} from '../apps/web/src/lib/school-directory.ts';
import type {SchoolTalentProfile} from '../apps/web/src/lib/school-talent-model.ts';

// Research fragments are additive. A saved public question's source must never
// change under its existing profile revision.
const root=resolve(import.meta.dirname,'..');
const cataloguePath=join(root,'apps/web/src/data/school-talent-profiles.json');
const catalogue=JSON.parse(readFileSync(cataloguePath,'utf8')) as {checkedAt:string;profiles:SchoolTalentProfile[]};
const files=process.argv.slice(2);
if(!files.length)throw new Error('공식 출처를 검증한 인재상 fragment 파일을 지정해 주세요.');
let inserted=0;
for(const file of files){
  const fragment=JSON.parse(readFileSync(resolve(root,file),'utf8'));
  if(!Array.isArray(fragment.profiles))throw new Error(`${file}: profiles 배열이 필요해요.`);
  for(const raw of fragment.profiles){
    const profile=raw as SchoolTalentProfile;
    const school=schoolDirectory.find(item=>item.id===profile.schoolReferenceId);
    if(!school || school.canonicalName!==profile.university)throw new Error(`${file}: 학교 이름과 catalogue ID가 일치하지 않아요: ${profile.id}`);
    if(!profile.id || !Number.isInteger(profile.revision) || profile.revision<1 || !['university','department'].includes(profile.scope) || profile.status!=='official_source')throw new Error(`${file}: profile 식별자·revision·scope·status를 확인해 주세요.`);
    if(profile.scope==='department' && !profile.department)throw new Error(`${file}: 학과 출처의 모집단위가 없어요.`);
    if(profile.definitionKind && !['talent','education_goal','core_competencies'].includes(profile.definitionKind))throw new Error(`${file}: 공식 정의의 종류를 확인해 주세요.`);
    const source=profile.source;
    const url=new URL(source?.url);
    if(url.protocol!=='https:' || url.username || url.password || !source.title || !/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt) || !source.note || !('publishedAt' in source) || !('applicableYear' in source))throw new Error(`${file}: 공식 출처 URL·확인일·적용 범위가 필요해요.`);
    if(source.applicableYear!==null && (!Number.isInteger(source.applicableYear)||source.applicableYear<2024))throw new Error(`${file}: 적용 학년도는 정수 또는 null이어야 해요.`);
    if(!profile.title || !Array.isArray(profile.points) || !profile.points.length || profile.points.some(point=>!point.id || !point.label || !point.description) || new Set(profile.points.map(point=>point.id)).size!==profile.points.length)throw new Error(`${file}: 중복 없는 공식 정의 요약이 필요해요.`);
    if('evaluation_weights' in raw || 'question_distribution' in raw || (raw as any).officialPastQuestion)throw new Error(`${file}: 인재상에 배점·출제 비율·기출 표시를 넣을 수 없어요.`);
    const existing=catalogue.profiles.find(item=>item.id===profile.id && item.revision===profile.revision);
    if(existing){if(!isDeepStrictEqual(existing,profile))throw new Error(`${file}: 기존 ${profile.id} revision ${profile.revision} 내용이 달라요. 새로운 revision을 추가해 주세요.`);continue;}
    const old=catalogue.profiles.filter(item=>item.id===profile.id);
    if(old.some(item=>item.revision>profile.revision))throw new Error(`${file}: 과거 revision을 뒤늦게 삽입하지 마세요.`);
    catalogue.profiles.push(profile);inserted++;
    if(source.checkedAt>catalogue.checkedAt)catalogue.checkedAt=source.checkedAt;
  }
}
catalogue.profiles.sort((a,b)=>a.university.localeCompare(b.university,'ko') || a.id.localeCompare(b.id) || a.revision-b.revision);
writeFileSync(cataloguePath,JSON.stringify(catalogue,null,2)+'\n');
const {schoolTalentCoverage}=await import('../apps/web/src/lib/school-talent-model.ts');
const coverage=schoolTalentCoverage();
writeFileSync(join(root,'.local/school-talent-coverage-2026-10-13.json'),JSON.stringify(coverage,null,2)+'\n');
console.log(JSON.stringify({inserted,registeredSchools:coverage.registeredSchools,officialSourceSchools:coverage.officialSourceSchools,needsConfirmationSchools:coverage.needsConfirmationSchools,profiles:coverage.profiles}));

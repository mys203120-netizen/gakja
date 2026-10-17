import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const matrixSeed=20261013;
export const matrixDirectory=JSON.parse(readFileSync(fileURLToPath(new URL('../../apps/web/src/data/school-directory.json',import.meta.url)),'utf8'));
/** Deterministic stratification makes a failed school / department case reproducible. */
export function selectSchoolMajorSamples(seed=matrixSeed) {
  let state=seed>>>0;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const tuples=matrixDirectory.schools.flatMap(school=>school.departments.map(department=>({school,department})));
  const groups=[
    ['humanities',row=>/인문학|언어.*문학/.test(row.department.category)],
    ['technology',row=>/전기|전자|컴퓨터/.test(row.department.category)],
    ['medicine',row=>/의료|간호|보건|약학/.test(row.department.category)],
    ['education',row=>row.department.category==='교육'],
    ['environment',row=>/환경/.test(row.department.name)&&['공학계열','자연과학계열'].includes(row.department.field)],
    ['arts',row=>row.department.field==='예체능계열'],
    ['campus',row=>Boolean(row.school.campusLabel)],
    ['broad',()=>true],
  ];
  const used=new Set();
  return groups.map(([stratum,accept])=>{
    const pool=tuples.filter(row=>accept(row)&&!used.has(row.school.id));
    if(!pool.length)throw Error(`No real catalogue tuple for ${stratum}`);
    const selected=pool[Math.floor(random()*pool.length)];used.add(selected.school.id);
    return {stratum,...selected};
  });
}

export function catalogueTarget(school,department,id='matrix-target') {
  return {id,university:school.university,school_reference_id:school.id,
    department_catalog_id:department.id,department:department.name,major:department.name,
    campus:school.campusLabel||department.campus,admission_year:2027,admission_type:'합성 학습 축 검증'};
}

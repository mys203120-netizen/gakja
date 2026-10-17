import type { SchoolProfileData,SchoolProfileProvenance } from '@gakja/content-contracts';

export const UOS_2027_SOURCE='https://file.uos.ac.kr/upload/admission/2027%ED%95%99%EB%85%84%EB%8F%84%20%EC%88%98%EC%8B%9C%EB%AA%A8%EC%A7%91%20%EC%8B%A0%EC%9E%85%EC%83%9D%20%EB%AA%A8%EC%A7%91%EC%9A%94%EA%B0%95_260831.pdf';
export const uosEnvironment2027Profile:SchoolProfileData & {interview_date:string;notes:string;source_sha256?:string}={
  admission_year:2027,university:'서울시립대학교',campus:'본교',department:'환경공학부',admission_type:'학생부종합전형Ⅰ(면접형)',interview_stage:'2단계',
  format:'document_individual',interview_conducted:true,interviewer_count:{min:2,max:2},applicant_count:{min:1,max:1},preparation_minutes:null,interview_minutes:{min:12,max:12},
  blind_rules:'성명·수험번호·출신고교·고교유형을 밝히지 않으며, 출신고교를 추측할 수 있는 교복을 입지 않아요.',
  admission_interview_weight:50,evaluation_weights:[{element:'학업역량',weight:35},{element:'잠재역량',weight:40},{element:'사회역량',weight:25}],
  question_distribution:null,interview_date:'2026-11-29',source_sha256:'e7c88c470663d53adad1b30a67d339a571eda8ee98e179a56e7ba132ecfc8050',notes:'학생부 기반 개인 면접, 약 12분 내외. 1단계 서류 100%(3배수), 2단계 서류 50%·면접 50%. 세부 입실시간은 1단계 합격 후 입학처에서 확인해요.',
};
export const uosEnvironment2027Source:SchoolProfileProvenance={
  source_url:UOS_2027_SOURCE,page:'PDF 13, 24–25, 46쪽 · 책 11, 22–23, 44쪽',document_title:'서울시립대학교 2027학년도 수시모집 신입생 모집요강(2026.08.31 수정)',applicable_year:2027,published_at:'2026-08-31',checked_at:'2026-10-14',review_note:'공식 입학처 연결 PDF에서 모집단위·전형·면접 방식·평가 배점·일정을 확인. 10:00은 자연계열 공통 고사 개시 시각이며 개인 입실 시각은 별도 공지되어 학교 면접일만 제공. 평가 배점은 질문 주제 비율로 사용하지 않음.',
};
const identityPart=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').replace(/\s+/gu,''):'';
export function officialProfileForTarget(target:Record<string,any>) {
  const profile=uosEnvironment2027Profile;
  if(identityPart(target.university)!==identityPart(profile.university)||Number(target.admission_year)!==profile.admission_year||identityPart(target.campus)!==identityPart(profile.campus)||identityPart(target.department||target.major)!==identityPart(profile.department)||identityPart(target.admission_type)!==identityPart(profile.admission_type))return null;
  // An omitted stage may use this official overview; every explicit stage must agree.
  if([target.interview_stage,target.stage].some(stage=>identityPart(stage)&&identityPart(stage)!==identityPart(profile.interview_stage)))return null;
  return {id:'official_uos_environment_2027_interview',revision:1,status:'official_confirmed',data:{...profile},provenance:{...uosEnvironment2027Source}};
}

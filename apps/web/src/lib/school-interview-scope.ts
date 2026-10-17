/** Product scope: student-record interviews only. Historical source files are preserved. */
type Target = Record<string, any>;
export type InterviewSupport = {supported:boolean;format:'document'|'passage'|'mixed'|'other'|'no_interview'|'needs_selection';reason:string;sourceUrl:string;academicYear:number;checkedAt:string};
const clean=(value:unknown)=>String(value||'').normalize('NFKC').replace(/[\s·・ㆍ()（）\[\]—–-]/gu,'').toLowerCase();
const excluded:Record<string,{format:InterviewSupport['format'];reason:string;url:string}>={
  '연세대학교':{format:'passage',reason:'활동우수형·국제형·국제인재·기회균형은 제시문 면접이에요. 체육인재 확인 면접도 학생부형 준비 범위에서 제외해요.',url:'https://admission.yonsei.ac.kr/seoul/admission/html/counsel/dataView.asp?BBS_NO=3500'},
  '부산교육대학교':{format:'passage',reason:'수시 제시문 기반 집단 면접은 이 앱의 준비 범위에 포함되지 않아요.',url:'https://enter.bnue.ac.kr/content/susi01'},
  '경인교육대학교':{format:'other',reason:'공개 공통 문항의 답변 동영상을 제출하는 방식으로, 개인 학생부 확인 면접과 달라요.',url:'https://ipsi.ginue.ac.kr/ipsi/CMS/Board/Board.do?board_seq=47508&mCode=MN028&mgr_seq=142&mode=view'},
  '공주교육대학교':{format:'no_interview',reason:'2027학년도 수시 학생부종합 전형은 면접을 실시하지 않아요.',url:'https://www.gjue.ac.kr/ipsi/72/pdfViewer/CAT183'},
  '한국에너지공과대학교':{format:'passage',reason:'제시된 과제에 답하는 창의성 면접은 이 앱의 준비 범위에 포함되지 않아요.',url:'https://admission.kentech.ac.kr/ipsi'},
  '영남대학교':{format:'mixed',reason:'의예과의 제시문·구술 면접과 군사학과의 군 면접은 학생부형 면접 준비 범위에서 제외해요.',url:'https://enter.yu.ac.kr/'},
  '홍익대학교':{format:'mixed',reason:'문제지를 읽고 준비한 뒤 답하는 미술 면접과 서류 확인을 함께 실시하므로 제외해요.',url:'https://admission.hongik.ac.kr/'},
  '한국과학기술원':{format:'mixed',reason:'특기자전형도 적합성·영어 제시문 면접을 포함해요. 2027학년도 면접 전형은 학생부형 준비 범위에서 제외해요.',url:'https://admission.kaist.ac.kr/undergraduate'},
};
function nameOf(target:Target){return String(target.canonicalName||target.university||'').split(' — ')[0].replace(/\s+(GIST|DGIST|UNIST|POSTECH|KAIST|KENTECH)$/u,'');}
export function schoolHasDocumentInterview(university:string){return !excluded[nameOf({university})];}
export function schoolDepartmentAvailable(university:string,department:string){
  const school=nameOf({university}),major=clean(department);
  if(school==='고려대학교')return /사이버국방|디자인조형|체육교육/.test(major);
  if(school==='한양대학교')return ['교육학과','교육공학과','국어교육과','영어교육과','수학교육과','의예과','스포츠산업과학부','연극영화학과'].some(name=>major.startsWith(clean(name)));
  if(school==='세종대학교'&&/창의소프트|디자인이노베이션|만화애니메이션/.test(major))return false;
  if(['서울대학교','아주대학교','울산대학교','부산대학교','한림대학교'].includes(school)&&/^(의예과|의학과|의학부)$/.test(major))return false;
  if(['포항공과대학교','한국과학기술원'].includes(school)&&/반도체/.test(major))return false;
  return true;
}
export function isStudentRecordQuestion(question:Target){
  const kinds=[...(question.grounding_types||[]),...(question.question_types||[])].join(' ');
  return !/passage|mmi|oral_exam|제시문|교과형/iu.test(kinds)&&!/제시문|주어진\s*(지문|자료)|다음\s*(글|지문|제시문)을/u.test(String(question.prompt||''));
}
export function interviewSupportForTarget(target:Target):InterviewSupport{
  const university=nameOf(target),track=clean(target.admission_type||target.track),major=clean(target.department||target.major);
  const academicYear=Number(target.admission_year||target.year)||2027;
  const result=(supported:boolean,format:InterviewSupport['format'],reason:string,sourceUrl=''):InterviewSupport=>({supported,format,reason,sourceUrl,academicYear,checkedAt:'2026-10-17'});
  // The release is explicitly scoped to 2027; do not silently certify a different year.
  if(academicYear!==2027)return result(false,'needs_selection','현재 준비 범위는 2027학년도예요. 다른 학년도는 면접 방식을 확인한 뒤 제공해요.');
  const whole=excluded[university];
  if(whole)return result(false,whole.format,whole.reason,whole.url);
  if(/제시문|교과형|창의성면접/.test(track))return result(false,'passage','제시문·교과 문제 풀이 면접은 이 앱에서 다루지 않아요.');
  if(university==='고려대학교'){
    const url='https://oku.korea.ac.kr/';
    if(/사이버국방/.test(track))return result(true,'document','사이버국방전형의 제출서류 기반 면접을 준비해요.',url);
    if(/특기자/.test(track)&&/디자인조형|체육교육/.test(major))return result(true,'document','제출서류·활동 경험 확인 질문을 준비해요.',url);
    return result(false,track&&track!=='미정'?'passage':'needs_selection','계열적합·고른기회·다문화·재직자 제시문 면접은 제외해요. 서류형인 사이버국방전형 등 해당 전형을 선택해 주세요.',url);
  }
  if(university==='서울대학교'){
    const url='https://snuarori.snu.ac.kr/interview/guide';
    if(/의예|의학과|의학부/.test(major))return result(false,'mixed','의과대학은 상황·제시문과 서류 면접을 함께 실시하므로 제외해요.',url);
    if(/일반/.test(track))return result(false,'passage','일반전형의 제시문·구술 면접은 제외해요. 지역균형·기회균형의 서류형 면접을 선택해 주세요.',url);
    if(!/지역균형|기회균형/.test(track))return result(false,'needs_selection','서류 기반인 지역균형·기회균형 전형을 선택해 주세요.',url);
  }
  if(university==='성균관대학교'){
    const url='https://admission.skku.edu/upload/guide/20260529115520H43SMR.pdf';
    if(/과학인재/.test(track))return result(false,'passage','과학인재의 수학·과학 제시문 면접은 제외해요.',url);
    if(/융합인재|탐구인재|기회균형/.test(track))return result(false,'no_interview','선택한 전형은 서류로 선발하며 면접을 실시하지 않아요.',url);
    if(/성균인재/.test(track)&&!['자유전공계열','교육학과','한문교육과','수학교육과','컴퓨터교육과','의예과','글로벌AI융합학부','글로벌융합학부','연기예술학과','스포츠과학과'].some(name=>clean(name)===major))return result(false,'no_interview','성균인재 면접은 자유전공계열·사범대학·의예과·글로벌AI융합학부·연기예술학과(연출)·스포츠과학과 모집단위를 확인해 주세요.',url);
  }
  if(university==='삼육대학교'&&/예체능인재/.test(track))return result(false,'passage','예체능인재전형의 사전 출제 제시문 면접은 제외해요. 학생부종합 서류형 전형을 선택해 주세요.','https://ipsi.syu.ac.kr/');
  if(university==='한양대학교'&&!(/특기자/.test(track)&&/스포츠산업과학|연극영화/.test(major))){
    const documentMajors=['교육학과','교육공학과','국어교육과','영어교육과','수학교육과','의예과'];
    if(!documentMajors.some(name=>clean(name)===major))return result(false,'passage','학생부종합 면접형 중 사범대학·의예과의 학생부형 면접만 제공해요. 공과대학·한양인터칼리지의 제시문 면접은 제외해요.','https://admission.hanyang.ac.kr/');
  }
  if(university==='세종대학교'&&/창의소프트|디자인이노베이션|만화애니메이션/.test(major))return result(false,'passage','창의소프트학부의 제시문 면접은 제외해요.','https://ipsi.sejong.ac.kr/');
  if(university==='광주과학기술원'&&!/특기자/.test(track))return result(false,'mixed','전공 수학능력 문제 풀이 면접을 포함한 전형은 제외해요. 특기자전형을 선택해 주세요.','https://www.gist.ac.kr/uadm/');
  if(university==='포항공과대학교'&&!/일반전형ii(?!i)|일반ii(?!i)|일반전형2/.test(track))return result(false,'mixed','개인 과제·제시문을 포함하는 일반전형Ⅰ·반도체공학인재는 제외해요. 서류형 개인 면접인 일반전형Ⅱ를 선택해 주세요.','https://adm-u.postech.ac.kr/');
  if(['아주대학교','울산대학교','부산대학교','한림대학교'].includes(university)&&/의예|의학과|의학부/.test(major))return result(false,'mixed','의과대학의 제시문·상황 또는 공통 문제 면접을 포함하는 전형은 제외해요.');
  if(university==='광주교육대학교'&&/교직적성우수자.*ii|농어촌|기초|차상위|한부모/.test(track))return result(false,'other','공개 공통 문항에 답하는 비대면 영상 제출 전형은 제외해요.','https://www.gnue.ac.kr/');
  return result(true,'document','학생부·제출서류에 있는 활동과 지원 학과를 연결해 준비해요.');
}

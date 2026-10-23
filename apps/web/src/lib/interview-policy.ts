/** Versioned product rules. Historical sessions without a mode remain practice. */
export type InterviewSessionMode = 'practice' | 'real';
export const INTERVIEW_POLICY_VERSION = 'interview-2026-10-23';
export const INTERVIEW_CHARACTERS = [
  {id:'A',name:'유나',gender:'female',focus:'경험의 핵심',hint:'말하려던 핵심을 한 문장으로 좁혀 주세요.',clovaVoice:'vara',voice:'ko-KR-Chirp3-HD-Aoede'},
  {id:'B',name:'도윤',gender:'male',focus:'전공 관심과 탐구',hint:'관심의 계기와 직접 탐구한 행동을 연결해 주세요.',clovaVoice:'vdaeseong',voice:'ko-KR-Chirp3-HD-Charon'},
  {id:'C',name:'하람',gender:'female',focus:'역할과 협업',hint:'실제 맡았던 일과 구체적인 장면을 떠올려 보세요.',clovaVoice:'vgoeun',voice:'ko-KR-Chirp3-HD-Kore'},
  {id:'D',name:'태오',gender:'male',focus:'근거와 반론',hint:'주장과 근거를 나누고 확인하지 못한 부분을 찾아보세요.',clovaVoice:'vdonghyun',voice:'ko-KR-Chirp3-HD-Puck'},
  {id:'E',name:'서진',gender:'female',focus:'답변의 순서',hint:'핵심, 경험, 배운 점 순서로 말할 내용을 정해 보세요.',clovaVoice:'vmikyung',voice:'ko-KR-Chirp3-HD-Leda'},
] as const;
export function interviewPolicy(data:Record<string,any> = {}) {
  const mode:InterviewSessionMode=data.sessionMode==='real'?'real':'practice';
  return {mode,helpAllowed:mode==='practice',retryAllowed:mode==='practice',textAllowed:mode==='practice',maxFollowups:data.pressure?2:1,feedbackTiming:mode==='real'?'end':data.feedbackTiming||'turn'};
}
/** Scheduled practice uses its frozen curriculum policy; real sessions retain the student's choice. */
export function interviewPressureForStart(input:{sessionMode?:InterviewSessionMode;pressure?:boolean;mode?:string},trainingPlan?:Record<string,any>){
  if(trainingPlan&&input.sessionMode!=='real')return trainingPlan.target?.automaticPractice?.hybrid?.pressure===true;
  return input.pressure??input.mode==='pressure';
}
/** Explicit name AND help intent; an ordinary name in an answer is not a command. */
export function requestedInterviewHelper(text:string) {
  if(!/(?:도와\s*줘|도움|힌트|막혔|모르겠)/u.test(text))return null;
  return INTERVIEW_CHARACTERS.find(person=>new RegExp(`(?:^|[\\s,.!?])${person.name}(?:아|야|님|씨)?(?:[\\s,.!?]|$)`).test(text))||null;
}
/** Validate newly generated questions without rewriting any published prompt. */
export function generatedInterviewQuestion(text:string,talentLabels:string[]=[]){
  const value=text.trim();
  if(value.length<5||value.length>120||/\[NEXT\]|인재상|[\r\n]/u.test(value)||(value.match(/[?？]/gu)||[]).length>1)return null;
  if([...new Intl.Segmenter('ko',{granularity:'sentence'}).segment(value)].filter(part=>part.segment.trim()).length!==1)return null;
  if(talentLabels.some(label=>label.trim().length>=2&&value.includes(label.trim())))return null;
  return value;
}
/** Evaluation observes recorded speech, never a polished replacement for it. */
export function interviewEvaluationEvidence(data:Record<string,any>) {
  const raw=typeof data.speechSource?.rawText==='string'?data.speechSource.rawText
    :data.submissionSource==='recording'&&data.rawTranscriptMediaId===data.submittedMediaId?data.rawTranscript:null;
  return {answer:raw||data.originalAnswer||data.answer||'',rawTranscript:raw||null,submittedAnswer:data.answer||null,
    source:raw?'recorded_speech':'student_text',studentEdited:Boolean(data.speechSource?.studentEdited||data.answer!==data.originalAnswer&&data.originalAnswer),
    speechAnalysis:data.speechAnalysis||null,assisted:Boolean(data.assisted),helpKinds:data.helpKinds||[]};
}

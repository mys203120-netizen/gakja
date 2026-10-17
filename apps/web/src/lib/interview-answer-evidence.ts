import type { InterviewHelpScope } from './assistance-records';

const bounded=(value:unknown,limit=12_000)=>typeof value==='string'&&value.trim()?value.slice(0,limit):null;
export type InterviewAnswerEvidence={
  status:'student_statement_unverified';session_id:string;turn_id:string;question_id:string;root_question_id:string;question:string|null;
  answer_state:'draft'|'submitted';submitted_answer:string|null;current_answer:string|null;
  current_draft:string|null;draft_origin:'formatted_transcript'|'student_edited'|'typed_or_unspecified';
  recording:null|{media_id:string;raw_stt:string|null;formatted_transcript:string|null};
  student_transcript_corrections:{text:string;at:string|null}[];
};

/** Receives only the server-locked owned turn. Never read an arbitrary client draft or whole media history. */
export function interviewAnswerEvidence(turn:Record<string,any>,scope:InterviewHelpScope,allowSubmitted=false):InterviewAnswerEvidence|null {
  if(turn?.id!==scope.turnId||turn?.session_id!==scope.sessionId||!turn.data||turn.data.invalidated||turn.data.answer&&!allowSubmitted)return null;
  const data=turn.data,submitted=Boolean(bounded(data.answer)),draft=submitted?null:bounded(data.draft),mediaId=bounded(data.mediaId||data.rawTranscriptMediaId,160);
  const version=mediaId&&Array.isArray(data.mediaVersions)?data.mediaVersions.find((item:Record<string,any>)=>item.mediaId===mediaId):null;
  // A later take's raw STT and an earlier selected formatted take must not be combined.
  const raw=mediaId===data.rawTranscriptMediaId?bounded(data.rawTranscript):bounded(version?.transcript);
  const formatted=mediaId===data.mediaId&&data.transcriptCleanup?.status==='completed'?bounded(data.displayTranscript)
    :version?.transcriptCleanup?.status==='completed'?bounded(version.displayTranscript):null;
  const corrections=(Array.isArray(data.transcriptRevisions)?data.transcriptRevisions:[])
    .filter((revision:Record<string,any>)=>revision.correctedBy==='student'&&bounded(revision.transcript)).slice(-3)
    .map((revision:Record<string,any>)=>({text:bounded(revision.transcript)!,at:bounded(revision.at,80)}));
  return {status:'student_statement_unverified',session_id:scope.sessionId,turn_id:scope.turnId,
    question_id:String(turn.question_id||scope.questionId),root_question_id:scope.questionId,question:bounded(data.question,2_000),
    answer_state:submitted?'submitted':'draft',submitted_answer:submitted?bounded(data.originalAnswer||data.answer):null,current_answer:submitted?bounded(data.answer):null,
    current_draft:draft,draft_origin:formatted&&draft===formatted?'formatted_transcript':formatted&&draft?'student_edited':'typed_or_unspecified',
    recording:mediaId?{media_id:mediaId,raw_stt:raw,formatted_transcript:formatted}:null,student_transcript_corrections:corrections};
}

/** Historical receipts remain only so transcript corrections can invalidate them.
 * Current interviewers use fixed clay portraits without expression scoring. */
const REACTION_VERSION = 'submitted-answer-v1';
type HistoricalReaction = {
  level:number; signal:'uncertain';
  status:'not_evaluated'|'unavailable'|'invalidated';
  evidence:string; reason:string; version:typeof REACTION_VERSION;
  timing:'after_submission';
};

export function neutralReaction(status:HistoricalReaction['status']='not_evaluated'):HistoricalReaction {
  return {level:50,signal:'uncertain',status,evidence:'',reason:'',version:REACTION_VERSION,timing:'after_submission'};
}

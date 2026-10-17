/** A readable transcription and observed speech are different views of one utterance. */
export type SpeechAnswerSource = {
  rawText:string; displayText:string; submittedText:string; mediaId:string;
  cleanupStatus:'completed'; cleanupModel:string|null; cleanupPromptVersion:string|null;
  rawHash:string|null; studentEdited:boolean;
};
export function snapshotSpeechAnswer(raw:unknown,display:unknown,cleanup:Record<string,any>|null|undefined,submitted:string,mediaId:string):SpeechAnswerSource|null {
  if(typeof raw!=='string'||!raw.trim()||typeof display!=='string'||!display.trim()||cleanup?.status!=='completed'||!mediaId)return null;
  return {rawText:raw,displayText:display,submittedText:submitted,mediaId,cleanupStatus:'completed',
    cleanupModel:typeof cleanup.modelId==='string'?cleanup.modelId:null,
    cleanupPromptVersion:typeof cleanup.promptVersion==='string'?cleanup.promptVersion:null,
    rawHash:typeof cleanup.rawHash==='string'?cleanup.rawHash:null,
    studentEdited:submitted.trim()!==display.trim()};
}
export function observedAnswerText(value:{script:string;raw_script?:string|null}) {
  return typeof value.raw_script==='string'&&value.raw_script.trim()?value.raw_script:value.script;
}

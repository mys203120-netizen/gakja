// Loaded only by the isolated persistence test's module hook.
import {createHash} from 'node:crypto';
const state=globalThis.__qaTranscriptionState;
if(!state)throw new Error('Synthetic transcription fixture is not active.');
export async function formatStoredTranscription(student,context,raw) {
  state.format++;await state.beforeFormat?.();await new Promise(resolve=>setTimeout(resolve,20));
  return {...raw,rawText:raw.text,displayText:state.fail?null:state.display,cleanup:{status:state.fail?'failed':'completed',modelId:'gpt-6-luna',promptVersion:'gakja-transcript-verbatim-2',rawHash:createHash('sha256').update(raw.text).digest('hex'),latencyMs:20,...(state.fail?{error:'TRANSCRIPT_CLEANUP_FAILED'}:{})}};
}
export async function transcribeStoredAudio(student,context,bytes,mime,duration,options) {
  state.stt++;const raw={text:state.raw,provider:'openai',modelId:'gpt-4o-mini-transcribe',alignmentStatus:'answer_only',words:[]};
  await options.onRawTranscription(raw);return formatStoredTranscription(student,context,raw);
}

import 'server-only';
import {completeUsage,FeatureError,googleSpeechToken,openai,reserveUsage,speechConfigured,speechProvider} from './ai';
import {INTERVIEW_CHARACTERS} from './interview-policy';

/** Opt-in only. Missing CLOVA credentials keep the existing speech provider. */
export function clovaSpeechConfigured(){return process.env.CLOVA_TTS_ENABLED==='true'&&Boolean(process.env.CLOVA_TTS_CLIENT_ID?.trim()&&process.env.CLOVA_TTS_CLIENT_SECRET?.trim());}
export function interviewSpeechText(text:string){return text.replace(/\bAI\b/g,'에이아이').replace(/\bGPT\b/g,'지피티').trim();}
/** Ephemeral response bytes only. CLOVA output is never written to media_assets or storage. */
export async function synthesizeInterviewSpeech(studentId:string,sessionId:string,text:string,characterId:string){
 const person=INTERVIEW_CHARACTERS.find(value=>value.id===characterId)||INTERVIEW_CHARACTERS[0];
 const selected=clovaSpeechConfigured()?'clova':speechProvider(),input=interviewSpeechText(text);
 if(!input||input.length>2000)throw new FeatureError(400,'음성으로 읽을 내용을 짧게 확인해 주세요.','SPEECH_TEXT_LIMIT');
 if(selected!=='clova'&&!speechConfigured())throw new FeatureError(503,'음성 연결을 준비 중이에요. 글로 확인할 수 있어요.','SPEECH_NOT_CONFIGURED');
 const voice=selected==='clova'?person.clovaVoice:selected==='google'?person.voice:({A:'nova',B:'onyx',C:'shimmer',D:'echo',E:'alloy'} as const)[person.id];
 const model=selected==='clova'?'clova-premium':selected==='google'?'chirp3-hd':process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts';
 const usage=await reserveUsage(studentId,'speech',sessionId,`${selected}:${model}:${voice}`);
 try{
  let bytes:Buffer;
  if(selected==='clova'){
   const response=await fetch('https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',{method:'POST',headers:{'X-NCP-APIGW-API-KEY-ID':process.env.CLOVA_TTS_CLIENT_ID!.trim(),'X-NCP-APIGW-API-KEY':process.env.CLOVA_TTS_CLIENT_SECRET!.trim(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({speaker:voice,text:input,format:'mp3',speed:'0'}),signal:AbortSignal.timeout(40000)});
   if(!response.ok)throw new Error('Speech synthesis failed');bytes=Buffer.from(await response.arrayBuffer());
  }else if(selected==='google'){
   const response=await fetch('https://texttospeech.googleapis.com/v1/text:synthesize',{method:'POST',headers:{Authorization:`Bearer ${await googleSpeechToken()}`,'Content-Type':'application/json',...(process.env.GOOGLE_CLOUD_PROJECT?{'X-Goog-User-Project':process.env.GOOGLE_CLOUD_PROJECT}:{})},body:JSON.stringify({input:{text:input},voice:{languageCode:'ko-KR',name:voice},audioConfig:{audioEncoding:'MP3'}}),signal:AbortSignal.timeout(40000)});
   if(!response.ok)throw new Error('Speech synthesis failed');const value=await response.json();if(typeof value.audioContent!=='string')throw new Error('Speech synthesis failed');bytes=Buffer.from(value.audioContent,'base64');
  }else{const value=await openai().audio.speech.create({model,voice:voice as 'nova'|'onyx'|'shimmer'|'echo'|'alloy',input,response_format:'mp3'});bytes=Buffer.from(await value.arrayBuffer());}
  await completeUsage(usage,'completed');return bytes;
 }catch(error){await completeUsage(usage,'failed');throw error instanceof FeatureError?error:new FeatureError(502,'음성을 준비하지 못했어요. 글로 확인한 뒤 다시 들을 수 있어요.','SPEECH_FAILED');}
}

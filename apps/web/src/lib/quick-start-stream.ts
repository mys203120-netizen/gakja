export type QuickStartStreamEvent={type:'start'|'delta'|'done'|'error';delta?:string;proposal?:{draft:string;followup_question:string|null;[key:string]:unknown};assisted?:boolean;duplicate?:boolean;error?:string;code?:string};
/** Server events contain genuine model deltas; only done contains a validated, committed proposal. */
export async function readQuickStartStream(response:Response,onEvent:(event:QuickStartStreamEvent)=>void|Promise<void>){
 if(!response.headers.get('content-type')?.includes('text/event-stream')){
  const result=await response.json();if(!response.ok)throw new Error(result.error||'답변을 정리하지 못했어요.');
  await onEvent({type:'done',...result});return;
 }
 if(!response.ok||!response.body)throw new Error('답변 연결을 확인해 주세요.');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',terminal=false;
 const consume=async(frame:string)=>{
  const text=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!text)return;
  const event=JSON.parse(text) as QuickStartStreamEvent;if(!['start','delta','done','error'].includes(event.type))return;
  if(['done','error'].includes(event.type))terminal=true;await onEvent(event);
 };
 try{for(;;){const part=await reader.read();buffer+=decoder.decode(part.value,{stream:!part.done});buffer=buffer.replace(/\r\n/g,'\n');if(buffer.length>200000)throw new Error('답변 연결 형식을 확인해 주세요.');let boundary;while((boundary=buffer.indexOf('\n\n'))!==-1){await consume(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}if(part.done){if(buffer.trim())await consume(buffer);break;}}
  if(!terminal)throw new Error('답변 연결이 중단됐어요. 적은 내용으로 다시 이어가 주세요.');
 }finally{reader.releaseLock();}
}

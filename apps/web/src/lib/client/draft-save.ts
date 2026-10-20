/** Draft writers register while their authenticated workspace is mounted.
 * Saving here must never submit an answer or finish a learning session. */
export type DraftSaver=()=>void|Promise<void>;
const writers=new Map<string,Set<DraftSaver>>();
const flights=new Map<string,Promise<void>>();

export function registerDraftSaver(userId:string,save:DraftSaver):()=>void {
  if(!userId)throw new Error('초안의 계정을 확인해 주세요.');
  const group=writers.get(userId)||new Set<DraftSaver>();group.add(save);writers.set(userId,group);
  return()=>{group.delete(save);if(!group.size&&writers.get(userId)===group)writers.delete(userId);};
}

/** Logout waits for every active writer, including writers that fail, so no
 * credentials are revoked while another workspace is still saving its draft. */
export function flushPendingDrafts(userId:string):Promise<void> {
  if(!userId)return Promise.reject(new Error('초안의 계정을 확인해 주세요.'));
  const existing=flights.get(userId);if(existing)return existing;
  const snapshot=[...(writers.get(userId)||[])];
  const flight=Promise.allSettled(snapshot.map(save=>Promise.resolve().then(save))).then(results=>{
    if(results.some(result=>result.status==='rejected'))throw new Error('초안을 보관하지 못했어요. 연결과 저장 공간을 확인한 뒤 다시 로그아웃해 주세요.');
  }).finally(()=>{if(flights.get(userId)===flight)flights.delete(userId);});
  flights.set(userId,flight);return flight;
}

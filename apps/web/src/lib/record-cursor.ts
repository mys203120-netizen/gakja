import { createHash } from 'node:crypto';

export type RecordPosition = { at: string; id: string };
export type RecordCursor = { after: RecordPosition; anchor: RecordPosition };
const stamp = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/;
function position(value: unknown): value is RecordPosition {
  const item=value as RecordPosition;
  return !!item&&typeof item.at==='string'&&stamp.test(item.at)&&Number.isFinite(Date.parse(item.at))&&typeof item.id==='string'&&/^[\w.:-]{1,200}$/.test(item.id);
}
function scopeKey(scope:string){return createHash('sha256').update(scope).digest('hex').slice(0,24);}
export function parseRecordCursor(raw:string|null|undefined,scope:string):RecordCursor|null {
  if(!raw)return null;
  try {
    if(raw.length>1600||!/^[A-Za-z0-9_-]+$/.test(raw))throw new Error();
    const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    if(value.v!==1||value.scope!==scopeKey(scope)||!position(value.after)||!position(value.anchor))throw new Error();
    return {after:value.after,anchor:value.anchor};
  }catch{throw new Error('기록 목록이 바뀌었어요. 처음부터 다시 불러와 주세요.');}
}
export function encodeRecordCursor(cursor:RecordCursor,scope:string){
  if(!position(cursor.after)||!position(cursor.anchor))throw new Error('기록 시각을 확인해 주세요.');
  return Buffer.from(JSON.stringify({v:1,scope:scopeKey(scope),...cursor})).toString('base64url');
}
export function recordPage<T extends Record<string,any>>(rows:T[],limit:number,scope:string,cursor:RecordCursor|null=null){
  const visible=rows.slice(0,limit),first=visible[0],last=visible.at(-1);
  const point=(row:T):RecordPosition=>({at:row.__cursor_at||new Date(row.created_at).toISOString(),id:String(row.id)});
  const nextCursor=rows.length>limit&&first&&last?encodeRecordCursor({anchor:cursor?.anchor||point(first),after:point(last)},scope):null;
  return {items:visible.map(({__cursor_at:_,...row})=>row as Omit<T,'__cursor_at'>),page:{nextCursor,hasMore:nextCursor!==null,limit}};
}
export const RECORD_CURSOR_TIMESTAMP="to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";

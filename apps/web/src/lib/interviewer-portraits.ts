/** Five stable adult identities, shared by Live, Chat, and saved answer history. */
export const INTERVIEWER_PORTRAITS = [
  {id:'clay-a',src:'/images/interviewers/human-clay-a.png'},
  {id:'clay-b',src:'/images/interviewers/human-clay-b.png'},
  {id:'clay-c',src:'/images/interviewers/human-clay-c.png'},
  {id:'clay-d',src:'/images/interviewers/human-clay-d.png'},
  {id:'clay-e',src:'/images/interviewers/human-clay-e.png'},
] as const;

export function interviewerPortrait(personId:string,index?:number) {
  const letter=personId.match(/^[A-Z]$/i);
  const fallback=letter?personId.toUpperCase().charCodeAt(0)-65:Array.from(personId).reduce((sum,char)=>sum+char.charCodeAt(0),0);
  const identity=typeof index==='number'&&Number.isFinite(index)?Math.max(0,Math.floor(index)):fallback;
  return INTERVIEWER_PORTRAITS[identity%INTERVIEWER_PORTRAITS.length];
}

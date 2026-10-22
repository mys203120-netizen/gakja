import type { SessionItem } from './quiz-rules';

export type QuizHistory = { memory_item_id: string; rating: string; due_at: string | Date | null; created_at: string | Date; data?: { correct?: boolean | null; timed_out?: boolean; hint_used?: boolean; assisted?: boolean; assistance_recorded?:boolean; recall_state?:string } };
export type QuizSelection = { items: SessionItem[]; wrong: number; due: number; unseen: number; reason: string };
/** Only server-owned latest attempts enter this selection. A self-rating is not verified mastery. */
export function selectQuizItems(pool: SessionItem[], history: QuizHistory[], now = Date.now(), limit = 6): QuizSelection {
  const latest = new Map<string, QuizHistory>();
  const reviewState = new Map<string, boolean>();
  for (const row of [...history].sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime())) {
    if (row.data?.correct === false || row.data?.timed_out === true || row.rating === 'again' || row.data?.correct==null && ['uncertain','needs_confirmation','unchecked'].includes(row.data?.recall_state||'')) reviewState.set(row.memory_item_id,true);
    else if (row.data?.correct === true && row.data?.assistance_recorded === true && row.data?.hint_used !== true && row.data?.assisted !== true) reviewState.set(row.memory_item_id,false);
  }
  for (const row of history) {
    const old = latest.get(row.memory_item_id);
    if (!old || new Date(row.created_at).getTime() > new Date(old.created_at).getTime()) latest.set(row.memory_item_id, row);
  }
  const ranked = pool.map((item, index) => {
    const attempt = latest.get(item.id), wrong = reviewState.get(item.id) === true;
    const due = !!attempt?.due_at && new Date(attempt.due_at).getTime() <= now;
    const assisted = !!attempt && (attempt.data?.hint_used === true || attempt.data?.assisted === true);
    const category = wrong ? 0 : due ? 1 : !attempt ? 2 : assisted ? 3 : 4;
    return { item, index, attempt, wrong, due, category };
  });
  // Within each priority, oldest practice goes first. The full pool is ranked before limiting.
  ranked.sort((a, b) => a.category - b.category || (a.attempt ? new Date(a.attempt.created_at).getTime() : 0) - (b.attempt ? new Date(b.attempt.created_at).getTime() : 0) || a.index - b.index);
  const wrong = ranked.filter(row => row.wrong).length, due = ranked.filter(row => row.due && !row.wrong).length, unseen = ranked.filter(row => !row.attempt).length;
  const items = ranked.slice(0, Math.max(1, Math.min(30, limit))).map(row => row.item);
  const reason = wrong ? `다시 확인할 ${wrong}문항부터` : due ? `복습할 때가 된 ${due}문항부터` : unseen ? `아직 연습하지 않은 ${unseen}문항부터` : items.length ? '최근에 덜 연습한 질문부터' : '발행된 연습 문항을 기다리고 있어요.';
  return { items, wrong, due, unseen, reason };
}

export function mapSavedQuizItem(saved: SessionItem, current: SessionItem[]): SessionItem | undefined {
  return current.find(item => item.id === saved.id) || current.find(item => item.kind === saved.kind && item.question_id === saved.question_id)
    || current.find(item => item.kind === saved.kind && item.prompt.trim() === saved.prompt.trim());
}

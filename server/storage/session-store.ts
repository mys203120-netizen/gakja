import type { InterviewSession } from '../protocol';
import type { InterviewContext } from '../data/load-interview-context';

/** Existing session/context persistence contract. Identity, owner checks,
 * frozen input and checkpoint transitions keep their current domain authority. */
export interface SessionStore {
  save(session: InterviewSession): Promise<void>;
  load(id: string, ownerId: string): Promise<InterviewSession | null>;
  list(ownerId: string): Promise<InterviewSession[]>;
  saveContext(context: InterviewContext, ownerId: string): Promise<string>;
  loadContext(contentSha256: string, ownerId: string): Promise<InterviewContext>;
}

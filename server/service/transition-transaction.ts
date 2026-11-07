import { scopedReplayOnly } from './scoped-command';
import type { PoolClient } from 'pg';
import type { AuthenticatedRequestContext } from '../auth/request-identity';
import { authorizeScoped, type ScopedServiceAuthority } from './scoped-authority';
export const transitionSettingNames = ['transition_mode','transition_generation','transition_id','transition_operation'] as const;
type Operation = 'read'|'admit'|'session-write'|'review-write'|'worker-write';
export function transitionSqlOperation(sql: string, family: 'session'|'evaluation'|'object'|'shadow', worker = false): Operation {
  if (/\b(?:session_(?:read|list|find_creation|receipt|find_committed|receipt_by_key|export)|evaluation_(?:scope_control|session_control|read_artifact|projection|read_command|command_receipt|read_revision|receipt|export|get_job)|shadow_(?:capture|resolve|unchanged))\s*\(/u.test(sql)) return 'read';
  if (worker) return 'worker-write';
  if (sql.includes('session_enroll') || sql.includes('session_restore')) return 'admit';
  return family === 'evaluation' ? 'review-write' : 'session-write';
}
export function transitionSessionId(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(arg)) return arg;
    try { const value = JSON.parse(arg); if (typeof value?.sessionId === 'string') return value.sessionId; } catch { /* SQL scalar */ }
  }
  return undefined;
}
export async function admitTransitionSql(authority: ScopedServiceAuthority | undefined, context: AuthenticatedRequestContext,
  operation: Operation, sessionId?: string) {
  if (!authority) return undefined;
  if(scopedReplayOnly())operation='read';
  const admission = await authorizeScoped(authority, context, operation, sessionId);
  return { admission, operation, sessionId };
}
export async function applyTransitionSql(client: PoolClient, permit: Awaited<ReturnType<typeof admitTransitionSql>>) {
  if (!permit) return;
  const values = ['service-g', permit.admission.transition_generation, permit.admission.transition_id, permit.admission.transition_operation];
  for (let i = 0; i < transitionSettingNames.length; i++) await client.query('SELECT set_config($1,$2,true)', ['gakja.' + transitionSettingNames[i], values[i]]);
}
export async function guardTransitionSql(client: PoolClient, permit: Awaited<ReturnType<typeof admitTransitionSql>>) {
  if (permit) await client.query('SELECT gakja.transition_guard($1::text,$2::text,$3::boolean)', [permit.operation, permit.sessionId ?? null, permit.operation === 'read']);
}
export async function cleanTransitionSql(client: PoolClient) {
  return (await client.query(`SELECT ${transitionSettingNames.map((_, i) => `coalesce(current_setting($${i + 1},true),'')=''`).join(' AND ')} clean`, transitionSettingNames.map(name => 'gakja.' + name))).rows[0]?.clean === true;
}

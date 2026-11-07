import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedRequestContext } from '../auth/request-identity';
import { transitionServiceSnapshot, TransitionError } from '../transition/transition-ports';
import { authorizeScoped, scopedServiceAuthority, withTransitionOperation, type ScopedServiceAuthority } from './scoped-authority';
const replayAttempts=new AsyncLocalStorage<boolean>();
export const scopedReplayOnly=()=>replayAttempts.getStore()===true;
export async function runScopedCommand<T>(authority:ScopedServiceAuthority,context:AuthenticatedRequestContext,input:{generation:string;kind:'http'|'wss';sessionId?:string},operation:()=>Promise<T>){
 const state=await transitionServiceSnapshot(scopedServiceAuthority(authority).transition,context);
 if(!state||state.generation!==input.generation)throw new TransitionError(409,'TRANSITION_GENERATION_CHANGED');
 if(['frozen','read-only-recovery'].includes(state.state))return replayAttempts.run(true,operation);
 return runScopedOperation(authority,context,input,operation);
}
const operations=new AsyncLocalStorage<{context:AuthenticatedRequestContext;generation:string;sessionId?:string;signal:AbortSignal}>();
export function scopedOperationContext(){const value=operations.getStore();if(!value)throw new TransitionError(503,'TRANSITION_OPERATION_REQUIRED');return value;}
export const SCOPED_SERVICE_COMMAND_VERSION = 'scoped-service-command-v1';
export const scopedServiceCommandSchema = z.object({ version: z.literal(SCOPED_SERVICE_COMMAND_VERSION), expectedTransitionGeneration: z.string().regex(/^\d+$/u), command: z.unknown() }).strict();
export function decodeScopedServiceCommand(input: unknown) {
  const result=scopedServiceCommandSchema.safeParse(input);
  if(!result.success)throw new TransitionError(400,'TRANSITION_COMMAND_ENVELOPE_REQUIRED');return result.data;
}
/** Transition metadata wraps the original E/F command and is excluded from its hashes. */
export async function runScopedOperation<T>(authority:ScopedServiceAuthority,context:AuthenticatedRequestContext,
  input:{generation:string;kind:'http'|'wss'|'capture'|'provider'|'worker';sessionId?:string;signal?:AbortSignal},operation:(signal:AbortSignal)=>Promise<T>) {
  const actual=await authorizeScoped(authority,context,'read',input.sessionId);
  if(actual.transition_generation!==input.generation)throw new TransitionError(409,'TRANSITION_GENERATION_CHANGED');
  return withTransitionOperation(scopedServiceAuthority(authority).transition,context,{operationId:randomUUID(),generation:input.generation,
    kind:input.kind,...(input.sessionId?{sessionId:input.sessionId}:{}),expiresAt:new Date(context.principal.expiresAt).toISOString(),signal:input.signal},signal=>operations.run({context,generation:input.generation,sessionId:input.sessionId,signal},()=>operation(signal)));
}

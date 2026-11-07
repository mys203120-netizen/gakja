import type { AuthenticatedRequestContext } from '../auth/request-identity';
import { TransitionError, assertTransitionServiceAuthority, transitionSqlAuthorization, withTransitionOperation, type TransitionServiceAuthority } from '../transition/transition-ports';

/** Server-held authority; request JSON, kind strings and ENV cannot mint it. */
export interface ScopedServiceAuthority { readonly kind: 'scoped-service-authority-v1' }
type Detail = { transition: TransitionServiceAuthority; mode: 'production' | 'rehearsal' };
const authorities = new WeakMap<ScopedServiceAuthority, Readonly<Detail>>();
const components = new WeakMap<object, ScopedServiceAuthority>();
export function createScopedServiceAuthority(transition: TransitionServiceAuthority, mode: Detail['mode']): ScopedServiceAuthority {
  assertTransitionServiceAuthority(transition, mode === 'production' ? 'service' : 'rehearsal');
  if (!['production', 'rehearsal'].includes(mode) || mode === 'rehearsal' && process.env.NODE_ENV === 'production')
    throw new TransitionError(503, 'SERVICE_AUTHORITY_REQUIRED');
  const token = Object.freeze({ kind: 'scoped-service-authority-v1' as const });
  authorities.set(token, Object.freeze({ transition, mode })); return token;
}
export function scopedServiceAuthority(value: ScopedServiceAuthority): Readonly<Detail> {
  const detail = authorities.get(value);
  if (!detail || detail.mode === 'rehearsal' && process.env.NODE_ENV === 'production') throw new TransitionError(503, 'SERVICE_AUTHORITY_REQUIRED');
  assertTransitionServiceAuthority(detail.transition); return detail;
}
/** These bind trusted composition products, never a client-supplied DTO. */
export function bindScopedComponent<T extends object>(authority: ScopedServiceAuthority, component: T): T {
  scopedServiceAuthority(authority); components.set(component, authority); return component;
}
export function assertScopedComponent(authority: ScopedServiceAuthority, component: object) {
  scopedServiceAuthority(authority);
  if (components.get(component) !== authority) throw new TransitionError(503, 'SERVICE_COMPONENT_REQUIRED');
}
export async function authorizeScoped(authority: ScopedServiceAuthority, context: AuthenticatedRequestContext,
  operation: 'read' | 'admit' | 'session-write' | 'review-write' | 'worker-write', sessionId?: string) {
  return transitionSqlAuthorization(scopedServiceAuthority(authority).transition, context, operation, sessionId);
}

export { withTransitionOperation };

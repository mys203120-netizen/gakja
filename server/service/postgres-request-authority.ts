import type { Pool } from 'pg';
import type { RequestIdentityBoundary } from '../auth/request-identity';
import { createPostgresRequestAuthority, type PostgresRequestAuthority } from '../db/postgres-authority';
import { TransitionError } from '../transition/transition-ports';
import { scopedServiceAuthority, type ScopedServiceAuthority } from './scoped-authority';
import { admitTransitionSql, applyTransitionSql, guardTransitionSql } from './transition-transaction';
/** G reuses the real A account/scope transaction, adding current G authority. */
export function createScopedPostgresRequestAuthority(options:{pool:Pool;boundary:RequestIdentityBoundary;authority:ScopedServiceAuthority}):PostgresRequestAuthority {
  scopedServiceAuthority(options.authority);const base=createPostgresRequestAuthority(options.pool,options.boundary);
  const withScope:PostgresRequestAuthority['withScope']=async(context,operation,settings)=>{
    const current=await options.boundary.revalidate(context);if(current.mode!=='authenticated'||!current.scope)throw new TransitionError(403,'TRANSITION_SCOPE_REQUIRED');
    const permit=await admitTransitionSql(options.authority,current,'read');
    return base.withScope(current,async(client,selected)=>{await applyTransitionSql(client,permit);const value=await operation(client,selected);await guardTransitionSql(client,permit);return value;},settings);
  };
  return {...base,withScope};
}

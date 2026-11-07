import { Pool } from 'pg';

/** Only the explicitly owned E child database is accepted, never DATABASE_URL. */
export function testPools(max = 1, database: 'primary' | 'restore' = 'primary', purpose: 'test' | 'server' = 'test') {
  const make = (role: string) => {
    const selected = purpose === 'server' && !['REQUEST','MAPPING'].includes(role) ? 'REQUEST' : role;
    const value = process.env[`PR07E_TEST_${database === 'restore' ? 'RESTORE_' : ''}${selected}_URL`];
    if (process.env.PR07E_TEST_DISPOSABLE !== '1' || !process.env.PR07E_TEST_RUN_ID || !value) throw new Error('PR07E_DISPOSABLE_DATABASE_REQUIRED');
    const url = new URL(value);
    if (!/^\/pr07e_[a-z0-9_]+$/u.test(url.pathname) || url.pathname.startsWith('/pr07e_admin_')) throw new Error('PR07E_CHILD_DATABASE_REQUIRED');
    return new Pool({ connectionString:value,max,connectionTimeoutMillis:5000,idleTimeoutMillis:1000 });
  };
  return { admin:make('ADMIN'),mapping:make('MAPPING'),request:make('REQUEST'),worker:make('WORKER'),bypass:make('BYPASS') };
}
export async function closePools(pools: ReturnType<typeof testPools>) { await Promise.all(Object.values(pools).map(pool=>pool.end())); }

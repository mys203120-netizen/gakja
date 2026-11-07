import { Pool } from 'pg';

/** Only the explicitly owned D child database is accepted, never DATABASE_URL. */
export function testPools(max = 1) {
  const make = (role: string) => {
    const value = process.env[`PR07D_TEST_${role}_URL`];
    if (process.env.PR07D_TEST_DISPOSABLE !== '1' || !process.env.PR07D_TEST_RUN_ID || !value) throw new Error('PR07D_DISPOSABLE_DATABASE_REQUIRED');
    const url = new URL(value);
    if (!/^\/pr07d_[a-z0-9_]+$/u.test(url.pathname) || url.pathname.startsWith('/pr07d_admin_')) throw new Error('PR07D_CHILD_DATABASE_REQUIRED');
    return new Pool({ connectionString:value,max,connectionTimeoutMillis:5000,idleTimeoutMillis:1000 });
  };
  return { admin:make('ADMIN'),mapping:make('MAPPING'),request:make('REQUEST'),worker:make('WORKER'),bypass:make('BYPASS') };
}
export async function closePools(pools: ReturnType<typeof testPools>) { await Promise.all(Object.values(pools).map(pool=>pool.end())); }

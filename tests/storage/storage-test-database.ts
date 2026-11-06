import { Pool } from 'pg';

/** Explicit child URLs are supplied only by the marked disposable C runner. */
export function testPools(max = 1) {
  const make = (name: string) => {
    const url = process.env[`PR07C_TEST_${name}_URL`];
    if (process.env.PR07C_TEST_DISPOSABLE !== '1' || !process.env.PR07C_TEST_RUN_ID || !url) throw new Error('PR07C_DISPOSABLE_DATABASE_REQUIRED');
    const parsed = new URL(url);
    if (!/^\/pr07c_[a-z0-9_]+$/u.test(parsed.pathname) || parsed.pathname.startsWith('/pr07c_admin_')) throw new Error('PR07C_CHILD_DATABASE_REQUIRED');
    return new Pool({ connectionString:url,max,connectionTimeoutMillis:5000,idleTimeoutMillis:1000 });
  };
  return { admin:make('ADMIN'),mapping:make('MAPPING'),request:make('REQUEST'),worker:make('WORKER'),bypass:make('BYPASS') };
}
export async function closePools(pools: ReturnType<typeof testPools>) { await Promise.all(Object.values(pools).map(pool=>pool.end())); }

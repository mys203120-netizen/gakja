import { Pool } from 'pg';

/** Only the dedicated disposable runner supplies these URLs. No DATABASE_URL or
 * operational env fallback is allowed. URLs/passwords must never be logged. */
export function testPools(max = 1) {
  const make = (name: string) => {
    const url = process.env[`PR07B_TEST_${name}_URL`];
    if (process.env.PR07B_TEST_DISPOSABLE !== '1' || !url || !process.env.PR07B_TEST_RUN_ID) throw new Error('PR07B_DISPOSABLE_DATABASE_REQUIRED');
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/pr07b_') || parsed.pathname.startsWith('/pr07b_admin_')) throw new Error('PR07B_CHILD_DATABASE_REQUIRED');
    return new Pool({ connectionString: url, max, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
  };
  return { admin: make('ADMIN'), mapping: make('MAPPING'), request: make('REQUEST'), worker: make('WORKER'), bypass: make('BYPASS') };
}

export async function closePools(pools: ReturnType<typeof testPools>) {
  await Promise.all(Object.values(pools).map(pool => pool.end()));
}

import 'server-only';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const globalDb = globalThis as unknown as { gakjaPool?: Pool };
export const pool = globalDb.gakjaPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
});
if (process.env.NODE_ENV !== 'production') globalDb.gakjaPool = pool;

export async function query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('begin'); const value = await fn(client); await client.query('commit'); return value; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status });
  const failure=error as {code?:string;message?:string};
  if(['55P03','40P01'].includes(failure?.code||''))return Response.json({error:'다른 화면에서 자료를 저장하고 있어요. 잠시 후 다시 시도해 주세요.'},{status:409});
  if(failure?.code==='P0001'&&['휴지통에 있는 항목이에요. 복원한 뒤 이어서 작성해 주세요.','삭제한 항목이에요. 새 항목으로 작성해 주세요.'].includes(failure.message||''))return Response.json({error:failure.message},{status:409});
  console.error(error);
  return Response.json({ error: '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' }, { status: 500 });
}

import { requireUser } from '@/lib/auth';
import { bootstrap } from '@/lib/data';
import { errorResponse } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET() { try { return Response.json(await bootstrap(await requireUser()), { headers: { 'Cache-Control': 'private, no-store' } }); } catch (error) { return errorResponse(error); } }

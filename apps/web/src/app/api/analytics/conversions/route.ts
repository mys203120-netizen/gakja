import { cookies } from 'next/headers';
import { checkOrigin, getUser } from '@/lib/auth';
import { errorResponse, transaction } from '@/lib/db';
import { ANALYTICS_CONSENT_COOKIE, analyticsConfigured, consentGrantedAt, safeConversionReceipt } from '@/lib/analytics-model';

export const dynamic = 'force-dynamic';
const json = (events: unknown[]) => Response.json({ events }, { headers: { 'Cache-Control': 'private, no-store' } });

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (!analyticsConfigured({ mode: process.env.NODE_ENV, measurementId: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, manualMeasurementConfirmed: process.env.NEXT_PUBLIC_GA_MANUAL_MEASUREMENT_CONFIRMED })) return json([]);
    const consentAt = consentGrantedAt((await cookies()).get(ANALYTICS_CONSENT_COOKIE)?.value);
    if (consentAt === null) return json([]);
    const user = await getUser();
    if (!user || user.role !== 'student' || user.is_test) return json([]);
    // Atomic, one-time server acknowledgment of committed milestones. Concurrent
    // tabs cannot consume the same event. Network/ad-block failures may undercount.
    const events = await transaction(async db => {
      const result = await db.query(`with pending as (
        select id from analytics_conversion_receipts where student_id=$1 and delivered_at is null
        and occurred_at >= $2 and occurred_at > now()-interval '1 day'
        order by occurred_at,id for update skip locked limit 20
      ) update analytics_conversion_receipts r set delivered_at=now() from pending
        where r.id=pending.id returning r.event_name as name,r.method`, [user.id, new Date(consentAt)]);
      return result.rows.map(safeConversionReceipt).filter(Boolean);
    });
    return json(events);
  } catch (error) { return errorResponse(error); }
}

import { documentDelivery, localDocumentResponse } from '@/lib/document-delivery';
import { requireUser } from '@/lib/auth';
import { ApiError, errorResponse, query } from '@/lib/db';
import { validatePublication } from '@/lib/content-publication';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (user.role !== 'student') throw new ApiError(403, '학생 계정의 발행된 교재만 볼 수 있어요.');
    const url = new URL(request.url), kind = url.searchParams.get('kind') || 'guidebook', requested = url.searchParams.get('contentVersion');
    if (!['guidebook', 'handbook'].includes(kind) || (requested !== null && (!/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested)) || Number(requested) < 1))) throw new ApiError(400, '교재 종류와 발행 버전을 확인해 주세요.');
    const [version] = await query("select v.*,p.student_id from content_packages p join content_versions v on v.package_id=p.id and v.version=coalesce($2::int,p.active_version) and v.status='published' where p.student_id=$1", [user.id, requested === null ? null : Number(requested)]);
    if (!version) throw new ApiError(404, '발행된 교재를 찾을 수 없어요.');
    const documents = await query('select id,kind,data,html,file_hash from documents where package_id=$1 and content_version=$2 order by kind', [version.package_id, version.version]);
    validatePublication(version, documents);
    const document = documents.find(document => document.kind === kind);
    if (!document) throw new ApiError(404, '이 버전에는 해당 교재가 없어요.');
    if (url.searchParams.get('original') === '1') return localDocumentResponse(document.html);
    url.searchParams.set('original', '1');
    return Response.json({ document: { ...await documentDelivery(document, url.pathname + url.search), content_version: version.version } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}

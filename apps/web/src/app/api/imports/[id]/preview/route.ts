import { documentDelivery, localDocumentResponse } from '@/lib/document-delivery';
import { requireStaff, requireUser } from '@/lib/auth';
import { ApiError, errorResponse, query } from '@/lib/db';
import { publicationDigest, validatePublication } from '@/lib/content-publication';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    if (user.role === 'student') throw new ApiError(403, '관리자와 배정된 담당자만 교재를 미리 볼 수 있어요.');
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, '등록 자료를 선택해 주세요.');
    const [version] = await query('select v.*,p.student_id from content_versions v join content_packages p on p.id=v.package_id where v.id=$1', [id]);
    if (!version) throw new ApiError(404, '등록 자료를 찾을 수 없어요.');
    await requireStaff(version.student_id, 'review');
    const documents = await query('select id,kind,data,html,file_hash from documents where package_id=$1 and content_version=$2 order by kind', [version.package_id, version.version]);
    validatePublication(version, documents);
    const url = new URL(request.url), original = url.searchParams.get('original');
    if (original !== null) {
      const document = documents.find(item => item.id === original);
      if (!document) throw new ApiError(404, '교재 원본을 찾을 수 없어요.');
      return localDocumentResponse(document.html);
    }
    const deliveries = await Promise.all(documents.map(document => documentDelivery(document, `${url.pathname}?original=${encodeURIComponent(document.id)}`)));
    return Response.json({ versionId: id, digest: publicationDigest(version, documents), documents: deliveries, externalApproval: version.review?.external_approval, learningLinks: version.review?.learning_links }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}

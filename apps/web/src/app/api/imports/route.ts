import { canonicalJson, parseLearningHtml, validateGuidebook } from '@gakja/content-contracts';
import { checkOrigin, requireStaff } from '@/lib/auth';
import { recordingForm } from '@/lib/recording-upload';
import { ApiError, errorResponse, query, transaction } from '@/lib/db';
import { assertRegisteredTargets, FINAL_GUIDEBOOK_CONTRACT, learningLinkSummary } from '@/lib/content-publication';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    if (Number(request.headers.get('content-length') || 0) > 5 * 1024 * 1024 + 65536) throw new ApiError(413, '최종 가이드북 HTML은 5MB까지 등록할 수 있어요.');
    const uploader = await requireStaff();
    const { form } = await recordingForm(request, uploader.id, 'guidebook');
    const studentId = String(form.get('studentId') ?? ''), productionJobRef = String(form.get('productionJobRef') ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(studentId)) throw new ApiError(400, '학생 계정을 선택해 주세요.');
    const user = await requireStaff(studentId, 'import');
    const [student] = await query("select id from profiles where id=$1 and role='student' and active=true", [studentId]);
    const [production] = await query('select id from production_links where id=$1 and student_id=$2', [productionJobRef, studentId]);
    if (!student || !production) throw new ApiError(400, '학생과 등록된 제작 건을 확인해 주세요.');
    const files = form.getAll('files').filter((file): file is File => file instanceof File);
    if (files.length !== 1) throw new ApiError(400, '검수를 마친 최종 가이드북 HTML 한 파일을 등록해 주세요.');
    const file = files[0];
    if (!/\.html?$/i.test(file.name) || file.size > 5 * 1024 * 1024 || file.size === 0) throw new ApiError(400, '가이드북 HTML은 5MB 이내로 등록해 주세요.');
    const html = await file.text();
    let parsed;
    try { parsed = parseLearningHtml(html); } catch (error) { throw new ApiError(400, error instanceof Error ? error.message : '교재의 학습 데이터를 확인해 주세요.'); }
    const result = await transaction(async db => {
      // Serialize first imports too, even if two requests propose different package IDs.
      await db.query('select id from profiles where id=$1 for update', [studentId]);
      const targets = (await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id for update", [studentId])).rows;
      let content;
      try { content = validateGuidebook(parsed.pack, { studentId, productionJobRef, registeredTargetIds: targets.map(target => target.id) }); }
      catch (error) { throw new ApiError(400, error instanceof Error ? error.message : '최종 가이드북 규격을 확인해 주세요.'); }
      assertRegisteredTargets(content.learning, targets);
      await db.query('select pg_advisory_xact_lock(hashtext($1))', [content.packageId]);
      const existingPackage = (await db.query('select * from content_packages where id=$1', [content.packageId])).rows[0];
      if (existingPackage && existingPackage.student_id !== studentId) throw new ApiError(403, '다른 학생에게 연결된 패키지예요.');
      const other = (await db.query('select id from content_packages where student_id=$1 and id<>$2', [studentId, content.packageId])).rows[0];
      if (other) throw new ApiError(409, '기존 학생 패키지 ID를 유지해 주세요.');
      await db.query('insert into content_packages(id,student_id) values($1,$2) on conflict(id) do nothing', [content.packageId, studentId]);
      const same = (await db.query('select * from content_versions where package_id=$1 and version=$2', [content.packageId, content.contentVersion])).rows[0];
      if (same) {
        const existingDocs = (await db.query('select kind,file_hash,data from documents where package_id=$1 and content_version=$2', [content.packageId, content.contentVersion])).rows;
        if (same.learning_hash !== content.learningHash || existingDocs.length !== 1 || existingDocs[0].kind !== 'guidebook' || existingDocs[0].file_hash !== parsed.fileHash || canonicalJson(existingDocs[0].data) !== canonicalJson(parsed.pack.document)) throw new ApiError(409, '같은 버전의 교재가 달라요. 콘텐츠 버전을 올려 주세요.');
        return { id: same.id, duplicate: true, version: same.version, status: same.status };
      }
      const previousVersions = (await db.query('select version,data from content_versions where package_id=$1 order by version desc', [content.packageId])).rows;
      if (content.contentVersion < (previousVersions[0]?.version ?? 0)) throw new ApiError(409, '과거 버전은 등록 대신 버전 복귀를 사용해 주세요.');
      for (const question of content.learning.questions) {
        if (previousVersions.some(version => version.data.questions?.some((old: any) => old.id === question.id && old.question_intent !== question.question_intent))) throw new ApiError(409, `질문 ${question.id}의 의도가 바뀌었어요. 새 질문 ID로 과거 답변과 구분해 주세요.`);
      }
      const previous = previousVersions[0]?.data;
      const diff = {
        activities: { before: previous?.activities.length ?? 0, after: content.learning.activities.length },
        questions: { before: previous?.questions.length ?? 0, after: content.learning.questions.length },
        memory_items: { before: previous?.memory_items.length ?? 0, after: content.learning.memory_items.length },
        removed_question_ids: previous?.questions.filter((question: any) => !content.learning.questions.some(item => item.id === question.id)).map((question: any) => question.id) ?? [],
      };
      const review = {
        import_contract: FINAL_GUIDEBOOK_CONTRACT, upload_mode: 'guidebook',
        checks: ['schema', 'toc', 'references', 'hash', 'ownership', 'production_link', 'final_approval', 'activity_evaluation', 'learning_links'],
        external_approval: { ...parsed.pack.provenance, criteria_version: parsed.pack.criteria_version },
        learning_links: learningLinkSummary(content.learning), diff,
      };
      const version = (await db.query('insert into content_versions(package_id,version,data,learning_hash,production_job_ref,created_by,review) values($1,$2,$3,$4,$5,$6,$7) returning id', [content.packageId, content.contentVersion, JSON.stringify(content.learning), content.learningHash, productionJobRef, user.id, JSON.stringify(review)])).rows[0];
      await db.query("insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,'guidebook',$4,$5,$6)", [studentId, content.packageId, content.contentVersion, JSON.stringify(parsed.pack.document), html, parsed.fileHash]);
      await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, studentId, 'content.import.staged', JSON.stringify({ versionId: version.id, packageId: content.packageId, version: content.contentVersion, file_names: [file.name], productionJobRef, upload_mode: 'guidebook' })]);
      return { id: version.id, duplicate: false, version: content.contentVersion, status: 'staged', diff };
    });
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}

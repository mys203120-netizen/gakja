/** Runtime fault tests still verify copied source bytes. Only their student identity is explicitly synthetic.
 * Full-document analysis/provider quality is tested separately; this adapter does not approve production readiness. */
import { loadInterviewContext as loadVerifiedContext } from '../../server/data/load-interview-context';
export async function loadInterviewContext() {
  const context = await loadVerifiedContext();
  if (context.errors.length || !context.manifest.sourceIntegrity.pdfHashVerified || !context.manifest.sourceIntegrity.evidenceTextVerified) throw new Error('RECOVERY_FIXTURE_SOURCE_VERIFICATION_FAILED');
  context.student.studentId ??= 'student-explicit-synthetic-runtime-fixture';
  context.manifest.recordIds.studentId = context.student.studentId;
  return context;
}

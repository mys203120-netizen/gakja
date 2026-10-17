import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { loadProjectEnv, redactEnvironmentSecrets } from './load-env.mjs';

// Dry-run by default. --apply deletes only expired, unreferenced upload objects,
// using Storage's API (never deleting storage.objects rows directly).
loadProjectEnv();
const apply = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
try {
  if (apply && (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) throw Error('Storage cleanup needs the server-only Supabase service role key.');
  const storage = apply ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).storage : null;
  await db.connect();
  const intents = (await db.query("select id,student_id,files from recording_uploads where expires_at<now()-interval '24 hours' order by coalesce(cleanup_checked_at,expires_at) limit 100")).rows;
  let orphanCount = 0, retained = 0;
  for (const intent of intents) {
    let hasReferences = false;
    for (const file of intent.files) {
      if (!['student-media','student-chat-files','content-imports'].includes(file.bucket) || file.path !== `${intent.student_id}/uploads/${intent.id}/${file.field}` || !['recording','analysisAudio','file0','file1','file2'].includes(file.field)) throw Error('Unexpected cleanup destination; no objects removed for this intent.');
      const linked = (await db.query("select 1 from media_assets where metadata->>'bucket'=$1 and metadata->>'path'=$2 union all select 1 from quiz_recordings where metadata->>'bucket'=$1 and metadata->>'path'=$2 union all select 1 from chat_attachments where storage->>'bucket'=$1 and storage->>'path'=$2 limit 1", [file.bucket,file.path])).rowCount;
      if (linked) { retained++; hasReferences = true; continue; }
      orphanCount++;
      if (storage) { const { error } = await storage.from(file.bucket).remove([file.path]); if (error) throw Error('Storage cleanup failed; upload intent retained for retry.'); }
    }
    if (apply) {
      if (hasReferences) await db.query('update recording_uploads set cleanup_checked_at=now() where id=$1',[intent.id]);
      else await db.query("delete from recording_uploads where id=$1 and expires_at<now()-interval '24 hours'",[intent.id]);
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', intents: intents.length, orphanObjects: orphanCount, retainedObjects: retained }));
} catch(error) {
  console.error(redactEnvironmentSecrets(error instanceof Error ? error.message : error)); process.exitCode=1;
} finally { await db.end(); }

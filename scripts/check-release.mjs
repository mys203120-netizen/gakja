import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProjectEnv } from './load-env.mjs';

/** Configuration inspection only: no requests, database connection or mutation. */
export function evaluateReleaseConfiguration(env, { nodeVersion = process.versions.node, fileExists = existsSync } = {}) {
  const present = name => Boolean(env[name]?.trim());
  const local = hostname => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  const httpsRemote = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !local(url.hostname) && !url.username && !url.password; }
    catch { return false; }
  };
  let remoteDatabase = false;
  try { const url = new URL(env.DATABASE_URL); remoteDatabase = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname && url.pathname.slice(1)) && !local(url.hostname); } catch { /* Invalid values are never printed. */ }
  let mountedGoogleCredentials = false;
  try { mountedGoogleCredentials = present('GOOGLE_APPLICATION_CREDENTIALS') && fileExists(env.GOOGLE_APPLICATION_CREDENTIALS); } catch { /* Report availability only, never file paths or contents. */ }
  const textModel = feature => env[`OPENAI_MODEL_${feature}`] || env.OPENAI_MODEL || 'gpt-5.6-terra';
  const ttsProvider = env.SPEECH_PROVIDER || 'google';
  const settings = [
    { id: 'node_runtime', configured: Number(nodeVersion.split('.')[0]) >= 22 },
    { id: 'production_supabase_auth', configured: env.AUTH_MODE === 'supabase' },
    { id: 'local_test_auth_disabled', configured: env.ALLOW_LOCAL_AUTH !== 'true' },
    { id: 'public_https_origin', configured: httpsRemote(env.APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL) },
    { id: 'remote_postgresql', configured: remoteDatabase },
    { id: 'postgresql_tls', configured: env.DATABASE_SSL === 'true' },
    { id: 'supabase_https_endpoint', configured: httpsRemote(env.NEXT_PUBLIC_SUPABASE_URL) },
    { id: 'supabase_public_credentials', configured: present('NEXT_PUBLIC_SUPABASE_ANON_KEY') },
    { id: 'supabase_server_credentials', configured: present('SUPABASE_SERVICE_ROLE_KEY') },
    { id: 'google_signup_enabled', configured: env.SUPABASE_GOOGLE_ENABLED === 'true' },
    { id: 'kakao_signup_enabled', configured: env.SUPABASE_KAKAO_ENABLED === 'true' },
    { id: 'openai_server_credentials', configured: present('OPENAI_API_KEY') },
    { id: 'configured_chat_model_supported', configured: textModel('CHAT') === 'gpt-5.6-terra' },
    { id: 'configured_interview_model_supported', configured: textModel('INTERVIEW') === 'gpt-5.6-terra' },
    { id: 'configured_transcription_pipeline', configured: (env.STT_PROVIDER || 'openai') === 'openai' && (env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe') === 'gpt-4o-mini-transcribe' },
    { id: 'configured_transcript_cleanup', configured: env.TRANSCRIPT_CLEANUP_ENABLED !== 'false' && (env.OPENAI_TRANSCRIPT_CLEANUP_MODEL || 'gpt-6-luna') === 'gpt-6-luna' },
    { id: 'tts_credentials_available', configured: ttsProvider === 'openai' ? present('OPENAI_API_KEY') : ttsProvider === 'google' && mountedGoogleCredentials },
  ];
  return {
    scope: 'configuration_presence_only',
    configurationComplete: settings.every(setting => setting.configured),
    configuredCount: settings.filter(setting => setting.configured).length,
    requiredCount: settings.length,
    settings,
    // These require evidence from the chosen production host. Setting a flag or
    // retaining a previous local E2E result cannot establish that they passed.
    notValidated: ['production_build_and_start', 'database_migrations_and_roles', 'private_storage_policies', 'oauth_and_recovery_roundtrip', 'hosting_upload_and_download_limits', 'provider_access_and_timeout', 'physical_mobile_recording', 'news_refresh_after_response', 'growing_history_payload_and_load', 'backup_restore_and_error_monitoring'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadProjectEnv();
  const result = evaluateReleaseConfiguration(process.env);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.configurationComplete ? 0 : 1;
}

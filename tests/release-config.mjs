import assert from 'node:assert/strict';
import { evaluateReleaseConfiguration } from '../scripts/check-release.mjs';

const secret = 'private-test-sentinel-not-a-real-key';
const env = {
  AUTH_MODE: 'supabase', ALLOW_LOCAL_AUTH: 'false', NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  DATABASE_URL: `postgresql://operator:${secret}@db.example.test:5432/app`, DATABASE_SSL: 'true',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: secret,
  SUPABASE_SERVICE_ROLE_KEY: secret, SUPABASE_GOOGLE_ENABLED: 'true', SUPABASE_KAKAO_ENABLED: 'true',
  OPENAI_API_KEY: secret, SPEECH_PROVIDER: 'google', GOOGLE_APPLICATION_CREDENTIALS: 'private-service-account-fixture',
};
let checks = 0;
const evaluate = input => evaluateReleaseConfiguration(input, { nodeVersion: '22.0.0', fileExists: path => path === 'private-service-account-fixture' });
const configured = evaluate(env);
assert.ok(configured.configurationComplete); checks++;
assert.ok(evaluate({ ...env, APP_URL: 'https://runtime.example.test', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' }).configurationComplete, 'runtime canonical APP_URL takes precedence over a build-time public URL'); checks++;
assert.ok(!evaluate({ ...env, APP_URL: 'https://user:secret@evil.example.test' }).configurationComplete, 'an invalid explicit APP_URL cannot fall back to a valid public URL'); checks++;
assert.ok(evaluate({ ...env, APP_URL: '   ' }).configurationComplete, 'an empty runtime setting retains legacy public URL compatibility'); checks++;
assert.ok(configured.notValidated.includes('hosting_upload_and_download_limits') && configured.notValidated.includes('oauth_and_recovery_roundtrip')); checks++;
assert.ok(!JSON.stringify(configured).includes(secret) && !JSON.stringify(configured).includes('example.test') && !JSON.stringify(configured).includes('private-service-account-fixture')); checks++;
for (const invalid of [
  { AUTH_MODE: 'local' }, { ALLOW_LOCAL_AUTH: 'true' }, { NEXT_PUBLIC_APP_URL: 'http://localhost:3100' },
  { DATABASE_URL: 'postgresql://local:private@localhost:54329/app' }, { DATABASE_SSL: 'false' },
  { NEXT_PUBLIC_SUPABASE_URL: '' }, { NEXT_PUBLIC_SUPABASE_ANON_KEY: '' }, { SUPABASE_SERVICE_ROLE_KEY: '' },
  { SUPABASE_GOOGLE_ENABLED: 'false' }, { SUPABASE_KAKAO_ENABLED: 'false' }, { OPENAI_API_KEY: '' },
  { OPENAI_MODEL_CHAT: 'unsupported-fixture' }, { OPENAI_MODEL_INTERVIEW: 'unsupported-fixture' },
  { STT_PROVIDER: 'google' }, { OPENAI_TRANSCRIPTION_MODEL: 'unsupported-fixture' },
  { TRANSCRIPT_CLEANUP_ENABLED: 'false' }, { OPENAI_TRANSCRIPT_CLEANUP_MODEL: 'unsupported-fixture' },
  { GOOGLE_APPLICATION_CREDENTIALS: '' },
]) { assert.ok(!evaluate({ ...env, ...invalid }).configurationComplete); checks++; }
assert.ok(!evaluateReleaseConfiguration(env, { nodeVersion: '20.0.0', fileExists: () => true }).configurationComplete); checks++;
assert.ok(!evaluateReleaseConfiguration(env, { nodeVersion: '22.0.0', fileExists: () => { throw new Error(secret); } }).configurationComplete); checks++;
const temporary = evaluate({ ...env, GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_SPEECH_ACCESS_TOKEN: secret });
assert.ok(!temporary.settings.find(setting => setting.id === 'tts_credentials_available').configured, 'expiring temporary Google token is not a durable launch credential'); checks++;
const openaiTts = evaluate({ ...env, GOOGLE_APPLICATION_CREDENTIALS: '', SPEECH_PROVIDER: 'openai' });
assert.ok(openaiTts.configurationComplete, 'explicit OpenAI TTS uses the existing single server credential'); checks++;
const invalidUrls = evaluate({ ...env, NEXT_PUBLIC_APP_URL: secret, DATABASE_URL: secret, NEXT_PUBLIC_SUPABASE_URL: secret });
assert.ok(!invalidUrls.configurationComplete && !JSON.stringify(invalidUrls).includes(secret)); checks++;
console.log(`Release configuration checks: ${checks} passed; network requests, database access, credentials printed and builds: 0.`);

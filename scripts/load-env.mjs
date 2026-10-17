import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Shell/deployment values win; root local overrides win over shared defaults. */
export function loadProjectEnv({ root = projectRoot, target = process.env } = {}) {
  const loaded = [];
  for (const name of ['.env.local', '.env']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    config({ path, processEnv: target, override: false, quiet: true });
    loaded.push(name);
  }
  return loaded;
}

/** Keep credentials out of launcher diagnostics, including a DB URL in an error. */
export function redactEnvironmentSecrets(value) {
  let text = String(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (secret && /(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|DATABASE_URL|SERVICE_ROLE_KEY|ANON_KEY|PRIVATE_KEY|CREDENTIALS)$/i.test(name)) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/gi, '$1[redacted]$3');
}

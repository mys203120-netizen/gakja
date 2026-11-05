import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import net from "node:net";
import { publicServiceError } from "../lib/interview/service-errors";

async function unusedPort() {
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}
// Full source/PDF verification may compete with other extraction workers in the complete suite.
// This is a bounded test setup allowance, not a product latency target.
test("real local HTTP status is usable without credentials and rejects foreign origins", { timeout: 75_000 }, async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/realtime.ts"], { cwd: process.cwd(), env: { ...process.env, REALTIME_PORT: String(port), WEB_PORT: String(port + 1), OPENAI_API_KEY: "", CLOVA_SPEECH_SECRET_KEY: "", CLOVA_VOICE_CLIENT_ID: "", CLOVA_VOICE_CLIENT_SECRET: "" }, stdio: "pipe", windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    const startupDeadline = Date.now() + 25_000;
    while (Date.now() < startupDeadline) {
      try { const response = await fetch(`${base}/api/health`, { headers: { Connection: 'close' } }); healthy = response.ok; if (healthy) break; } catch { /* startup */ }
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, output);
    const workspaceId = createHash("sha256").update(path.resolve(process.cwd()).toLowerCase()).digest("hex").slice(0, 16);
    assert.deepEqual(await (await fetch(`${base}/api/health`, { headers: { Connection: 'close' } })).json(), { app: "each-answer-interview", ok: true, workspaceId });
    const status = await (await fetch(`${base}/api/status`, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(60_000) })).json();
    assert.equal(status.ready, false);
    assert.deepEqual(status.missingKeys, ["OPENAI_API_KEY", "CLOVA_SPEECH_SECRET_KEY", "CLOVA_VOICE_CLIENT_ID", "CLOVA_VOICE_CLIENT_SECRET"]);
    assert.equal(status.target.year, 2027);
    assert.equal(status.sources.files, undefined);
    assert.ok(Number.isSafeInteger(status.sources.studentEvidenceCount) && status.sources.studentEvidenceCount > 0);
    assert.equal(typeof status.preparationReady, 'boolean');
    const expectedPreparationErrors = [...(!status.questionBankReady ? ['면접 자료의 사전 준비가 필요합니다.'] : []), ...(!status.analysisIdentityReady ? ['학생 전체 분석과 지원처별 분석의 사전 준비가 필요합니다.'] : [])];
    assert.deepEqual(status.errors, expectedPreparationErrors);
    assert.match(status.sources.sourceFingerprint, /^[a-f0-9]{64}$/u);
    assert.equal(status.durationSeconds, 720);
    assert.ok(Number.isSafeInteger(status.mainQuestionCount) && status.mainQuestionCount > 0, 'Prepared objective pool size must not be interpreted as a fixed interview ending count');
    assert.equal(status.interviewOverview.durationSeconds, 720);
    assert.equal(status.interviewOverview.lines.length, 3);
    assert.equal(status.interviewOverview.trackId, "track_afc9619a17b66c2765c9");
    assert.equal(status.sources.recordIds.departmentId, "dept_7ce7fba69ac8b83c64d4");
    const foreign = await fetch(`${base}/api/status`, { headers: { Origin: "https://foreign.example", Connection: 'close' } });
    assert.equal(foreign.status, 403);
    const start = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", Connection: 'close' }, body: "{}" });
    assert.equal(start.status, 503);
    assert.equal((await start.json()).error, publicServiceError('connection'));
    const prepare = await fetch(`${base}/api/prepare`, { method: "POST", headers: { "Content-Type": "application/json", Connection: 'close' }, body: "{}" });
    assert.equal(prepare.status, 503);
    assert.equal((await fetch(`${base}/data/prepared/student.json`, { headers: { Connection: 'close' } })).status, 404);
    assert.equal((await fetch(`${base}/윤지우학생%20생활기록부.pdf`, { headers: { Connection: 'close' } })).status, 404);
  } finally {
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
  }
});

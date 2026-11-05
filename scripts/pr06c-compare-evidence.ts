/** Compare independently executed C source trees without application helpers.
 * Original raw handler files remain intact; only validated runtime-config port
 * numbers are mapped for controlled byte comparison. No log row is dropped. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'artifacts/pr06c');
const read = async (file: string) => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
const [before, after, storeBefore, storeAfter, logBefore, logAfter, naturalOne, naturalTwo, controlledOne, controlledTwo, controlledAfter, source] = await Promise.all([
  read('before-private.json'), read('after-private.json'), read('session-store-before-cases.json'), read('session-store-after-cases.json'), read('before-conversation-log.json'), read('after-conversation-log.json'),
  read('handler-before-natural-1.json'), read('handler-before-natural-2.json'), read('handler-before-controlled-1.json'), read('handler-before-controlled-2.json'), read('handler-after-controlled.json'), read('source-capture-before.log'),
]);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value) ?? '<undefined>');
const checks: { id: string; passed: boolean }[] = [];
const same = (id: string, left: unknown, right: unknown) => checks.push({ id, passed: JSON.stringify(left) === JSON.stringify(right) });
assert.notEqual(path.resolve(before.sourceRoot), path.resolve(after.sourceRoot));
for (const [label, old, next] of [['store', storeBefore, storeAfter], ['log', logBefore, logAfter]] as const) {
  same(label + ':same-controlled-fixture-and-clock', [old.fixtureSha256, old.controlledClock], [next.fixtureSha256, next.controlledClock]);
  assert.equal(old.cases.length, next.cases.length);
  for (const row of old.cases) { const current = next.cases.find((item: { id: string }) => item.id === row.id); assert.ok(current); same(label + ':' + row.id + ':all-observations-I/O-events-final-bytes', row, current); }
}
same('private:actual-session-context-list-owner-log-recovery-read-outcomes', before.observations, after.observations);
for (const group of before.protectedGroups) same('private:' + group.category + ':all-file-identities-and-physical-bytes', group, after.protectedGroups.find((item: { category: string }) => item.category === group.category));
for (const item of [before, after]) { assert.equal(item.privateWriteAttempts, 0); assert.equal(item.networkAttempts, 0); assert.equal(item.originalFilesUnchanged, true); assert.equal(item.sourceModulesUnchanged, true); }
type HandlerFile = { path: string; bytes: number; sha256: string; text: string };
type Ports = { realtime: number; web: number };
const ports = (report: typeof controlledOne): Ports => {
  const found: Ports[] = [];
  for (const file of report.rawEvidence.files as HandlerFile[]) {
    assert.equal(Buffer.byteLength(file.text), file.bytes); assert.equal(sha(file.text), file.sha256);
    if (!file.path.endsWith('.jsonl')) continue;
    for (const line of file.text.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line); assert.equal(JSON.stringify(row), line, 'raw compact JSONL spelling must be preserved');
      if (!row.payload?.ports) continue;
      assert.equal(row.type, 'provider.config'); const value = row.payload.ports; assert.deepEqual(Object.keys(value), ['realtime', 'web']);
      for (const key of ['realtime', 'web'] as const) assert.ok(Number.isInteger(value[key]) && value[key] >= 1024 && value[key] <= 65535);
      found.push(value);
    }
  }
  assert.ok(found.length > 0); for (const value of found) assert.deepEqual(value, found[0]); return found[0];
};
const portReference = ports(controlledOne);
function controlledProjection(report: typeof controlledOne) {
  assert.equal(report.controlled, true); ports(report);
  const files = (report.rawEvidence.files as HandlerFile[]).map(file => {
    if (!file.path.endsWith('.jsonl')) return file;
    const text = file.text.split('\n').map(line => {
      if (!line) return line;
      const row = JSON.parse(line);
      if (row.type === 'provider.config' && row.payload?.ports) { row.payload.ports.realtime = portReference.realtime; row.payload.ports.web = portReference.web; return JSON.stringify(row); }
      return line;
    }).join('\n');
    return { ...file, bytes: Buffer.byteLength(text), sha256: sha(text), text };
  });
  return { ...report.rawEvidence, files };
}
for (const report of [naturalOne, naturalTwo, controlledOne, controlledTwo, controlledAfter]) {
  assert.equal(report.realHttpWs, true); assert.equal(report.actualSessionLogWriters, true); assert.equal(report.actualProviderCalls, 0); assert.equal(report.privateFilesCopied, 0);
  assert.equal(report.processIds.length, 2); assert.notEqual(report.processIds[0], report.processIds[1]);
  for (const file of report.rawEvidence.files as HandlerFile[]) { assert.equal(Buffer.byteLength(file.text), file.bytes); assert.equal(sha(file.text), file.sha256); }
}
same('handler:natural-BEFORE-repeat-stable-observations', naturalOne.observations, naturalTwo.observations);
same('handler:controlled-BEFORE-repeat-stable-observations', controlledOne.observations, controlledTwo.observations);
same('handler:controlled-BEFORE-AFTER-stable-observations', controlledOne.observations, controlledAfter.observations);
const projectedOne = controlledProjection(controlledOne), projectedTwo = controlledProjection(controlledTwo), projectedAfter = controlledProjection(controlledAfter);
same('handler:controlled-BEFORE-repeat-entire-raw-evidence-ports-only', projectedOne, projectedTwo);
same('handler:controlled-BEFORE-AFTER-entire-raw-evidence-ports-only', projectedOne, projectedAfter);
const naturalSession = (report: typeof naturalOne) => JSON.parse((report.rawEvidence.files as HandlerFile[]).find(file => file.path === `data/sessions/${report.rawEvidence.firstId}.json`)!.text);
const n1 = naturalSession(naturalOne), n2 = naturalSession(naturalTwo);
for (const report of [naturalOne, naturalTwo]) { assert.equal(report.controlled, false); assert.match(report.rawEvidence.firstId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu); }
checks.push({ id: 'handler:actual-natural-BEFORE-repeat-proves-UUID-and-clock-nondeterminism', passed: naturalOne.rawEvidence.firstId !== naturalTwo.rawEvidence.firstId && n1.createdAt !== n2.createdAt && Number.isFinite(Date.parse(n1.createdAt)) && Number.isFinite(Date.parse(n2.createdAt)) });
const physical = (report: typeof controlledOne) => (report.rawEvidence.files as HandlerFile[]).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
const result = { version: 'pr06c-independent-before-after-comparison-v1', generatedAt: new Date().toISOString(), status: checks.every(row => row.passed) ? 'passed' : 'failed',
  beforeSource: { kind: source.sourceKind, head: source.head, treeSha256: source.sourceTreeSha256, files: source.files, sourceModuleHashes: before.sourceModuleHashes }, afterSource: { sourceModuleHashes: after.sourceModuleHashes }, dependencyReuse: true, freshInstallClaimed: false,
  execution: { storeCases: storeBefore.cases.length, loggerCases: logBefore.cases.length, actualHandlerModes: 'natural BEFORE twice; controlled BEFORE twice and AFTER once; real HTTP/WS and fresh server process',
    privateProtectedFiles: before.protectedGroups.reduce((sum: number, row: { files: number }) => sum + row.files, 0), privateProtectedBytes: before.protectedGroups.reduce((sum: number, row: { bytes: number }) => sum + row.bytes, 0),
    privateSessionAttempts: before.observations.sessionCount, privateReferencedContexts: before.observations.referencedContextCount, privateSessionOutcomes: before.observations.sessionOutcomeCounts, privateContextOutcomes: before.observations.contextOutcomeCounts },
  handlerEvidence: { observations: controlledAfter.observations, fullControlledRawComparisonSha256: jsonSha(projectedAfter), controlledPortsReference: portReference,
    rawPhysicalFileHashes: { before: physical(controlledOne), repeatedBefore: physical(controlledTwo), after: physical(controlledAfter) },
    naturalBefore: { rawEvidenceSha256: jsonSha(naturalOne.rawEvidence), repeatedRawEvidenceSha256: jsonSha(naturalTwo.rawEvidence), firstIdSha256: sha(naturalOne.rawEvidence.firstId), repeatedFirstIdSha256: sha(naturalTwo.rawEvidence.firstId), createdAt: n1.createdAt, repeatedCreatedAt: n2.createdAt },
    control: 'Actual controlled UUID/Date/performance inputs; no ID/timestamp removal. Only provider.config payload.ports.realtime/web are mapped after exact key/type/range validation. JSONL key spelling/order, every row, newline, event binding, source/owner/pin, response and saved payload remains present. Raw original text/bytes/SHA retained separately.' },
  preservation: { privateOriginalFilesUnchanged: true, privateWrites: 0, actualProviderCalls: 0, privateRawTextOrIdsExported: false, evaluationApprovalGranted: false, logsAreAuxiliaryNotNewStateTruth: true },
  limitations: ['Controlled 599999/600000/600001 and anchor/resave tests are logical clock cases, not an actual ten-minute or device wait.', 'Actual handler uses synthetic context/providers/PCM with real LocalSessionStore/logger; not a whole-store mock or production multi-user Auth/RLS proof.', 'Private logs use existing offline parser, never append/correction/reconstruction. Legacy rejected sessions remain rejected.', 'Per-file writes, Windows retry tests and controlled end/save races do not prove a multi-file transaction, distributed lease or power-loss durability.', 'No actual evaluation approval/provider, remote CI, W0 integration, real browser or hardware test is claimed by this evidence.'],
  checks, failedChecks: checks.filter(row => !row.passed).map(row => row.id) };
await writeFile(path.join(directory, 'repository-comparison.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks: checks.length, failedChecks: result.failedChecks, execution: result.execution }, null, 2));
if (result.status !== 'passed') process.exitCode = 1;

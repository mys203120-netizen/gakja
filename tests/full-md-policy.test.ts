import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interviewConfig } from '../interview.config';
import { compileInterviewerPolicy } from '../server/policy/interviewer-policy';
import { assertFullMdPolicyOriginals, captureFullMdPolicyOriginals, fullMdInterviewerPolicyInstructions, fullMdPolicyDiagnostics, fullMdPolicyRoles } from '../server/policy/full-md-policy';

async function fixture() {
  const policy = await compileInterviewerPolicy();
  const inputs = await Promise.all(fullMdPolicyRoles.map(async role => {
    const path = interviewConfig.files[role], mapped = policy.sourceFiles.find(file => file.path === path)!;
    return { role, path, sha256: mapped.sha256, bytes: await readFile(path) };
  }));
  const fullMdPolicyOriginals = captureFullMdPolicyOriginals(inputs, policy);
  return { inputs, context: { interviewerPolicy: policy, fullMdPolicyOriginals, manifest: { files: inputs.map(({role,path,sha256})=>({role,path,sha256})), interviewerPolicy: { contentSha256: policy.contentSha256 } } } };
}

test('runtime instructions contain all twelve exact originals in stable numeric order, not compact substitutes', async () => {
  const { context, inputs } = await fixture();
  const instructions = fullMdInterviewerPolicyInstructions(context);
  let previous = -1;
  for (const [index, input] of inputs.entries()) {
    const boundary = `===== MD ${index + 1}: ${input.path}`;
    const offset = instructions.indexOf(boundary);
    assert.ok(offset > previous);
    assert.ok(instructions.includes(input.bytes.toString('utf8')));
    previous = offset;
  }
  assert.equal(instructions, fullMdInterviewerPolicyInstructions(JSON.parse(JSON.stringify(context))));
  const diagnostics = fullMdPolicyDiagnostics(context.fullMdPolicyOriginals);
  assert.equal(diagnostics.documentCount, 12);
  assert.equal(diagnostics.originalUtf8Bytes, inputs.reduce((sum,input)=>sum+input.bytes.length,0));
  assert.ok(instructions.indexOf('명시적 사용자 운영 예외(충돌 시 우선)') > previous);
  assert.ok(instructions.includes('USER_SINGLE_REALTIME_CORE'));
  assert.ok(instructions.includes('예시 학생·답안·수치는 현재 학생의 사실이 아니다'));
});

test('missing, reordered, changed or manifest-mismatched policy originals fail closed without filesystem substitution', async () => {
  const { context } = await fixture();
  for (const mutate of [
    (c: typeof context) => { c.fullMdPolicyOriginals.documents.pop(); },
    (c: typeof context) => { c.fullMdPolicyOriginals.documents.reverse(); },
    (c: typeof context) => { c.fullMdPolicyOriginals.documents[0].text += '\nchanged'; },
    (c: typeof context) => { c.manifest.files[0].sha256 = 'a'.repeat(64); },
    (c: typeof context) => { c.manifest.interviewerPolicy.contentSha256 = 'b'.repeat(64); },
  ]) {
    const broken = structuredClone(context); mutate(broken);
    assert.throws(() => fullMdInterviewerPolicyInstructions(broken), /FULL_MD_POLICY_/);
  }
  const missing = { ...context, fullMdPolicyOriginals: undefined };
  assert.throws(() => fullMdInterviewerPolicyInstructions(missing), /FULL_MD_POLICY_ORIGINALS_REQUIRED/);
  assert.doesNotThrow(() => assertFullMdPolicyOriginals(JSON.parse(JSON.stringify(context))));
});

test('capture accepts only the exact twelve configured MD roles approved by policy and manifest inputs', async () => {
  const { context, inputs } = await fixture();
  assert.throws(() => captureFullMdPolicyOriginals(inputs.slice(1), context.interviewerPolicy), /SOURCE_MISMATCH/);
  const changed = inputs.map(input=>({...input,bytes:Buffer.from(input.bytes)}));
  changed[0].bytes=Buffer.from('book text or a student record cannot replace policy');
  assert.throws(() => captureFullMdPolicyOriginals(changed, context.interviewerPolicy), /SOURCE_MISMATCH/);
  assert.equal(context.fullMdPolicyOriginals.documents.some(doc=>/studentPdf|bookContentMd/u.test(doc.role)), false);
});

test('only fixtures with no compiled policy may use compact compatibility instructions', () => {
  const synthetic = {manifest:{files:[]}};
  assert.ok(fullMdInterviewerPolicyInstructions(synthetic).includes('학생 사실은'));
  assert.throws(() => assertFullMdPolicyOriginals(synthetic), /ORIGINALS_REQUIRED/);
});

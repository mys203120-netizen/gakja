import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { compactInterviewerPolicyInstructions, compileInterviewerPolicy } from '../server/policy/interviewer-policy';

test('policy compilation binds explicit clauses to exact reviewed MD hashes and execution checks without provider calls', async () => {
  const pack = await compileInterviewerPolicy();
  assert.equal(pack.sourceFiles.length, 12);
  assert.ok(pack.rules.length >= 15);
  assert.equal(new Set(pack.rules.map(rule => rule.id)).size, pack.rules.length);
  assert.deepEqual(pack, await compileInterviewerPolicy());
  for (const rule of pack.rules) {
    const text = await readFile(resolve(rule.source.path), 'utf8');
    assert.ok(text.split(/\r?\n/u)[rule.source.startLine - 1].includes(rule.source.quote));
    assert.ok(rule.guards.length && rule.regressions.length);
  }
  assert.ok(compactInterviewerPolicyInstructions(pack).includes('일치하는 책 문항은 생성의 필수 조건이 아니다'));
  assert.ok(pack.userOverrides.every(rule => rule.precedence > pack.rules[0].precedence));
});

test('changed canonical MD bytes fail policy compilation instead of silently changing the running rules', async () => {
  const pack = await compileInterviewerPolicy();
  const root = await mkdtemp(join(tmpdir(), 'interviewer-policy-test-'));
  try {
    for (const source of pack.sourceFiles) {
      const target = resolve(root, source.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(resolve(source.path)));
    }
    await writeFile(resolve(root, pack.sourceFiles[0].path), '\nchanged', { flag: 'a' });
    await assert.rejects(() => compileInterviewerPolicy(root), /SOURCE_CHANGED/);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('interviewer-policy-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

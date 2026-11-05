import dotenv from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { InterviewSession } from '../server/protocol';
import type { RealtimeCoreRequest } from '../server/providers/realtime-core';
import { loadStagedInterviewContextAt } from '../server/data/staged-interview-context';
import { actualUserCoreCheckpoint, rebindActualUserCheckpoint, projectHistoricalQuestionEvidence, ACTUAL_USER_MANIFEST_PATH, type ActualUserCoreManifest } from './replay-actual-user-core';
import { runSingleCoreRuntime } from '../server/providers/single-core-runtime';
import { encodeSingleCoreCandidateResponse, SINGLE_CORE_DIALOGUE_RULES } from '../server/providers/single-core-contract';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion } from '../server/protocol';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const revision = 'data/prepared/student-analysis-revisions/c00231afeacadbb1335ca02328469f6f5d68aad80b6a19c76980cde32c8be54d/analysis.json';
dotenv.config({ path: '.env.local', quiet: true });
const manifest = JSON.parse(await readFile(ACTUAL_USER_MANIFEST_PATH, 'utf8')) as ActualUserCoreManifest;
const { context: base } = await loadStagedInterviewContextAt(process.cwd(), revision);
const { context } = await projectHistoricalQuestionEvidence(base, manifest);
const replay = JSON.parse(await readFile('artifacts/actual-user-core-v7-final-c00231-20261104.json', 'utf8')) as { cases: Array<{ id: string; policyTrace: { semanticInputSha256: string } }> };
const inspectKeys = new Set(['primaryFunction', 'primaryFunctions', 'depth', 'targetEvidence', 'expectedEvidence', 'requiredClaimSlots', 'questionIntent', 'intent', 'assessmentTarget', 'trigger', 'applicabilityConditions']);
const paths = (value: unknown, current = ''): string[] => {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => [...(inspectKeys.has(key) ? [`${current}.${key}`] : []), ...paths(entry, `${current}.${key}`)]);
};
const cases = [];
for (const id of ['R1-Q6', 'R2-Q7']) {
  const row = manifest.cases.find(item => item.id === id)!;
  const original = JSON.parse(await readFile(row.sourcePath, 'utf8')) as InterviewSession;
  const checkpoint = actualUserCoreCheckpoint(context, original, row); rebindActualUserCheckpoint(context, original, checkpoint);
  const capture: { request?: RealtimeCoreRequest } = {};
  const duration = checkpoint.durationSeconds!;
  await runSingleCoreRuntime(context, checkpoint, { candidateOnly: true, policyMode: 'compiled', coreReasoningEffort: 'low',
    allowFollowUp: mayAskFollowUp(checkpoint, duration, 2), allowClarification: mayAskClarification(checkpoint, duration), allowReplay: mayReplayQuestion(checkpoint, duration),
    requestSingleCore: async request => { capture.request = request; return encodeSingleCoreCandidateResponse({ assessment: { coverage: 'met', response: 'answered', reason: 'No-provider request-capture seam only.' }, next: { action: 'TRANSITION', question: null }, reaction: null }); } });
  if (!capture.request) throw new Error('NO_PROVIDER_REQUEST_CAPTURED');
  const input = JSON.parse(capture.request.input) as Record<string, unknown>;
  const inputSha256 = hash(capture.request.input);
  const historical = original.turns[row.turnIndex].metadata;
  const item = { id, inputSha256, exactReplayInputSha256: replay.cases.find(item => item.id === id)!.policyTrace.semanticInputSha256,
    matchesActualReplayInput: inputSha256 === replay.cases.find(item => item.id === id)!.policyTrace.semanticInputSha256,
    inputCharacters: capture.request.input.length, instructionCharacters: capture.request.instructions.length,
    coreInstructionCharacters: SINGLE_CORE_DIALOGUE_RULES.length,
    pinnedCompiledInstructionCharacters: capture.request.instructions.length - SINGLE_CORE_DIALOGUE_RULES.length - 1,
    modelFacingTopKeys: Object.keys(input), question: input.question, rootQuestion: input.rootQuestion,
    strategyCandidates: input.strategyCandidates, approvedRestatements: input.approvedRestatements,
    designMetadataPathsActuallyTransmitted: paths(input),
    serverOnlyDeclaredDesign: { primaryFunction: historical.primaryFunction, depth: historical.depth, questionIntent: historical.questionIntent, targetEvidence: historical.targetEvidence },
  };
  cases.push(item);
}
const output = process.argv.find(arg=>arg.startsWith('--out='))?.slice(6) ?? 'artifacts/actual-user-core-v7-input-inspection-20261104.json';
await writeFile(output, JSON.stringify({ scope: 'No-provider exact request reconstruction; no production/session/pointer activation or model decisions.', providerCalls: 0, revision, cases }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, providerCalls: 0, cases: cases.map(item => ({ id: item.id, matchesReplay: item.matchesActualReplayInput, transmittedDesignPaths: item.designMetadataPathsActuallyTransmitted, inputCharacters: item.inputCharacters, instructionCharacters: item.instructionCharacters, coreInstructionCharacters: item.coreInstructionCharacters, pinnedCompiledInstructionCharacters: item.pinnedCompiledInstructionCharacters })) }));

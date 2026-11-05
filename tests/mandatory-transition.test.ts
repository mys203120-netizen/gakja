import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRequiredTransition, repeatedUnrelatedAfterRephrase } from '../server/providers/mandatory-transition';
import { selectBridge } from '../server/providers/acknowledgement-phrases';
import type { InterviewSession } from '../server/protocol';
import type { AnswerReaction } from '../server/providers/answer-reaction';
const fixture = () => ({ id: 's', turns: [
  { id: 'q', parentMainQuestionId: 'q', questionKind: 'main', metadata: { coreDecision: { answerRelation: { kind: 'unrelated' } } } },
  { id: 'c', parentMainQuestionId: 'q', questionKind: 'clarification', answerId: 'a', metadata: { clarificationOfTurnId: 'q', clarificationMode: 'rephrase' } },
] }) as unknown as InterviewSession;
test('repeated unrelated answers require non-evaluative closure without quoting unrelated content', () => {
  const session = fixture(), reaction = { directive: 'next_main', classification: 'off_topic', reply: null } as AnswerReaction;
  const output = bindRequiredTransition(reaction, session);
  assert.ok(output.reply); assert.equal(output.bridge?.kind, 'off_topic_end'); assert.equal(output.keywordQuote, null);
  assert.equal(output.directive, 'next_main');
  session.turns.at(-1)!.metadata.clarificationMode = 'repeat_audio';
  assert.equal(repeatedUnrelatedAfterRephrase(session), false);
  assert.equal(bindRequiredTransition(reaction, session), reaction);
});
test('required closing never falls back to silence after every wording has been used', () => {
  const previousTexts: string[] = [];
  for (let index = 0; index < 12; index++) {
    const selected = selectBridge({ kind: 'off_topic_end', seed: String(index), previousTexts });
    assert.ok(selected.text); previousTexts.push(selected.text);
  }
  assert.ok(new Set(previousTexts).size >= 3);
});

test('audio replay preserves an already delivered rephrase for the same actual question', () => {
  const session = fixture();
  session.turns[1].metadata.coreDecision = { answerRelation: { kind: 'non_answer' } } as NonNullable<typeof session.turns[1]['metadata']['coreDecision']>;
  session.turns.push({ id: 'audio-replay', parentMainQuestionId: 'q', questionKind: 'clarification', answerId: 'after-replay',
    metadata: { clarificationOfTurnId: 'q', clarificationMode: 'repeat_audio' } } as typeof session.turns[number]);
  const reaction = { directive: 'next_main', classification: 'off_topic', reply: null } as AnswerReaction;
  assert.equal(repeatedUnrelatedAfterRephrase(session), true);
  const output = bindRequiredTransition(reaction, session);
  assert.ok(output.reply);
  assert.equal(output.bridge?.kind, 'off_topic_end');
  assert.equal(output.keywordQuote, null);
});

test('an audio replay alone does not consume a rephrase opportunity', () => {
  const session = fixture();
  session.turns[0].metadata.coreDecision = { answerRelation: { kind: 'non_answer' } } as NonNullable<typeof session.turns[0]['metadata']['coreDecision']>;
  session.turns[1].metadata.clarificationMode = 'repeat_audio';
  assert.equal(repeatedUnrelatedAfterRephrase(session), false);
  session.turns[0].metadata.coreDecision!.answerRelation = { kind: 'unrelated' };
  assert.equal(repeatedUnrelatedAfterRephrase(session), false);
});

test('a rephrase for the main question cannot close the first unrelated answer to a different follow-up', () => {
  const session = fixture();
  session.turns.push({ id: 'follow', parentMainQuestionId: 'q', questionKind: 'follow_up',
    metadata: { coreDecision: { answerRelation: { kind: 'non_answer' } } } } as unknown as typeof session.turns[number]);
  session.turns.push({ id: 'follow-replay', parentMainQuestionId: 'q', questionKind: 'clarification', answerId: 'f-answer',
    metadata: { clarificationOfTurnId: 'follow', clarificationMode: 'repeat_audio' } } as typeof session.turns[number]);
  assert.equal(repeatedUnrelatedAfterRephrase(session), false);
  // Nor does an actual rephrase delivered before any unrelated answer count as
  // the one chance to clarify an off-topic answer.
  session.turns.at(-1)!.metadata.clarificationMode = 'rephrase';
  assert.equal(repeatedUnrelatedAfterRephrase(session), false);
});

import test from 'node:test';

test('choice quiz manual review, recovery and keyboard interaction', async () => {
  const { runQuizChoiceInteractionChecks } = await import('./quiz-choice-interaction.mjs');
  await runQuizChoiceInteractionChecks();
});

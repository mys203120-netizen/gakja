import test from 'node:test';

test('choice quiz manual review, recovery and keyboard interaction', async () => {
  const { runQuizChoiceInteractionChecks } = await import('./quiz-choice-interaction.mjs');
  await runQuizChoiceInteractionChecks();
});


test('plan quiz starts once after handoff while free, paused, failed and stale scopes remain guarded',async()=>{
  const {runPlannedQuizAutoStartChecks}=await import('./quiz-choice-interaction.mjs');
  await runPlannedQuizAutoStartChecks();
});

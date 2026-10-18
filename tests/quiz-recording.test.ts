import test from 'node:test';

// Keep the rendered-handler regression harness in the normal CI test discovery.
test('Q&A recording stop, upload, transcription and interrupted-draft recovery', async () => {
  await import('./quiz-recovery.mjs');
});

type DeltaSchedule<Handle> = {
  schedule: (callback: () => void) => Handle;
  cancel: (handle: Handle) => void;
};

/** Batches incoming chunks into exact text deltas without delaying completion. */
export function createAssistantDeltaBuffer<Handle>(
  onText: (text: string) => void,
  { schedule, cancel }: DeltaSchedule<Handle>,
) {
  let queued = '';
  let pending: { active: boolean; hasHandle: boolean; handle?: Handle } | null = null;

  function clearPending() {
    const job = pending;
    pending = null;
    const text = queued;
    queued = '';
    if (job) {
      job.active = false;
      if (job.hasHandle) cancel(job.handle as Handle);
    }
    return text;
  }

  return {
    append(text: string) {
      if (!text) return;
      queued += text;
      if (pending) return;
      const job = { active: true, hasHandle: false, handle: undefined as Handle | undefined };
      pending = job;
      const handle = schedule(() => {
        if (!job.active || pending !== job) return;
        job.active = false;
        pending = null;
        const delta = queued;
        queued = '';
        if (delta) onText(delta);
      });
      if (job.active && pending === job) {
        job.handle = handle;
        job.hasHandle = true;
      }
    },
    flush() {
      const text = clearPending();
      if (text) onText(text);
    },
    discard() {
      clearPending();
    },
  };
}

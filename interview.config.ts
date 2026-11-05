import { interviewFiles, interviewReferenceFiles, guidelineSourceVersions, guidelineSourceTitles } from './interview-files.mjs';
/** Server-only fixed local test target. Never import this module from client components. */
export const interviewConfig = {
  target: {
    university: "서울시립대학교",
    department: "융합응용화학과",
    admissionTrack: "학생부종합전형I (면접형)",
    track: "학생부종합전형I (면접형)",
    academicYear: 2027,
    year: 2027,
    studentName: "윤지우",
  },
  files: interviewFiles,
  referenceFiles: interviewReferenceFiles,
  guidelineSourceVersions,
  guidelineSourceTitles,
  // Preparation-only fallback. A started session uses the verified admission track duration.
  durationSeconds: 720,
  // Legacy count policy only. New objective-pool sessions stop by time and valid candidates.
  // Retained only for callers loading old sessions without a saved turn count or plan.
  mainQuestionCount: 4,
  mainQuestionSeconds: 150,
  maxFollowUps: 2,
  // Technical ceiling: existing low-core/review/repair/review/TTS + STT caps.
  // This is a conservative configurable default, not a measured latency SLA.
  turnWaitTimeoutMs: 95_000,
  // Same-model checkpoint evaluation: low preserved dialogue judgments while
  // reducing total turn time versus the duplicated v4 meaning-review chain.
  coreReasoningEffort: 'low' as 'none' | 'low',
  simulatedInterviewerCount: 2,
  rulesVersion: "interview-screen-v2-plan-v2-reaction-v3-startup-v2-sources-v3-premise-v1-answer-v2.3-context-v1-singlecore-v2-offline-v1-book-tone-v2-full-corpus-v1-target-first-strategies-v1-contract-v1-engine-v3-analysis-v1-pool-v2-runtime-v1-policy-v2",
} as const;

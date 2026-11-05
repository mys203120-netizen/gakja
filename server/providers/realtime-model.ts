/** Realtime selection is separate from the approved question bank's model. */
export function realtimeCoreModel(environment: Partial<NodeJS.ProcessEnv> = process.env) {
  return environment.OPENAI_REALTIME_MODEL?.trim() || environment.OPENAI_QUESTION_MODEL?.trim() || 'gpt-6-luna';
}

/** This provider checks factual support; it never chooses coverage or C/F. */
export function runtimeFactReviewModel(environment: Partial<NodeJS.ProcessEnv> = process.env) {
  return environment.OPENAI_REVIEW_MODEL?.trim() || environment.OPENAI_QUESTION_MODEL?.trim() || 'gpt-6-luna';
}

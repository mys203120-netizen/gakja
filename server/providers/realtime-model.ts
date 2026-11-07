import { pinnedProviderModels } from './provider-model-context';
/** Realtime selection is separate from the approved question bank's model. */
export function realtimeCoreModel(environment: Partial<NodeJS.ProcessEnv> = process.env) {
  return (environment===process.env?pinnedProviderModels()?.realtime:undefined) || environment.OPENAI_REALTIME_MODEL?.trim() || environment.OPENAI_QUESTION_MODEL?.trim() || 'gpt-6-luna';
}

/** This provider checks factual support; it never chooses coverage or C/F. */
export function runtimeFactReviewModel(environment: Partial<NodeJS.ProcessEnv> = process.env) {
  return (environment===process.env?pinnedProviderModels()?.review:undefined) || environment.OPENAI_REVIEW_MODEL?.trim() || environment.OPENAI_QUESTION_MODEL?.trim() || 'gpt-6-luna';
}

export function questionGenerationModel(environment:Partial<NodeJS.ProcessEnv>=process.env){return (environment===process.env?pinnedProviderModels()?.question:undefined)||environment.OPENAI_QUESTION_MODEL||'gpt-6-luna';}

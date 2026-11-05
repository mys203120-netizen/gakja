/** Local preflight bounds, not a model tokenizer. Provider usage is the
 * authority for actual input/output/cached token counts. One visible UTF-8
 * byte can require at most one byte-level token; hidden message framing is
 * reserved separately. This deliberately does not call a counting API on
 * the realtime path or confuse JavaScript character counts with tokens. */
export interface RequestBudgetInput {
  instructions: string;
  input: string;
  schema?: unknown;
  maxOutputTokens: number;
}

export interface RequestTokenBudgetMeasurement {
  version: 'visible-request-byte-bound-v1';
  method: 'utf8_upper_bound_not_exact_token_count';
  exactInputTokens: null;
  blocks: Record<'instructions' | 'input' | 'schema', { characters: number; utf8Bytes: number }>;
  totalVisibleCharacters: number;
  totalVisibleInputBytes: number;
  conservativeVisibleInputTokenUpperBound: number;
  maxOutputTokens: number;
}

export function measureRequestTokenBudget(request: RequestBudgetInput): RequestTokenBudgetMeasurement {
  const texts = { instructions: request.instructions, input: request.input, schema: request.schema === undefined ? '' : JSON.stringify(request.schema) };
  const blocks = Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, { characters: value.length, utf8Bytes: Buffer.byteLength(value, 'utf8') }])) as RequestTokenBudgetMeasurement['blocks'];
  const totalVisibleCharacters = Object.values(blocks).reduce((sum, block) => sum + block.characters, 0);
  const totalVisibleInputBytes = Object.values(blocks).reduce((sum, block) => sum + block.utf8Bytes, 0);
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new Error('REQUEST_OUTPUT_BUDGET_INVALID');
  return { version: 'visible-request-byte-bound-v1', method: 'utf8_upper_bound_not_exact_token_count', exactInputTokens: null,
    blocks, totalVisibleCharacters, totalVisibleInputBytes, conservativeVisibleInputTokenUpperBound: totalVisibleInputBytes, maxOutputTokens: request.maxOutputTokens };
}

export function assertRequestTokenBudget(measurement: RequestTokenBudgetMeasurement, limits: {
  maxVisibleInputBytes: number;
  contextWindowTokens?: number;
  framingReserveTokens?: number;
}) {
  const framing = limits.framingReserveTokens ?? 2048;
  if (![limits.maxVisibleInputBytes, framing].every(value => Number.isSafeInteger(value) && value >= 0) || limits.maxVisibleInputBytes < 1) throw new Error('REQUEST_INPUT_BUDGET_INVALID');
  if (measurement.totalVisibleInputBytes > limits.maxVisibleInputBytes) throw new Error('REQUEST_VISIBLE_INPUT_BUDGET_EXCEEDED');
  if (limits.contextWindowTokens !== undefined && (!Number.isSafeInteger(limits.contextWindowTokens) || limits.contextWindowTokens < 1 ||
    measurement.conservativeVisibleInputTokenUpperBound + measurement.maxOutputTokens + framing > limits.contextWindowTokens)) throw new Error('REQUEST_CONTEXT_BUDGET_EXCEEDED');
  return measurement;
}

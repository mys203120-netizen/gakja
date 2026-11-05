/** User-supplied tariff snapshot. These are scenarios, never reconciled invoices. */
export const SPEECH_USER_PROVIDED_PRICE_SNAPSHOT = Object.freeze({
  id: 'clova-speech-streaming-basic-user-2026-11-03',
  asOf: '2026-11-03', source: 'user' as const, currency: 'KRW' as const,
  durationUnitMs: 15_000, krwPerDurationUnit: 5,
});
export const VOICE_USER_PROVIDED_PRICE_SNAPSHOT = Object.freeze({
  id: 'clova-voice-premium-user-2026-11-03',
  asOf: '2026-11-03', source: 'user' as const, currency: 'KRW' as const,
  monthlyBasePerApplicationKrw: 90_000, includedCharactersPerApplication: 1_000_000,
  overageCharacterUnit: 1_000, krwPerOverageUnit: 100,
});
const commonAssumptions = [
  'Tariff supplied by the user on 2026-11-03; provider invoice, discounts, tax and currency conversion are not reconciled.',
  'No storage, network, hosting, OpenAI, offline analysis or other service charges are included.',
];
const money = (value: number) => Number(value.toFixed(8));
function validCount(value: number, name: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new RangeError(`${name} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
}
function validDuration(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new RangeError('durationMs must be finite and nonnegative');
}

/** Each array entry is a separately opened/billed stream, not a VAD speech segment. */
export function speechCost(durationMs: readonly (number | null)[] | null) {
  const price = SPEECH_USER_PROVIDED_PRICE_SNAPSHOT;
  const measured = (durationMs ?? []).filter((duration): duration is number => duration !== null);
  measured.forEach(validDuration);
  const knownDuration = measured.reduce((sum, duration) => sum + duration, 0);
  const knownProrated = money(knownDuration / price.durationUnitMs * price.krwPerDurationUnit);
  const knownRounded = measured.reduce((sum, duration) => sum + Math.ceil(duration / price.durationUnitMs) * price.krwPerDurationUnit, 0);
  const complete = durationMs !== null && measured.length === durationMs.length;
  return {
    basis: 'user-provided-tariff-scenario' as const, invoiceVerified: false as const, currency: 'KRW' as const,
    pricingSnapshot: price.id, roundingVerified: false as const,
    streams: durationMs?.length ?? null, measuredStreams: measured.length,
    unmeasuredStreams: durationMs === null ? null : durationMs.length - measured.length,
    capturedDurationMs: complete ? knownDuration : null, knownCapturedDurationMs: knownDuration,
    proratedKrw: complete ? knownProrated : null,
    perStream15SecondRoundedKrw: complete ? knownRounded : null,
    knownProratedSubtotalKrw: knownProrated, knownRoundedSubtotalKrw: knownRounded,
    assumptions: [...commonAssumptions,
      'Both duration-proportional and per-stream 15-second ceiling scenarios are shown; actual billing rounding/minimum-duration terms are unverified.',
      'Use captured/transmitted stream duration, including transmitted silence; not answer word count, VAD speech duration or wall-clock session duration.',
      'An empty array explicitly means no new streams. Missing durations stay unknown rather than becoming zero.',
    ],
  };
}

export interface VoiceMonthlyCostEstimate {
  basis: 'user-provided-tariff-scenario'; invoiceVerified: false; currency: 'KRW'; pricingSnapshot: string;
  distribution: 'single-application' | 'per-application' | 'aggregate-only';
  applicationCount: number; newSynthesisCharacters: number | null; monthlyFixedKrw: number;
  monthlyProratedKrw: number | null; monthly1000CharacterRoundedKrw: number | null;
  proratedRangeKrw: { minimum: number; maximum: number | null };
  roundingVerified: false; assumptions: string[];
}
function voiceResult(applicationCount: number, characters: number | null, distribution: VoiceMonthlyCostEstimate['distribution']): VoiceMonthlyCostEstimate {
  const price = VOICE_USER_PROVIDED_PRICE_SNAPSHOT;
  return {
    basis: 'user-provided-tariff-scenario', invoiceVerified: false, currency: 'KRW', pricingSnapshot: price.id,
    applicationCount, newSynthesisCharacters: characters, distribution,
    monthlyFixedKrw: applicationCount * price.monthlyBasePerApplicationKrw,
    monthlyProratedKrw: null, monthly1000CharacterRoundedKrw: null,
    proratedRangeKrw: { minimum: applicationCount * price.monthlyBasePerApplicationKrw, maximum: null },
    roundingVerified: false,
    assumptions: [...commonAssumptions,
      'Included characters belong to each application; allowances are not assumed pooled across applications.',
      'Count only new synthesis requests in this billing month; an audio cache read adds zero synthesis characters but does not remove the monthly application fee.',
      'Character counts must follow provider billing rules. Both proportional overage and 1,000-character ceiling scenarios are shown where distribution is known; rounding terms are unverified.',
      'A complete-month application fee is assumed; activation/proration, retries and failed-request charging require invoice verification.',
    ],
  };
}
const voiceOverage = (characters: number) => Math.max(0, characters - VOICE_USER_PROVIDED_PRICE_SNAPSHOT.includedCharactersPerApplication);
const overagePrice = (characters: number) => characters / VOICE_USER_PROVIDED_PRICE_SNAPSHOT.overageCharacterUnit * VOICE_USER_PROVIDED_PRICE_SNAPSHOT.krwPerOverageUnit;

/** Preferred form: monthly new synthesis characters separately for each paid application. */
export function voiceMonthlyCostByApplication(newCharactersByApplication: readonly (number | null)[]): VoiceMonthlyCostEstimate {
  validCount(newCharactersByApplication.length, 'applicationCount', true);
  const known = newCharactersByApplication.filter((characters): characters is number => characters !== null);
  known.forEach(value => validCount(value, 'newSynthesisCharacters'));
  const complete = known.length === newCharactersByApplication.length;
  const totalCharacters = known.reduce((sum, value) => sum + value, 0);
  validCount(totalCharacters, 'totalNewSynthesisCharacters');
  const result = voiceResult(newCharactersByApplication.length, complete ? totalCharacters : null, newCharactersByApplication.length === 1 ? 'single-application' : 'per-application');
  const prorated = money(result.monthlyFixedKrw + known.reduce((sum, value) => sum + overagePrice(voiceOverage(value)), 0));
  const rounded = result.monthlyFixedKrw + known.reduce((sum, value) => sum + Math.ceil(voiceOverage(value) / VOICE_USER_PROVIDED_PRICE_SNAPSHOT.overageCharacterUnit) * VOICE_USER_PROVIDED_PRICE_SNAPSHOT.krwPerOverageUnit, 0);
  result.proratedRangeKrw = { minimum: prorated, maximum: complete ? prorated : null };
  if (complete) { result.monthlyProratedKrw = prorated; result.monthly1000CharacterRoundedKrw = rounded; }
  return result;
}

/** Aggregate-only multi-application usage returns a range if its distribution matters. */
export function voiceMonthlyCost(totalNewSynthesisCharacters: number | null, applicationCount = 1): VoiceMonthlyCostEstimate {
  validCount(applicationCount, 'applicationCount', true);
  if (applicationCount === 1) return voiceMonthlyCostByApplication([totalNewSynthesisCharacters]);
  if (totalNewSynthesisCharacters !== null) validCount(totalNewSynthesisCharacters, 'totalNewSynthesisCharacters');
  const result = voiceResult(applicationCount, totalNewSynthesisCharacters, 'aggregate-only');
  if (totalNewSynthesisCharacters === null) return result;
  const minimum = money(result.monthlyFixedKrw + overagePrice(Math.max(0, totalNewSynthesisCharacters - applicationCount * VOICE_USER_PROVIDED_PRICE_SNAPSHOT.includedCharactersPerApplication)));
  const maximum = money(result.monthlyFixedKrw + overagePrice(voiceOverage(totalNewSynthesisCharacters)));
  result.proratedRangeKrw = { minimum, maximum };
  if (minimum === maximum) {
    result.monthlyProratedKrw = minimum;
    // Equal bounds here mean the aggregate is within one application's allowance.
    result.monthly1000CharacterRoundedKrw = result.monthlyFixedKrw;
  }
  return result;
}

/** A monthly accounting allocation, not a fee invoiced for an individual interview. */
export function allocateVoiceMonthlyCost(monthly: VoiceMonthlyCostEstimate, sessionsPerMonth: number) {
  validCount(sessionsPerMonth, 'sessionsPerMonth', true);
  const fixed = monthly.monthlyFixedKrw / sessionsPerMonth;
  return {
    basis: 'monthly-fee-allocation' as const, invoiceVerified: false as const, currency: 'KRW' as const, sessionsPerMonth,
    fixedPerSessionKrw: money(fixed),
    proratedVariablePerSessionKrw: monthly.monthlyProratedKrw === null ? null : money((monthly.monthlyProratedKrw - monthly.monthlyFixedKrw) / sessionsPerMonth),
    proratedTotalPerSessionKrw: monthly.monthlyProratedKrw === null ? null : money(monthly.monthlyProratedKrw / sessionsPerMonth),
    roundedTotalPerSessionKrw: monthly.monthly1000CharacterRoundedKrw === null ? null : money(monthly.monthly1000CharacterRoundedKrw / sessionsPerMonth),
    proratedPerSessionRangeKrw: {
      minimum: money(monthly.proratedRangeKrw.minimum / sessionsPerMonth),
      maximum: monthly.proratedRangeKrw.maximum === null ? null : money(monthly.proratedRangeKrw.maximum / sessionsPerMonth),
    },
    assumption: 'Monthly fees are divided evenly across the supplied monthly interview count; this is not an exact per-interview provider charge.',
  };
}

export function speechCostScenario(sessionsPerMonth: number, newSynthesisCharactersPerSession: number, captureDurationMsPerSession: number) {
  validCount(sessionsPerMonth, 'sessionsPerMonth', true);
  validCount(newSynthesisCharactersPerSession, 'newSynthesisCharactersPerSession');
  validDuration(captureDurationMsPerSession);
  const voice = voiceMonthlyCost(sessionsPerMonth * newSynthesisCharactersPerSession);
  const allocation = allocateVoiceMonthlyCost(voice, sessionsPerMonth);
  const speech = speechCost([captureDurationMsPerSession]);
  return {
    sessionsPerMonth, newSynthesisCharactersPerSession, captureDurationMsPerSession,
    applicationCount: 1, capturedStreamsPerSession: 1, voice, allocation, speech,
    speechAndVoiceProratedPerSessionKrw: money(speech.proratedKrw! + allocation.proratedTotalPerSessionKrw!),
    speechAndVoiceRoundedPerSessionKrw: money(speech.perStream15SecondRoundedKrw! + allocation.roundedTotalPerSessionKrw!),
    invoiceVerified: false as const,
  };
}

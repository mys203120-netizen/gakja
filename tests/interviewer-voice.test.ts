import test from "node:test";
import assert from "node:assert/strict";
import { interviewerVoiceDefaults, resolveVoiceSettings, speechAudioCacheId, synthesizeSpeech } from "../server/providers/clova-tts";
import { SpeechAudioCache, type SpeechSynthesisOptions, type SpeechSynthesisTiming } from "../server/providers/speech-audio-cache";
import { assertInterviewQuestionSpeech } from "../server/providers/openai";
import { generateWithVerifiedGrounding, QuestionValidationError } from "../server/providers/question-grounding";
import type { QuestionDraft } from "../server/protocol";

test("interviewer defaults keep neutral Pro voices and lower pitch with separately tuned role speeds", () => {
  assert.equal(interviewerVoiceDefaults.primary, "vdaeseong");
  assert.equal(interviewerVoiceDefaults.secondary, "vmikyung");
  assert.deepEqual(resolveVoiceSettings(interviewerVoiceDefaults.primary, {}), { speaker: "vdaeseong", speed: 0, pitch: 1, volume: 0, format: "mp3" });
  assert.equal(resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SPEED: "", CLOVA_VOICE_PITCH: "" }).speed, -1);
});
test("role speed overrides take precedence while legacy common speed remains compatible", () => {
  const environment = { CLOVA_VOICE_SPEED: "3", CLOVA_VOICE_PRIMARY_SPEED: "0", CLOVA_VOICE_SECOND_SPEED: "-1" };
  assert.equal(resolveVoiceSettings("vdaeseong", environment).speed, 0);
  assert.equal(resolveVoiceSettings("vmikyung", environment).speed, -1);
  for (const speaker of ["vdaeseong", "vmikyung"]) assert.equal(resolveVoiceSettings(speaker, { CLOVA_VOICE_SPEED: "0" }).speed, 0);
  assert.equal(resolveVoiceSettings("vmikyung", { ...environment, CLOVA_VOICE_SECOND_SPEED: "  " }).speed, 3);
  assert.equal(resolveVoiceSettings("nara", environment).speed, 3);
});
test("roles follow configured speakers rather than a voice's gender or default name", () => {
  const environment = { CLOVA_VOICE_SPEAKER: "vmikyung", CLOVA_VOICE_SECOND_SPEAKER: "vdaeseong", CLOVA_VOICE_PRIMARY_SPEED: "1", CLOVA_VOICE_SECOND_SPEED: "-2" };
  assert.equal(resolveVoiceSettings("vmikyung", environment).speed, 1);
  assert.equal(resolveVoiceSettings("vdaeseong", environment).speed, -2);
  assert.equal(resolveVoiceSettings("nara", environment, { role: "secondary" }).speed, -2);
});
test("explicit roles distinguish the same speaker and speed changes invalidate its actual audio cache", () => {
  const environment = { CLOVA_VOICE_SPEAKER: "vdaeseong", CLOVA_VOICE_SECOND_SPEAKER: "vdaeseong", CLOVA_VOICE_SPEED: "0", CLOVA_VOICE_PRIMARY_SPEED: "1", CLOVA_VOICE_SECOND_SPEED: "-1" };
  const primary = resolveVoiceSettings("vdaeseong", environment, { role: "primary" });
  const secondary = resolveVoiceSettings("vdaeseong", environment, { role: "secondary" });
  assert.equal(primary.speed, 1); assert.equal(secondary.speed, -1);
  assert.equal(resolveVoiceSettings("vdaeseong", environment).speed, 0);
  assert.notEqual(speechAudioCacheId("판단 기준은 무엇인가요?", primary), speechAudioCacheId("판단 기준은 무엇인가요?", secondary));
  assert.equal(speechAudioCacheId("판단 기준은 무엇인가요?", { ...primary, speed: -1 }), speechAudioCacheId("판단 기준은 무엇인가요?", secondary));
});
test("role-specific invalid settings fail before any synthesis and identify the actual setting", () => {
  for (const value of ["11", "-6", "0.5", "unknown"]) {
    assert.throws(() => resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SECOND_SPEED: value }), /CLOVA_VOICE_SECOND_SPEED/u);
    assert.throws(() => resolveVoiceSettings("vdaeseong", { CLOVA_VOICE_PRIMARY_SPEED: value }), /CLOVA_VOICE_PRIMARY_SPEED/u);
  }
});
test("synthesis timing exposes only resolved non-secret voice settings for each explicit role", async t => {
  const keys = ["CLOVA_VOICE_PRIMARY_SPEED", "CLOVA_VOICE_SECOND_SPEED", "CLOVA_VOICE_PITCH"];
  const backup = keys.map(key => [key, process.env[key]] as const);
  process.env.CLOVA_VOICE_PRIMARY_SPEED = "0"; process.env.CLOVA_VOICE_SECOND_SPEED = "-1"; process.env.CLOVA_VOICE_PITCH = "1";
  const events: SpeechSynthesisTiming[] = [];
  t.mock.method(SpeechAudioCache.prototype, "getOrCreate", async (id: string, _load: () => Promise<Buffer>, options: SpeechSynthesisOptions = {}) => {
    options.onTiming?.({ cache: "memory", durationMs: 0, providerMs: null, audioId: id });
    return `/api/audio/${id}`;
  });
  try {
    await synthesizeSpeech("판단 기준은 무엇인가요?", "vdaeseong", { role: "primary", onTiming: event => { events.push(event); } });
    await synthesizeSpeech("판단 기준은 무엇인가요?", "vmikyung", { role: "secondary", onTiming: event => { events.push(event); } });
    assert.equal(events[0].settings?.speed, 0); assert.equal(events[1].settings?.speed, -1);
    assert.deepEqual(Object.keys(events[1].settings ?? {}).sort(), ["format", "pitch", "speaker", "speed", "volume"]);
    assert.equal(JSON.stringify(events).includes("CLIENT_SECRET"), false);
    assert.equal(events[1].audioId, speechAudioCacheId("판단 기준은 무엇인가요?", events[1].settings!));
  } finally { for (const [key, value] of backup) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("supported speed and pitch are mapped directly without reversing CLOVA's positive direction", () => {
  assert.equal(resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SPEED: "2", CLOVA_VOICE_PITCH: "3" }).speed, 2);
  assert.equal(resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SPEED: "2", CLOVA_VOICE_PITCH: "3" }).pitch, 3);
  assert.equal(resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SPEED: "0", CLOVA_VOICE_PITCH: "0" }).speed, 0);
  assert.throws(() => resolveVoiceSettings("vmikyung", { CLOVA_VOICE_SPEED: "11" }));
  assert.throws(() => resolveVoiceSettings("vmikyung", { CLOVA_VOICE_PITCH: "-6" }));
  assert.throws(() => resolveVoiceSettings("vmikyung", { CLOVA_VOICE_PITCH: "0.5" }));
});
test("voice, speed, pitch and volume changes invalidate the cached audio", () => {
  const settings = resolveVoiceSettings("vdaeseong", {});
  const original = speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", settings);
  assert.notEqual(original, speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", { ...settings, speaker: "vmikyung" }));
  assert.notEqual(original, speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", { ...settings, speed: 1 }));
  assert.notEqual(original, speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", { ...settings, pitch: 0 }));
  assert.notEqual(original, speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", { ...settings, volume: 1 }));
  assert.equal(original, speechAudioCacheId("탐구 과정에서 어떤 기준을 세웠나요?", { format: "mp3", volume: 0, pitch: 1, speed: 0, speaker: "vdaeseong" }));
});
test("first-question progress announcements are rejected, including whitespace variants", () => {
  for (const text of [
    "안녕하세요. 학생부에 기록된 활동부터 질문드리겠습니다. 비교 조건을 어떻게 정했나요?",
    "우선 학생부 활동부터 질문을 시작하겠습니다. 어떤 기준을 세웠나요?",
    "안녕하세요. 지금부터 면접을 시작하겠습니다. 탐구 목적은 무엇인가요?",
    "학생부 활동부터 질문을\n드리겠습니다. 조건을 어떻게 비교했나요?",
    "지원동기를 여쭤볼게요. 지원한 이유는 무엇인가요?",
  ]) assert.throws(() => assertInterviewQuestionSpeech(text), error => error instanceof QuestionValidationError && error.code === "FORBIDDEN_SPEECH");
});
test("a brief greeting followed by a concrete grounded question stays intact", () => {
  for (const text of [
    "안녕하세요. 흡광도를 측정할 때 비교 조건은 어떻게 정했나요?",
    "이온의 이동성을 비교하면서 가장 중요하게 본 조건은 무엇인가요?",
    "학생부에 기록된 실험에서 변수 하나를 바꾼 이유는 무엇인가요?",
  ]) assert.doesNotThrow(() => assertInterviewQuestionSpeech(text));
});
test("announcement rejection uses the bounded generation retry without rewriting the question after validation", async () => {
  const evidence = { id: "TEST-E01", text: "비교 조건을 정하고 흡광도를 측정함." };
  const makeDraft = (questionText: string): QuestionDraft => ({
    acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: "main", parentMainQuestionId: null,
    evidenceIds: [evidence.id], evidenceQuotes: [{ evidenceId: evidence.id, quote: evidence.text }],
    primaryFunction: "CHOICE", questionIntent: "비교 조건의 선택 근거 확인", targetEvidence: ["조건을 선택한 기준"], depth: "D2",
    groundingRationale: "기록된 비교 조건에 대한 질문", validationStatus: "approved", validationFailures: [],
  });
  let calls = 0;
  const directQuestion = "안녕하세요. 흡광도를 측정할 때 비교 조건은 어떻게 정했나요?";
  const result = await generateWithVerifiedGrounding({
    sources: [evidence],
    requestDraft: async request => { calls++; return makeDraft(request.attempt === 1 ? "학생부에 기록된 활동부터 질문드리겠습니다. 비교 조건은 어떻게 정했나요?" : directQuestion); },
    validateDraft: draft => assertInterviewQuestionSpeech(draft.questionText),
  });
  assert.equal(calls, 2);
  assert.equal(result.questionText, directQuestion);
  assert.equal(result.evidenceQuotes[0].quote, evidence.text);
});

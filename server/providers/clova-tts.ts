import { createHash } from "node:crypto";
import path from "node:path";
import { SpeechAudioCache, type SpeechSynthesisOptions, type SpeechSynthesisSettings, type SpeechRole } from "./speech-audio-cache";
export type { SpeechSynthesisOptions, SpeechSynthesisTiming, SpeechRole } from "./speech-audio-cache";

const TTS_URL = "https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts";
const directory = path.join(process.cwd(), "data", "audio");
const cache = new SpeechAudioCache(directory);
export const interviewerVoiceDefaults = { primary: "vdaeseong", secondary: "vmikyung", speed: 0, primarySpeed: 0, secondarySpeed: -1, pitch: 1 } as const;

export type VoiceSettings = SpeechSynthesisSettings;

function voiceRole(speaker: string, environment: Record<string, string | undefined>, explicit?: SpeechRole): SpeechRole | undefined {
  if (explicit) return explicit;
  const primary = environment.CLOVA_VOICE_SPEAKER?.trim() || interviewerVoiceDefaults.primary;
  const secondary = environment.CLOVA_VOICE_SECOND_SPEAKER?.trim() || interviewerVoiceDefaults.secondary;
  // A shared speaker alone cannot identify the current role. Keep the legacy/common setting in that case.
  if (speaker === primary && speaker !== secondary) return "primary";
  if (speaker === secondary && speaker !== primary) return "secondary";
  return undefined;
}

export function resolveVoiceSettings(speaker: string, environment: Record<string, string | undefined> = process.env, options: Pick<SpeechSynthesisOptions, "role"> = {}): VoiceSettings {
  if (!/^[a-z0-9_-]+$/i.test(speaker)) throw new Error("CLOVA_VOICE_SPEAKER 값이 유효하지 않습니다.");
  const role = voiceRole(speaker, environment, options.role);
  const roleSpeedKey = role === "primary" ? "CLOVA_VOICE_PRIMARY_SPEED" : role === "secondary" ? "CLOVA_VOICE_SECOND_SPEED" : null;
  const roleSpeed = roleSpeedKey ? environment[roleSpeedKey]?.trim() : undefined;
  const commonSpeed = environment.CLOVA_VOICE_SPEED?.trim();
  const defaultSpeed = role === "secondary" ? interviewerVoiceDefaults.secondarySpeed : interviewerVoiceDefaults.primarySpeed;
  const speed = Number(roleSpeed || commonSpeed || defaultSpeed);
  const pitch = Number(environment.CLOVA_VOICE_PITCH?.trim() || interviewerVoiceDefaults.pitch);
  if (!Number.isInteger(speed) || speed < -5 || speed > 10) throw new Error(`${roleSpeed && roleSpeedKey ? roleSpeedKey : "CLOVA_VOICE_SPEED"}는 -5~10 정수여야 합니다.`);
  if (!Number.isInteger(pitch) || pitch < -5 || pitch > 5) throw new Error("CLOVA_VOICE_PITCH는 -5~5 정수여야 합니다.");
  return { speaker, speed, pitch, volume: 0, format: "mp3" };
}

export function speechAudioCacheId(text: string, settings: VoiceSettings) {
  return createHash("sha256").update(JSON.stringify({ version: 2, text, speaker: settings.speaker, speed: settings.speed, pitch: settings.pitch, volume: settings.volume, format: settings.format })).digest("hex");
}

export async function synthesizeSpeech(text: string, speaker: string, options: SpeechSynthesisOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (!text.trim()) throw new Error("빈 문장의 음성을 만들 수 없습니다.");
  const settings = options.settings ? { ...options.settings } : resolveVoiceSettings(speaker, process.env, options);
  if (settings.speaker !== speaker || !/^[a-z0-9_-]+$/i.test(settings.speaker) || !Number.isInteger(settings.speed) || settings.speed < -5 || settings.speed > 10 || !Number.isInteger(settings.pitch) || settings.pitch < -5 || settings.pitch > 5 || !Number.isInteger(settings.volume) || settings.volume < -5 || settings.volume > 5 || settings.format !== 'mp3') throw new Error('저장된 면접관 음성 설정을 확인하지 못했습니다.');
  const id = speechAudioCacheId(text, settings);
  return cache.getOrCreate(id, async producerSignal => {
    const requestSignal = AbortSignal.any([producerSignal, AbortSignal.timeout(35_000)]);
    requestSignal.throwIfAborted();
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: { "X-NCP-APIGW-API-KEY-ID": process.env.CLOVA_VOICE_CLIENT_ID ?? "", "X-NCP-APIGW-API-KEY": process.env.CLOVA_VOICE_CLIENT_SECRET ?? "", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ speaker: settings.speaker, text, format: settings.format, volume: String(settings.volume), speed: String(settings.speed), pitch: String(settings.pitch) }),
      signal: requestSignal,
    });
    requestSignal.throwIfAborted();
    if (!response.ok) throw new Error(`CLOVA Voice ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    requestSignal.throwIfAborted();
    if (!bytes.length || !(response.headers.get("content-type") ?? "").includes("audio")) throw new Error("CLOVA Voice가 유효한 음성 파일을 반환하지 않았습니다.");
    return bytes;
  }, { signal: options.signal, onTiming: timing => options.onTiming?.({ ...timing, settings: { ...settings } }) });
}

export async function readSpeechAudio(id: string) {
  return cache.read(id);
}
/** Offline publication only; does not change the real-time playback path. */
export async function readDurableSpeechAudio(id: string) {
  return cache.readDurable(id);
}

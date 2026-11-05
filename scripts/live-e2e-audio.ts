import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = path.join(root, '.local', 'e2e-audio-runtime');
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
let executable: Promise<string> | undefined;

/** Test-only local tools. Never sends the audio to another decoding service. */
function run(binary: string, args: string[], input?: Buffer, maxBytes = MAX_AUDIO_BYTES) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks, bytes));
    };
    const timer = setTimeout(() => finish(new Error('SYNTHETIC_AUDIO_TOOL_TIMEOUT')), 30_000);
    child.once('error', () => finish(new Error('SYNTHETIC_AUDIO_TOOL_UNAVAILABLE')));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) finish(new Error('SYNTHETIC_AUDIO_OUTPUT_TOO_LARGE'));
      else chunks.push(chunk);
    });
    // Decoder stderr can contain arbitrary embedded metadata; keep it out of logs.
    child.stderr.resume();
    child.stdin.on('error', () => { /* Exit status owns decoder input failures. */ });
    child.once('close', code => finish(code === 0 ? undefined : new Error('SYNTHETIC_AUDIO_TOOL_FAILED')));
    child.stdin.end(input);
  });
}

async function ffmpegExecutable() {
  executable ??= (async () => {
    const script = 'import sys; sys.path.insert(0, sys.argv[1]); import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())';
    const resolved = (await run('python', ['-c', script, runtime], undefined, 16_384)).toString('utf8').trim();
    const relative = path.relative(runtime, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SYNTHETIC_AUDIO_TOOL_PATH_INVALID');
    await access(resolved);
    return resolved;
  })();
  return executable;
}

/** Decode real cached MP3 bytes into the exact PCM transport used by the app.
 * Duration measures decoded audio samples, not VAD speech or browser playback.
 */
export async function decodeSyntheticAudio(mp3Buffer: Buffer): Promise<{ pcm: Buffer; durationMs: number }> {
  if (!Buffer.isBuffer(mp3Buffer) || mp3Buffer.length === 0 || mp3Buffer.length > MAX_AUDIO_BYTES) throw new Error('SYNTHETIC_AUDIO_INPUT_INVALID');
  const pcm = await run(await ffmpegExecutable(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'], mp3Buffer);
  if (!pcm.length || pcm.length % 2) throw new Error('SYNTHETIC_AUDIO_PCM_INVALID');
  return { pcm, durationMs: pcm.length / PCM_BYTES_PER_SECOND * 1000 };
}

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/** Exercise actual hook callbacks with stable refs; this fixture does not model React rendering or native permissions. */
const compiled = build({ entryPoints: [fileURLToPath(new URL("../hooks/useAudioDevices.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent", plugins: [{ name: "deterministic-hook-callbacks", setup(builder) {
  builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "hook-fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "hook-fixture" }, () => ({ contents: "exports.useRef=value=>({current:value});exports.useState=value=>[typeof value==='function'?value():value,()=>{}];exports.useCallback=callback=>callback;exports.useEffect=()=>{};", loader: "js" }));
} }] }).then(result => result.outputFiles[0].text);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settleNativeResponse = () => new Promise<void>(resolve => setImmediate(resolve));
function stream() { const track = { readyState: "live", stops: 0, stop() { this.readyState = "ended"; this.stops++; }, addEventListener() {} }; return { track, getTracks: () => [track], getVideoTracks: () => [track] }; }
async function hook(getUserMedia: (constraints: unknown) => Promise<unknown>, enumerateDevices = async (): Promise<unknown[]> => []) {
  const cameraModule = { exports: {} as { useAudioDevices: () => { requestCamera(): Promise<unknown>; disableCamera(): void } } };
  vm.runInNewContext(await compiled, { module: cameraModule, exports: cameraModule.exports, navigator: { mediaDevices: { getUserMedia, enumerateDevices } }, console, DOMException, AbortController, setTimeout, clearTimeout });
  return cameraModule.exports.useAudioDevices();
}

test("camera opt-out invalidates a pending native request and stops its late stream", async () => {
  const pending = deferred<ReturnType<typeof stream>>(), acquired = stream();
  const media = await hook(async constraints => { assert.deepEqual(JSON.parse(JSON.stringify(constraints)).audio, false); return pending.promise; });
  const request = media.requestCamera(), rejected = assert.rejects(request); media.disableCamera(); pending.resolve(acquired);
  await rejected; await settleNativeResponse(); assert.equal(acquired.track.readyState, "ended");
  assert.equal(acquired.track.stops, 1);
});

test("a late permission response after opt-out cannot replace or stop a newer explicit camera request", async () => {
  const old = deferred<ReturnType<typeof stream>>(), first = stream(), second = stream(); let calls = 0;
  const media = await hook(async () => ++calls === 1 ? old.promise : second);
  const stale = media.requestCamera(), rejected = assert.rejects(stale); media.disableCamera(); await media.requestCamera(); old.resolve(first);
  await rejected; await settleNativeResponse(); assert.equal(first.track.readyState, "ended"); assert.equal(second.track.stops, 0);
  media.disableCamera(); assert.equal(second.track.readyState, "ended");
});

test("pending enumeration does not block actual camera acquisition or revive its preview after opt-out", async () => {
  const enumeration = deferred<unknown[]>(), started = deferred<boolean>(), acquired = stream();
  const media = await hook(async () => acquired, () => { started.resolve(true); return enumeration.promise; });
  const request = media.requestCamera(); await started.promise;
  // Enumeration is informational: the acquired live track can become ready
  // before its device list responds, and opt-out still stops it immediately.
  assert.equal(await request, acquired); assert.equal(acquired.track.readyState, 'live');
  media.disableCamera(); assert.equal(acquired.track.readyState, 'ended');
  enumeration.resolve([]); await settleNativeResponse();
  assert.equal(acquired.track.readyState, 'ended'); assert.equal(acquired.track.stops, 1);
});

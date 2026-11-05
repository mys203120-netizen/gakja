# G1 native browser diagnostic

Run `node tests/browser/g1-native-browser.mjs` from the repository root on Windows with Chrome installed. Optionally set `G1_CHROME_EXECUTABLE` to an installed Chromium executable. `--quick` exercises setup and the flow but **does not prove the 95-second boundary**.

The script uses installed `esbuild` and `ws`, creates its own localhost HTTP/WebSocket fixture server, launches real headless Chrome with a fresh profile under ignored `artifacts/browser-g1/`, and closes only its own browser/server. No `.env` file, user browser profile, external provider, or API credential is loaded. Browser network requests are restricted to the fixture origin and local data/blob URLs.

The production `InterviewShell`, session/audio hooks, styles, fullscreen handling, AudioContext, AudioWorklet microphone pipeline, media playback and local-storage recovery run in the browser. An observation wrapper records hook state and native media events without replacing hook behavior. This is a client diagnostic host, not the Next server/router or production realtime server.

The backend, source records, finalized transcript, question WAV tones and browser microphone are synthetic. The camera is explicitly skipped. This does not verify physical microphone/speaker behavior, real STT/TTS/LLM providers, Live2D rendering quality, authenticated production persistence, or deployment behavior.

The full run holds `/next`, exits native fullscreen to pause, releases the next question, checks real elapsed 94/95/96-second boundaries, then verifies a deliberately failed local audio fetch can retry the same question with one `/next`. It reloads after accepting Chrome's native before-unload confirmation, restores the same session, closes the actual WebSocket and reconnects, and explicitly ends once.

Each run writes screenshots and `evidence.json` containing browser/version, source hashes, real timestamps, requests, WebSocket messages, native playback events, client-state snapshots, assertions and any failure. The report identifies quick runs separately from full boundary proof. Generated evidence and isolated Chrome profiles stay under `artifacts/` and should not be committed.

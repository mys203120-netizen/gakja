'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { summarizeVisionRecords } from '@/lib/interview/vision-metrics';
type Observation = { timestamp: number; phase: string; turnId: string | null; cameraEnabled: boolean; cameraRevision: number; faceDetected: boolean; gazeOff: boolean | null; qualityReason: string | null; inferenceMs: number; smileScore?: number | null; jawOpen?: number | null; mouthSmileLeft?: number | null; mouthSmileRight?: number | null; browDownLeft?: number | null; browDownRight?: number | null; yaw?: number | null; pitch?: number | null; episodeCount?: number; episodeStarted?: boolean };
type ModelDiagnostic = { stage: string; name: string; message: string };
const boundedDiagnostic = (error: { name?: unknown; message?: unknown }, stage: string): ModelDiagnostic => ({ stage: stage.slice(0, 48), name: String(error.name || 'Error').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 48), message: String(error.message || 'Vision initialization failed').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([?&](?:[^=\s]+)=)[^&\s]+/g, '$1[redacted]').slice(0, 280) });
export function useFaceMetrics(video: RefObject<HTMLVideoElement | null>, enabled: boolean, phase: string, turnId: string | null) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'calibrating' | 'calibrated' | 'unavailable'>('loading');
  const worker = useRef<Worker | null>(null), observations = useRef<Observation[]>([]);
  const records = useRef<Record<string, unknown>[]>([]), phaseRef = useRef(phase), turnRef = useRef(turnId);
  const enabledRef = useRef(enabled), ready = useRef(false), busy = useRef(false), intervalMs = useRef(150);
  const aggregateRef = useRef<() => void>(() => {}), lastAggregate = useRef(0);
  const cameraRevision = useRef(0), cameraIdentity = useRef<string | null>(null), calibrationReason = useRef('not_calibrated');
  const calibrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelDiagnostic = useRef<ModelDiagnostic | null>(null);
  const quality = useRef({ inferenceSamples: 0, droppedLateFrames: 0, rejectedPreviousCameraFrames: 0 });
  const timeline = useRef<{ at: number; phase: string; turnId: string | null; cameraEnabled: boolean; cameraRevision: number }[]>([]);
  phaseRef.current = phase; turnRef.current = turnId; enabledRef.current = enabled;
  useEffect(() => { timeline.current.push({ at: performance.now(), phase, turnId, cameraEnabled: enabled, cameraRevision: cameraRevision.current }); }, [enabled, phase, turnId]);
  useEffect(() => {
    let raf = 0, last = 0, closed = false;
    try {
      const w = new Worker('/face-metrics.worker.js'); worker.current = w;
      w.onmessage = ({ data }) => {
        if (closed) return;
        if (data.type === 'ready') { ready.current = true; modelDiagnostic.current = null; setStatus('ready'); }
        if (data.type === 'calibrated' && data.cameraRevision === cameraRevision.current) { if (calibrationTimer.current) clearTimeout(calibrationTimer.current); calibrationReason.current = 'calibrated'; setStatus('calibrated'); }
        if (data.type === 'error') { modelDiagnostic.current = boundedDiagnostic(data.diagnostic ?? {}, String(data.diagnostic?.stage ?? 'model_create')); calibrationReason.current = 'model_unavailable'; setStatus('unavailable'); ready.current = false; }
        if (data.type === 'observation') { busy.current = false; if (data.cameraRevision !== cameraRevision.current) { quality.current.rejectedPreviousCameraFrames++; return; } quality.current.inferenceSamples++; observations.current.push(data); if (data.inferenceMs > 100) intervalMs.current = Math.min(500, data.inferenceMs * 2); }
      };
      w.onerror = event => { modelDiagnostic.current = boundedDiagnostic({ name: 'WorkerError', message: event.message }, 'worker_runtime'); calibrationReason.current = 'worker_unavailable'; setStatus('unavailable'); ready.current = false; busy.current = false; };
      w.postMessage({ type: 'init' });
      const frame = async (timestamp: number) => {
        raf = requestAnimationFrame(frame);
        const element = video.current;
        const stream = element?.srcObject instanceof MediaStream ? element.srcObject : null;
        const identity = stream ? `${stream.id}:${stream.getVideoTracks()[0]?.id ?? ''}` : null;
        if (identity !== cameraIdentity.current) {
          cameraIdentity.current = identity; cameraRevision.current++;
          timeline.current.push({ at: timestamp, phase: phaseRef.current, turnId: turnRef.current, cameraEnabled: enabledRef.current, cameraRevision: cameraRevision.current });
          if (calibrationTimer.current) clearTimeout(calibrationTimer.current);
          if (ready.current) calibrationReason.current = identity ? 'camera_changed_requires_calibration' : 'camera_removed';
          w.postMessage({ type: 'reset_calibration', cameraRevision: cameraRevision.current });
          if (ready.current) setStatus('ready');
        }
        if (!enabledRef.current || !ready.current || busy.current || !element || element.readyState < 2 || timestamp - last < intervalMs.current) return;
        last = timestamp; busy.current = true;
        const capturedPhase = phaseRef.current, capturedTurn = turnRef.current, capturedEnabled = enabledRef.current;
        const capturedRevision = cameraRevision.current;
        try { const bitmap = await createImageBitmap(element, { resizeWidth: 480, resizeHeight: 270 }); if (closed || capturedRevision !== cameraRevision.current) { bitmap.close(); busy.current = false; return; } w.postMessage({ type: 'frame', timestamp, bitmap, phase: capturedPhase, turnId: capturedTurn, cameraEnabled: capturedEnabled, cameraRevision: capturedRevision }, [bitmap]); }
        catch { busy.current = false; }
      };
      raf = requestAnimationFrame(frame);
    } catch (error) { modelDiagnostic.current = boundedDiagnostic(error instanceof Error ? error : {}, 'worker_construct'); calibrationReason.current = 'worker_unavailable'; setStatus('unavailable'); }
    lastAggregate.current = performance.now();
    aggregateRef.current = () => {
      const samples = observations.current.splice(0), now = performance.now();
      const start = lastAggregate.current; lastAggregate.current = now;
      quality.current.droppedLateFrames += samples.filter(sample => sample.timestamp < start).length;
      const history = timeline.current;
      for (let h = 0; h < history.length; h++) {
        const entry = history[h], from = Math.max(start, entry.at), until = Math.min(now, history[h + 1]?.at ?? now);
        if (until <= from || entry.phase === 'idle' || entry.phase === 'completed') continue;
        const section = samples.filter(s => s.phase === entry.phase && s.turnId === entry.turnId && s.cameraEnabled === entry.cameraEnabled && s.cameraRevision === entry.cameraRevision && s.timestamp >= from && s.timestamp < until);
        const valid = section.filter(x => x.cameraEnabled && x.faceDetected), gaze = valid.filter(x => x.gazeOff !== null), off = gaze.filter(x => x.gazeOff);
        const average = (key: keyof Observation) => { const list = valid.map(x => x[key]).filter((x): x is number => typeof x === 'number'); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; };
        let gazeValidDurationMs = 0, gazeOffDurationMs = 0;
        section.forEach((s, i) => { const duration = Math.min(250, (section[i + 1]?.timestamp ?? until) - s.timestamp); if (s.cameraEnabled && s.gazeOff !== null && duration > 0) { gazeValidDurationMs += duration; if (s.gazeOff) gazeOffDurationMs += duration; } });
        records.current.push({ turnId: entry.turnId, phase: entry.phase, cameraRevision: entry.cameraRevision, startedAtMs: from, durationMs: until - from, faceDetected: valid.length > 0, validFrameCount: valid.length, gazeValidFrameCount: gaze.length, gazeOffFrameCount: off.length, gazeValidDurationMs, gazeOffDurationMs, gazeOff: gaze.length ? off.length > gaze.length / 2 : null, gazeEpisodeStarts: section.filter(x => x.episodeStarted).length, episodeCount: section.at(-1)?.episodeCount ?? null, smileValidFrameCount: valid.filter(x => typeof x.smileScore === 'number').length, browDownValidFrameCount: valid.filter(x => typeof x.browDownLeft === 'number' && typeof x.browDownRight === 'number').length, smileFrameCount: valid.filter(x => (x.smileScore ?? 0) >= .25).length, browDownFrameCount: valid.filter(x => Math.max(x.browDownLeft ?? 0, x.browDownRight ?? 0) >= .3).length, smileScore: average('smileScore'), jawOpen: average('jawOpen'), mouthSmileLeft: average('mouthSmileLeft'), mouthSmileRight: average('mouthSmileRight'), browDownLeft: average('browDownLeft'), browDownRight: average('browDownRight'), yaw: average('yaw'), pitch: average('pitch'), inferenceMs: section.length ? section.reduce((s, x) => s + x.inferenceMs, 0) / section.length : null, qualityReason: !entry.cameraEnabled ? 'camera_off' : section.at(-1)?.qualityReason ?? calibrationReason.current });
      }
      if (history.length) timeline.current = [history.at(-1)!];
    };
    const aggregate = setInterval(() => aggregateRef.current(), 500);
    return () => { closed = true; cancelAnimationFrame(raf); clearInterval(aggregate); if (calibrationTimer.current) clearTimeout(calibrationTimer.current); worker.current?.terminate(); worker.current = null; };
  }, [video]);
  const calibrate = useCallback(() => { if (ready.current) { if (calibrationTimer.current) clearTimeout(calibrationTimer.current); const revision = cameraRevision.current; setStatus('calibrating'); worker.current?.postMessage({ type: 'calibrate', cameraRevision: revision }); calibrationTimer.current = setTimeout(() => { if (revision === cameraRevision.current) { calibrationReason.current = 'calibration_timeout'; setStatus(current => current === 'calibrating' ? 'ready' : current); } }, 7000); } }, []);
  const snapshot = useCallback(() => {
    aggregateRef.current();
    return { version: 'webcam-observation-v1', method: 'webcam_gaze_deviation_estimate', calibration: status, calibrationReason: calibrationReason.current, modelDiagnostic: modelDiagnostic.current, cameraRevision: cameraRevision.current, baselineScope: 'current_camera_stream_only', quality: { ...quality.current, pendingInference: busy.current, inferenceIntervalMs: intervalMs.current }, thresholds: { smile: .25, browDown: .3, gazeMinEpisodeMs: 600 }, records: records.current, summary: summarizeVisionRecords(records.current) };
  }, [status]);
  const reset = useCallback(() => { records.current = []; observations.current = []; quality.current = { inferenceSamples: 0, droppedLateFrames: 0, rejectedPreviousCameraFrames: 0 }; lastAggregate.current = performance.now(); worker.current?.postMessage({ type: 'reset' }); }, []);
  return { status, calibrate, snapshot, reset };
}

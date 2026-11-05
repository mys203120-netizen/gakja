// The WASM loader sets ModuleFactory on the classic worker global scope.
// Importing its script as an ES module hides that factory from MediaPipe.
importScripts('/vendor/mediapipe/vision_bundle.js');
const { FaceLandmarker, FilesetResolver } = Vision;
let model, baseline = null, calibration = null, smoothed = null, off = false, offSince = null, episodeCount = 0;
let previousScope = '';
let calibrationRevision = 0;
let initializationStage = 'wasm_fileset';
const diagnostic = (error, stage) => ({
  stage,
  name: String(error?.name || 'Error').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 48),
  message: String(error?.message || 'Vision initialization failed').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([?&](?:[^=\s]+)=)[^&\s]+/g, '$1[redacted]').slice(0, 280),
});
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const eye = (landmarks, iris, a, b, top, bottom) => {
  const p = landmarks[iris], x1 = landmarks[a], x2 = landmarks[b];
  const width = Math.hypot(x2.x - x1.x, x2.y - x1.y);
  const height = Math.hypot(landmarks[top].x - landmarks[bottom].x, landmarks[top].y - landmarks[bottom].y);
  if (width < .015 || height < .002) return null;
  const dx = x2.x - x1.x, dy = x2.y - x1.y;
  return { x: ((p.x - x1.x) * dx + (p.y - x1.y) * dy) / (width * width), y: (p.y - (landmarks[top].y + landmarks[bottom].y) / 2) / height };
};
async function init() {
  initializationStage = 'wasm_fileset';
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  initializationStage = 'model_create';
  model = await FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: .6, minFacePresenceConfidence: .6, minTrackingConfidence: .6 });
  postMessage({ type: 'ready' });
}
onmessage = async ({ data }) => {
  if (data.type === 'init') { try { await init(); } catch (error) { postMessage({ type: 'error', reason: 'model_unavailable', diagnostic: diagnostic(error, initializationStage) }); } return; }
  if (data.type === 'calibrate') { baseline = null; calibration = []; calibrationRevision = data.cameraRevision; smoothed = null; off = false; offSince = null; return; }
  if (data.type === 'reset_calibration') { baseline = null; calibration = null; smoothed = null; off = false; offSince = null; calibrationRevision = data.cameraRevision; return; }
  if (data.type === 'reset') { smoothed = null; off = false; offSince = null; episodeCount = 0; return; }
  if (data.type !== 'frame') return;
  const started = performance.now();
  const scope = `${data.phase}:${data.turnId}`;
  if (scope !== previousScope) { off = false; offSince = null; smoothed = null; previousScope = scope; }
  const publish = value => postMessage({ ...value, phase: data.phase, turnId: data.turnId, cameraEnabled: data.cameraEnabled, cameraRevision: data.cameraRevision });
  try {
    const result = model.detectForVideo(data.bitmap, data.timestamp), landmarks = result.faceLandmarks[0];
    if (!landmarks || landmarks.length < 478) { publish({ type: 'observation', timestamp: data.timestamp, faceDetected: false, gazeOff: null, qualityReason: 'face_not_detected', inferenceMs: performance.now() - started }); return; }
    const shapes = Object.fromEntries((result.faceBlendshapes[0]?.categories || []).map(x => [x.categoryName, x.score]));
    const left = eye(landmarks, 473, 362, 263, 386, 374), right = eye(landmarks, 468, 33, 133, 159, 145);
    const blink = (shapes.eyeBlinkLeft || 0) > .45 || (shapes.eyeBlinkRight || 0) > .45;
    const matrix = result.facialTransformationMatrixes[0]?.data;
    const yaw = matrix ? Math.atan2(matrix[8], matrix[10]) * 180 / Math.PI : null;
    const pitch = matrix ? Math.atan2(-matrix[9], Math.hypot(matrix[8], matrix[10])) * 180 / Math.PI : null;
    let gaze = left && right && !blink ? { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, yaw: yaw ?? 0, pitch: pitch ?? 0 } : null;
    if (gaze && calibration && data.cameraRevision === calibrationRevision) {
      calibration.push(gaze);
      if (calibration.length >= 12) { baseline = { x: mean(calibration.map(x => x.x)), y: mean(calibration.map(x => x.y)), yaw: mean(calibration.map(x => x.yaw)), pitch: mean(calibration.map(x => x.pitch)) }; calibration = null; postMessage({ type: 'calibrated', cameraRevision: data.cameraRevision }); }
    }
    let gazeOff = null, episodeStarted = false;
    if (gaze && baseline) {
      smoothed = smoothed ? Object.fromEntries(Object.keys(gaze).map(k => [k, .65 * smoothed[k] + .35 * gaze[k]])) : gaze;
      const distance = Math.max(Math.abs(smoothed.x - baseline.x) / .18, Math.abs(smoothed.y - baseline.y) / .35, Math.abs(smoothed.yaw - baseline.yaw) / 22, Math.abs(smoothed.pitch - baseline.pitch) / 18);
      if (!off && distance > 1) { offSince ??= data.timestamp; if (data.timestamp - offSince >= 600) { off = true; episodeCount++; episodeStarted = true; } }
      else if (off && distance < .7) { off = false; offSince = null; }
      else if (!off && distance < 1) offSince = null;
      gazeOff = off;
    } else { offSince = null; off = false; }
    publish({ type: 'observation', timestamp: data.timestamp, faceDetected: true, gazeOff, yaw, pitch, episodeCount, episodeStarted, jawOpen: shapes.jawOpen ?? null, mouthSmileLeft: shapes.mouthSmileLeft ?? null, mouthSmileRight: shapes.mouthSmileRight ?? null, smileScore: shapes.mouthSmileLeft != null && shapes.mouthSmileRight != null ? (shapes.mouthSmileLeft + shapes.mouthSmileRight) / 2 : null, browDownLeft: shapes.browDownLeft ?? null, browDownRight: shapes.browDownRight ?? null, qualityReason: blink ? 'blink' : !gaze ? 'eye_occluded' : !baseline ? 'not_calibrated' : null, inferenceMs: performance.now() - started });
  } catch { publish({ type: 'observation', timestamp: data.timestamp, faceDetected: false, gazeOff: null, qualityReason: 'inference_error', inferenceMs: performance.now() - started }); }
  finally { data.bitmap.close(); }
};

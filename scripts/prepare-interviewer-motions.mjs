import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'live2d', 'production', 'motions');
const round = value => Math.round(value * 1_000_000) / 1_000_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mouth = id => /mouth|^Param[AIUEO]$/i.test(id);

// Proposed model parameter values, NOT measured rotation angles or exported model limits.
export const parameterPlan = {
  ParamAngleX: { min: -5, max: 5, default: 0, motionLimit: .5 },
  ParamAngleY: { min: -4, max: 4, default: 0, motionLimit: .4 },
  ParamAngleZ: { min: -3, max: 3, default: 0, motionLimit: .15 },
  ParamBodyAngleX: { min: -2, max: 2, default: 0, motionLimit: .12 },
  ParamBodyAngleY: { min: -2, max: 2, default: 0, motionLimit: .10 },
  ParamBodyAngleZ: { min: -2, max: 2, default: 0, motionLimit: .08 },
  ParamQuestionGesture: { min: 0, max: 1, default: 0, motionLimit: 0 },
  ParamBrowLY: { min: -1, max: 1, default: 0, expressionLimit: .08 },
  ParamBrowRY: { min: -1, max: 1, default: 0, expressionLimit: .08 },
  ParamBrowLAngle: { min: -1, max: 1, default: 0, expressionLimit: .08 },
  ParamBrowRAngle: { min: -1, max: 1, default: 0, expressionLimit: .08 },
  ParamEyeLSmile: { min: 0, max: 1, default: 0, expressionLimit: .08 },
  ParamEyeRSmile: { min: 0, max: 1, default: 0, expressionLimit: .08 },
};
const motionIds = Object.keys(parameterPlan).filter(id => parameterPlan[id].motionLimit !== undefined);
const expressionIds = Object.keys(parameterPlan).filter(id => parameterPlan[id].expressionLimit !== undefined);
const motionNames = ['Greeting', 'QuestionStart', 'Listening', 'SmallNod', 'ReturnToNeutral', 'Closing'];
const expressionNames = ['Neutral', 'SoftSmile', 'Attentive'];
const speakers = [
  { id: 'interviewer-1', amplitude: 1, side: 1, durations: [3.2, 2.4, 8.2, 2.6, 1.4, 3.4] },
  { id: 'interviewer-2', amplitude: .88, side: -1, durations: [3.45, 2.65, 9.1, 2.8, 1.6, 3.7] },
];

/** A restricted cubic segment has time handles at 1/3 and 2/3; flat value
 * handles ease in/out without overshoot. The numbers are our original motion,
 * not curves copied from a sample character. */
function curve(id, points) {
  const segments = [...points[0]];
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1], [t1, v1] = points[i], dt = t1 - t0;
    segments.push(1, round(t0 + dt / 3), v0, round(t0 + 2 * dt / 3), v1, t1, v1);
  }
  return { Target: 'Parameter', Id: id, Segments: segments };
}

function buildMotion(name, speaker, duration) {
  const { amplitude: a, side } = speaker;
  const paths = {};
  const put = (id, points) => { paths[id] = points.map(([fraction, value]) => [round(fraction * duration), round(value * a)]); };
  // All paths start/end neutral and contain long holds. Hand gesture is always zero.
  if (name === 'Greeting') {
    put('ParamAngleY', [[0, 0], [.13, 0], [.34, -.32], [.58, 0], [1, 0]]);
    put('ParamAngleX', [[0, 0], [.22, 0], [.56, .17 * side], [.83, 0], [1, 0]]);
    put('ParamBodyAngleY', [[0, 0], [.14, 0], [.37, -.045], [.65, 0], [1, 0]]);
  } else if (name === 'QuestionStart') {
    put('ParamAngleX', [[0, 0], [.15, 0], [.43, .28 * side], [.77, 0], [1, 0]]);
    put('ParamAngleY', [[0, 0], [.19, 0], [.46, .12], [.76, 0], [1, 0]]);
    put('ParamAngleZ', [[0, 0], [.20, 0], [.48, .055 * side], [.78, 0], [1, 0]]);
    put('ParamBodyAngleX', [[0, 0], [.20, 0], [.48, .055 * side], [.80, 0], [1, 0]]);
  } else if (name === 'Listening') {
    // No head movement: this is not an approval nod loop.
    put('ParamBodyAngleX', [[0, 0], [.25, 0], [.48, .022 * side], [.79, 0], [1, 0]]);
    put('ParamBodyAngleY', [[0, 0], [.32, 0], [.56, .014], [.86, 0], [1, 0]]);
  } else if (name === 'SmallNod') {
    put('ParamAngleY', [[0, 0], [.18, 0], [.40, -.30], [.70, 0], [1, 0]]);
    put('ParamBodyAngleY', [[0, 0], [.22, 0], [.44, -.035], [.73, 0], [1, 0]]);
  } else if (name === 'Closing') {
    put('ParamAngleX', [[0, 0], [.18, 0], [.42, -.16 * side], [.74, 0], [1, 0]]);
    put('ParamAngleY', [[0, 0], [.16, 0], [.40, -.24], [.72, 0], [1, 0]]);
    put('ParamBodyAngleY', [[0, 0], [.20, 0], [.45, -.035], [.76, 0], [1, 0]]);
  }
  // ReturnToNeutral supplies neutral target curves. Its blend must start from
  // a captured current pose or the outgoing motion; this file cannot capture one.
  const curves = motionIds.map(id => curve(id, paths[id] ?? [[0, 0], [duration, 0]]));
  const segments = curves.reduce((count, c) => count + (c.Segments.length - 2) / 7, 0);
  return {
    Version: 3,
    Meta: { Duration: duration, Fps: 30, Loop: false, AreBeziersRestricted: true, CurveCount: curves.length, TotalSegmentCount: segments, TotalPointCount: curves.length + segments * 3, UserDataCount: 0, TotalUserDataSize: 0 },
    FadeInTime: name === 'ReturnToNeutral' ? .65 : .4,
    FadeOutTime: name === 'ReturnToNeutral' ? .45 : .55,
    Curves: curves,
    UserData: [],
  };
}

function buildExpression(name, speaker) {
  const strength = speaker.id === 'interviewer-1' ? 1 : .92;
  const values = name === 'SoftSmile'
    ? { ParamBrowLY: .018, ParamBrowRY: .018, ParamBrowLAngle: 0, ParamBrowRAngle: 0, ParamEyeLSmile: .06, ParamEyeRSmile: .06 }
    : name === 'Attentive'
      ? { ParamBrowLY: .025, ParamBrowRY: .025, ParamBrowLAngle: -.018, ParamBrowRAngle: -.018, ParamEyeLSmile: 0, ParamEyeRSmile: 0 }
      : {};
  return { Type: 'Live2D Expression', FadeInTime: .45, FadeOutTime: .55, Parameters: expressionIds.map(Id => ({ Id, Value: round((values[Id] ?? 0) * strength), Blend: 'Overwrite' })) };
}

export function buildMotionPackage() {
  const files = [];
  for (const speaker of speakers) {
    for (const [index, name] of motionNames.entries()) files.push({ speakerId: speaker.id, name, kind: 'motion', path: `${speaker.id}/${name}.motion3.json`, data: buildMotion(name, speaker, speaker.durations[index]) });
    for (const name of expressionNames) files.push({ speakerId: speaker.id, name, kind: 'expression', path: `${speaker.id}/${name}.exp3.json`, data: buildExpression(name, speaker) });
  }
  return files;
}

/** Checks this deliberately restricted production format, not every possible
 * Cubism curve type. All generated files use only Parameter/restricted Bezier. */
export function validateMotion(value, name = '') {
  const errors = [], meta = value?.Meta;
  const reject = message => errors.push(message);
  if (value?.Version !== 3 || !meta || !Array.isArray(value.Curves) || !value.Curves.length) return ['Version 3, Meta and nonempty Curves are required'];
  if (!finite(meta.Duration) || meta.Duration <= 0 || meta.Fps !== 30 || meta.Loop !== false || meta.AreBeziersRestricted !== true) reject('Unsupported duration/Fps/Loop/Bezier metadata');
  if (!finite(value.FadeInTime) || value.FadeInTime < 0 || !finite(value.FadeOutTime) || value.FadeOutTime < 0) reject('Invalid fade durations');
  if (meta.UserDataCount !== 0 || meta.TotalUserDataSize !== 0 || !Array.isArray(value.UserData) || value.UserData.length) reject('No user-data/audio events are allowed');
  let segmentCount = 0, pointCount = 0;
  const seen = new Set();
  for (const c of value.Curves) {
    if (!c || c.Target !== 'Parameter' || !motionIds.includes(c.Id) || mouth(c.Id)) { reject('Only the planned body/head parameters may appear in motions'); continue; }
    if (seen.has(c.Id)) reject(`Duplicate parameter: ${c.Id}`);
    seen.add(c.Id);
    const s = c.Segments, plan = parameterPlan[c.Id];
    if (!Array.isArray(s) || s.length < 9 || (s.length - 2) % 7 !== 0 || !s.every(finite)) { reject(`Invalid restricted cubic encoding: ${c.Id}`); continue; }
    pointCount += 1;
    let previousTime = s[0], previousValue = s[1];
    if (previousTime !== 0 || previousValue !== plan.default) reject(`Curve must start at neutral t=0: ${c.Id}`);
    const values = [previousValue];
    for (let offset = 2; offset < s.length; offset += 7) {
      const [type, t1, v1, t2, v2, endTime, endValue] = s.slice(offset, offset + 7);
      segmentCount++; pointCount += 3;
      if (type !== 1) reject(`Only Bezier type 1 is authored: ${c.Id}`);
      if (!(endTime > previousTime && t1 > previousTime && t2 > t1 && endTime > t2) || endTime > meta.Duration) reject(`Time must progress monotonically: ${c.Id}`);
      const dt = endTime - previousTime;
      if (Math.abs(t1 - (previousTime + dt / 3)) > .000002 || Math.abs(t2 - (previousTime + dt * 2 / 3)) > .000002) reject(`Bezier time handles must be restricted: ${c.Id}`);
      if (v1 !== previousValue || v2 !== endValue) reject(`Non-flat value handles could alter easing: ${c.Id}`);
      values.push(v1, v2, endValue);
      previousTime = endTime; previousValue = endValue;
    }
    if (previousTime !== meta.Duration || previousValue !== plan.default) reject(`Curve must finish and hold neutral at Duration: ${c.Id}`);
    if (values.some(v => v < plan.min || v > plan.max || Math.abs(v) > plan.motionLimit)) reject(`Parameter exceeds proposed safe range: ${c.Id}`);
    if (c.Id === 'ParamQuestionGesture' && values.some(v => v !== 0)) reject('Hand gesture must remain exactly zero');
    if (name === 'Listening' && /^ParamAngle/.test(c.Id) && values.some(v => v !== 0)) reject('Listening must not include approval head/nod movement');
  }
  if (seen.size !== motionIds.length) reject('Every planned motion channel, including zero hand gesture, is required');
  if (meta.CurveCount !== value.Curves.length || meta.TotalSegmentCount !== segmentCount || meta.TotalPointCount !== pointCount) reject('Curve/segment/point totals do not match metadata');
  return errors;
}

export function validateExpression(value) {
  if (value?.Type !== 'Live2D Expression' || !Array.isArray(value.Parameters) || !value.Parameters.length) return ['Expression type and nonempty Parameters are required'];
  const errors = [], seen = new Set();
  if (!finite(value.FadeInTime) || value.FadeInTime < 0 || !finite(value.FadeOutTime) || value.FadeOutTime < 0) errors.push('Invalid expression fades');
  for (const p of value.Parameters) {
    if (!p || !expressionIds.includes(p.Id) || mouth(p.Id) || /^ParamEye[LR]Open$/.test(p.Id)) { errors.push('Expression may only own the planned brow/eye-smile channels'); continue; }
    const plan = parameterPlan[p.Id];
    if (seen.has(p.Id)) errors.push('Duplicate expression parameter');
    seen.add(p.Id);
    if (!finite(p.Value) || p.Value < plan.min || p.Value > plan.max || Math.abs(p.Value) > plan.expressionLimit || p.Blend !== 'Overwrite') errors.push(`Invalid expression value/blend: ${p.Id}`);
  }
  if (seen.size !== expressionIds.length) errors.push('Every planned expression channel is required');
  return errors;
}

function validateFile(file, value = file.data) { return file.kind === 'motion' ? validateMotion(value, file.name) : validateExpression(value); }

export function selfTest() {
  const files = buildMotionPackage();
  for (const file of files) assert.deepEqual(validateFile(file, JSON.parse(JSON.stringify(file.data))), [], file.path);
  const original = files.find(f => f.name === 'Greeting');
  const invalid = mutate => { const copy = structuredClone(original.data); mutate(copy); assert.ok(validateMotion(copy, 'Greeting').length); };
  invalid(v => { v.Meta.TotalPointCount++; });
  invalid(v => { v.Curves[0].Segments[3] = -.1; });
  invalid(v => { v.Curves[0].Segments[5] = v.Curves[0].Segments[3]; });
  invalid(v => { v.Curves[1].Id = v.Curves[0].Id; });
  invalid(v => { v.Curves[0].Id = 'ParamMouthOpenY'; });
  invalid(v => { const s = v.Curves.find(c => c.Id === 'ParamQuestionGesture').Segments; s[6] = s[8] = .1; });
  invalid(v => { v.Curves[0].Segments[1] = .1; });
  invalid(v => { v.Curves[0].Segments[4] = 100; });
  const listening = structuredClone(files.find(f => f.name === 'Listening').data);
  const nod = listening.Curves.find(c => c.Id === 'ParamAngleY'); nod.Segments[1] = nod.Segments[4] = .05;
  assert.ok(validateMotion(listening, 'Listening').some(e => e.includes('Listening')));
  const expression = structuredClone(files.find(f => f.kind === 'expression').data);
  expression.Parameters[0].Id = 'ParamMouthForm'; assert.ok(validateExpression(expression).length);
  expression.Parameters[0].Id = 'ParamEyeLOpen'; assert.ok(validateExpression(expression).length);
  expression.Parameters[0].Id = 'ParamBrowLY'; expression.Parameters[0].Value = Infinity; assert.ok(validateExpression(expression).length);
  return { generatedFilesValidated: files.length, malformedCasesRejected: 12 };
}

async function writePackage() {
  const files = buildMotionPackage(), entries = [];
  for (const file of files) {
    const errors = validateFile(file);
    if (errors.length) throw new Error(`${file.path}: ${errors.join('; ')}`);
    const bytes = `${JSON.stringify(file.data, null, 2)}\n`;
    const filename = path.join(output, file.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    entries.push({ speakerId: file.speakerId, name: file.name, kind: file.kind, file: file.path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const catalog = {
    schemaVersion: 1, status: 'authored-curves-awaiting-dedicated-models',
    parameterStatus: 'proposed-not-exported', units: 'model-parameter-values-not-physical-angles',
    modelLoadTested: false, runtimePlaybackTested: false, handGestureEnabled: false,
    mouthParametersIncluded: false, expressionBlinkChannelsIncluded: false,
    authoringReferences: {
      motionParser: 'https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismmotionjson.ts',
      segmentParser: 'https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismmotion.ts',
      expressionParser: 'https://github.com/Live2D/CubismWebFramework/blob/5-r.5/src/motion/cubismexpressionmotion.ts',
    },
    proposedParameters: parameterPlan, files: entries,
  };
  await writeFile(path.join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
}

export async function checkPackage() {
  const files = buildMotionPackage();
  const catalog = JSON.parse(await readFile(path.join(output, 'catalog.json'), 'utf8'));
  const failures = [];
  if (catalog.parameterStatus !== 'proposed-not-exported' || catalog.modelLoadTested !== false || catalog.runtimePlaybackTested !== false || catalog.mouthParametersIncluded !== false || catalog.handGestureEnabled !== false) failures.push('Catalog must not claim model/runtime/hand validation');
  for (const file of files) {
    const bytes = await readFile(path.join(output, file.path), 'utf8');
    const value = JSON.parse(bytes);
    for (const error of validateFile(file, value)) failures.push(`${file.path}: ${error}`);
    const entry = catalog.files?.find(item => item.file === file.path && item.speakerId === file.speakerId);
    if (!entry || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) failures.push(`${file.path}: catalog hash/reference mismatch`);
  }
  if (catalog.files?.length !== files.length) failures.push('Catalog must list the complete independent two-speaker set');
  if (failures.length) throw new Error(failures.join('\n'));
  return { files: files.length, speakers: speakers.map(s => s.id), mouthCurveCount: 0, modelLoadTested: false, runtimePlaybackTested: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--check', '--self-test'].includes(arg))) throw new Error('Usage: node scripts/prepare-interviewer-motions.mjs [--check | --self-test]');
    if (args.includes('--self-test')) process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'curve-format-and-policy', ...selfTest() }, null, 2)}\n`);
    if (!args.length) { await writePackage(); process.stdout.write(`${JSON.stringify({ status: 'written-and-checked', output, ...await checkPackage() }, null, 2)}\n`); }
    else if (args.includes('--check')) process.stdout.write(`${JSON.stringify({ status: 'passed', scope: 'serialized-files-and-catalog', ...await checkPackage() }, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

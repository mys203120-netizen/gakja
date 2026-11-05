/**
 * LEVEL 2: execute an explicitly supplied local Cubism Core against real MOC
 * bytes. This never downloads Core, accepts a license, invents parameters, or
 * treats a file signature as a successful model load. Browser rendering and
 * MotionSync audio execution are outside this check.
 *
 * Core calls follow the project's pinned official Web Framework 5-r.5 source:
 * Moc.fromArrayBuffer, Model.fromMoc, model.parameters, model.release,
 * moc._release. A child process contains native failures; VM is not presented
 * as a security boundary for an operator-selected executable library.
 */
/** @typedef {'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN'} ValidationStatus */
/** @typedef {{id:string,status:ValidationStatus,message:string,details?:unknown}} CoreValidationCheck */
/** @typedef {{id:string,min:number,max:number,default:number,current:number}} CoreParameter */
/** @typedef {{path:string,kind:string,bytes:number,sha256:string}} CoreValidationOutput */
/** @typedef {{raw:number,major:number,minor:number,patch:number}} CoreVersion */
/** @typedef {{status:ValidationStatus,modelId:string|null,checks:CoreValidationCheck[],parameters:CoreParameter[],outputs:CoreValidationOutput[],coreVersion:CoreVersion|null,loadedCoreHash:string|null,mocHash:string|null,environment:Record<string,unknown>&{coreExecutionAttempted:boolean,actualModelLoaded:boolean,coreFileHash?:string},command:{executable:string,arguments:string[],transport:string}|null}} CoreValidationResult */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const childFlag = '--live2d-core-validation-worker';
const maxFileBytes = 64 * 1024 * 1024;
const vmTimeoutMs = 5_000;
const childTimeoutMs = 15_000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reason = failure => String(failure?.message ?? failure).slice(0, 4_000);
const near = (a, b) => Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b));
const inRange = (value, min, max) => (value >= min || near(value, min)) && (value <= max || near(value, max));
const check = (id, status, message, details) => ({ id, status, message, ...(details === undefined ? {} : { details }) });
const within = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

function localPath(value) {
  if (!nonempty(value) || /^[a-z]+:\/\//i.test(value) || value.startsWith('\\\\') || value.startsWith('//')) throw new Error('A local filesystem path is required; URLs and network shares are not read.');
  return path.resolve(value);
}

async function readLocal(value) {
  const filename = await fsp.realpath(localPath(value));
  localPath(filename);
  const info = await fsp.stat(filename);
  if (!info.isFile() || info.size === 0 || info.size > maxFileBytes) throw new Error('A nonempty regular file of at most 64 MiB is required.');
  const bytes = await fsp.readFile(filename);
  if (!bytes.length || bytes.length > maxFileBytes) throw new Error('File size changed or is outside the supported limit.');
  return { path: filename, bytes, sha256: digest(bytes) };
}

function desiredHash(targetHashes, role, filename) {
  if (!object(targetHashes)) return undefined;
  return targetHashes[role] ?? targetHashes[`${role}Hash`] ?? targetHashes[filename];
}

function compareHash(checks, wanted, actual, label) {
  if (wanted === undefined) return;
  if (typeof wanted !== 'string' || !/^[a-f0-9]{64}$/i.test(wanted)) checks.push(check(`hash:${label}`, 'FAIL', 'Expected SHA-256 is malformed.'));
  else checks.push(check(`hash:${label}`, wanted.toLowerCase() === actual ? 'PASS' : 'FAIL', wanted.toLowerCase() === actual ? 'File matches the selected SHA-256.' : 'File differs from the selected SHA-256.', { expected: wanted.toLowerCase(), actual }));
}

function normalizeExpected(input) {
  if (input === undefined) return [];
  const entries = Array.isArray(input) ? input.map(value => typeof value === 'string' ? { id: value } : value) : object(input) ? Object.entries(input).map(([id, value]) => ({ ...value, id })) : null;
  if (!entries) throw new Error('expectedParameters must be an array or a record keyed by actual parameter ID.');
  const ids = new Set();
  for (const entry of entries) {
    if (!object(entry) || !nonempty(entry.id) || ids.has(entry.id) || (entry.required !== undefined && typeof entry.required !== 'boolean')) throw new Error('Expected parameter IDs must be nonempty, unique, and have a boolean required flag.');
    ids.add(entry.id);
    for (const key of ['min', 'max', 'default']) if (entry[key] !== undefined && !finite(entry[key])) throw new Error(`Expected ${entry.id}.${key} must be finite.`);
    if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) throw new Error(`Expected ${entry.id} has an inverted range.`);
    if (entry.default !== undefined && entry.min !== undefined && entry.max !== undefined && !inRange(entry.default, entry.min, entry.max)) throw new Error(`Expected ${entry.id}.default is outside its planned range.`);
  }
  return entries;
}

function parseMotion(value) {
  if (!object(value) || value.Version !== 3 || !Array.isArray(value.Curves) || !value.Curves.length) throw new Error('Motion requires Version 3 and nonempty Curves.');
  return value.Curves.map((curve, curveIndex) => {
    if (!object(curve) || !nonempty(curve.Id) || !['Parameter', 'PartOpacity', 'Model'].includes(curve.Target) || !Array.isArray(curve.Segments) || curve.Segments.length < 2 || !curve.Segments.every(finite)) throw new Error(`Motion curve ${curveIndex} has an invalid target or segments.`);
    const values = [curve.Segments[1]];
    let offset = 2;
    while (offset < curve.Segments.length) {
      const kind = curve.Segments[offset];
      const width = kind === 1 ? 7 : [0, 2, 3].includes(kind) ? 3 : 0;
      if (!width || offset + width > curve.Segments.length) throw new Error(`Motion curve ${curveIndex} contains a malformed segment.`);
      // Check Bezier control values as well as curve endpoints. This is a
      // conservative range check, not sampled animation playback.
      if (kind === 1) values.push(curve.Segments[offset + 2], curve.Segments[offset + 4], curve.Segments[offset + 6]);
      else values.push(curve.Segments[offset + 2]);
      offset += width;
    }
    return { id: curve.Id, target: curve.Target, values, curveIndex };
  });
}

function parseExpression(value) {
  if (!object(value) || value.Type !== 'Live2D Expression' || !Array.isArray(value.Parameters) || !value.Parameters.length) throw new Error('Expression requires Live2D Expression and nonempty Parameters.');
  return value.Parameters.map((parameter, index) => {
    if (!object(parameter) || !nonempty(parameter.Id) || !finite(parameter.Value) || (parameter.Blend !== undefined && !['Add', 'Multiply', 'Overwrite'].includes(parameter.Blend))) throw new Error(`Expression parameter ${index} is invalid.`);
    return { id: parameter.Id, target: 'Parameter', values: [], expressionValue: parameter.Value, blend: parameter.Blend ?? 'Add', parameterIndex: index };
  });
}

function parseMotionSync(value) {
  if (!object(value) || value.Version !== 1 || !Array.isArray(value.Settings) || !value.Settings.length) throw new Error('MotionSync requires Version 1 and nonempty Settings.');
  const targets = [];
  for (const [settingIndex, setting] of value.Settings.entries()) {
    if (!object(setting) || !nonempty(setting.Id) || !Array.isArray(setting.CubismParameters) || !setting.CubismParameters.length || !Array.isArray(setting.Mappings) || !setting.Mappings.length) throw new Error(`MotionSync setting ${settingIndex} lacks parameter mappings.`);
    const declared = new Set();
    for (const parameter of setting.CubismParameters) {
      if (!object(parameter) || !nonempty(parameter.Id) || declared.has(parameter.Id) || !finite(parameter.Min) || !finite(parameter.Max) || parameter.Min >= parameter.Max) throw new Error(`MotionSync setting ${settingIndex} has invalid CubismParameters.`);
      declared.add(parameter.Id);
      targets.push({ id: parameter.Id, target: 'Parameter', values: [], min: parameter.Min, max: parameter.Max, settingIndex, source: 'CubismParameters' });
    }
    for (const [mappingIndex, mapping] of setting.Mappings.entries()) {
      if (!object(mapping) || !Array.isArray(mapping.Targets) || !mapping.Targets.length) throw new Error(`MotionSync setting ${settingIndex}, mapping ${mappingIndex} has no Targets.`);
      for (const target of mapping.Targets) {
        if (!object(target) || !nonempty(target.Id) || !finite(target.Value) || !declared.has(target.Id)) throw new Error(`MotionSync mapping target is invalid or undeclared: ${target?.Id ?? '(missing)'}.`);
        const declaration = setting.CubismParameters.find(parameter => parameter.Id === target.Id);
        if (!inRange(target.Value, declaration.Min, declaration.Max)) throw new Error(`MotionSync mapping value for ${target.Id} exceeds its declared range.`);
        targets.push({ id: target.Id, target: 'Parameter', values: [target.Value], settingIndex, mappingIndex, source: 'Mappings.Targets' });
      }
    }
  }
  return targets;
}

async function loadSettings(options, checks) {
  const entries = [];
  for (const [kind, parser] of [['motionFiles', parseMotion], ['expressionFiles', parseExpression], ['motionSyncFiles', parseMotionSync]]) {
    const list = options[kind] ?? [];
    if (!Array.isArray(list)) { checks.push(check(`settings:${kind}`, 'FAIL', 'Settings files must be an array of local paths.')); continue; }
    for (const [index, input] of list.entries()) {
      const filename = typeof input === 'string' ? input : input?.path;
      const label = `${kind}:${index}`;
      try {
        const file = await readLocal(filename);
        const value = JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/, ''));
        const targets = parser(value);
        entries.push({ kind, path: file.path, sha256: file.sha256, targets });
        checks.push(check(`settings:${label}`, 'PASS', 'Settings JSON and explicit target structure were read; Core binding has not yet run.', { path: file.path, sha256: file.sha256, targetCount: targets.length }));
        compareHash(checks, typeof input === 'object' ? input.sha256 : options.targetHashes?.[file.path], file.sha256, label);
      } catch (failure) { checks.push(check(`settings:${label}`, 'FAIL', `Settings could not be validated before execution: ${reason(failure)}`, { path: typeof filename === 'string' ? filename : null })); }
    }
  }
  return entries;
}

function validateBindings(parameters, parts, settings, expected, checks) {
  const table = new Map();
  for (const [index, parameter] of parameters.entries()) {
    if (!object(parameter) || !nonempty(parameter.id) || table.has(parameter.id) || !['min', 'max', 'default', 'current'].every(key => finite(parameter[key])) || parameter.min > parameter.max || !inRange(parameter.default, parameter.min, parameter.max) || !inRange(parameter.current, parameter.min, parameter.max)) {
      checks.push(check(`parameter:${index}`, 'FAIL', 'Actual Core parameter ID, range, default or current value is invalid.', parameter));
    } else table.set(parameter.id, parameter);
  }
  checks.push(check('parameter_table', table.size === parameters.length ? 'PASS' : 'FAIL', 'Parameter table was obtained from the actual Core model.', { actualCount: parameters.length, validUniqueCount: table.size }));
  for (const planned of expected) {
    const actual = table.get(planned.id);
    if (!actual) {
      checks.push(check(`expected:${planned.id}`, planned.required === false ? 'NOT_RUN' : 'FAIL', planned.required === false ? 'Optional planned parameter is absent; no value was invented.' : 'Required parameter is missing from the actual Core model.'));
      continue;
    }
    const differences = ['min', 'max', 'default'].filter(key => planned[key] !== undefined && !near(planned[key], actual[key])).map(key => ({ field: key, expected: planned[key], actual: actual[key] }));
    checks.push(check(`expected:${planned.id}`, differences.length ? 'FAIL' : 'PASS', differences.length ? 'Planned range/default differs from the actual Core model.' : 'Requested parameter matches the actual Core model.', { expected: planned, actual, differences }));
  }
  const partIds = new Set(parts);
  for (const file of settings) {
    const failures = [];
    for (const target of file.targets) {
      if (target.target === 'Model') {
        if (!['EyeBlink', 'LipSync', 'Opacity'].includes(target.id)) failures.push({ id: target.id, reason: 'Unsupported Model effect target; it was not silently ignored.' });
        continue;
      }
      if (target.target === 'PartOpacity') {
        if (!partIds.has(target.id)) failures.push({ id: target.id, reason: 'PartOpacity target does not exist in the actual Core part table.' });
        else if (target.values.some(value => !inRange(value, 0, 1))) failures.push({ id: target.id, reason: 'Part opacity endpoint is outside 0..1.' });
        continue;
      }
      const actual = table.get(target.id);
      if (!actual) { failures.push({ id: target.id, reason: 'Target parameter does not exist in the actual Core table.' }); continue; }
      if (target.min !== undefined && (!inRange(target.min, actual.min, actual.max) || !inRange(target.max, actual.min, actual.max))) failures.push({ id: target.id, reason: 'MotionSync declared range exceeds the actual model range.', declared: { min: target.min, max: target.max }, actual });
      for (const value of target.values) if (!inRange(value, actual.min, actual.max)) failures.push({ id: target.id, reason: 'Target value/endpoint exceeds the actual model range.', value, actual });
      if (target.expressionValue !== undefined) {
        const neutralValue = target.blend === 'Overwrite' ? target.expressionValue : target.blend === 'Multiply' ? actual.default * target.expressionValue : actual.default + target.expressionValue;
        if (!inRange(neutralValue, actual.min, actual.max)) failures.push({ id: target.id, reason: 'Expression blend applied to the actual neutral/default value exceeds the model range.', blend: target.blend, inputValue: target.expressionValue, neutralDefault: actual.default, result: neutralValue, actual });
      }
    }
    checks.push(check(`targets:${file.path}`, failures.length ? 'FAIL' : 'PASS', failures.length ? 'Settings reference missing or incompatible actual model targets.' : 'Every explicit target was checked against the actual model or recognized SDK Model effect.', { path: file.path, sha256: file.sha256, failures, modelEffects: file.targets.filter(target => target.target === 'Model').map(target => target.id), note: 'This checks target binding, endpoints and Bezier control values. Expression Add/Multiply/Overwrite is evaluated against actual neutral defaults, not combined motions. It does not verify animation playback, physics, rendering, or MotionSync audio quality.' }));
  }
}

function runChild(input) {
  return new Promise(resolve => {
    const environment = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key];
    let child;
    try { child = fork(selfPath, [childFlag], { cwd: path.dirname(input.corePath), execArgv: [], env: environment, silent: true }); }
    catch (failure) { resolve({ status: 'BLOCKED', checks: [check('core_execution', 'BLOCKED', `Could not start the Core child process: ${reason(failure)}`)], parameters: [], parts: [], executed: false, logs: '', stage: 'child-start' }); return; }
    let result = null, logs = '', stage = 'child-start', settled = false, timedOut = false;
    const append = bytes => { if (logs.length < 16_384) logs += String(bytes).slice(0, 16_384 - logs.length); };
    child.stdout?.on('data', append); child.stderr?.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, childTimeoutMs);
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    child.on('message', message => {
      if (message?.kind === 'progress') stage = message.stage;
      if (message?.kind === 'result') result = message.result;
    });
    child.once('error', failure => finish({ status: 'BLOCKED', checks: [check('core_execution', 'BLOCKED', `Core process could not execute: ${reason(failure)}`)], parameters: [], parts: [], executed: stage !== 'child-start', logs, stage }));
    child.once('close', (code, signal) => {
      if (result && !timedOut) finish({ ...result, logs: `${result.logs ?? ''}${logs}`.slice(0, 16_384), exitCode: code, signal });
      else finish({ status: 'BLOCKED', checks: [check('core_execution', 'BLOCKED', timedOut ? 'Core child process exceeded its 15 second limit; no load success was inferred.' : 'Core child process exited without a completed validation result.', { stage, exitCode: code, signal })], parameters: [], parts: [], executed: stage !== 'child-start', logs, stage, exitCode: code, signal });
    });
    child.send(input, failure => { if (failure) { child.kill('SIGKILL'); finish({ status: 'BLOCKED', checks: [check('core_execution', 'BLOCKED', `Core worker input could not be sent: ${reason(failure)}`)], parameters: [], parts: [], executed: false, logs, stage }); } });
  });
}

async function writeEvidence(result, directory, modelId) {
  if (directory === undefined) return result;
  try {
    const outputRoot = localPath(directory);
    await fsp.mkdir(outputRoot, { recursive: true });
    const label = String(modelId ?? 'model').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64) || 'model';
    const basename = `core-validation-${label}-${randomUUID()}`;
    if (result.environment.coreLog) {
      const output = path.join(outputRoot, `${basename}.log.txt`);
      const bytes = Buffer.from(result.environment.coreLog, 'utf8');
      await fsp.writeFile(output, bytes, { flag: 'wx' });
      result.outputs.push({ path: output, kind: 'core-log', bytes: bytes.length, sha256: digest(bytes) });
    }
    const output = path.join(outputRoot, `${basename}.json`);
    // The evidence file excludes its own hash; its hash is returned to the
    // caller, which can bind it into a parent report without a hash cycle.
    const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fsp.writeFile(output, bytes, { flag: 'wx' });
    result.outputs.push({ path: output, kind: 'core-validation-report', bytes: bytes.length, sha256: digest(bytes) });
  } catch (failure) { result.status = 'FAIL'; result.checks.push(check('evidence_write', 'FAIL', `Validation evidence could not be written: ${reason(failure)}`)); }
  return result;
}

/**
 * @param {{corePath?:string,mocPath?:string,modelId?:string,motionFiles?:Array<string|{path:string,sha256?:string}>,expressionFiles?:Array<string|{path:string,sha256?:string}>,motionSyncFiles?:Array<string|{path:string,sha256?:string}>,expectedParameters?:Array<string|{id:string,min?:number,max?:number,default?:number,required?:boolean}>|Record<string,{min?:number,max?:number,default?:number,required?:boolean}>,runEvidenceDirectory?:string,targetHashes?:Record<string,string>}} [options]
 * @returns {Promise<CoreValidationResult>}
 */
export async function validateWithCore(options = {}) {
  const result = {
    status: 'NOT_RUN', modelId: options.modelId ?? null,
    checks: [], parameters: [], outputs: [], coreVersion: null, loadedCoreHash: null, mocHash: null,
    environment: { node: process.version, platform: process.platform, architecture: process.arch, mode: 'node-child-process/vm', coreExecutionAttempted: false, actualModelLoaded: false, coreProvenance: 'operator-supplied file; vendor authenticity and license entitlement are not inferred', checkedAt: new Date().toISOString(), network: 'no network fetch/import capability supplied to Core; only local Core sidecars are read' },
    command: null,
  };
  let core, moc, expected = [];
  try { expected = normalizeExpected(options.expectedParameters); }
  catch (failure) { result.checks.push(check('expected_parameter_spec', 'FAIL', reason(failure))); }
  const settings = await loadSettings(options, result.checks);
  if (!options.corePath) result.checks.push(check('core_file', 'BLOCKED', 'No local Core was explicitly supplied; Core and model execution were not attempted.'));
  else {
    try {
      core = await readLocal(options.corePath);
      result.environment.corePath = core.path; result.environment.coreFileHash = core.sha256;
      result.checks.push(check('core_file', 'PASS', 'Selected local Core file was read; this is not a runtime pass.', { path: core.path, sha256: core.sha256 }));
      compareHash(result.checks, desiredHash(options.targetHashes, 'core', core.path), core.sha256, 'core');
    } catch (failure) { result.checks.push(check('core_file', 'BLOCKED', `Selected local Core is unavailable: ${reason(failure)}`)); }
  }
  if (!options.mocPath) result.checks.push(check('moc_file', 'BLOCKED', 'No local MOC3 file was supplied.'));
  else {
    try {
      moc = await readLocal(options.mocPath); result.mocHash = moc.sha256; result.environment.mocPath = moc.path;
      result.checks.push(check('moc_file', 'PASS', 'Actual MOC bytes were read; no signature was treated as a load pass.', { path: moc.path, bytes: moc.bytes.length, sha256: moc.sha256 }));
      compareHash(result.checks, desiredHash(options.targetHashes, 'moc', moc.path), moc.sha256, 'moc');
    } catch (failure) { result.checks.push(check('moc_file', 'BLOCKED', `Selected MOC3 file is unavailable: ${reason(failure)}`)); }
  }
  if (result.checks.some(entry => entry.status === 'FAIL') || !core || !moc) {
    result.status = result.checks.some(entry => entry.status === 'FAIL') ? 'FAIL' : 'BLOCKED';
    result.checks.push(check('core_execution', 'NOT_RUN', 'Core was not executed because required inputs or preflight checks were not satisfied.'));
    result.checks.push(check('moc_load', 'NOT_RUN', 'No actual Core model-load result exists.'));
    return writeEvidence(result, options.runEvidenceDirectory, options.modelId);
  }
  result.command = { executable: process.execPath, arguments: [selfPath, childFlag], transport: 'IPC paths plus observed file hashes; no shell' };
  const executed = await runChild({ corePath: core.path, mocPath: moc.path, coreHash: core.sha256, mocHash: moc.sha256 });
  result.checks.push(...executed.checks);
  result.parameters = executed.parameters ?? [];
  result.coreVersion = executed.coreVersion ?? null;
  result.loadedCoreHash = executed.loadedCoreHash ?? null;
  result.mocHash = executed.mocHash ?? result.mocHash;
  Object.assign(result.environment, { coreExecutionAttempted: executed.executed, actualModelLoaded: executed.modelLoaded === true, stage: executed.stage, childExitCode: executed.exitCode ?? null, childSignal: executed.signal ?? null, sidecars: executed.sidecars ?? [], coreLog: executed.logs ?? '', coreLoadError: executed.error ?? null });
  if (executed.status === 'PASS') validateBindings(result.parameters, executed.parts ?? [], settings, expected, result.checks);
  else result.checks.push(check('target_binding', 'NOT_RUN', 'Actual model targets cannot be checked without a completed Core parameter table.'));
  result.status = result.checks.some(entry => entry.status === 'FAIL') ? 'FAIL' : executed.status;
  return writeEvidence(result, options.runEvidenceDirectory, options.modelId);
}

async function coreWorker(input) {
  const result = { status: 'BLOCKED', checks: [], parameters: [], parts: [], coreVersion: null, loadedCoreHash: null, mocHash: null, executed: false, modelLoaded: false, sidecars: [], stage: 'read-inputs', logs: '' };
  const progress = stage => { result.stage = stage; process.send?.({ kind: 'progress', stage }); };
  let context;
  const timers = new Set();
  const log = (...args) => { if (result.logs.length < 16_384) result.logs += `${args.map(value => String(value)).join(' ')}\n`.slice(0, 16_384 - result.logs.length); };
  try {
    const [core, moc] = await Promise.all([readLocal(input.corePath), readLocal(input.mocPath)]);
    result.mocHash = moc.sha256;
    if (core.sha256 !== input.coreHash || moc.sha256 !== input.mocHash) {
      result.status = 'FAIL'; result.checks.push(check('input_hash_binding', 'FAIL', 'Core or MOC changed after the parent preflight. No changed library was executed.')); return result;
    }
    const coreDirectory = path.dirname(core.path);
    function sidecarPath(value) {
      if (value instanceof URL) value = fileURLToPath(value);
      if (typeof value === 'string' && value.startsWith('file:')) value = fileURLToPath(value);
      if (typeof value !== 'string') throw new Error('Core sidecar path is not local text.');
      const filename = fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(coreDirectory, value));
      localPath(filename);
      if (!within(coreDirectory, filename)) throw new Error('Core sidecar is outside the selected Core directory.');
      const info = fs.statSync(filename);
      if (!info.isFile() || info.size > maxFileBytes) throw new Error('Core sidecar is not a supported local regular file.');
      return filename;
    }
    const localFs = {
      readFileSync(value, encoding) {
        const filename = sidecarPath(value), bytes = fs.readFileSync(filename);
        const hash = digest(bytes);
        if (!result.sidecars.some(entry => entry.path === filename)) result.sidecars.push({ path: filename, bytes: bytes.length, sha256: hash });
        const codec = typeof encoding === 'string' ? encoding : encoding?.encoding;
        return codec ? bytes.toString(codec) : bytes;
      },
      readFile(value, encoding, callback) {
        if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
        try { const bytes = localFs.readFileSync(value, encoding); queueMicrotask(() => callback(null, bytes)); }
        catch (failure) { queueMicrotask(() => callback(failure)); }
      },
      existsSync(value) { try { sidecarPath(value); return true; } catch { return false; } },
    };
    const sandbox = {
      console: { log, warn: log, error: log, info: log, debug: log }, print: log, printErr: log,
      Buffer, TextEncoder, TextDecoder, WebAssembly, URL, performance,
      __filename: core.path, __dirname: coreDirectory,
      process: { versions: { node: process.versions.node }, version: process.version, platform: process.platform, argv: [process.execPath, core.path], env: {}, cwd: () => coreDirectory, on() {}, exit(code) { throw new Error(`Core requested process exit ${code}.`); } },
      module: { exports: {} },
      require(name) {
        if (name === 'fs' || name === 'node:fs') return localFs;
        if (name === 'path' || name === 'node:path') return path;
        throw new Error(`Core requires an unsupported module in this headless runner: ${name}`);
      },
      setTimeout(callback, delay, ...args) { const id = setTimeout(() => { timers.delete(id); callback(...args); }, delay); timers.add(id); return id; },
      clearTimeout(id) { clearTimeout(id); timers.delete(id); },
      __mocBytes: new Uint8Array(moc.bytes),
    };
    sandbox.exports = sandbox.module.exports;
    context = vm.createContext(sandbox, { name: 'supplied-live2d-core' });
    context.global = context; context.self = context;
    progress('core-evaluation'); result.executed = true; result.loadedCoreHash = core.sha256;
    new vm.Script(core.bytes.toString('utf8'), { filename: core.path }).runInContext(context, { timeout: vmTimeoutMs });
    vm.runInContext('globalThis.__validationCore = typeof Live2DCubismCore !== "undefined" ? Live2DCubismCore : (module.exports.Live2DCubismCore ?? module.exports.default ?? module.exports);', context, { timeout: vmTimeoutMs });
    if (context.__validationCore && typeof context.__validationCore.then === 'function') context.__validationCore = await context.__validationCore;
    if (context.__validationCore?.ready && typeof context.__validationCore.ready.then === 'function') await context.__validationCore.ready;
    const supported = vm.runInContext('Boolean(__validationCore && typeof __validationCore.Moc?.fromArrayBuffer === "function" && typeof __validationCore.Model?.fromMoc === "function" && typeof __validationCore.Version?.csmGetVersion === "function")', context, { timeout: vmTimeoutMs });
    if (!supported) throw new Error('The supplied file did not expose the documented Cubism Core Moc/Model/Version API in Node VM. Browser-only or incompatible Core needs a compatible execution environment.');
    const number = vm.runInContext('__validationCore.Version.csmGetVersion()', context, { timeout: vmTimeoutMs });
    if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) throw new Error('Core returned an invalid numeric version.');
    result.coreVersion = { raw: number, major: number >>> 24, minor: number >>> 16 & 255, patch: number & 65535 };
    result.checks.push(check('core_execution', 'PASS', 'The explicitly supplied local Core executed and returned its actual version.', { sha256: core.sha256, version: result.coreVersion }));
    vm.runInContext('globalThis.__validationMocBuffer = Uint8Array.from(__mocBytes).buffer;', context, { timeout: vmTimeoutMs });
    progress('moc-load');
    const consistency = vm.runInContext('typeof __validationCore.Moc.prototype.hasMocConsistency === "function" ? __validationCore.Moc.prototype.hasMocConsistency(__validationMocBuffer) : null', context, { timeout: vmTimeoutMs });
    if (consistency !== null && consistency !== 1 && consistency !== true) { result.status = 'FAIL'; result.checks.push(check('moc_consistency', 'FAIL', 'Actual Core rejected MOC consistency.', { returned: consistency })); return result; }
    result.checks.push(check('moc_consistency', consistency === null ? 'NOT_RUN' : 'PASS', consistency === null ? 'This Core does not expose the optional consistency API; it was not replaced with a header check.' : 'Actual Core consistency API accepted these MOC bytes.'));
    const loaded = vm.runInContext('globalThis.__validationMoc = __validationCore.Moc.fromArrayBuffer(__validationMocBuffer); Boolean(__validationMoc);', context, { timeout: vmTimeoutMs });
    if (!loaded) { result.status = 'FAIL'; result.checks.push(check('moc_load', 'FAIL', 'Actual Core Moc.fromArrayBuffer did not load the supplied MOC bytes.')); return result; }
    result.checks.push(check('moc_load', 'PASS', 'Actual Core Moc.fromArrayBuffer loaded the supplied MOC bytes.', { sha256: moc.sha256 }));
    progress('model-create');
    const created = vm.runInContext('globalThis.__validationModel = __validationCore.Model.fromMoc(__validationMoc); Boolean(__validationModel);', context, { timeout: vmTimeoutMs });
    if (!created) { result.status = 'FAIL'; result.checks.push(check('model_create', 'FAIL', 'Actual Core Model.fromMoc did not create a model.')); return result; }
    result.modelLoaded = true;
    result.checks.push(check('model_create', 'PASS', 'Actual Core Model.fromMoc created a real model object.'));
    progress('model-update');
    vm.runInContext('if (typeof __validationModel.update !== "function") throw new Error("Core model.update is unavailable."); __validationModel.update();', context, { timeout: vmTimeoutMs });
    result.checks.push(check('model_update', 'PASS', 'Actual Core model.update completed once; no visual rendering was performed.'));
    progress('parameter-read');
    const snapshot = vm.runInContext(`JSON.stringify((() => {
      const table = __validationModel.parameters;
      if (!table || !Number.isInteger(table.count) || table.count < 0 || table.count > 65536) throw new Error('Actual Core parameter count is unsupported.');
      for (const key of ['ids','minimumValues','maximumValues','defaultValues','values']) if (!table[key] || table[key].length !== table.count) throw new Error('Actual Core parameter array length does not match: ' + key);
      const parameters = Array.from({length:table.count}, (_, index) => ({id:table.ids[index],min:table.minimumValues[index],max:table.maximumValues[index],default:table.defaultValues[index],current:table.values[index]}));
      const parts = __validationModel.parts;
      if (parts && (!Number.isInteger(parts.count) || parts.count < 0 || parts.count > 65536 || !parts.ids || parts.ids.length !== parts.count)) throw new Error('Actual Core part table is invalid.');
      return {parameters,parts:parts ? Array.from(parts.ids) : []};
    })())`, context, { timeout: vmTimeoutMs });
    const actual = JSON.parse(snapshot);
    result.parameters = actual.parameters; result.parts = actual.parts;
    result.status = 'PASS';
  } catch (failure) {
    result.error = reason(failure);
    result.status = ['read-inputs', 'core-evaluation'].includes(result.stage) || failure?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'BLOCKED' : 'FAIL';
    result.checks.push(check(result.stage === 'core-evaluation' ? 'core_execution' : result.stage, result.status, `Actual execution could not complete: ${result.error}`));
  } finally {
    if (context) {
      try {
        const released = vm.runInContext(`(() => {
          const result = {model:'not-created',moc:'not-created'};
          if (globalThis.__validationModel) { if (typeof __validationModel.release !== 'function') throw new Error('Actual Core model.release is unavailable.'); __validationModel.release(); globalThis.__validationModel=null; result.model='released'; }
          if (globalThis.__validationMoc) { if (typeof __validationMoc._release !== 'function') throw new Error('Actual Core moc._release is unavailable.'); __validationMoc._release(); globalThis.__validationMoc=null; result.moc='released'; }
          return JSON.stringify(result);
        })()`, context, { timeout: vmTimeoutMs });
        result.checks.push(check('core_dispose', 'PASS', 'Created Core resources were released, or no model/MOC resource had been created.', JSON.parse(released)));
      } catch (failure) { result.status = 'FAIL'; result.checks.push(check('core_dispose', 'FAIL', `Core resources could not be cleanly released: ${reason(failure)}`)); }
    }
    for (const timer of timers) clearTimeout(timer);
  }
  return result;
}

if (process.argv[2] === childFlag && typeof process.send === 'function') {
  process.once('message', async input => {
    let result;
    try { result = await coreWorker(input); }
    catch (failure) { result = { status: 'BLOCKED', checks: [check('core_execution', 'BLOCKED', reason(failure))], parameters: [], executed: false, error: reason(failure) }; }
    process.send({ kind: 'result', result }, () => process.disconnect());
  });
}

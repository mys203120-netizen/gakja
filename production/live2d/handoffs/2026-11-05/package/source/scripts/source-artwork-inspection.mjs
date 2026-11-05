#!/usr/bin/env node
/** Read PNG metadata/alpha only. Never edits, resizes, recolors, or overwrites art. */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
const expectedNames = ['approved-master.png', 'underpaint.png', 'mouth-open-source.png'];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const relativePath = target => path.relative(root, target).split(path.sep).join('/');

function alphaBounds(alpha, width, height, threshold) {
  let left = width, top = height, right = -1, bottom = -1, pixelCount = 0;
  for (let y = 0, offset = 0; y < height; y++) for (let x = 0; x < width; x++, offset++) {
    if (alpha[offset] <= threshold) continue;
    pixelCount++;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { threshold, comparison: 'alpha > threshold', pixelCount,
    bounds: pixelCount ? { left, top, rightExclusive: right + 1, bottomExclusive: bottom + 1, width: right - left + 1, height: bottom - top + 1 } : null };
}

export async function inspectPng(sourcePath) {
  const bytes = await readFile(sourcePath);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Not a PNG file (signature mismatch).');
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error('PNG dimensions are missing.');
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated/multipage PNG is not supported as a single artwork source.');
  // Only decode alpha; no color conversion, orientation transform or output PNG
  // is performed. For RGB PNGs ensureAlpha adds opaque samples for measurement,
  // and the report explicitly distinguishes those from a stored alpha channel.
  const { data: alpha, info } = await sharp(bytes, { ignoreIcc: true }).ensureAlpha().extractChannel('alpha').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.width !== metadata.width || info.height !== metadata.height) throw new Error('Unexpected alpha decoding dimensions.');
  let transparent = 0, translucent = 0, opaque = 0, minimum = 255, maximum = 0;
  for (const value of alpha) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    if (value === 0) transparent++; else if (value === 255) opaque++; else translucent++;
  }
  // PNG IHDR bit depth is authoritative for the stored file. Sharp's depth is
  // recorded separately so indexed palettes are not misreported as RGB8.
  const ihdrBitDepth = bytes[24], ihdrColorType = bytes[25];
  const pngColorTypes = { 0: 'Grayscale', 2: 'RGB', 3: 'Indexed', 4: 'Grayscale+Alpha', 6: 'RGBA' };
  return {
    path: relativePath(sourcePath), name: path.basename(sourcePath), bytes: bytes.length, sha256: sha256(bytes),
    format: 'PNG', width: metadata.width, height: metadata.height, storedBitsPerChannel: ihdrBitDepth,
    pngColorType: ihdrColorType, storedColorModel: pngColorTypes[ihdrColorType] ?? 'Unknown',
    decodedDepth: metadata.depth, decodedColorSpace: metadata.space, decodedChannels: metadata.channels,
    isStoredRGB8: ihdrBitDepth === 8 && (ihdrColorType === 2 || ihdrColorType === 6),
    embeddedIccProfile: metadata.icc ? { bytes: metadata.icc.length, sha256: sha256(metadata.icc) } : null,
    colorProfileInterpretation: metadata.icc ? 'ICC bytes present; this inspection does not identify/convert the profile' : 'no embedded ICC profile found; no profile was assigned',
    orientation: metadata.orientation ?? 1,
    hasStoredAlphaChannel: Boolean(metadata.hasAlpha),
    alphaMeasurement: {
      sampleDepth: 8, source: metadata.hasAlpha ? 'decoded stored transparency' : 'synthetic opaque alpha for RGB source measurement only',
      minimum, maximum, pixels: { transparent, translucent, opaque, total: alpha.length },
      actualTransparencyDetected: Boolean(metadata.hasAlpha && transparent + translucent > 0),
      greaterThan0: alphaBounds(alpha, metadata.width, metadata.height, 0),
      greaterThan128: alphaBounds(alpha, metadata.width, metadata.height, 128),
      coordinateSystem: 'storage pixel coordinates; origin top-left; right/bottom exclusive; no auto-orientation',
    },
  };
}

export async function inspectSourceDirectory(sourceDirectory, speakerId) {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png')).map(entry => entry.name).sort();
  const files = [], errors = [], warnings = [];
  for (const name of names) {
    try { files.push(await inspectPng(path.join(sourceDirectory, name))); }
    catch (error) { errors.push({ path: relativePath(path.join(sourceDirectory, name)), message: error.message }); }
  }
  const missingExpectedFiles = expectedNames.filter(name => !names.includes(name));
  if (new Set(files.map(file => `${file.width}x${file.height}`)).size > 1) warnings.push('Sources have different canvas sizes. This report does not register or rescale them; artwork part offsets must be explicit.');
  for (const file of files) {
    if (!file.isStoredRGB8) warnings.push(`${file.name}: stored file is ${file.storedColorModel}/${file.storedBitsPerChannel}-bit, not RGB8.`);
    if (!file.hasStoredAlphaChannel) warnings.push(`${file.name}: no stored alpha channel. Full-canvas bounds do not prove a transparent cutout.`);
    else if (!file.alphaMeasurement.actualTransparencyDetected) warnings.push(`${file.name}: alpha exists but every pixel is opaque.`);
  }
  const report = {
    schemaVersion: 1, scope: 'source-PNG-metadata-and-alpha-only', inspectedAt: new Date().toISOString(), speakerId,
    sourceDirectory: relativePath(sourceDirectory), status: errors.length ? 'read-error' : missingExpectedFiles.length ? 'partial-inputs' : 'complete-metadata',
    expectedFiles: expectedNames, missingExpectedFiles, files, warnings, errors,
    visualReviewPerformed: false, geometryChanged: false, sourceFilesChanged: false,
    limitations: ['Alpha bounds describe occupied pixels, not anatomical part boundaries.', 'Actual transparency is measured; painted checkerboard detection is not a visual claim.', 'This inspection does not prove face consistency, inpainting quality, mouth anatomy, alignment, PSD editability, rigging, or Live2D execution.'],
  };
  const output = path.join(sourceDirectory, 'inspection.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, reportPath: relativePath(output) };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('node scripts/source-artwork-inspection.mjs [--speaker interviewer-1|interviewer-2] [--allow-missing]\nReads public/live2d/production/<speaker>/sources PNGs and writes sources/inspection.json. No artwork is edited. Missing expected inputs give exit code 2 unless --allow-missing is specified.');
    return;
  }
  const speakerArgument = process.argv.indexOf('--speaker');
  const speakers = speakerArgument < 0 ? ['interviewer-1', 'interviewer-2'] : [process.argv[speakerArgument + 1]];
  if (speakers.some(speaker => !['interviewer-1', 'interviewer-2'].includes(speaker))) throw new Error('Use --speaker interviewer-1 or interviewer-2.');
  const results = [];
  for (const speaker of speakers) results.push(await inspectSourceDirectory(path.join(root, 'public', 'live2d', 'production', speaker, 'sources'), speaker));
  console.log(JSON.stringify(results.map(result => ({ speakerId: result.speakerId, status: result.status,
    inspectedFiles: result.files.length, missingExpectedFiles: result.missingExpectedFiles, reportPath: result.reportPath,
    files: result.files.map(file => ({ name: file.name, bytes: file.bytes, width: file.width, height: file.height, isStoredRGB8: file.isStoredRGB8, hasStoredAlphaChannel: file.hasStoredAlphaChannel, occupiedBounds: file.alphaMeasurement.greaterThan0.bounds })) })), null, 2));
  if (results.some(result => result.errors.length)) process.exitCode = 1;
  else if (!process.argv.includes('--allow-missing') && results.some(result => result.missingExpectedFiles.length)) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`Source artwork inspection failed: ${error.message}`); process.exitCode = 1; });

#!/usr/bin/env node
/**
 * Package existing, independently painted PNG parts into real editable PSD layers.
 * This script does not segment, repaint, retouch, deform, or resize artwork.
 *
 * Setup (keeps the app package and lockfile unchanged):
 *   npm install --prefix tmp/psd-tools --save-exact ag-psd@34.1.0 --ignore-scripts
 * Usage:
 *   node scripts/build-interviewer-psd.mjs production/male/parts/manifest.json
 *   node scripts/build-interviewer-psd.mjs --self-test
 *
 * Manifest paths are relative to the manifest directory. x/y are top-left pixel
 * offsets in the shared canvas. z grows from back to front. group is an optional
 * slash-delimited hierarchy. Reference/guide/annotation/preview roles are retained
 * in artwork_master.psd and excluded from cubism_import.psd. Hidden art variants
 * remain real hidden layers in both. No masks, clipping, effects, or smart objects
 * are generated. The master groups must not interleave in z order.
 *
 * Input example:
 * { "canvas": { "width": 1920, "height": 1080, "dpi": 72 }, "layers": [
 *   { "id": "body", "name": "Body", "group": "Body", "path": "body.png",
 *     "x": 0, "y": 0, "z": 0, "visible": true, "role": "part" },
 *   { "id": "face", "name": "Face_Base", "group": "Head", "path": "face.png",
 *     "x": 0, "y": 0, "z": 100, "visible": true, "role": "part" }
 * ] }
 *
 * Supported output: PSD v1, RGB, 8 bits/channel, real RGBA per raster layer,
 * embedded sRGB ICC, saved bounds/offsets and Unicode names/groups. Export is
 * verified by reading every saved layer and comparing decoded RGBA bytes, canvas,
 * ICC, names, bounds, visibility, order and hierarchy against the inputs. This is
 * a file-format round-trip, NOT verification of anatomical part separation,
 * Photoshop/Cubism import, rigging, or original drawing quality.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedFromCubism = new Set(['reference', 'guide', 'annotation', 'preview']);
const opaqueRoles = new Set(['background', ...excludedFromCubism]);
const maxDecodedPixels = 200_000_000;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const byteView = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function dependencies() {
  const requireApp = createRequire(path.join(projectRoot, 'package.json'));
  const requireTools = createRequire(path.join(projectRoot, 'tmp', 'psd-tools', 'package.json'));
  let ag;
  try { ag = requireTools('ag-psd'); }
  catch { throw new Error('ag-psd is missing. Run: npm install --prefix tmp/psd-tools --save-exact ag-psd@34.1.0 --ignore-scripts'); }
  const version = requireTools('ag-psd/package.json').version;
  assert(version === '34.1.0', 'This helper verifies the exact merged white-matte codec of ag-psd 34.1.0. Revalidate that codec before changing the pinned version.');
  const sharp = requireApp('sharp');
  // ag-psd can use raw pixels without node-canvas, avoiding premultiplied-alpha
  // conversion. Creating a Canvas is an error because none is needed here.
  ag.initializeCanvas(() => { throw new Error('Unexpected Canvas access. PSD packaging must use raw RGBA.'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));
  return { ag, sharp, version };
}

function groupPath(group) {
  if (group === undefined || group === null || group === '') return [];
  assert(typeof group === 'string', 'layer.group must be a slash-delimited string.');
  const groups = group.split('/').map(value => value.trim());
  assert(groups.every(Boolean), 'Empty group names are not supported.');
  assert(groups.every(value => !/[\x00-\x1f]/u.test(value)), 'Group names cannot contain control characters.');
  return groups;
}

function alphaStatistics(data) {
  let transparent = 0, translucent = 0, opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++;
    else if (data[i] === 255) opaque++;
    else translucent++;
  }
  return { transparent, translucent, opaque };
}

async function readLayers(manifest, manifestDirectory, sharp) {
  const { width, height } = manifest.canvas ?? {};
  assert(Number.isInteger(width) && width > 0 && width <= 30000, 'canvas.width must be an integer in 1..30000 (PSD v1).');
  assert(Number.isInteger(height) && height > 0 && height <= 30000, 'canvas.height must be an integer in 1..30000 (PSD v1).');
  assert(width * height <= maxDecodedPixels, 'Canvas exceeds the packaging memory bound.');
  assert(Array.isArray(manifest.layers) && manifest.layers.length >= 2, 'Provide at least two independent painted PNG layers; a flat PNG is not a layered character source.');
  assert(manifest.layers.length <= 1000, 'At most 1000 raster layers are supported by this helper.');
  let totalPixels = width * height;
  const ids = new Set(), names = new Set(), result = [];
  for (const [index, input] of manifest.layers.entries()) {
    assert(input && typeof input === 'object', `Invalid layer at index ${index}.`);
    assert(typeof input.id === 'string' && /^[a-zA-Z0-9_.-]+$/u.test(input.id), `Layer ${index}: id must contain ASCII letters, digits, _, . or -.`);
    assert(!ids.has(input.id), `Duplicate layer id: ${input.id}`); ids.add(input.id);
    const name = input.name ?? input.id;
    assert(typeof name === 'string' && name.trim() && !/[\x00-\x1f]/u.test(name), `Layer ${input.id}: invalid name.`);
    assert(!names.has(name), `Duplicate layer name: ${name}. Cubism import names must remain distinguishable.`); names.add(name);
    assert(typeof input.path === 'string' && input.path.toLowerCase().endsWith('.png'), `Layer ${input.id}: use an existing PNG part.`);
    assert(Number.isInteger(input.x) && Number.isInteger(input.y), `Layer ${input.id}: x/y must be explicit integer canvas offsets.`);
    assert(Number.isFinite(input.z), `Layer ${input.id}: z must be explicit and finite.`);
    assert(input.visible === undefined || typeof input.visible === 'boolean', `Layer ${input.id}: visible must be boolean.`);
    assert(input.role === undefined || typeof input.role === 'string', `Layer ${input.id}: role must be a string.`);
    const sourcePath = path.resolve(manifestDirectory, input.path);
    const png = await readFile(sourcePath);
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Layer ${input.id}: invalid PNG signature.`);
    const metadata = await sharp(png).metadata();
    assert(metadata.depth === 'uchar', `Layer ${input.id}: expected an 8-bit PNG; do not silently reduce a higher-bit original.`);
    assert(!metadata.orientation || metadata.orientation === 1, `Layer ${input.id}: normalize orientation in the artwork source first.`);
    assert(metadata.space === 'srgb', `Layer ${input.id}: expected RGB/sRGB PNG, received ${metadata.space}. Convert the source deliberately before packaging.`);
    totalPixels += metadata.width * metadata.height;
    assert(totalPixels <= maxDecodedPixels, `Decoded layers exceed ${maxDecodedPixels} pixels. Crop parts with their original x/y offsets before packaging.`);
    assert(input.x >= 0 && input.y >= 0 && input.x + metadata.width <= width && input.y + metadata.height <= height,
      `Layer ${input.id}: image bounds extend beyond the shared canvas. Nothing is clipped or repositioned automatically.`);
    // A tagged non-sRGB profile must be converted deliberately rather than merely
    // relabelled. withIccProfile performs an explicit ICC conversion to sRGB;
    // untagged PNG RGB values use sRGB. No geometry or alpha is changed.
    const { data, info } = await sharp(png).withIccProfile('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert(info.channels === 4 && info.width === metadata.width && info.height === metadata.height, `Layer ${input.id}: unexpected decoded dimensions/channels.`);
    const alpha = alphaStatistics(data), role = input.role ?? 'part';
    assert(alpha.opaque + alpha.translucent > 0, `Layer ${input.id}: completely empty/transparent layer.`);
    if (!opaqueRoles.has(role)) assert(metadata.hasAlpha && alpha.transparent + alpha.translucent > 0,
      `Layer ${input.id}: a character part needs real transparency; an opaque/checkerboard background cannot be packaged as alpha.`);
    result.push({ id: input.id, name, groups: groupPath(input.group), x: input.x, y: input.y, z: input.z,
      visible: input.visible !== false, role, width: info.width, height: info.height, data,
      psdId: index + 1, sourcePath, pngSha256: sha256(png), rgbaSha256: sha256(data), alpha,
      sourceHadIccProfile: Boolean(metadata.icc), colorHandling: metadata.icc ? 'embedded input ICC converted to sRGB' : 'untagged RGB interpreted as sRGB' });
  }
  const art = result.filter(layer => !excludedFromCubism.has(layer.role));
  assert(art.length >= 2, 'Cubism import needs at least two real art layers after excluding references/guides.');
  assert(new Set(art.map(layer => layer.rgbaSha256)).size >= 2, 'Duplicating one flattened image does not create independent artwork parts.');
  return result.sort((a, b) => b.z - a.z || b.psdId - a.psdId);
}

function makeLeaf(layer) {
  return { name: layer.name, id: layer.psdId, left: layer.x, top: layer.y,
    right: layer.x + layer.width, bottom: layer.y + layer.height,
    hidden: !layer.visible, opacity: 1, blendMode: 'normal', clipping: false,
    transparencyProtected: false,
    imageData: { width: layer.width, height: layer.height, data: layer.data } };
}

function groupedChildren(layers) {
  const children = [];
  for (const layer of layers) {
    let siblings = children;
    for (const name of layer.groups) {
      let group = siblings.find(item => item.children && item.name === name);
      if (!group) { group = { name, blendMode: 'pass through', opacity: 1, opened: true, children: [] }; siblings.push(group); }
      siblings = group.children;
    }
    siblings.push(makeLeaf(layer));
  }
  const actualOrder = flatten(children).map(layer => layer.id);
  assert(actualOrder.every((id, index) => id === layers[index].psdId), 'Group hierarchy interleaves z order. Use contiguous groups or revise the manifest; artwork order is never changed silently.');
  return children;
}

function flatten(children, groups = []) {
  return (children ?? []).flatMap(layer => layer.children
    ? flatten(layer.children, [...groups, layer.name])
    : [{ ...layer, groups }]);
}

async function composite(layers, canvas, sharp) {
  // Normal source-over compositing only. It creates the PSD merged preview; all
  // independently editable source layers remain separately stored and checked.
  const ordered = [...layers].reverse().filter(layer => layer.visible);
  const pipeline = sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background: '#00000000' } });
  if (ordered.length) pipeline.composite(ordered.map(layer => ({ input: layer.data,
    raw: { width: layer.width, height: layer.height, channels: 4 }, left: layer.x, top: layer.y, blend: 'over' })));
  return pipeline.raw().toBuffer();
}

async function srgbProfile(sharp) {
  const tagged = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#00000000' } }).withIccProfile('srgb').png().toBuffer();
  const profile = (await sharp(tagged).metadata()).icc;
  assert(profile?.length && profile.subarray(36, 40).toString('ascii') === 'acsp', 'Cannot generate a valid embedded sRGB ICC profile.');
  return profile;
}

function verifySaved(bytes, expected, children, canvas, profile, merged, ag) {
  assert(bytes.subarray(0, 4).toString('ascii') === '8BPS' && bytes.readUInt16BE(4) === 1, 'Output is not a PSD v1 file.');
  const decoded = ag.readPsd(bytes, { useImageData: true, skipThumbnail: true, totalMemoryLimit: maxDecodedPixels * 4 + 32_000_000, throwForMissingFeatures: true });
  assert(decoded.width === canvas.width && decoded.height === canvas.height, 'PSD canvas mismatch.');
  assert(decoded.colorMode === 3 && decoded.bitsPerChannel === 8, 'PSD is not RGB 8-bit.');
  assert(Buffer.from(decoded.imageResources?.iccProfile ?? []).equals(profile), 'Embedded ICC profile mismatch.');
  const leaves = flatten(decoded.children), expectedTree = flatten(children);
  assert(leaves.length === expected.length, 'Saved raster layer count mismatch.');
  const proofs = leaves.map((layer, index) => {
    const source = expected[index], treeLayer = expectedTree[index];
    assert(layer.name === source.name && layer.id === source.psdId, `Saved layer name/id mismatch: ${source.id}`);
    assert(JSON.stringify(layer.groups) === JSON.stringify(treeLayer.groups), `Saved layer group mismatch: ${source.id}`);
    assert(layer.left === source.x && layer.top === source.y && layer.right === source.x + source.width && layer.bottom === source.y + source.height,
      `Saved layer bounds mismatch: ${source.id}`);
    assert(Boolean(layer.hidden) === !source.visible, `Saved layer visibility mismatch: ${source.id}`);
    assert(layer.imageData?.width === source.width && layer.imageData?.height === source.height, `Saved layer bitmap size mismatch: ${source.id}`);
    const rgbaSha256 = sha256(byteView(layer.imageData.data));
    assert(rgbaSha256 === source.rgbaSha256, `Saved RGBA channel bytes differ: ${source.id}`);
    return { id: source.id, name: layer.name, groups: layer.groups, x: layer.left, y: layer.top, width: source.width, height: source.height,
      visible: !layer.hidden, rgbaSha256, alpha: alphaStatistics(layer.imageData.data) };
  });
  assert(decoded.imageData?.width === canvas.width && decoded.imageData?.height === canvas.height, 'Merged preview is absent or has wrong dimensions.');
  // The pinned ag-psd 34.1.0 getCompositeData writes white-matted RGB into
  // Uint8Array (truncation, error <1), then removeWhiteMatte assigns unmatted RGB
  // into Uint8ClampedArray (nearest rounding, error <=0.5). Thus premultiplied RGB
  // error is <1 + 0.5*alpha, below 1.5 code values. Reproduce that exact codec and
  // require byte-for-byte predicted decoded RGB as a stronger check than merely
  // relaxing a global threshold. Independent layer RGBA above stays byte-exact.
  const decodedMerged = decoded.imageData.data;
  const predicted = new Uint8ClampedArray(1);
  let maxPremultipliedRgbError = 0;
  for (let pixel = 0; pixel < merged.length; pixel += 4) {
    assert(decodedMerged[pixel + 3] === merged[pixel + 3], 'Merged preview alpha channel differs.');
    const alpha = merged[pixel + 3] / 255;
    for (let channel = 0; channel < 3; channel++) {
      const original = merged[pixel + channel];
      if (alpha > 0 && alpha < 1) {
        const matted = Math.trunc(original * alpha + 255 * (1 - alpha));
        const reciprocalAlpha = 1 / alpha;
        predicted[0] = matted * reciprocalAlpha + 255 * (1 - reciprocalAlpha);
      } else predicted[0] = original;
      assert(decodedMerged[pixel + channel] === predicted[0], 'Merged preview differs from the pinned white-matte encoder/decoder prediction.');
      const error = Math.abs(decodedMerged[pixel + channel] - original) * alpha;
      assert(error <= 1 + 0.5 * alpha + 1e-10, 'Merged preview exceeds the derived per-pixel quantization bound.');
      maxPremultipliedRgbError = Math.max(maxPremultipliedRgbError, error);
    }
  }
  assert(maxPremultipliedRgbError <= 1.5, `Merged preview exceeds PSD white-matte quantization bound: ${maxPremultipliedRgbError}`);
  return { signature: '8BPS', version: 1, colorMode: 'RGB', bitsPerChannel: 8, width: decoded.width, height: decoded.height,
    channels: decoded.channels, rasterLayers: leaves.length, iccSha256: sha256(profile), iccBytes: profile.length, layers: proofs,
    mergedRgbaSha256: sha256(byteView(decoded.imageData.data)),
    mergedPreviewVerification: { alphaExact: true, pinnedCodecPredictionByteExact: true,
      maxPremultipliedRgbError, allowedPremultipliedRgbError: 1.5, derivedPerPixelBound: '1 + 0.5*(alpha/255)',
      reason: 'ag-psd 34.1.0 white-matte Uint8Array truncation followed by Uint8ClampedArray unmatte rounding; every independent layer RGBA is byte-exact' } };
}

export async function buildInterviewerPsd(manifestPath, options = {}) {
  const { ag, sharp, version } = await dependencies();
  const absoluteManifest = path.resolve(manifestPath), directory = path.dirname(absoluteManifest);
  const sourceManifest = await readFile(absoluteManifest), manifest = JSON.parse(sourceManifest.toString('utf8'));
  const canvas = manifest.canvas;
  const layers = await readLayers(manifest, directory, sharp);
  const profile = await srgbProfile(sharp);
  const dpi = canvas.dpi ?? 72;
  assert(Number.isFinite(dpi) && dpi > 0 && dpi < 10000, 'canvas.dpi must be positive and finite.');
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(directory, '..'));
  await mkdir(outputDirectory, { recursive: true });
  const outputNames = ['artwork_master.psd', 'cubism_import.psd', 'psd-verification.json'];
  if (!options.overwrite) for (const name of outputNames) {
    let exists = false; try { await access(path.join(outputDirectory, name)); exists = true; } catch { /* New output. */ }
    assert(!exists, `Output exists: ${path.join(outputDirectory, name)}. Use a new directory or explicitly pass --overwrite.`);
  }
  const report = {
    status: 'verified-file-format', generatedAt: new Date().toISOString(),
    manifest: absoluteManifest, manifestSha256: sha256(sourceManifest), library: { name: 'ag-psd', version },
    canvas: { width: canvas.width, height: canvas.height, dpi },
    inputs: layers.map(layer => Object.fromEntries(Object.entries(layer).filter(([key]) => key !== 'data' && key !== 'psdId'))), outputs: [],
    scope: 'Independent RGBA raster layers are preserved. No segmentation, repainting, anatomical verification, PSD application import, or rigging was performed by this packaging helper.',
    unverified: ['Photoshop UI opening/editing', 'Cubism Editor import', 'part anatomy and visual completeness', 'rigging and export'],
  };
  for (const kind of ['artwork_master', 'cubism_import']) {
    const selected = kind === 'artwork_master' ? layers : layers.filter(layer => !excludedFromCubism.has(layer.role));
    // Import PSD keeps art layers flat. This avoids accidental group clipping,
    // allows independent ArtMesh assignment, and retains the exact visual order.
    const children = kind === 'artwork_master' ? groupedChildren(selected) : selected.map(makeLeaf);
    const merged = await composite(selected, canvas, sharp);
    const psd = { width: canvas.width, height: canvas.height, colorMode: 3, bitsPerChannel: 8, children,
      imageData: { width: canvas.width, height: canvas.height, data: merged },
      imageResources: { iccProfile: profile,
        resolutionInfo: { horizontalResolution: dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' },
        versionInfo: { hasRealMergedData: true, writerName: `each-answer PSD packager / ag-psd ${version}`, readerName: 'Adobe Photoshop', fileVersion: 1 } } };
    const bytes = ag.writePsdBuffer(psd, { noBackground: true, trimImageData: false, generateThumbnail: false });
    verifySaved(bytes, selected, children, canvas, profile, merged, ag);
    const outputPath = path.join(outputDirectory, `${kind}.psd`);
    await writeFile(outputPath, bytes, { flag: options.overwrite ? 'w' : 'wx' });
    const saved = await readFile(outputPath);
    assert(saved.equals(bytes), 'Written PSD bytes differ from the verified buffer.');
    const proof = verifySaved(saved, selected, children, canvas, profile, merged, ag);
    report.outputs.push({ kind, path: outputPath, bytes: saved.length, sha256: sha256(saved), ...proof });
  }
  const reportPath = path.join(outputDirectory, 'psd-verification.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: options.overwrite ? 'w' : 'wx' });
  return { ...report, reportPath };
}

async function selfTest() {
  const { sharp } = await dependencies();
  const outputDirectory = path.join(projectRoot, 'tmp', 'psd-tools', 'self-test');
  const partsDirectory = path.join(outputDirectory, 'parts');
  await mkdir(partsDirectory, { recursive: true });
  const definitions = [
    { id: 'body', name: 'Body_몸통', group: 'Body', path: 'body.png', x: 2, y: 1, z: 0, visible: true, role: 'part', color: [90, 70, 60, 255] },
    { id: 'face', name: 'Face_Base', group: 'Head/Face', path: 'face.png', x: 3, y: 0, z: 10, visible: true, role: 'part', color: [220, 150, 100, 128] },
    { id: 'mouth_alt', name: 'Mouth_Alternate', group: 'Head/Face', path: 'mouth.png', x: 4, y: 2, z: 11, visible: false, role: 'part', color: [130, 20, 30, 255] },
    { id: 'reference', name: 'Reference_비납품예시', group: 'Reference', path: 'reference.png', x: 0, y: 0, z: 100, visible: false, role: 'reference', color: [40, 50, 60, 255] },
  ];
  for (const layer of definitions) {
    const pixels = Buffer.alloc(3 * 3 * 4);
    for (const pixel of [1, 3, 4, 5, 7]) for (let channel = 0; channel < 4; channel++) pixels[pixel * 4 + channel] = layer.color[channel];
    await sharp(pixels, { raw: { width: 3, height: 3, channels: 4 } }).withIccProfile('srgb').png().toFile(path.join(partsDirectory, layer.path));
  }
  const manifest = { fixture: true, canvas: { width: 10, height: 8, dpi: 72 }, layers: definitions.map(layer => Object.fromEntries(Object.entries(layer).filter(([key]) => key !== 'color'))) };
  const manifestPath = path.join(partsDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const result = await buildInterviewerPsd(manifestPath, { outputDirectory, overwrite: true });
  assert(result.outputs[0].rasterLayers === 4 && result.outputs[1].rasterLayers === 3, 'Self-test layer filtering failed.');
  return { test: 'synthetic-file-format-fixture-only', status: 'passed', outputs: result.outputs.map(({ path: outputPath, rasterLayers, bytes }) => ({ path: outputPath, rasterLayers, bytes })), reportPath: result.reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--self-test')) console.log(JSON.stringify(await selfTest(), null, 2));
    else if (!process.argv[2] || process.argv.includes('--help')) console.log('Usage: node scripts/build-interviewer-psd.mjs <parts/manifest.json> [--output-dir <directory>] [--overwrite]\nSelf-test: node scripts/build-interviewer-psd.mjs --self-test\nSetup: npm install --prefix tmp/psd-tools --save-exact ag-psd@34.1.0 --ignore-scripts\nSee the script header for manifest, color, alpha, grouping and verification contracts.');
    else {
      const outputIndex = process.argv.indexOf('--output-dir');
      assert(outputIndex < 0 || process.argv[outputIndex + 1], '--output-dir needs a directory.');
      const report = await buildInterviewerPsd(process.argv[2], { outputDirectory: outputIndex < 0 ? undefined : process.argv[outputIndex + 1], overwrite: process.argv.includes('--overwrite') });
      console.log(JSON.stringify({ status: report.status, outputs: report.outputs.map(({ path: outputPath, rasterLayers, bytes }) => ({ path: outputPath, rasterLayers, bytes })), reportPath: report.reportPath }, null, 2));
    }
  } catch (error) { console.error(`PSD packaging failed: ${error.message}`); process.exitCode = 1; }
}

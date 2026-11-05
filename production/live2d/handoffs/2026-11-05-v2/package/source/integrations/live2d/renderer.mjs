/**
 * Application adapter for the pinned official Cubism Web Framework 5-r.5 and
 * MotionSync Plugin 5-r.3. Run scripts/setup-live2d-sdk.mjs to resolve imports.
 * This file does not include Core binaries or author a Live2D model.
 */
import { CubismFramework, Option, LogLevel } from '@framework/live2dcubismframework';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismShaderManager_WebGL, CubismShaderSet } from '@framework/rendering/cubismshader_webgl';
import { CubismPhysics } from '@framework/physics/cubismphysics';
import { CubismMotionSync, MotionSyncOption } from '@motionsyncframework/live2dcubismmotionsync';
import { assertRuntimeParameterIds, assertRuntimeFrameParameters, parseSceneManifest, ScenePreparationError } from '../../lib/live2d/manifest.ts';

const sampleRate = 48_000;
const shaderRoot = new URL('./shaders/', import.meta.url).href;
let frameworkUsers = 0;
let motionSyncUsers = 0;
const activeCanvases = new WeakSet();

function fail(message, code = 'renderer_failed') { throw new ScenePreparationError(code, message); }
function checkSignal(signal) { signal.throwIfAborted(); }
function sameOriginUrl(input, base = location.href) {
  const url = new URL(input, base);
  if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('장면 파일은 현재 서비스에서 불러와야 합니다.', 'asset_origin_mismatch');
  return url.href;
}
async function readBytes(url, signal, audio = false, kind = 'asset') {
  checkSignal(signal);
  const resolved = new URL(url, location.href);
  const target = audio && resolved.protocol === 'blob:' && resolved.origin === location.origin ? resolved.href : sameOriginUrl(url);
  let response;
  try { response = await fetch(target, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); }
  catch { checkSignal(signal); fail(`장면 파일을 불러오지 못했습니다: ${resolved.pathname}`, `${kind}_load_failed`); }
  if (!response.ok) fail(`장면 파일을 불러오지 못했습니다: ${resolved.pathname} (${response.status})`, response.status === 404 ? `${kind}_missing` : `${kind}_load_failed`);
  const buffer = await response.arrayBuffer();
  checkSignal(signal);
  if (!buffer.byteLength || buffer.byteLength > 64 * 1024 * 1024) fail(`장면 파일의 크기를 확인해 주세요: ${resolved.pathname}`, `${kind}_invalid`);
  return buffer;
}

function acquireFramework(withMotionSync) {
  if (!globalThis.Live2DCubismCore) fail('Cubism Core 파일이 제공되거나 로드되지 않았습니다.', 'cubism_core_unavailable');
  if (withMotionSync && !globalThis.Live2DCubismMotionSyncCore) fail('MotionSync Core 파일이 제공되거나 로드되지 않았습니다.', 'motionsync_core_unavailable');
  if (!frameworkUsers) {
    const option = new Option();
    option.logFunction = message => console.warn('[Cubism]', message);
    option.loggingLevel = LogLevel.LogLevel_Warning;
    if (!CubismFramework.startUp(option)) fail('Cubism Framework failed to start.');
    CubismFramework.initialize();
  }
  frameworkUsers += 1;
  try {
    if (withMotionSync) {
      if (!motionSyncUsers) {
        const option = new MotionSyncOption();
        option.logFunction = message => console.warn('[MotionSync]', message);
        option.loggingLevel = LogLevel.LogLevel_Warning;
        CubismMotionSync.startUp(option);
        CubismMotionSync.initialize();
      }
      motionSyncUsers += 1;
    }
  } catch (error) {
    if (--frameworkUsers === 0) { CubismFramework.dispose(); CubismFramework.cleanUp(); }
    throw error;
  }
}

function releaseFramework(withMotionSync) {
  if (withMotionSync && motionSyncUsers > 0 && --motionSyncUsers === 0) {
    CubismMotionSync.dispose();
    CubismMotionSync.cleanUp();
  }
  if (frameworkUsers > 0 && --frameworkUsers === 0) {
    CubismFramework.dispose();
    CubismFramework.cleanUp();
  }
}

function makeShader(gl, kind, source) {
  const shader = gl.createShader(kind);
  if (!shader) fail('Scene shader allocation failed.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    fail('Scene shader compilation failed.');
  }
  return shader;
}

function makeLayerRenderer(gl) {
  const vertex = makeShader(gl, gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; in vec2 texcoord; out vec2 uv; void main(){uv=texcoord;gl_Position=vec4(position,0.,1.);}');
  const fragment = makeShader(gl, gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; in vec2 uv; uniform sampler2D image; out vec4 color; void main(){color=texture(image,uv);}');
  const program = gl.createProgram();
  if (!program) fail('Scene program allocation failed.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); fail('Scene program link failed.'); }
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) { gl.deleteProgram(program); fail('Scene geometry allocation failed.'); }
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,1,0,0,-1,-1,0,1,1,1,1,0,1,1,1,0,-1,-1,0,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  const texcoord = gl.getAttribLocation(program, 'texcoord');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(texcoord);
  gl.vertexAttribPointer(texcoord, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  return {
    draw(texture) {
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    },
    dispose() { gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); },
  };
}

async function loadTexture(gl, url, signal) {
  const bytes = await readBytes(url, signal, false, 'texture');
  const image = new Image();
  const objectUrl = URL.createObjectURL(new Blob([bytes]));
  try {
    await new Promise((resolve, reject) => {
      const abort = () => { image.src = ''; reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      image.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
      image.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('Scene texture could not be decoded.')); };
      signal.addEventListener('abort', abort, { once: true });
      image.src = objectUrl;
      if (signal.aborted) abort();
    });
    checkSignal(signal);
    if (Math.max(image.naturalWidth, image.naturalHeight) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) fail('Scene texture exceeds the device limit.');
    const texture = gl.createTexture();
    if (!texture) fail('Scene texture allocation failed.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  } finally {
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(objectUrl);
  }
}

async function prepareShaders(gl, signal) {
  // R5's loadShaders() starts unabortable asynchronous fetches. Preload with the
  // scene lifetime signal, then use its public registration functions in one
  // synchronous step. These declared shader fields are pinned to 5-r.5.
  const fields = {
    'vertshadersrc.vert': '_vertShaderSrc',
    'vertshadersrcmasked.vert': '_vertShaderSrcMasked',
    'vertshadersrcsetupmask.vert': '_vertShaderSrcSetupMask',
    'fragshadersrcsetupmask.frag': '_fragShaderSrcSetupMask',
    'fragshadersrcpremultipliedalpha.frag': '_fragShaderSrcPremultipliedAlpha',
    'fragshadersrcmaskpremultipliedalpha.frag': '_fragShaderSrcMaskPremultipliedAlpha',
    'fragshadersrcmaskinvertedpremultipliedalpha.frag': '_fragShaderSrcMaskInvertedPremultipliedAlpha',
    'vertshadersrccopy.vert': '_vertShaderSrcCopy',
    'fragshadersrccopy.frag': '_fragShaderSrcCopy',
    'fragshadersrccolorblend.frag': '_fragShaderSrcColorBlend',
    'fragshadersrcalphablend.frag': '_fragShaderSrcAlphaBlend',
    'vertshadersrcblend.vert': '_vertShaderSrcBlend',
    'fragshadersrcpremultipliedalphablend.frag': '_fragShaderSrcBlend',
  };
  let shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
  if (!shader._isShaderLoaded) {
    const sources = await Promise.all(Object.entries(fields).map(async ([filename, field]) => [field, new TextDecoder().decode(await readBytes(new URL(filename, shaderRoot).href, signal, false, 'shader'))]));
    checkSignal(signal);
    shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    for (const [field, source] of sources) shader[field] = source;
    shader._shaderSets = Array.from({ length: shader._shaderCount }, () => new CubismShaderSet());
    shader.registerShader();
    shader.registerBlendShader();
    shader._isShaderLoading = false;
    shader._isShaderLoaded = true;
  }
  if (shader._shaderSets.some(set => !set.shaderProgram || !gl.getProgramParameter(set.shaderProgram, gl.LINK_STATUS))) fail('Cubism shader compilation failed.');
}

function restBounds(model) {
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (let index = 0; index < model.getDrawableCount(); index += 1) {
    const vertices = model.getDrawableVertices(index);
    for (let offset = 0; offset < vertices.length; offset += 2) {
      left = Math.min(left, vertices[offset]); right = Math.max(right, vertices[offset]);
      bottom = Math.min(bottom, vertices[offset + 1]); top = Math.max(top, vertices[offset + 1]);
    }
  }
  if (![left, right, bottom, top].every(Number.isFinite) || right <= left || top <= bottom) fail('The model has no valid drawable bounds.');
  return { left, right, bottom, top };
}

function fitModel(item, scene) {
  const { layout } = item.definition;
  const b = item.bounds;
  const unitsPerPixel = 2 / scene.height;
  const scale = Math.min(layout.width / (b.right - b.left), layout.height / (b.top - b.bottom)) * unitsPerPixel;
  const matrix = new CubismMatrix44();
  matrix.scale(scale / (scene.width / scene.height), scale);
  matrix.translate(
    (2 * layout.centerX / scene.width - 1) - (b.left + b.right) / 2 * scale / (scene.width / scene.height),
    (1 - 2 * layout.centerY / scene.height) - (b.bottom + b.top) / 2 * scale,
  );
  return matrix;
}

function closeMouth(item) {
  for (const id of item.mouthIds) {
    const index = item.parameterIndices.get(id);
    if (index !== undefined) item.model.setParameterValueByIndex(index, item.model.getParameterDefaultValue(index));
  }
  const open = item.parameterIndices.get('ParamMouthOpenY');
  if (open !== undefined) item.model.setParameterValueByIndex(open, 0);
}

export function createRenderer() {
  const lifetime = new AbortController();
  let canvas, gl, manifest, layerRenderer, resourceSignal;
  let disposed = false, lease = false, withMotionSync = false, canvasLease = false;
  let models = [], textures = [], drawables = [];
  let viewport = [0, 0, 1, 1];
  let speechKey = '', speechAbort, pcm = null, audioError = null, previousSample = 0;
  let generation = 0;

  function resetMotionSync(item) {
    item.motionSync?.release();
    item.motionSync = CubismMotionSync.create(item.model, item.motionSyncBytes, item.motionSyncBytes.byteLength, sampleRate);
    if (!item.motionSync) fail('전용 모델의 MotionSync를 초기화하지 못했습니다.', 'motion_sync_invalid');
    const data = item.motionSync.getData();
    if (!data.getSettingCount()) fail('전용 모델에 실제 MotionSync 매핑이 없습니다.', 'motion_sync_invalid');
    item.pending = Array.from({ length: data.getSettingCount() }, () => []);
    item.mouthIds = new Set();
    for (let index = 0; index < data.getSettingCount(); index += 1) {
      for (const parameter of data.getSetting(index).cubismParameterList) {
        if (!item.parameterIndices.has(parameter.id)) fail(`${item.definition.speakerId}의 MotionSync 대상이 실제 모델에 없습니다: ${parameter.id}`, 'model_parameter_missing');
        item.mouthIds.add(parameter.id);
      }
    }
  }

  function updateSpeech(speech) {
    const key = speech ? `${speech.turnId}\u0000${speech.speakerId}\u0000${speech.src}` : '';
    if (key === speechKey) return;
    speechKey = key;
    speechAbort?.abort();
    pcm = null; audioError = null; previousSample = 0;
    generation += 1;
    for (const item of models) {
      if (speech && item.definition.speakerId === speech.speakerId && item.motionSyncBytes) resetMotionSync(item);
      else for (const pending of item.pending) pending.length = 0;
    }
    if (!speech || !withMotionSync) return;
    const currentGeneration = generation;
    speechAbort = new AbortController();
    const signal = AbortSignal.any([resourceSignal, speechAbort.signal]);
    void (async () => {
      const bytes = await readBytes(speech.src, signal, true, 'audio');
      const decoder = new OfflineAudioContext(1, 1, sampleRate);
      const decoded = await decoder.decodeAudioData(bytes);
      checkSignal(signal);
      if (decoded.duration > 300) fail('The interviewer audio exceeds the scene turn limit.');
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const values = decoded.getChannelData(channel);
        for (let index = 0; index < values.length; index += 1) mono[index] += values[index] / decoded.numberOfChannels;
      }
      if (!disposed && generation === currentGeneration) pcm = mono;
    })().catch(error => { if (!signal.aborted && !disposed && generation === currentGeneration) audioError = error; });
  }

  return {
    async prepare(target, definition, signal) {
      if (disposed || lease) fail('Create a new renderer instance before preparing again.');
      checkSignal(signal);
      signal = AbortSignal.any([signal, lifetime.signal]);
      definition = parseSceneManifest(definition, location.origin);
      manifest = definition; canvas = target; resourceSignal = signal;
      if (definition.status !== 'ready' || definition.models.length !== 2) fail('검사가 확인된 전용 면접관 모델이 아직 준비되지 않았습니다.', 'model_not_ready');
      if (activeCanvases.has(canvas)) fail('The scene canvas already has an active renderer.');
      activeCanvases.add(canvas); canvasLease = true;
      withMotionSync = definition.runtime?.lipSync === 'motion-sync';
      try {
        gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
        if (!gl) fail('The interview scene requires WebGL2.');
        acquireFramework(withMotionSync); lease = true;
        layerRenderer = makeLayerRenderer(gl);
        for (const layer of definition.layers) {
          const texture = await loadTexture(gl, sameOriginUrl(layer.url), signal);
          textures.push(texture);
          drawables.push({ type: 'layer', order: layer.order, texture });
        }
        for (let index = 0; index < definition.models.length; index += 1) {
          const entry = definition.models[index];
          const baseUrl = sameOriginUrl(entry.url);
          const settingsBytes = await readBytes(baseUrl, signal, false, 'model_settings');
          let setting;
          try { setting = new CubismModelSettingJson(settingsBytes, settingsBytes.byteLength); }
          catch { fail(`${entry.speakerId} 모델 설정을 읽지 못했습니다.`, 'model_settings_invalid'); }
          const user = new CubismUserModel();
          const item = { user, setting, definition: entry, model: null, textures: [], parameterIndices: new Map(), parameterIds: new Set(), mouthIds: new Set(['ParamMouthOpenY', 'ParamMouthForm']), motionSync: null, pending: [] };
          models.push(item);
          const mocUrl = setting.getModelFileName();
          if (!mocUrl) fail(`${entry.speakerId} 모델 설정에 moc3 파일 경로가 없습니다.`, 'model_missing');
          const mocBytes = await readBytes(sameOriginUrl(mocUrl, baseUrl), signal, false, 'model');
          try { user.loadModel(mocBytes, true); }
          catch { fail(`${entry.speakerId}의 실제 moc3 모델을 로드하지 못했습니다.`, 'model_load_failed'); }
          item.model = user.getModel();
          if (!item.model) fail(`${entry.speakerId}의 실제 moc3 모델을 로드하지 못했습니다.`, 'model_load_failed');
          item.bounds = restBounds(item.model);
          item.matrix = fitModel(item, definition.canvas);
          for (let parameter = 0; parameter < item.model.getParameterCount(); parameter += 1) item.parameterIndices.set(item.model.getParameterId(parameter).getString().s, parameter);
          item.parameterIds = new Set(item.parameterIndices.keys());
          assertRuntimeParameterIds(item.parameterIds, entry.speakerId);
          if (setting.getPhysicsFileName()) {
            const physics = await readBytes(sameOriginUrl(setting.getPhysicsFileName(), baseUrl), signal, false, 'physics');
            item.physics = CubismPhysics.create(physics, physics.byteLength);
          }
          user.createRenderer(canvas.width || 1, canvas.height || 1);
          const renderer = user.getRenderer();
          renderer.startUp(gl);
          renderer.setIsPremultipliedAlpha(true);
          if (!setting.getTextureCount()) fail(`${entry.speakerId}의 실제 모델 텍스처가 없습니다.`, 'texture_missing');
          for (let textureIndex = 0; textureIndex < setting.getTextureCount(); textureIndex += 1) {
            const texture = await loadTexture(gl, sameOriginUrl(setting.getTextureFileName(textureIndex), baseUrl), signal);
            textures.push(texture); item.textures.push(texture);
            renderer.bindTexture(textureIndex, texture);
          }
          await prepareShaders(gl, signal);
          if (withMotionSync) {
            if (!entry.motionSyncUrl) fail(`${entry.speakerId}의 실제 MotionSync 설정 경로가 없습니다.`, 'motion_sync_missing');
            item.motionSyncBytes = await readBytes(sameOriginUrl(entry.motionSyncUrl), signal, false, 'motion_sync');
            resetMotionSync(item);
          }
          item.model.saveParameters();
          drawables.push({ type: 'model', order: index ? 110 : 100, item });
        }
        drawables.sort((a, b) => a.order - b.order);
        checkSignal(signal);
      } catch (error) { this.dispose(); throw error; }
    },

    render(frame) {
      if (disposed || !lease) return;
      checkSignal(resourceSignal);
      if (gl.isContextLost()) fail('The interview graphics context was lost.');
      updateSpeech(frame.speech);
      if (audioError) throw audioError;
      const speech = frame.speech;
      const active = speech?.playing && frame.state === 'speaking';
      const sample = Math.max(0, Math.min(pcm?.length ?? 0, Math.floor((speech?.timeSeconds ?? 0) * sampleRate)));
      if (sample < previousSample || sample - previousSample > sampleRate / 2) {
        for (const item of models) if (item.motionSyncBytes) resetMotionSync(item);
        previousSample = Math.max(0, sample - sampleRate / 10);
      }
      for (const item of models) {
        item.model.loadParameters();
        const parameters = frame.parameters[item.definition.speakerId] ?? {};
        assertRuntimeFrameParameters(parameters, item.parameterIds, item.definition.speakerId);
        for (const [id, value] of Object.entries(parameters)) {
          const index = item.parameterIndices.get(id);
          // The assertion permits only an absent, disabled hand channel here.
          if (index === undefined || item.mouthIds.has(id)) continue;
          item.model.setParameterValueByIndex(index, Math.min(item.model.getParameterMaximumValue(index), Math.max(item.model.getParameterMinimumValue(index), value)));
        }
        item.physics?.evaluate(item.model, Math.min(frame.deltaSeconds, 0.1));
        if (active && speech.speakerId === item.definition.speakerId && !withMotionSync) {
          for (const id of item.mouthIds) {
            const value = frame.parameters[item.definition.speakerId]?.[id];
            const index = item.parameterIndices.get(id);
            if (index !== undefined && Number.isFinite(value)) item.model.setParameterValueByIndex(index, Math.min(item.model.getParameterMaximumValue(index), Math.max(item.model.getParameterMinimumValue(index), value)));
          }
        } else if (active && speech.speakerId === item.definition.speakerId && item.motionSync && pcm) {
          const added = pcm.subarray(previousSample, sample);
          for (let index = 0; index < item.pending.length; index += 1) {
            const pending = item.pending[index];
            for (const value of added) pending.push(value);
            if (pending.length > sampleRate / 2) fail('MotionSync audio processing stopped advancing.');
            item.motionSync.setSoundBuffer(index, pending, 0);
          }
          item.motionSync.updateParameters(item.model, Math.min(frame.deltaSeconds, 0.1));
          for (let index = 0; index < item.pending.length; index += 1) item.pending[index].splice(0, item.motionSync.getLastTotalProcessedCount(index));
          // Mouth closure follows actual decoded output silence, including pauses.
          let square = 0;
          const start = Math.max(0, sample - 960);
          for (let index = start; index < sample; index += 1) square += pcm[index] * pcm[index];
          if (sample <= start || Math.sqrt(square / (sample - start)) < 0.004) closeMouth(item);
        } else if (!active || speech.speakerId !== item.definition.speakerId || withMotionSync) closeMouth(item);
        item.model.update();
      }
      previousSample = sample;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      for (const drawable of drawables) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(...viewport);
        if (drawable.type === 'layer') layerRenderer.draw(drawable.texture);
        else {
          gl.bindVertexArray(null);
          const renderer = drawable.item.user.getRenderer();
          renderer.setMvpMatrix(drawable.item.matrix);
          renderer.setRenderState(null, viewport);
          renderer.drawModel();
        }
      }
    },

    resize(width, height, dpr) {
      if (!canvas || disposed) return;
      const ratio = Number.isFinite(dpr) ? Math.min(2, Math.max(1, dpr)) : 1;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const fit = Math.min(canvas.width / manifest.canvas.width, canvas.height / manifest.canvas.height);
      const w = Math.max(1, Math.round(manifest.canvas.width * fit));
      const h = Math.max(1, Math.round(manifest.canvas.height * fit));
      viewport = [Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h];
      for (const item of models) item.user.setRenderTargetSize(w, h);
    },

    dispose() {
      if (disposed) return;
      disposed = true; generation += 1; lifetime.abort(); speechAbort?.abort(); pcm = null;
      for (const item of models) { item.motionSync?.release(); CubismPhysics.delete(item.physics); item.user.release(); item.setting.release(); }
      for (const texture of textures) gl?.deleteTexture(texture);
      layerRenderer?.dispose();
      models = []; textures = []; drawables = [];
      if (lease) releaseFramework(withMotionSync);
      if (canvasLease) activeCanvases.delete(canvas);
      canvasLease = false;
      lease = false;
    },
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CN_HF_MIRROR_URL,
  DEFAULT_HF_MIRROR_URL,
  DEFAULT_LOCAL_MODEL_ID,
  DEFAULT_VOICE_CONFIG,
  LOCAL_SPEECH_MODELS,
  LocalModelStore,
  LocalSpeechRuntime,
  VoiceInputEngine,
  buildModelDownloadUrl,
  createVoiceInputWorkerDefinition,
  encodePcm16WavBuffer,
  formatBytes,
  getLocalSpeechModel,
  normalizeVoiceConfig,
} from '../worker/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function makeSyntheticModel(payloadText, overrides = {}) {
  const bytes = Buffer.from(payloadText, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    model: Object.freeze({
      id: overrides.id || 'test-org/tiny-test-gguf',
      revision: overrides.revision || '0123456789abcdef0123456789abcdef01234567',
      name: overrides.name || 'Tiny Test GGUF',
      description: 'Synthetic test model',
      filename: overrides.filename || 'tiny-test-Q8_0.gguf',
      size: bytes.length,
      sha256,
      languages: ['zh', 'en'],
      languageCount: 2,
      recommended: true,
      supportsStreaming: false,
      supportsLanguageDetection: true,
      supportsTranslation: true,
      tags: ['测试'],
    }),
  };
}

function makeVoicedWavBase64(durationSec = 0.6, sampleRate = 16000) {
  const count = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = 0.25 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return encodePcm16WavBuffer(samples, sampleRate).toString('base64');
}

describe('Local Offline Speech Models (GGUF + transcribe.cpp)', () => {
  it('ships 12 curated GGUF models with valid revisions, sizes, SHA-256 digests, and mirror URLs', () => {
    assert.equal(LOCAL_SPEECH_MODELS.length, 12);
    assert.ok(getLocalSpeechModel(DEFAULT_LOCAL_MODEL_ID), 'Default local model must exist');

    const ids = new Set();
    for (const model of LOCAL_SPEECH_MODELS) {
      assert.ok(!ids.has(model.id), `Duplicate model ID: ${model.id}`);
      ids.add(model.id);
      assert.match(model.revision, /^[0-9a-f]{40}$/, `Invalid revision for ${model.id}`);
      assert.match(model.sha256, /^[0-9a-f]{64}$/, `Invalid sha256 for ${model.id}`);
      assert.ok(Number.isInteger(model.size) && model.size > 0, `Invalid size for ${model.id}`);
      assert.match(model.filename, /\.gguf$/i, `Expected .gguf filename for ${model.id}`);

      const hfUrl = buildModelDownloadUrl(model, DEFAULT_HF_MIRROR_URL);
      assert.equal(
        hfUrl,
        `https://huggingface.co/${model.id}/resolve/${model.revision}/${model.filename}`,
      );
      const cnUrl = buildModelDownloadUrl(model, `${CN_HF_MIRROR_URL}/`);
      assert.equal(
        cnUrl,
        `https://hf-mirror.com/${model.id}/resolve/${model.revision}/${model.filename}`,
      );
    }

    assert.equal(formatBytes(252_684_608), '241 MB');
    assert.equal(formatBytes(2_185_030_624), '2.03 GB');
  });

  it('declares local-model config schema with accurate x-visible-when visibility rules', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(PLUGIN_ROOT, '.dimo-plugin', 'plugin.json'), 'utf8'),
    );
    const props = manifest.config.schema.properties;
    assert.ok(props.providerProtocol.enum.includes('local-model'));

    for (const field of [
      'localModelId',
      'localAcceleration',
      'localUnloadTimeoutSec',
      'hfMirrorUrl',
      'localModelsDir',
    ]) {
      assert.ok(props[field], `Manifest missing field ${field}`);
      assert.deepEqual(props[field]['x-visible-when'], {
        providerProtocol: ['local-model'],
      });
    }

    // Cloud-only fields remain hidden for both browser-speech and local-model
    for (const cloudField of [
      'baseUrl',
      'apiKey',
      'model',
      'cleanupModel',
      'useLlmCleanup',
      'cleanupInstructions',
    ]) {
      const visibleFor = props[cloudField]['x-visible-when']?.providerProtocol || [];
      assert.ok(!visibleFor.includes('local-model'), `${cloudField} should be hidden for local-model`);
      assert.ok(
        !visibleFor.includes('browser-speech'),
        `${cloudField} should be hidden for browser-speech`,
      );
    }

    // Config normalizer bounds localUnloadTimeoutSec and validates localAcceleration
    const norm = normalizeVoiceConfig({
      providerProtocol: 'local-model',
      localAcceleration: 'invalid',
      localUnloadTimeoutSec: 99999,
      hfMirrorUrl: 'https://hf-mirror.com///',
    });
    assert.equal(norm.providerProtocol, 'local-model');
    assert.equal(norm.localAcceleration, 'auto');
    assert.equal(norm.localUnloadTimeoutSec, 3600);
    assert.equal(norm.hfMirrorUrl, 'https://hf-mirror.com');
  });

  it('supports resumable HTTP Range downloads, SHA-256 verification, .verified caching, and corrupt hash rejection', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'dimo-voice-store-'));
    try {
      const { bytes, model } = makeSyntheticModel('GGUF-TEST-PAYLOAD-'.repeat(200));
      const splitAt = Math.floor(bytes.length / 2);
      const requestRanges = [];
      let callCount = 0;

      const store = new LocalModelStore({
        modelsDir: tmpDir,
        catalog: [model],
        knownSearchRoots: [],
        fetchImpl: async (_url, init) => {
          callCount += 1;
          const rangeHeader = init?.headers?.Range || null;
          requestRanges.push(rangeHeader);

          if (callCount === 1) {
            // Simulate partial stream that truncates halfway
            const part1 = bytes.subarray(0, splitAt);
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(part1);
                controller.close();
              },
            });
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-length': String(bytes.length) }),
              body: stream,
            };
          }

          // Second attempt resumes via Range: bytes=<splitAt>-
          const part2 = bytes.subarray(splitAt);
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(part2);
              controller.close();
            },
          });
          return {
            ok: true,
            status: 206,
            headers: new Headers({
              'content-range': `bytes ${splitAt}-${bytes.length - 1}/${bytes.length}`,
              'content-length': String(part2.length),
            }),
            body: stream,
          };
        },
      });

      const progressEvents = [];
      let verifiedHookCalled = false;
      const dlResult = await store.download(model, {
        hfMirrorUrl: CN_HF_MIRROR_URL,
        onProgress: (p) => progressEvents.push(p),
        onVerificationStart: () => {
          verifiedHookCalled = true;
        },
      });

      assert.equal(callCount, 2);
      assert.deepEqual(requestRanges, [null, `bytes=${splitAt}-`]);
      assert.equal(verifiedHookCalled, true);
      assert.ok(progressEvents.length >= 1);
      assert.equal(dlResult.reused, false);
      assert.equal(await store.isReady(model), true);
      assert.equal(await store.getInstalledPath(model), dlResult.path);
      assert.ok(existsSync(`${dlResult.path}.verified`), '.verified marker should be created');

      // Corrupt hash should reject cleanly and leave no leftover file
      const badModel = {
        ...model,
        id: 'test-org/corrupt-gguf',
        filename: 'corrupt-Q8_0.gguf',
        sha256: '0'.repeat(64),
      };
      const badStore = new LocalModelStore({
        modelsDir: tmpDir,
        catalog: [badModel],
        knownSearchRoots: [],
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      });
      await assert.rejects(
        () => badStore.download(badModel),
        /SHA-256/,
      );
      assert.equal(await badStore.isReady(badModel), false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('zero-copy links existing local copies from cache/folder and preserves originals on remove', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'dimo-voice-link-'));
    const storeDir = path.join(tmpRoot, 'dimo-models');
    const externalDir = path.join(tmpRoot, 't3-models');
    try {
      await mkdir(externalDir, { recursive: true });
      const { bytes, model } = makeSyntheticModel('GGUF-EXISTING-COPY-'.repeat(120));
      const externalFile = path.join(externalDir, model.filename);
      await writeFile(externalFile, bytes);

      // 1. Explicit linkFromSource scan
      const store = new LocalModelStore({
        modelsDir: storeDir,
        catalog: [model],
        knownSearchRoots: [],
      });
      const linkRes = await store.linkFromSource(externalDir);
      assert.equal(linkRes.linked.length, 1);
      assert.equal(linkRes.linked[0].modelId, model.id);
      assert.equal(await store.isReady(model), true);
      const linkedFrom = await store.getLinkedFrom(model);
      assert.equal(path.resolve(linkedFrom), path.resolve(externalFile));

      // Removing from Dimo store must NEVER delete the original external source file
      await store.remove(model.id);
      assert.equal(await store.isReady(model), false);
      assert.equal(existsSync(externalFile), true, 'Original external model file must remain intact');

      // 2. Automatic zero-copy reuse via knownSearchRoots during download() with zero network calls
      let fetchCalled = false;
      const autoStore = new LocalModelStore({
        modelsDir: storeDir,
        catalog: [model],
        knownSearchRoots: [externalDir],
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('Should not hit network when local copy exists');
        },
      });
      const reused = await autoStore.download(model);
      assert.equal(fetchCalled, false);
      assert.equal(reused.reused, true);
      assert.equal(path.resolve(reused.linkedFrom), path.resolve(externalFile));
      assert.equal(await autoStore.isReady(model), true);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('executes end-to-end local-model transcription, structured missing errors, and voice.local.* worker handlers', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'dimo-voice-e2e-'));
    try {
      const { bytes, model } = makeSyntheticModel('GGUF-E2E-MODEL-'.repeat(64));
      const modelStore = new LocalModelStore({
        modelsDir: path.join(tmpRoot, 'models'),
        catalog: [model],
        knownSearchRoots: [],
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      });

      const localRuntime = new LocalSpeechRuntime({
        runtimeDir: path.join(tmpRoot, 'runtime-empty'),
        execFileImpl: (_cmd, _args, _opts, cb) => cb(new Error('not found')),
      });

      const { engine, workerDefinition } = createVoiceInputWorkerDefinition({
        config: {
          ...DEFAULT_VOICE_CONFIG,
          providerProtocol: 'local-model',
          localModelId: model.id,
          vocabulary: 'Dimo = vibe x, TypeScript',
          removeFillerWords: true,
          silenceFiltering: true,
        },
        modelStore,
        localRuntime,
        fetchImpl: async () => {
          throw new Error('Cloud fetch must never be called in local-model mode');
        },
      });

      const handlers = new Map();
      await workerDefinition.setup({
        handle(name, fn) {
          handlers.set(name, fn);
        },
        onConfigUpdate() {},
        onDispose() {},
      });

      for (const hName of [
        'voice.local.models',
        'voice.local.download',
        'voice.local.cancelDownload',
        'voice.local.remove',
        'voice.local.link',
        'voice.local.installEngine',
        'voice.local.unload',
      ]) {
        assert.ok(handlers.has(hName), `Worker must register handler ${hName}`);
      }

      const wavB64 = makeVoicedWavBase64(0.6);

      // 1. Model not yet downloaded -> structured `local-model-missing` error
      await assert.rejects(
        () => engine.transcribe({ wavBase64: wavB64, mimeType: 'audio/wav' }),
        (err) => err?.code === 'local-model-missing' && err?.action === 'models',
      );

      // 2. Download model via worker handler
      const dlRes = await handlers.get('voice.local.download')({
        modelId: model.id,
        waitForCompletion: true,
      });
      assert.equal(dlRes.started, true);
      assert.equal(dlRes.state.models[0].installed, true);

      // 3. Model installed, engine not installed -> structured `local-engine-missing` error
      await assert.rejects(
        () => engine.transcribe({ wavBase64: wavB64, mimeType: 'audio/wav' }),
        (err) => err?.code === 'local-engine-missing' && err?.action === 'models',
      );

      // 4. Attach mocked local runtime and transcribe end-to-end (with vocabulary + filler cleanup!)
      let receivedPcmLen = 0;
      localRuntime.customTranscribeImpl = async (opts) => {
        receivedPcmLen = opts.pcmFloat32.length;
        return { text: '嗯，那个请帮我检查一下 vibe x 的 typescrpt 编译错误', backend: 'vulkan' };
      };

      const res = await handlers.get('voice.transcribe')({
        wavBase64: wavB64,
        mimeType: 'audio/wav',
      });
      assert.ok(receivedPcmLen > 0, 'Local runtime should receive decoded Float32 PCM');
      assert.match(res.provider, /^local-model:tiny-test-Q8_0 \(vulkan\)$/);
      assert.match(res.text, /Dimo/);
      assert.match(res.text, /TypeScript/);
      assert.ok(!/^嗯/.test(res.text), 'Leading Chinese filler should be removed');
      assert.equal(engine.metrics.localModelTranscriptions, 1);

      // 5. Unload + remove model via worker handlers
      const unloadRes = await handlers.get('voice.local.unload')();
      assert.equal(unloadRes.unloaded, true);
      const rmRes = await handlers.get('voice.local.remove')({ modelId: model.id });
      assert.equal(rmRes.removed, true);
      assert.equal(rmRes.state.models[0].installed, false);
      engine.dispose();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('runs real isolated IPC child-process inference with recursive InputTooLong split and clean unload', async () => {
    const tmpRuntime = await mkdtemp(path.join(os.tmpdir(), 'dimo-voice-ipc-'));
    try {
      const pkgDir = path.join(tmpRuntime, 'node_modules', 'transcribe-cpp');
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'transcribe-cpp', version: '0.4.2', type: 'module', main: 'index.mjs' }),
      );
      await writeFile(
        path.join(pkgDir, 'index.mjs'),
        `
export function getAvailableBackends() {
  return [{ name: 'MockVulkanGPU', type: 'gpu' }];
}
export class TranscribeModel {
  static async load(modelPath, opts) {
    return new TranscribeModel(modelPath, opts);
  }
  constructor(modelPath, opts) {
    this.modelPath = modelPath;
    this.opts = opts;
  }
  async transcribe(samples, opts) {
    // Force recursive split when audio exceeds 20,000 samples (> 1.25s)
    if (samples.length > 20000) {
      throw new Error('InputTooLong: chunk exceeds mock window');
    }
    return { text: 'seg:' + samples.length + ':' + (opts.language || 'auto') };
  }
  dispose() {}
}
`,
      );

      const runtime = new LocalSpeechRuntime({ runtimeDir: tmpRuntime });
      const status = await runtime.getEngineStatus();
      assert.equal(status.installed, true);
      assert.equal(status.transcribeCppInstalled, true);
      assert.equal(status.version, '0.4.2');

      const backends = await runtime.discoverBackends();
      assert.equal(backends.length, 1);
      assert.equal(backends[0].name, 'MockVulkanGPU');

      // Pass 36,000 samples (2.25s) to exercise recursive split -> 2 halves of 18,000 each!
      const pcm = new Float32Array(36_000);
      const out = await runtime.transcribePcm({
        modelPath: path.join(tmpRuntime, 'fake.gguf'),
        modelId: 'test/model',
        pcmFloat32: pcm,
        language: 'zh',
        acceleration: 'cpu',
        unloadTimeoutSec: 60,
      });
      assert.equal(out.backend, 'cpu');
      assert.equal(out.text, 'seg:18000:zh seg:18000:zh');

      const unloaded = await runtime.unload();
      assert.equal(unloaded.unloaded, true);
      runtime.dispose();
    } finally {
      await rm(tmpRuntime, { recursive: true, force: true });
    }
  });
});

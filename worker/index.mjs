import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  detectSilenceAndTrimPcm,
  encodePcm16WavBuffer,
  filterSilenceFromWavBase64,
  parseWavBuffer,
  stripBase64DataUrlPrefix,
} from './audio.mjs';
import {
  DEFAULT_VOICE_CONFIG,
  PLUGIN_ID,
  isLocalhostUrl,
  normalizeVoiceConfig,
  resolveApiKey,
} from './config.mjs';
import {
  CN_HF_MIRROR_URL,
  DEFAULT_HF_MIRROR_URL,
  DEFAULT_LOCAL_MODEL_ID,
  LOCAL_SPEECH_MODELS,
  buildModelDownloadUrl,
  formatBytes,
  getLocalSpeechModel,
} from './localCatalog.mjs';
import { LocalModelStore } from './localModelStore.mjs';
import { LocalSpeechRuntime, TRANSCRIBE_CPP_VERSION } from './localRuntime.mjs';
import { transcribeWavWithWindowsSpeech } from './nativeSpeech.mjs';
import {
  buildChatAudioRequest,
  buildMultipartAudioRequest,
  buildOpenRouterAudioRequest,
  buildXaiSttRequest,
  classifyCloudError,
  extractTranscriptionText,
} from './providers.mjs';
import {
  buildCleanupChatRequest,
  buildWhisperPrompt,
  cleanTranscriptText,
  levenshteinDistance,
  normalizeVocabularyTerms,
  parseVocabularyEntries,
  parseVocabularyList,
  soundex,
  stripSpokenFillers,
} from './textProcessing.mjs';

export {
  CN_HF_MIRROR_URL,
  DEFAULT_HF_MIRROR_URL,
  DEFAULT_LOCAL_MODEL_ID,
  DEFAULT_VOICE_CONFIG,
  LOCAL_SPEECH_MODELS,
  LocalModelStore,
  LocalSpeechRuntime,
  PLUGIN_ID,
  TRANSCRIBE_CPP_VERSION,
  buildChatAudioRequest,
  buildCleanupChatRequest,
  buildModelDownloadUrl,
  buildMultipartAudioRequest,
  buildOpenRouterAudioRequest,
  buildWhisperPrompt,
  buildXaiSttRequest,
  classifyCloudError,
  cleanTranscriptText,
  detectSilenceAndTrimPcm,
  encodePcm16WavBuffer,
  extractTranscriptionText,
  filterSilenceFromWavBase64,
  formatBytes,
  getLocalSpeechModel,
  isLocalhostUrl,
  levenshteinDistance,
  normalizeVocabularyTerms,
  normalizeVoiceConfig,
  parseVocabularyEntries,
  parseVocabularyList,
  parseWavBuffer,
  resolveApiKey,
  soundex,
  stripBase64DataUrlPrefix,
  stripSpokenFillers,
  transcribeWavWithWindowsSpeech,
};

function makeVoiceError(code, message, action = 'retry', retryable = true) {
  const err = new Error(message);
  err.code = code;
  err.errorCode = code;
  err.action = action;
  err.errorAction = action;
  err.retryable = retryable;
  return err;
}

export class VoiceInputEngine {
  constructor(options = {}) {
    this.config = normalizeVoiceConfig(options.config || {});
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.env = options.env || process.env;
    this.nativeOsTranscribeImpl =
      options.nativeOsTranscribeImpl || transcribeWavWithWindowsSpeech;
    this.modelStore =
      options.modelStore ||
      new LocalModelStore({
        modelsDir: this.config.localModelsDir || undefined,
        fetchImpl: this.fetchImpl,
        env: this.env,
      });
    this.localRuntime =
      options.localRuntime ||
      new LocalSpeechRuntime({
        env: this.env,
      });
    this.history = [];
    this.activeAbortControllers = new Map();
    this.metrics = {
      totalTranscriptions: 0,
      cloudTranscriptions: 0,
      localModelTranscriptions: 0,
      browserFallbackTranscriptions: 0,
      osSpeechTranscriptions: 0,
      llmCleanups: 0,
      silenceFilteredCount: 0,
      lastLatencyMs: 0,
      lastProvider: null,
      lastError: null,
      lastErrorCode: null,
    };
  }

  updateConfig(partial = {}) {
    this.config = normalizeVoiceConfig({ ...this.config, ...(partial || {}) });
    if (this.modelStore && typeof this.modelStore.setModelsDir === 'function') {
      this.modelStore.setModelsDir(this.config.localModelsDir);
    }
    return this.config;
  }

  getStatus() {
    const apiKey = resolveApiKey(this.config, this.env);
    const localUnauthAllowed =
      (this.config.providerProtocol === 'custom-openai' ||
        this.config.providerProtocol === 'openai-whisper') &&
      isLocalhostUrl(this.config.baseUrl);
    return {
      pluginId: PLUGIN_ID,
      enabled: this.config.enabled,
      providerProtocol: this.config.providerProtocol,
      localModelId: this.config.localModelId,
      localAcceleration: this.config.localAcceleration,
      localUnloadTimeoutSec: this.config.localUnloadTimeoutSec,
      hfMirrorUrl: this.config.hfMirrorUrl,
      localModelsDir: this.config.localModelsDir,
      modelsDir: this.modelStore?.modelsDir || '',
      runtimeDir: this.localRuntime?.runtimeDir || '',
      model: this.config.model,
      cleanupModel: this.config.cleanupModel,
      language: this.config.language,
      translateToEnglish: this.config.translateToEnglish,
      recordingMode: this.config.recordingMode,
      shortcut: this.config.shortcut,
      cleanupMode: this.config.cleanupMode,
      removeFillerWords: this.config.removeFillerWords,
      useLlmCleanup: this.config.useLlmCleanup,
      correctionCue: this.config.correctionCue,
      silenceFiltering: this.config.silenceFiltering,
      hasApiKey: Boolean(apiKey),
      cloudReady: Boolean(apiKey) || localUnauthAllowed,
      metrics: { ...this.metrics },
      historyCount: this.history.length,
    };
  }

  getHistory(limit = 20) {
    return this.history.slice(0, Math.max(1, Math.min(50, limit)));
  }

  cancel(requestId) {
    if (requestId && this.activeAbortControllers.has(requestId)) {
      this.activeAbortControllers.get(requestId).abort();
      this.activeAbortControllers.delete(requestId);
      return { cancelled: true, requestId };
    }
    for (const ac of this.activeAbortControllers.values()) {
      ac.abort();
    }
    this.activeAbortControllers.clear();
    return { cancelled: true };
  }

  async _fetchJson(request, signal, providerLabel) {
    if (typeof this.fetchImpl !== 'function') {
      throw makeVoiceError('unavailable', '当前运行环境缺少 fetch 实现', 'retry', true);
    }
    let response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method || 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw makeVoiceError('cancelled', '语音转写已取消', null, false);
      }
      throw makeVoiceError(
        'network-error',
        `无法连接到 ${providerLabel} 语音服务：${String(err?.message || err)}`,
        'retry',
        true,
      );
    }

    let payload = null;
    let rawBody = '';
    if (typeof response.json === 'function') {
      try {
        payload = await response.json();
      } catch {
        if (typeof response.text === 'function') {
          rawBody = await response.text().catch(() => '');
        }
      }
    } else if (typeof response.text === 'function') {
      rawBody = await response.text().catch(() => '');
      try {
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        payload = rawBody;
      }
    }

    if (!response.ok) {
      const detail =
        payload?.error?.message ||
        (typeof payload?.error === 'string' ? payload.error : '') ||
        payload?.message ||
        rawBody ||
        '';
      const info = classifyCloudError(response.status, detail, providerLabel);
      throw makeVoiceError(info.code, info.message, info.action, info.retryable);
    }

    return payload;
  }

  async cleanupText(params = {}) {
    const cfg = normalizeVoiceConfig({ ...this.config, ...(params.config || {}) });
    const rawText = String(params.text ?? params.rawText ?? '').trim();
    if (!rawText) {
      return {
        rawText: '',
        cleanedText: '',
        text: '',
        usedLlm: false,
      };
    }

    const deterministic = cleanTranscriptText(rawText, {
      cleanupMode: params.cleanupMode || cfg.cleanupMode,
      vocabulary: params.vocabulary ?? cfg.vocabulary,
      removeFillerWords: params.removeFillerWords ?? cfg.removeFillerWords,
      correctionCue: params.correctionCue ?? cfg.correctionCue,
    });

    const cleanupMode = params.cleanupMode || cfg.cleanupMode;
    const allowLlm =
      cleanupMode !== 'off' &&
      params.useLlm !== false &&
      params.skipLlmCleanup !== true &&
      cfg.useLlmCleanup !== false;

    const apiKey = resolveApiKey(cfg, this.env);
    const canCallLlm =
      allowLlm &&
      (Boolean(apiKey) || isLocalhostUrl(cfg.baseUrl)) &&
      cfg.providerProtocol !== 'browser-speech' &&
      (cfg.providerProtocol !== 'local-model' || params.forceLlm === true) &&
      Boolean(cfg.cleanupModel) &&
      (params.forceLlm === true ||
        Boolean(params.draftContext) ||
        Boolean(cfg.correctionCue) ||
        Boolean(cfg.cleanupInstructions) ||
        rawText.length >= 16);

    if (!canCallLlm) {
      return {
        rawText,
        cleanedText: deterministic,
        text: cleanupMode === 'off' ? rawText : deterministic,
        usedLlm: false,
      };
    }

    const reqId = params.requestId || `clean-${Date.now()}`;
    const abortController = new AbortController();
    this.activeAbortControllers.set(reqId, abortController);
    const timeoutId = setTimeout(() => abortController.abort(), 18_000);

    try {
      const cleanupBase =
        cfg.providerProtocol === 'xai-stt' &&
        cfg.baseUrl === DEFAULT_VOICE_CONFIG.baseUrl
          ? 'https://api.x.ai/v1'
          : cfg.providerProtocol === 'openrouter-stt' &&
              cfg.baseUrl === DEFAULT_VOICE_CONFIG.baseUrl
            ? 'https://openrouter.ai/api/v1'
            : cfg.providerProtocol === 'groq-whisper' &&
                cfg.baseUrl === DEFAULT_VOICE_CONFIG.baseUrl
              ? 'https://api.groq.com/openai/v1'
              : cfg.baseUrl;

      const req = buildCleanupChatRequest({
        baseUrl: cleanupBase,
        apiKey,
        model: params.cleanupModel || cfg.cleanupModel,
        rawText: deterministic || rawText,
        vocabulary: params.vocabulary ?? cfg.vocabulary,
        language: params.language ?? cfg.language,
        correctionCue: params.correctionCue ?? cfg.correctionCue,
        cleanupInstructions: params.cleanupInstructions ?? cfg.cleanupInstructions,
        removeFillerWords: params.removeFillerWords ?? cfg.removeFillerWords,
        draftContext: params.draftContext || null,
      });

      const payload = await this._fetchJson(req, abortController.signal, 'LLM 润色');
      const llmText = extractTranscriptionText(payload);
      if (llmText) {
        const finalClean = normalizeVocabularyTerms(
          llmText,
          params.vocabulary ?? cfg.vocabulary,
        ).trim();
        this.metrics.llmCleanups += 1;
        return {
          rawText,
          cleanedText: finalClean,
          text: finalClean,
          usedLlm: true,
        };
      }
    } catch {
      // Never lose user speech because LLM cleanup failed — gracefully fall back to deterministic cleanup
    } finally {
      clearTimeout(timeoutId);
      this.activeAbortControllers.delete(reqId);
    }

    return {
      rawText,
      cleanedText: deterministic,
      text: deterministic,
      usedLlm: false,
    };
  }

  async transcribe(params = {}) {
    const startedAt = Date.now();
    const cfg = normalizeVoiceConfig({ ...this.config, ...(params.config || {}) });
    const protocol = params.providerProtocol || cfg.providerProtocol;
    const language = params.language || cfg.language;
    const translateToEnglish =
      typeof params.translateToEnglish === 'boolean'
        ? params.translateToEnglish
        : cfg.translateToEnglish;
    const liveTranscript = String(params.liveTranscript || '').trim();
    const rawAudioBase64 = stripBase64DataUrlPrefix(
      params.audioBase64 || params.wavBase64 || '',
    );
    const wavBase64 = stripBase64DataUrlPrefix(params.wavBase64 || '');
    const mimeType = params.mimeType || (wavBase64 && !params.audioBase64 ? 'audio/wav' : 'audio/webm');

    let effectiveAudioBase64 = rawAudioBase64;
    let effectiveMimeType = mimeType;
    let silenceMeta = null;

    const isCloudProtocol =
      protocol === 'openai-whisper' ||
      protocol === 'groq-whisper' ||
      protocol === 'xai-stt' ||
      protocol === 'openrouter-stt' ||
      protocol === 'openai-chat-audio' ||
      protocol === 'custom-openai' ||
      protocol === 'hybrid';

    // Optional WAV silence filtering & no-speech detection before cloud or local inference
    const wavCandidate = wavBase64 || (mimeType.includes('wav') ? rawAudioBase64 : '');
    let effectiveWavBase64 = wavCandidate;
    if (cfg.silenceFiltering && wavCandidate) {
      const vad = filterSilenceFromWavBase64(wavCandidate);
      if (vad.analyzed) {
        silenceMeta = {
          hasSpeech: vad.hasSpeech,
          originalDurationMs: vad.originalDurationMs,
          trimmedDurationMs: vad.trimmedDurationMs,
          speechRatio: vad.speechRatio,
        };
        if (
          !vad.hasSpeech &&
          !liveTranscript &&
          ((isCloudProtocol && protocol !== 'hybrid') || protocol === 'local-model')
        ) {
          this.metrics.silenceFilteredCount += 1;
          this.metrics.lastError = '未检测到人声语音，请靠近麦克风重试';
          this.metrics.lastErrorCode = 'no-speech';
          throw makeVoiceError(
            'no-speech',
            '未检测到人声语音，请靠近麦克风重试',
            'retry',
            false,
          );
        }
        if (vad.hasSpeech && vad.wavBase64) {
          effectiveWavBase64 = vad.wavBase64;
          if (mimeType.includes('wav') || !params.audioBase64 || protocol === 'local-model') {
            effectiveAudioBase64 = vad.wavBase64;
            effectiveMimeType = 'audio/wav';
            this.metrics.silenceFilteredCount += 1;
          }
        }
      }
    }

    const reqId = params.requestId || `stt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const abortController = new AbortController();
    this.activeAbortControllers.set(reqId, abortController);
    const timeoutId = setTimeout(
      () => abortController.abort(),
      protocol === 'local-model' ? 95_000 : 45_000,
    );

    let rawText = '';
    let resolvedProvider = protocol;

    try {
      if (protocol === 'local-model') {
        const targetModelId = params.localModelId || cfg.localModelId;
        const model =
          this.modelStore?.catalog?.find((m) => m.id === targetModelId) ||
          getLocalSpeechModel(targetModelId);
        if (!model) {
          throw makeVoiceError(
            'local-model-missing',
            `未知的本地语音模型：${String(targetModelId)}，请在状态栏「本地模型」面板重新选择。`,
            'models',
            false,
          );
        }

        const modelPath = await this.modelStore.getInstalledPath(model);
        if (!modelPath) {
          throw makeVoiceError(
            'local-model-missing',
            `尚未安装本地模型「${model.name}」，请在状态栏「本地模型」面板一键下载或导入本地文件。`,
            'models',
            false,
          );
        }

        const engineStatus = await this.localRuntime.getEngineStatus();
        if (!engineStatus.installed) {
          throw makeVoiceError(
            'local-engine-missing',
            '尚未安装本地语音推理引擎（transcribe.cpp），请在状态栏「本地模型」面板点击「安装推理引擎」。',
            'models',
            false,
          );
        }

        if (!effectiveWavBase64) {
          throw makeVoiceError(
            'no-speech',
            '本地模型需要 16kHz PCM WAV 音频输入，未捕获到有效录音数据。',
            'retry',
            true,
          );
        }

        const parsedWav = parseWavBuffer(Buffer.from(effectiveWavBase64, 'base64'));
        if (!parsedWav || !parsedWav.samples || parsedWav.samples.length === 0) {
          throw makeVoiceError(
            'no-speech',
            '无法解析录音 WAV 数据，请重试。',
            'retry',
            true,
          );
        }

        const localRes = await this.localRuntime.transcribePcm({
          modelPath,
          modelId: model.id,
          pcmFloat32: parsedWav.samples,
          sampleRate: parsedWav.sampleRate,
          language,
          translateToEnglish: Boolean(translateToEnglish && model.supportsTranslation),
          vocabulary: cfg.vocabulary,
          acceleration: cfg.localAcceleration,
          unloadTimeoutSec: cfg.localUnloadTimeoutSec,
          signal: abortController.signal,
        });

        rawText = String(localRes?.text || '').trim();
        const shortName = model.filename.replace(/\.gguf$/i, '');
        resolvedProvider = `local-model:${shortName}${localRes?.backend ? ` (${localRes.backend})` : ''}`;
        this.metrics.localModelTranscriptions += 1;
      } else {
        const apiKey = resolveApiKey(cfg, this.env);
        const canUseCloud =
          isCloudProtocol &&
          Boolean(effectiveAudioBase64) &&
          !(silenceMeta && silenceMeta.hasSpeech === false) &&
          (Boolean(apiKey) ||
            ((protocol === 'custom-openai' || protocol === 'openai-whisper') &&
              isLocalhostUrl(cfg.baseUrl)));

        if (canUseCloud) {
          let req;
          if (protocol === 'xai-stt') {
            req = buildXaiSttRequest({
              baseUrl: cfg.baseUrl,
              apiKey,
              model: cfg.model,
              audioBase64: effectiveAudioBase64,
              mimeType: effectiveMimeType,
              language,
              vocabulary: cfg.vocabulary,
              correctionCue: cfg.correctionCue,
              removeFillerWords: cfg.removeFillerWords,
            });
          } else if (protocol === 'openrouter-stt') {
            req = buildOpenRouterAudioRequest({
              baseUrl: cfg.baseUrl,
              apiKey,
              model: cfg.model,
              audioBase64: effectiveAudioBase64,
              mimeType: effectiveMimeType,
              language,
              vocabulary: cfg.vocabulary,
              correctionCue: cfg.correctionCue,
            });
          } else if (protocol === 'openai-chat-audio') {
            req = buildChatAudioRequest({
              baseUrl: cfg.baseUrl,
              apiKey,
              model: cfg.model,
              audioBase64: effectiveAudioBase64,
              mimeType: effectiveMimeType,
              language,
              translateToEnglish,
              vocabulary: cfg.vocabulary,
              correctionCue: cfg.correctionCue,
            });
          } else {
            req = buildMultipartAudioRequest({
              baseUrl: cfg.baseUrl,
              apiKey,
              providerProtocol: protocol === 'hybrid' ? 'openai-whisper' : protocol,
              model: cfg.model,
              audioBase64: effectiveAudioBase64,
              mimeType: effectiveMimeType,
              language,
              translateToEnglish,
              vocabulary: cfg.vocabulary,
              correctionCue: cfg.correctionCue,
            });
          }

          try {
            const payload = await this._fetchJson(req, abortController.signal, protocol);
            rawText = extractTranscriptionText(payload);
            resolvedProvider = protocol === 'hybrid' ? 'hybrid-cloud-whisper' : protocol;
            this.metrics.cloudTranscriptions += 1;
          } catch (cloudErr) {
            if (protocol === 'hybrid' && liveTranscript) {
              rawText = liveTranscript;
              resolvedProvider = 'hybrid-browser-speech';
              this.metrics.browserFallbackTranscriptions += 1;
            } else {
              throw cloudErr;
            }
          }
        } else if (
          isCloudProtocol &&
          protocol !== 'hybrid' &&
          !liveTranscript &&
          !apiKey
        ) {
          throw makeVoiceError(
            'missing-key',
            `尚未配置 ${protocol} 所需的 API 密钥，请在设置中填写或切换到本地模型 / 浏览器原生识别。`,
            'settings',
            false,
          );
        } else if (liveTranscript) {
          rawText = liveTranscript;
          resolvedProvider =
            protocol === 'hybrid' ? 'hybrid-browser-speech' : 'browser-speech';
          this.metrics.browserFallbackTranscriptions += 1;
        } else if (
          (protocol === 'browser-speech' || protocol === 'hybrid') &&
          (wavBase64 || effectiveAudioBase64)
        ) {
          const osText = await this.nativeOsTranscribeImpl(
            wavBase64 || effectiveAudioBase64,
            language,
          );
          if (osText && osText.trim()) {
            rawText = osText.trim();
            resolvedProvider = 'os-speech';
            this.metrics.osSpeechTranscriptions += 1;
          }
        }
      }

      if (!rawText) {
        throw makeVoiceError(
          'no-speech',
          '未识别到有效语音内容，请检查麦克风或重试。',
          'retry',
          false,
        );
      }

      // Deterministic cleanup immediately; optional LLM cleanup unless deferred to client two-stage flow
      const deterministicCleaned = cleanTranscriptText(rawText, {
        cleanupMode: cfg.cleanupMode,
        vocabulary: cfg.vocabulary,
        removeFillerWords: cfg.removeFillerWords,
        correctionCue: cfg.correctionCue,
      });

      let cleanedText = deterministicCleaned;
      let usedLlm = false;
      const shouldRunInlineLlm =
        params.deferLlmCleanup !== true &&
        params.skipLlmCleanup !== true &&
        protocol !== 'local-model' &&
        cfg.cleanupMode !== 'off' &&
        cfg.useLlmCleanup === true &&
        Boolean(params.draftContext || cfg.correctionCue || cfg.cleanupInstructions);

      if (shouldRunInlineLlm) {
        const llmRes = await this.cleanupText({
          text: rawText,
          config: cfg,
          draftContext: params.draftContext || null,
          requestId: `${reqId}-clean`,
        });
        cleanedText = llmRes.cleanedText || deterministicCleaned;
        usedLlm = Boolean(llmRes.usedLlm);
      }

      const finalText = cfg.cleanupMode === 'off' ? deterministicCleaned : cleanedText;
      const latencyMs = Date.now() - startedAt;

      const entry = {
        id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        provider: resolvedProvider,
        language,
        rawText,
        cleanedText,
        text: finalText,
        usedLlm,
        latencyMs,
        silenceMeta,
      };

      this.history.unshift(entry);
      if (this.history.length > 30) this.history.length = 30;
      this.metrics.totalTranscriptions += 1;
      this.metrics.lastLatencyMs = latencyMs;
      this.metrics.lastProvider = resolvedProvider;
      this.metrics.lastError = null;
      this.metrics.lastErrorCode = null;

      return entry;
    } catch (err) {
      this.metrics.lastError = String(err?.message || err);
      this.metrics.lastErrorCode = err?.code || err?.errorCode || 'transcription-failed';
      throw err;
    } finally {
      clearTimeout(timeoutId);
      this.activeAbortControllers.delete(reqId);
    }
  }

  async getLocalModelsState(options = {}) {
    const [models, engine] = await Promise.all([
      this.modelStore.listModels(this.config.localModelId),
      this.localRuntime.getEngineStatus(),
    ]);
    if (options.probeBackends && engine.transcribeCppInstalled && (!engine.backends || engine.backends.length === 0)) {
      engine.backends = await this.localRuntime.discoverBackends();
    }
    return {
      models,
      activeModelId: this.config.localModelId,
      providerProtocol: this.config.providerProtocol,
      modelsDir: this.modelStore.modelsDir,
      runtimeDir: this.localRuntime.runtimeDir,
      hfMirrorUrl: this.config.hfMirrorUrl,
      localAcceleration: this.config.localAcceleration,
      localUnloadTimeoutSec: this.config.localUnloadTimeoutSec,
      engine,
    };
  }

  async downloadLocalModel(input = {}) {
    const modelId = input.modelId || this.config.localModelId;
    const hfMirrorUrl = input.hfMirrorUrl || this.config.hfMirrorUrl;
    const download = this.modelStore.startDownload(modelId, { hfMirrorUrl });

    if (input.autoInstallEngine) {
      const status = await this.localRuntime.getEngineStatus();
      if (!status.installed && status.installState?.status !== 'installing') {
        void this.localRuntime.installEngine().catch(() => {});
      }
    }

    if (input.waitForCompletion) {
      const record = this.modelStore.activeDownloads.get(modelId);
      if (record?.promise) {
        await record.promise;
      }
    }

    return {
      started: true,
      modelId,
      download,
      state: await this.getLocalModelsState(),
    };
  }

  async cancelLocalModelDownload(input = {}) {
    const res = this.modelStore.cancelDownload(input.modelId);
    return {
      ...res,
      state: await this.getLocalModelsState(),
    };
  }

  async removeLocalModel(input = {}) {
    const modelId = input.modelId;
    if (this.localRuntime?._loadedModelId === modelId) {
      await this.localRuntime.unload();
    }
    const res = await this.modelStore.remove(modelId);
    return {
      ...res,
      state: await this.getLocalModelsState(),
    };
  }

  async linkLocalModels(input = {}) {
    const result = await this.modelStore.linkFromSource(input.sourcePath);
    return {
      ...result,
      state: await this.getLocalModelsState(),
    };
  }

  async installLocalEngine(input = {}) {
    if (input.background) {
      void this.localRuntime.installEngine({ force: Boolean(input.force) }).catch(() => {});
      return {
        started: true,
        state: await this.getLocalModelsState(),
      };
    }
    const engine = await this.localRuntime.installEngine({ force: Boolean(input.force) });
    return {
      installed: Boolean(engine.installed),
      engine,
      state: await this.getLocalModelsState(),
    };
  }

  async unloadLocalModel() {
    const res = await this.localRuntime.unload();
    return {
      ...res,
      state: await this.getLocalModelsState(),
    };
  }

  dispose() {
    this.cancel();
    this.modelStore?.dispose?.();
    this.localRuntime?.dispose?.();
  }
}

export function createVoiceInputWorkerDefinition(options = {}) {
  const engine = new VoiceInputEngine(options);

  const workerDefinition = {
    async setup(registrar, setupContext = {}) {
      const initialConfig = setupContext?.context?.config;
      if (initialConfig && typeof initialConfig === 'object') {
        engine.updateConfig(initialConfig);
      }

      if (typeof registrar.onConfigUpdate === 'function') {
        registrar.onConfigUpdate((nextConfig) => {
          engine.updateConfig(nextConfig);
        });
      }

      registrar.handle('voice.status', async () => engine.getStatus());
      registrar.handle('voice.configure', async (input) => {
        if (input && typeof input === 'object') {
          engine.updateConfig(input);
        }
        return engine.getStatus();
      });
      registrar.handle('voice.toggle', async (input) => {
        if (input && typeof input.enabled === 'boolean') {
          engine.updateConfig({ enabled: input.enabled });
        }
        return engine.getStatus();
      });
      registrar.handle('voice.transcribe', async (input) => {
        return await engine.transcribe(input || {});
      });
      registrar.handle('voice.cleanup', async (input) => {
        return await engine.cleanupText(input || {});
      });
      registrar.handle('voice.cancel', async (input) => {
        return engine.cancel(input?.requestId);
      });
      registrar.handle('voice.history', async (input) => {
        return { items: engine.getHistory(input?.limit || 20) };
      });

      // Local offline speech model & engine management handlers
      registrar.handle('voice.local.models', async (input) => {
        return await engine.getLocalModelsState(input || {});
      });
      registrar.handle('voice.local.download', async (input) => {
        return await engine.downloadLocalModel(input || {});
      });
      registrar.handle('voice.local.cancelDownload', async (input) => {
        return await engine.cancelLocalModelDownload(input || {});
      });
      registrar.handle('voice.local.remove', async (input) => {
        return await engine.removeLocalModel(input || {});
      });
      registrar.handle('voice.local.link', async (input) => {
        return await engine.linkLocalModels(input || {});
      });
      registrar.handle('voice.local.installEngine', async (input) => {
        return await engine.installLocalEngine(input || {});
      });
      registrar.handle('voice.local.unload', async () => {
        return await engine.unloadLocalModel();
      });

      if (typeof registrar.onDispose === 'function') {
        registrar.onDispose(() => {
          engine.dispose();
        });
      }
    },
  };

  return { engine, workerDefinition };
}

const defaultWorker = createVoiceInputWorkerDefinition();
export const engine = defaultWorker.engine;
export default defaultWorker.workerDefinition;

export async function startVoiceInputStdioLoop(definition = defaultWorker.workerDefinition) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const handlers = new Map();
  const disposables = [];
  let configUpdateListener = null;

  const send = (msg) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({
        id: 'unknown',
        ok: false,
        error: { code: 'protocol_invalid', message: 'Invalid JSON message' },
      });
      continue;
    }

    if (!('method' in message)) continue;

    try {
      switch (message.method) {
        case 'initialize': {
          send({
            id: message.id,
            ok: true,
            result: {
              protocolVersion: '1.1',
              sdkVersion: '2.0',
              registrations: [],
              requestedFeatures: [],
            },
          });
          break;
        }
        case 'activate': {
          handlers.clear();
          const registrar = {
            handle(id, fn) {
              handlers.set(id, fn);
            },
            onConfigUpdate(fn) {
              configUpdateListener = fn;
            },
            onDispose(fn) {
              disposables.push(fn);
            },
          };
          await definition.setup(registrar, {
            context: message.params || {},
          });
          send({
            id: message.id,
            ok: true,
            result: { handlers: [...handlers.keys()].sort() },
          });
          break;
        }
        case 'config.volatile-update': {
          if (typeof configUpdateListener === 'function' && message.params?.config) {
            configUpdateListener(message.params.config);
          }
          send({
            id: message.id,
            ok: true,
            result: { updated: true },
          });
          break;
        }
        case 'invoke': {
          const fn = handlers.get(message.params?.handler);
          if (!fn) {
            send({
              id: message.id,
              ok: false,
              error: {
                code: 'handler_not_found',
                message: `Handler ${String(message.params?.handler)} is not registered`,
              },
            });
            break;
          }
          Promise.resolve(fn(message.params?.input, {}))
            .then((result) => send({ id: message.id, ok: true, result }))
            .catch((err) =>
              send({
                id: message.id,
                ok: false,
                error: {
                  code: err?.code || err?.errorCode || 'worker_failed',
                  message: String(err?.message || err),
                  action: err?.action || err?.errorAction || null,
                  retryable: Boolean(err?.retryable),
                },
              }),
            );
          break;
        }
        case 'dispose':
        case 'plugin.unload': {
          for (const d of disposables.splice(0)) {
            if (typeof d === 'function') await d();
          }
          handlers.clear();
          send({ id: message.id, ok: true, result: null });
          break;
        }
        case 'ping': {
          send({ id: message.id, ok: true, result: { apiVersion: '2.0' } });
          break;
        }
        default: {
          send({
            id: message.id,
            ok: false,
            error: {
              code: 'protocol_invalid',
              message: `Unknown method ${String(message.method)}`,
            },
          });
        }
      }
    } catch (err) {
      send({
        id: message.id,
        ok: false,
        error: {
          code: err?.code || 'worker_failed',
          message: String(err?.message || err),
        },
      });
    }
  }
}

function runStdioLoopIfMain() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return;
  let isMain = false;
  try {
    isMain = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    isMain = false;
  }
  if (isMain) {
    void startVoiceInputStdioLoop(defaultWorker.workerDefinition);
  }
}

runStdioLoopIfMain();

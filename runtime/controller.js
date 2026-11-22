import {
  enumerateAudioInputs,
  loadMicrophoneOrder,
  rememberMicrophones,
  resolvePreferredMicrophone,
  saveMicrophoneOrder,
} from './microphones.js';
import {
  buildAudioWorkletProcessorSource,
  computeChunkRms,
  computeSmoothedLevel,
  concatFloat32Chunks,
  encodeMonoWavBase64,
} from './pcmResampler.js';
import { formatDuration } from './shortcuts.js';
import {
  DEFAULT_VOICE_CONFIG,
  PLUGIN_ID,
  cleanTranscriptText,
  formatTranscriptInsertion,
  normalizeVoiceConfig,
  readComposerDraftContext,
} from './textInsertion.js';

export const MAX_RECORDING_MS = 5 * 60 * 1000; // 5 minutes (aligned with T3 Code)
export const VOICE_HISTORY_STORAGE_KEY = 'dimo.voice-input.history';

const SPEECH_LANG_MAP = {
  auto: 'zh-CN',
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
};

function loadPersistedHistory() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VOICE_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 15) : [];
  } catch {
    return [];
  }
}

function savePersistedHistory(items) {
  try {
    if (typeof localStorage === 'undefined' || !Array.isArray(items)) return;
    localStorage.setItem(VOICE_HISTORY_STORAGE_KEY, JSON.stringify(items.slice(0, 15)));
  } catch {
    // ignore storage errors
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (!blob || typeof FileReader === 'undefined') {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf('base64,');
      resolve(idx >= 0 ? result.slice(idx + 'base64,'.length) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio blob'));
    reader.readAsDataURL(blob);
  });
}

function defaultSpeechRecognitionFactory() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export class VoiceSessionController {
  constructor(options = {}) {
    this.config = normalizeVoiceConfig(options.config || DEFAULT_VOICE_CONFIG);
    this.invokeWorker = options.invokeWorker || null;
    this.getEditorBridge = options.getEditorBridge || null;
    this.insertIntoComposer = options.insertIntoComposer || null;
    this.speechRecognitionFactory =
      options.speechRecognitionFactory || defaultSpeechRecognitionFactory;
    this.getUserMedia =
      options.getUserMedia ||
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null);

    // State machine: idle | preparing | recording | transcribing | post-processing | preview | error
    this.state = 'idle';
    this.liveTranscript = '';
    this.finalTranscriptParts = [];
    this.durationMs = 0;
    this.audioLevels = new Array(10).fill(0.14);
    this.smoothedLevel = 0;
    this.previewDraft = null;
    this.lastError = null;
    this.errorCode = null;
    this.errorAction = null;
    this.lastResult = null;
    this.lastTestResult = null;
    this.lastFailedCapture = null;
    this.history = loadPersistedHistory();
    this.microphoneOrder = loadMicrophoneOrder();
    this.availableMicrophones = [];
    this.isTestSession = false;

    this._listeners = new Set();
    this._operationToken = 0;
    this._recordingStartedAt = 0;
    this._durationTimer = null;
    this._recognition = null;
    this._mediaStream = null;
    this._mediaRecorder = null;
    this._recordedBlobs = [];
    this._audioContext = null;
    this._audioSource = null;
    this._audioWorkletNode = null;
    this._workletBlobUrl = null;
    this._scriptProcessor = null;
    this._pcmChunks = [];
    this._pcmSampleRate = 16000;
    this._activeDraftContext = null;
    this._skipPostProcessingResolver = null;
    this._activeRequestId = null;
    this._trackEndedHandler = null;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      // ignore initial listener error
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  notify() {
    const snap = this.getSnapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  getSnapshot() {
    return {
      state: this.state,
      config: { ...this.config },
      liveTranscript: this.liveTranscript,
      durationMs: this.durationMs,
      durationLabel: formatDuration(this.durationMs),
      maxDurationMs: MAX_RECORDING_MS,
      audioLevels: [...this.audioLevels],
      previewDraft: this.previewDraft ? { ...this.previewDraft } : null,
      lastError: this.lastError,
      errorCode: this.errorCode,
      errorAction: this.errorAction,
      canRetry: Boolean(this.lastFailedCapture),
      lastResult: this.lastResult ? { ...this.lastResult } : null,
      lastTestResult: this.lastTestResult ? { ...this.lastTestResult } : null,
      history: this.history.slice(0, 15),
      availableMicrophones: this.availableMicrophones,
      microphoneOrder: this.microphoneOrder,
      isTestSession: this.isTestSession,
    };
  }

  updateConfig(partial = {}) {
    this.config = normalizeVoiceConfig({ ...this.config, ...(partial || {}) });
    this.notify();
    return this.config;
  }

  async refreshMicrophones() {
    const devices = await enumerateAudioInputs();
    this.availableMicrophones = devices;
    if (devices.length > 0) {
      this.microphoneOrder = rememberMicrophones(this.microphoneOrder, devices);
      saveMicrophoneOrder(this.microphoneOrder);
    }
    this.notify();
    return devices;
  }

  setMicrophoneOrder(nextOrder) {
    this.microphoneOrder = Array.isArray(nextOrder) ? nextOrder : [];
    saveMicrophoneOrder(this.microphoneOrder);
    this.notify();
  }

  _pushAudioLevel(level) {
    const clamped = Math.max(0.08, Math.min(1, Number(level) || 0.08));
    this.audioLevels = [...this.audioLevels.slice(1), clamped];
    this.notify();
  }

  _setError(code, message, action = 'retry') {
    this.state = 'error';
    this.errorCode = code || 'transcription-failed';
    this.lastError = String(message || '语音输入失败');
    this.errorAction = action;
    this.notify();
  }

  _clearError() {
    this.lastError = null;
    this.errorCode = null;
    this.errorAction = null;
  }

  _pushHistory(entry) {
    if (!entry || !entry.text) return;
    const item = {
      id: entry.id || `voice-${Date.now()}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      provider: entry.provider || this.config.providerProtocol,
      rawText: entry.rawText || entry.text,
      cleanedText: entry.cleanedText || entry.text,
      text: entry.text,
      latencyMs: entry.latencyMs || 0,
      usedLlm: Boolean(entry.usedLlm),
    };
    this.history = [item, ...this.history.filter((h) => h.id !== item.id)].slice(0, 15);
    savePersistedHistory(this.history);
  }

  clearHistory() {
    this.history = [];
    savePersistedHistory([]);
    this.notify();
  }

  async reinsertHistoryItem(id, useRaw = false) {
    const item = this.history.find((h) => h.id === id);
    if (!item) return { inserted: false, target: null };
    const text = useRaw ? item.rawText || item.text : item.cleanedText || item.text;
    return await this.insertTranscriptIntoTarget(text);
  }

  _cleanupMediaResources() {
    if (this._durationTimer) {
      clearInterval(this._durationTimer);
      this._durationTimer = null;
    }
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.stop();
      } catch {
        // ignore
      }
      this._recognition = null;
    }
    if (this._audioWorkletNode) {
      try {
        this._audioWorkletNode.port.onmessage = null;
        this._audioWorkletNode.disconnect();
      } catch {
        // ignore
      }
      this._audioWorkletNode = null;
    }
    if (this._workletBlobUrl) {
      try {
        URL.revokeObjectURL(this._workletBlobUrl);
      } catch {
        // ignore
      }
      this._workletBlobUrl = null;
    }
    if (this._scriptProcessor) {
      try {
        this._scriptProcessor.onaudioprocess = null;
        this._scriptProcessor.disconnect();
      } catch {
        // ignore
      }
      this._scriptProcessor = null;
    }
    if (this._audioSource) {
      try {
        this._audioSource.disconnect();
      } catch {
        // ignore
      }
      this._audioSource = null;
    }
    if (this._audioContext) {
      try {
        void this._audioContext.close();
      } catch {
        // ignore
      }
      this._audioContext = null;
    }
    if (this._mediaStream) {
      try {
        for (const track of this._mediaStream.getTracks()) {
          if (this._trackEndedHandler && typeof track.removeEventListener === 'function') {
            track.removeEventListener('ended', this._trackEndedHandler);
          }
          track.stop();
        }
      } catch {
        // ignore
      }
      this._mediaStream = null;
    }
    this._trackEndedHandler = null;
    this._mediaRecorder = null;
  }

  async _setupAudioCapture(stream, token) {
    const AudioCtx =
      typeof window !== 'undefined'
        ? window.AudioContext || window.webkitAudioContext
        : null;
    if (!AudioCtx || !stream) return;

    const audioCtx = new AudioCtx();
    this._audioContext = audioCtx;
    this._pcmSampleRate = audioCtx.sampleRate || 16000;
    const source = audioCtx.createMediaStreamSource(stream);
    this._audioSource = source;

    const handlePcmChunk = (floatChunk) => {
      if (token !== this._operationToken || this.state !== 'recording') return;
      this._pcmChunks.push(floatChunk);
      const rms = computeChunkRms(floatChunk);
      this.smoothedLevel = computeSmoothedLevel(
        rms,
        this.smoothedLevel,
        floatChunk.length / this._pcmSampleRate,
      );
      this._pushAudioLevel(Math.max(0.1, this.smoothedLevel));
    };

    // Prefer modern off-main-thread AudioWorklet when supported
    let workletReady = false;
    if (
      audioCtx.audioWorklet &&
      typeof audioCtx.audioWorklet.addModule === 'function' &&
      typeof AudioWorkletNode === 'function' &&
      typeof Blob === 'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      try {
        const blob = new Blob([buildAudioWorkletProcessorSource()], {
          type: 'application/javascript',
        });
        const url = URL.createObjectURL(blob);
        this._workletBlobUrl = url;
        await audioCtx.audioWorklet.addModule(url);
        if (token !== this._operationToken) return;
        const workletNode = new AudioWorkletNode(audioCtx, 'dimo-voice-pcm-processor');
        workletNode.port.onmessage = (ev) => {
          if (ev.data instanceof Float32Array) {
            handlePcmChunk(ev.data);
          }
        };
        source.connect(workletNode);
        this._audioWorkletNode = workletNode;
        workletReady = true;
      } catch {
        workletReady = false;
      }
    }

    // Fallback to ScriptProcessorNode if AudioWorklet is unavailable
    if (!workletReady && typeof audioCtx.createScriptProcessor === 'function') {
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (ev) => {
        const data = ev.inputBuffer.getChannelData(0);
        handlePcmChunk(new Float32Array(data));
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      this._scriptProcessor = processor;
    }
  }

  async startRecording(options = {}) {
    if (!this.config.enabled) {
      return { started: false, reason: 'disabled' };
    }
    if (this.state === 'recording' || this.state === 'preparing') {
      return { started: true, alreadyRecording: true };
    }
    if (this.state === 'transcribing' || this.state === 'post-processing') {
      return { started: false, reason: 'still-transcribing' };
    }

    const token = ++this._operationToken;
    this._clearError();
    this.previewDraft = null;
    this.liveTranscript = '';
    this.finalTranscriptParts = [];
    this.durationMs = 0;
    this.smoothedLevel = 0;
    this.audioLevels = new Array(10).fill(0.14);
    this._recordedBlobs = [];
    this._pcmChunks = [];
    this.isTestSession = Boolean(options.testOnly);
    this._activeDraftContext = this.isTestSession
      ? null
      : readComposerDraftContext(this.getEditorBridge);

    this.state = 'preparing';
    this.notify();

    // 1. Start Web Speech API streaming captions for `hybrid` and `browser-speech`
    const wantsBrowserSpeech =
      this.config.providerProtocol === 'hybrid' ||
      this.config.providerProtocol === 'browser-speech';
    if (wantsBrowserSpeech && typeof this.speechRecognitionFactory === 'function') {
      try {
        const rec = this.speechRecognitionFactory();
        if (rec) {
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = SPEECH_LANG_MAP[this.config.language] || 'zh-CN';
          rec.onresult = (ev) => {
            if (token !== this._operationToken) return;
            let interim = '';
            const results = ev?.results || [];
            for (let i = ev.resultIndex || 0; i < results.length; i += 1) {
              const res = results[i];
              const text = res?.[0]?.transcript || '';
              if (res?.isFinal) {
                this.finalTranscriptParts.push(text.trim());
              } else {
                interim += text;
              }
            }
            this.liveTranscript = [...this.finalTranscriptParts, interim.trim()]
              .filter(Boolean)
              .join(' ')
              .trim();
            this.notify();
          };
          rec.onerror = (ev) => {
            if (token !== this._operationToken) return;
            if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
              this._setError(
                'microphone-blocked',
                '浏览器未授予麦克风权限，请在系统设置中允许访问',
                'settings',
              );
            }
          };
          rec.start();
          this._recognition = rec;
        }
      } catch {
        this._recognition = null;
      }
    }

    // 2. Acquire microphone stream with preferred device fallback
    if (typeof this.getUserMedia === 'function') {
      try {
        const devices = this.availableMicrophones.length
          ? this.availableMicrophones
          : await enumerateAudioInputs();
        const preferredId = resolvePreferredMicrophone(
          this.microphoneOrder,
          devices,
          this.config.audioDeviceId,
        );
        const audioConstraint =
          preferredId && preferredId !== 'default'
            ? {
                deviceId: { ideal: preferredId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              };

        const stream = await this.getUserMedia({ audio: audioConstraint });
        if (token !== this._operationToken) {
          stream?.getTracks?.().forEach((t) => t.stop());
          return { started: false, cancelled: true };
        }

        if (stream) {
          this._mediaStream = stream;

          // Detect mid-recording microphone disconnect
          const audioTrack = stream.getAudioTracks?.()[0];
          if (audioTrack && typeof audioTrack.addEventListener === 'function') {
            this._trackEndedHandler = () => {
              if (token !== this._operationToken || this.state !== 'recording') return;
              this._cleanupMediaResources();
              this._setError(
                'microphone-disconnected',
                '麦克风已断开连接，请检查音频输入设备后重试',
                'settings',
              );
            };
            audioTrack.addEventListener('ended', this._trackEndedHandler);
          }

          await this._setupAudioCapture(stream, token);

          // Also capture MediaRecorder blob if available for compact uploads
          if (typeof MediaRecorder === 'function') {
            try {
              const preferredMime =
                typeof MediaRecorder.isTypeSupported === 'function' &&
                MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                  ? 'audio/webm;codecs=opus'
                  : undefined;
              const recorder = preferredMime
                ? new MediaRecorder(stream, { mimeType: preferredMime })
                : new MediaRecorder(stream);
              recorder.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0) {
                  this._recordedBlobs.push(ev.data);
                }
              };
              recorder.start(250);
              this._mediaRecorder = recorder;
            } catch {
              this._mediaRecorder = null;
            }
          }
        }
      } catch (err) {
        if (token !== this._operationToken) {
          return { started: false, cancelled: true };
        }
        const name = err?.name || '';
        const isPermission = name === 'NotAllowedError' || name === 'SecurityError';
        const isMissing = name === 'NotFoundError' || name === 'DevicesNotFoundError';
        if (!this._recognition) {
          this._cleanupMediaResources();
          this._setError(
            isPermission
              ? 'microphone-blocked'
              : isMissing
                ? 'microphone-disconnected'
                : 'microphone-failed',
            isPermission
              ? '麦克风权限被拒绝，请在系统/应用权限设置中允许麦克风访问'
              : isMissing
                ? '未检测到可用麦克风，请插入设备后重试'
                : `无法启动麦克风录音：${String(err?.message || err)}`,
            isPermission || isMissing ? 'settings' : 'retry',
          );
          return { started: false, error: this.lastError, errorCode: this.errorCode };
        }
      }
    }

    if (token !== this._operationToken) {
      this._cleanupMediaResources();
      return { started: false, cancelled: true };
    }

    this._recordingStartedAt = Date.now();
    this.state = 'recording';
    this._durationTimer = setInterval(() => {
      if (token !== this._operationToken || this.state !== 'recording') return;
      this.durationMs = Date.now() - this._recordingStartedAt;
      if (this.durationMs >= MAX_RECORDING_MS) {
        void this.stopRecording({ reason: 'max-duration' });
        return;
      }
      this.notify();
    }, 120);

    this.notify();
    return { started: true, state: this.state };
  }

  async _collectCapturedAudio() {
    let audioBase64 = '';
    let mimeType = 'audio/wav';

    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        const rec = this._mediaRecorder;
        const done = () => resolve();
        rec.onstop = done;
        try {
          rec.stop();
        } catch {
          done();
        }
        setTimeout(done, 400);
      });
    }

    if (this._recordedBlobs.length > 0 && typeof Blob === 'function') {
      const blob = new Blob(this._recordedBlobs, {
        type: this._recordedBlobs[0]?.type || 'audio/webm',
      });
      mimeType = blob.type || 'audio/webm';
      audioBase64 = await blobToBase64(blob).catch(() => '');
    }

    let wavBase64 = '';
    if (this._pcmChunks.length > 0) {
      const merged = concatFloat32Chunks(this._pcmChunks);
      if (merged.length > 0) {
        wavBase64 = encodeMonoWavBase64(merged, this._pcmSampleRate, 16000);
      }
    }

    // Prefer clean 16kHz FIR-resampled WAV for local-model, silence VAD, and universal provider support
    if (
      wavBase64 &&
      (!audioBase64 ||
        this.config.silenceFiltering ||
        this.config.providerProtocol === 'local-model')
    ) {
      audioBase64 = wavBase64;
      mimeType = 'audio/wav';
    }

    return {
      audioBase64,
      wavBase64,
      mimeType,
      liveTranscript: this.liveTranscript.trim(),
    };
  }

  async stopRecording(options = {}) {
    if (this.state !== 'recording' && this.state !== 'preparing') {
      return { stopped: false, reason: 'not-recording' };
    }

    const token = this._operationToken;
    const testOnly = Boolean(options.testOnly ?? this.isTestSession);
    const draftContext = this._activeDraftContext;

    if (this._recognition) {
      try {
        this._recognition.stop();
      } catch {
        // ignore
      }
    }

    const capture = await this._collectCapturedAudio();
    this._cleanupMediaResources();
    this._recordedBlobs = [];
    this._pcmChunks = [];

    if (token !== this._operationToken) {
      return { stopped: true, cancelled: true };
    }

    const payload = {
      ...capture,
      language: this.config.language,
      providerProtocol: this.config.providerProtocol,
      translateToEnglish: this.config.translateToEnglish,
      draftContext,
      testOnly,
    };

    return await this._runTranscriptionPipeline(payload, token, options);
  }

  async retryLastRecording() {
    if (!this.lastFailedCapture) {
      return await this.startRecording();
    }
    const token = ++this._operationToken;
    const capture = { ...this.lastFailedCapture };
    this._clearError();
    return await this._runTranscriptionPipeline(capture, token, {});
  }

  skipPostProcessing() {
    if (this.state !== 'post-processing') return false;
    if (this._activeRequestId && typeof this.invokeWorker === 'function') {
      void this.invokeWorker('voice.cancel', { requestId: this._activeRequestId }).catch(() => {});
    }
    if (typeof this._skipPostProcessingResolver === 'function') {
      this._skipPostProcessingResolver({ skipped: true });
      this._skipPostProcessingResolver = null;
      return true;
    }
    return false;
  }

  async _runTranscriptionPipeline(capture, token, options = {}) {
    this.state = 'transcribing';
    this._clearError();
    this.notify();

    const requestId = `req-${Date.now()}-${token}`;
    this._activeRequestId = requestId;

    const wantsTwoStageLlm =
      this.config.cleanupMode !== 'off' &&
      this.config.useLlmCleanup === true &&
      this.config.providerProtocol !== 'browser-speech' &&
      this.config.providerProtocol !== 'local-model';

    try {
      let result = null;
      if (typeof this.invokeWorker === 'function') {
        result = await this.invokeWorker('voice.transcribe', {
          requestId,
          audioBase64: capture.audioBase64,
          wavBase64: capture.wavBase64,
          mimeType: capture.mimeType,
          liveTranscript: capture.liveTranscript,
          language: this.config.language,
          providerProtocol: this.config.providerProtocol,
          translateToEnglish: this.config.translateToEnglish,
          draftContext: capture.draftContext || null,
          deferLlmCleanup: wantsTwoStageLlm,
        });
      } else if (capture.liveTranscript) {
        const cleaned = cleanTranscriptText(capture.liveTranscript, {
          cleanupMode: this.config.cleanupMode,
          vocabulary: this.config.vocabulary,
          removeFillerWords: this.config.removeFillerWords,
          correctionCue: this.config.correctionCue,
        });
        result = {
          id: `local-${Date.now()}`,
          rawText: capture.liveTranscript,
          cleanedText: cleaned,
          text: cleaned,
          provider: 'browser-speech',
        };
      }

      if (token !== this._operationToken) {
        return { stopped: true, cancelled: true };
      }

      if (!result || !String(result.text || result.rawText || '').trim()) {
        this.lastFailedCapture = capture.audioBase64 || capture.wavBase64 ? capture : null;
        this._setError('no-speech', '未识别到有效语音内容，请重试', 'retry');
        return { stopped: true, inserted: false, error: this.lastError, errorCode: this.errorCode };
      }

      let rawText = String(result.rawText || result.text || '').trim();
      let cleanedText = String(result.cleanedText || result.text || rawText).trim();
      let usedLlm = Boolean(result.usedLlm);

      // Stage 2: Optional skippable LLM post-processing
      const shouldRunStage2Cleanup =
        wantsTwoStageLlm &&
        !usedLlm &&
        typeof this.invokeWorker === 'function' &&
        (Boolean(capture.draftContext) ||
          Boolean(this.config.correctionCue) ||
          Boolean(this.config.cleanupInstructions) ||
          rawText.length >= 16);

      if (shouldRunStage2Cleanup) {
        this.state = 'post-processing';
        const cleanReqId = `${requestId}-clean`;
        this._activeRequestId = cleanReqId;
        this.notify();

        const skipPromise = new Promise((resolve) => {
          this._skipPostProcessingResolver = resolve;
        });

        const cleanupPromise = this.invokeWorker('voice.cleanup', {
          requestId: cleanReqId,
          text: rawText,
          draftContext: capture.draftContext || null,
        })
          .then((res) => ({ skipped: false, res }))
          .catch(() => ({ skipped: true, res: null }));

        const race = await Promise.race([cleanupPromise, skipPromise]);
        this._skipPostProcessingResolver = null;

        if (token !== this._operationToken) {
          return { stopped: true, cancelled: true };
        }

        if (!race.skipped && race.res?.cleanedText) {
          cleanedText = String(race.res.cleanedText).trim();
          usedLlm = Boolean(race.res.usedLlm);
        }
      }

      const finalText = this.config.cleanupMode === 'off' ? rawText : cleanedText;
      const completed = {
        ...result,
        rawText,
        cleanedText,
        text: finalText,
        usedLlm,
      };

      this.lastResult = completed;
      this.lastFailedCapture = null;
      this._activeRequestId = null;

      if (capture.testOnly) {
        this.lastTestResult = completed;
        this.isTestSession = false;
        this.state = 'idle';
        this.notify();
        return {
          stopped: true,
          testOnly: true,
          inserted: false,
          ...completed,
        };
      }

      this._pushHistory(completed);

      if (this.config.cleanupMode === 'preview' && options.autoInsert !== true) {
        this.previewDraft = {
          rawText,
          cleanedText,
          editedText: cleanedText,
          activeVariant: 'cleaned',
          provider: completed.provider || this.config.providerProtocol,
          latencyMs: completed.latencyMs || 0,
          usedLlm,
          draftContext: capture.draftContext || null,
        };
        this.state = 'preview';
        this.notify();
        return {
          stopped: true,
          preview: true,
          inserted: false,
          ...completed,
        };
      }

      const insertRes = await this.insertTranscriptIntoTarget(finalText, {
        draftContext: capture.draftContext || null,
      });
      this.state = 'idle';
      this.notify();

      return {
        stopped: true,
        inserted: insertRes.inserted,
        target: insertRes.target,
        ...completed,
      };
    } catch (err) {
      if (token !== this._operationToken) {
        return { stopped: true, cancelled: true };
      }
      this._activeRequestId = null;
      this.lastFailedCapture = capture.audioBase64 || capture.wavBase64 ? capture : null;
      const code = err?.code || err?.errorCode || 'transcription-failed';
      const action =
        err?.action ||
        err?.errorAction ||
        (code === 'missing-key' || code === 'rejected-key' || code === 'model-unavailable'
          ? 'settings'
          : 'retry');
      this._setError(code, String(err?.message || err), action);
      return {
        stopped: true,
        inserted: false,
        error: this.lastError,
        errorCode: this.errorCode,
      };
    }
  }

  updatePreviewText(nextText, variant) {
    if (!this.previewDraft) return;
    this.previewDraft = {
      ...this.previewDraft,
      editedText: typeof nextText === 'string' ? nextText : this.previewDraft.editedText,
      activeVariant: variant || this.previewDraft.activeVariant,
    };
    this.notify();
  }

  async commitPreview(useRaw = false) {
    if (!this.previewDraft) return { inserted: false, target: null };
    const draft = this.previewDraft;
    const text = useRaw
      ? draft.rawText
      : String(draft.editedText || draft.cleanedText || draft.rawText).trim();
    this.previewDraft = null;
    this.state = 'idle';
    this.notify();
    if (!text) return { inserted: false, target: null };
    return await this.insertTranscriptIntoTarget(text, {
      draftContext: draft.draftContext || null,
    });
  }

  cancelPreview() {
    this.previewDraft = null;
    if (this.state === 'preview') {
      this.state = 'idle';
    }
    this.notify();
    return { cancelled: true };
  }

  cancelRecording() {
    this._operationToken += 1;
    if (this._activeRequestId && typeof this.invokeWorker === 'function') {
      void this.invokeWorker('voice.cancel', { requestId: this._activeRequestId }).catch(() => {});
      this._activeRequestId = null;
    }
    if (typeof this._skipPostProcessingResolver === 'function') {
      this._skipPostProcessingResolver({ skipped: true });
      this._skipPostProcessingResolver = null;
    }
    this._cleanupMediaResources();
    this._recordedBlobs = [];
    this._pcmChunks = [];
    this.liveTranscript = '';
    this.finalTranscriptParts = [];
    this.durationMs = 0;
    this.previewDraft = null;
    this.isTestSession = false;
    this._clearError();
    this.state = 'idle';
    this.notify();
    return { cancelled: true };
  }

  async toggleRecording(options = {}) {
    if (this.state === 'recording' || this.state === 'preparing') {
      return await this.stopRecording(options);
    }
    if (this.state === 'preview') {
      return await this.commitPreview(false);
    }
    return await this.startRecording(options);
  }

  async insertTranscriptIntoTarget(rawText, options = {}) {
    const cleanRaw = String(rawText || '').trim();
    if (!cleanRaw) return { inserted: false, target: null };

    const draftContext =
      options.draftContext ?? readComposerDraftContext(this.getEditorBridge);
    const text = formatTranscriptInsertion(cleanRaw, draftContext);

    // 1. Focused Monaco Editor with Undo Stop Barrier
    try {
      const bridge =
        typeof this.getEditorBridge === 'function' ? this.getEditorBridge() : null;
      const editor =
        bridge && typeof bridge.getActiveEditor === 'function'
          ? bridge.getActiveEditor()
          : null;
      if (editor && typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) {
        const pos =
          (typeof editor.getSelection === 'function' && editor.getSelection()) ||
          (typeof editor.getPosition === 'function' && editor.getPosition()) || {
            lineNumber: 1,
            column: 1,
          };
        const range =
          pos.startLineNumber !== undefined
            ? pos
            : {
                startLineNumber: pos.lineNumber || 1,
                startColumn: pos.column || 1,
                endLineNumber: pos.lineNumber || 1,
                endColumn: pos.column || 1,
              };
        if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
        editor.executeEdits(PLUGIN_ID, [{ range, text, forceMoveMarkers: true }]);
        if (typeof editor.pushUndoStop === 'function') editor.pushUndoStop();
        return { inserted: true, target: 'monaco-editor', text };
      }
    } catch {
      // fall through to composer
    }

    // 2. Host session composer bridge
    if (typeof this.insertIntoComposer === 'function') {
      try {
        const ok = await this.insertIntoComposer(text);
        if (ok !== false) {
          return { inserted: true, target: 'session-composer', text };
        }
      } catch {
        // fall through to active DOM input
      }
    }

    // 3. Fallback: focused DOM textarea / input
    try {
      if (typeof document !== 'undefined') {
        const active = document.activeElement;
        if (
          active &&
          (active.tagName === 'TEXTAREA' ||
            (active.tagName === 'INPUT' &&
              /^(text|search|url|email)$/i.test(active.type || 'text')))
        ) {
          const val = String(active.value || '');
          const start =
            typeof active.selectionStart === 'number' ? active.selectionStart : val.length;
          const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : start;
          active.value = `${val.slice(0, start)}${text}${val.slice(end)}`;
          if (typeof active.setSelectionRange === 'function') {
            const caret = start + text.length;
            active.setSelectionRange(caret, caret);
          }
          if (typeof active.dispatchEvent === 'function' && typeof Event === 'function') {
            active.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { inserted: true, target: 'dom-input', text };
        }
      }
    } catch {
      // ignore
    }

    return { inserted: false, target: null, text };
  }

  dispose() {
    this._operationToken += 1;
    this._cleanupMediaResources();
    this._listeners.clear();
  }
}

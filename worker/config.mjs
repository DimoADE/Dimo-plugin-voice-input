import {
  DEFAULT_HF_MIRROR_URL,
  DEFAULT_LOCAL_MODEL_ID,
  normalizeHfMirrorUrl,
} from './localCatalog.mjs';

export const PLUGIN_ID = 'dimo.voice-input';

export const VALID_PROTOCOLS = new Set([
  'hybrid',
  'local-model',
  'openai-whisper',
  'groq-whisper',
  'xai-stt',
  'openrouter-stt',
  'openai-chat-audio',
  'custom-openai',
  'browser-speech',
]);

export const VALID_LOCAL_ACCELERATIONS = new Set(['auto', 'cpu', 'gpu']);

export const VALID_LANGUAGES = new Set([
  'auto',
  'zh',
  'en',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
]);

export const VALID_RECORDING_MODES = new Set([
  'auto',
  'toggle',
  'push-to-talk',
]);

export const VALID_CLEANUP_MODES = new Set(['auto-clean', 'preview', 'off']);

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  enabled: true,
  providerProtocol: 'hybrid',
  localModelId: DEFAULT_LOCAL_MODEL_ID,
  localAcceleration: 'auto',
  localUnloadTimeoutSec: 300,
  hfMirrorUrl: DEFAULT_HF_MIRROR_URL,
  localModelsDir: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini-transcribe',
  cleanupModel: 'gpt-4o-mini',
  language: 'auto',
  translateToEnglish: false,
  recordingMode: 'auto',
  shortcut: 'Alt+V',
  cleanupMode: 'auto-clean',
  removeFillerWords: true,
  useLlmCleanup: true,
  correctionCue: '',
  cleanupInstructions: '',
  vocabulary:
    'Dimo, Tauri, Monaco, TypeScript, Rust, React, MCP, Skill, Worktree, Claude, Codex',
  silenceFiltering: true,
  audioDeviceId: 'default',
  showFloatingHud: true,
});

export function normalizeVoiceConfig(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const protocol = VALID_PROTOCOLS.has(input.providerProtocol)
    ? input.providerProtocol
    : DEFAULT_VOICE_CONFIG.providerProtocol;
  const localAcceleration = VALID_LOCAL_ACCELERATIONS.has(input.localAcceleration)
    ? input.localAcceleration
    : DEFAULT_VOICE_CONFIG.localAcceleration;
  const language = VALID_LANGUAGES.has(input.language)
    ? input.language
    : DEFAULT_VOICE_CONFIG.language;
  const recordingMode = VALID_RECORDING_MODES.has(input.recordingMode)
    ? input.recordingMode
    : DEFAULT_VOICE_CONFIG.recordingMode;
  const cleanupMode = VALID_CLEANUP_MODES.has(input.cleanupMode)
    ? input.cleanupMode
    : DEFAULT_VOICE_CONFIG.cleanupMode;

  const rawUnloadSec = Number(input.localUnloadTimeoutSec);
  const localUnloadTimeoutSec = Number.isFinite(rawUnloadSec)
    ? Math.max(0, Math.min(3600, Math.round(rawUnloadSec)))
    : DEFAULT_VOICE_CONFIG.localUnloadTimeoutSec;

  return {
    enabled:
      typeof input.enabled === 'boolean'
        ? input.enabled
        : DEFAULT_VOICE_CONFIG.enabled,
    providerProtocol: protocol,
    localModelId:
      typeof input.localModelId === 'string' && input.localModelId.trim()
        ? input.localModelId.trim()
        : DEFAULT_VOICE_CONFIG.localModelId,
    localAcceleration,
    localUnloadTimeoutSec,
    hfMirrorUrl: normalizeHfMirrorUrl(input.hfMirrorUrl),
    localModelsDir:
      typeof input.localModelsDir === 'string' ? input.localModelsDir.trim() : '',
    baseUrl:
      typeof input.baseUrl === 'string' && input.baseUrl.trim()
        ? input.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULT_VOICE_CONFIG.baseUrl,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    model:
      typeof input.model === 'string' && input.model.trim()
        ? input.model.trim()
        : DEFAULT_VOICE_CONFIG.model,
    cleanupModel:
      typeof input.cleanupModel === 'string' && input.cleanupModel.trim()
        ? input.cleanupModel.trim()
        : DEFAULT_VOICE_CONFIG.cleanupModel,
    language,
    translateToEnglish:
      typeof input.translateToEnglish === 'boolean'
        ? input.translateToEnglish
        : DEFAULT_VOICE_CONFIG.translateToEnglish,
    recordingMode,
    shortcut:
      typeof input.shortcut === 'string' && input.shortcut.trim()
        ? input.shortcut.trim()
        : DEFAULT_VOICE_CONFIG.shortcut,
    cleanupMode,
    removeFillerWords:
      typeof input.removeFillerWords === 'boolean'
        ? input.removeFillerWords
        : DEFAULT_VOICE_CONFIG.removeFillerWords,
    useLlmCleanup:
      typeof input.useLlmCleanup === 'boolean'
        ? input.useLlmCleanup
        : DEFAULT_VOICE_CONFIG.useLlmCleanup,
    correctionCue:
      typeof input.correctionCue === 'string'
        ? input.correctionCue.trim().slice(0, 64)
        : DEFAULT_VOICE_CONFIG.correctionCue,
    cleanupInstructions:
      typeof input.cleanupInstructions === 'string'
        ? input.cleanupInstructions.trim().slice(0, 1200)
        : DEFAULT_VOICE_CONFIG.cleanupInstructions,
    vocabulary:
      typeof input.vocabulary === 'string'
        ? input.vocabulary
        : DEFAULT_VOICE_CONFIG.vocabulary,
    silenceFiltering:
      typeof input.silenceFiltering === 'boolean'
        ? input.silenceFiltering
        : DEFAULT_VOICE_CONFIG.silenceFiltering,
    audioDeviceId:
      typeof input.audioDeviceId === 'string' && input.audioDeviceId.trim()
        ? input.audioDeviceId.trim()
        : DEFAULT_VOICE_CONFIG.audioDeviceId,
    showFloatingHud:
      typeof input.showFloatingHud === 'boolean'
        ? input.showFloatingHud
        : DEFAULT_VOICE_CONFIG.showFloatingHud,
  };
}

export function isLocalhostUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

export function resolveApiKey(config, env = process.env) {
  if (config?.apiKey && config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  const sourceEnv = env && typeof env === 'object' ? env : {};
  const protocol = config?.providerProtocol || 'hybrid';
  if (protocol === 'groq-whisper') {
    return (
      sourceEnv.GROQ_API_KEY ||
      sourceEnv.DIMO_VOICE_API_KEY ||
      sourceEnv.OPENAI_API_KEY ||
      ''
    ).trim();
  }
  if (protocol === 'xai-stt') {
    return (
      sourceEnv.XAI_API_KEY ||
      sourceEnv.DIMO_VOICE_API_KEY ||
      ''
    ).trim();
  }
  if (protocol === 'openrouter-stt') {
    return (
      sourceEnv.OPENROUTER_API_KEY ||
      sourceEnv.DIMO_VOICE_API_KEY ||
      ''
    ).trim();
  }
  return (
    sourceEnv.DIMO_VOICE_API_KEY ||
    sourceEnv.OPENAI_API_KEY ||
    sourceEnv.GROQ_API_KEY ||
    ''
  ).trim();
}

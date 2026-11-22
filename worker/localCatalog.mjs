/**
 * Curated catalog of local GGUF speech recognition models compatible with `transcribe-cpp`
 * (aligned with handy-computer/transcribe.cpp & T3 Code SpeechModelStore).
 *
 * Every model entry is pinned to a specific HuggingFace commit revision with exact byte size
 * and SHA-256 digest for integrity verification and zero-copy local deduplication.
 */

export const DEFAULT_HF_MIRROR_URL = 'https://huggingface.co';
export const CN_HF_MIRROR_URL = 'https://hf-mirror.com';

export const DEFAULT_LOCAL_MODEL_ID = 'handy-computer/SenseVoiceSmall-gguf';

export const LOCAL_SPEECH_MODELS = Object.freeze([
  Object.freeze({
    id: 'handy-computer/SenseVoiceSmall-gguf',
    revision: '4a08b8e900b38a977e32eb08d5d0697d6e72ba04',
    name: 'SenseVoice Small (Q8_0)',
    description: '超快中英日韩粤多语识别，体积小巧、延迟极低，推荐日常中文与双语听写。',
    filename: 'SenseVoiceSmall-Q8_0.gguf',
    size: 252_684_608,
    sha256: '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29',
    languages: ['zh', 'yue', 'en', 'ja', 'ko'],
    languageCount: 5,
    recommended: true,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['推荐', '中文优选', '极速'],
  }),
  Object.freeze({
    id: 'handy-computer/Qwen3-ASR-0.6B-gguf',
    revision: 'e4e16599b900eb0cb36e524514756bb92eb092b7',
    name: 'Qwen3-ASR 0.6B (Q8_0)',
    description: '通义千问新一代轻量语音识别模型，中英文混说与技术术语表现优异。',
    filename: 'Qwen3-ASR-0.6B-Q8_0.gguf',
    size: 850_423_456,
    sha256: 'f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8',
    languages: ['zh', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 30,
    recommended: true,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['推荐', '中英混说'],
  }),
  Object.freeze({
    id: 'handy-computer/whisper-large-v3-turbo-gguf',
    revision: '5eaf945c7978e564bae5b28a5b1639dd93c2bfb1',
    name: 'Whisper Large v3 Turbo (Q8_0)',
    description: 'OpenAI Whisper 大模型 Turbo 量化版，覆盖 100 种语言，精度与速度均衡。',
    filename: 'whisper-large-v3-turbo-Q8_0.gguf',
    size: 886_381_760,
    sha256: 'b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 100,
    recommended: true,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['推荐', '高精度', '100语种'],
  }),
  Object.freeze({
    id: 'handy-computer/Fun-ASR-MLT-Nano-2512-gguf',
    revision: '0b8f9c7bc545a219658aeb1dd4eeaa55d1cf89f3',
    name: 'Fun-ASR MLT Nano 2512 (Q8_0)',
    description: '阿里 FunASR 多语种端侧模型，支持 31 种语言及方言口音鲁棒识别。',
    filename: 'Fun-ASR-MLT-Nano-2512-Q8_0.gguf',
    size: 891_271_232,
    sha256: 'd12476d8d9f2baa0ebf738fa955fa05ed33a654f1567289033a810c45d9d9002',
    languages: ['zh', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 31,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['多语种', '中文'],
  }),
  Object.freeze({
    id: 'handy-computer/parakeet-unified-en-0.6b-gguf',
    revision: '7e948f21b7bdbac698d3318db9d350f1096f3b6c',
    name: 'Parakeet Unified EN 0.6B (Q8_0)',
    description: 'NVIDIA Parakeet 英文流式识别模型，纯英语听写速度与准确率顶尖。',
    filename: 'parakeet-unified-en-0.6b-Q8_0.gguf',
    size: 731_357_568,
    sha256: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795',
    languages: ['en'],
    languageCount: 1,
    recommended: false,
    supportsStreaming: true,
    supportsLanguageDetection: false,
    supportsTranslation: false,
    tags: ['英文专精', '流式'],
  }),
  Object.freeze({
    id: 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf',
    revision: '6d44e540bc31b0de1dbe174a3cea87f53a7f22fb',
    name: 'Nemotron 3.5 ASR Streaming 0.6B (Q8_0)',
    description: 'NVIDIA Nemotron 28 语种流式语音模型，低延迟边录边转写。',
    filename: 'nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf',
    size: 751_094_240,
    sha256: 'b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 28,
    recommended: false,
    supportsStreaming: true,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['流式', '多语种'],
  }),
  Object.freeze({
    id: 'handy-computer/whisper-medium-gguf',
    revision: 'ec78f06fded51aa82cde751678b78f76f78c8b7f',
    name: 'Whisper Medium (Q8_0)',
    description: '经典 Whisper Medium 99 语种模型，支持将任意语音直接翻译为英文。',
    filename: 'whisper-medium-Q8_0.gguf',
    size: 831_538_144,
    sha256: '09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 99,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: true,
    tags: ['可译英文', '99语种'],
  }),
  Object.freeze({
    id: 'handy-computer/whisper-small-gguf',
    revision: 'c0214bd34be9296695486f838e0142f900803159',
    name: 'Whisper Small (Q8_0)',
    description: '轻量 99 语种 Whisper 模型，CPU 机器流畅运行并支持英译。',
    filename: 'whisper-small-Q8_0.gguf',
    size: 269_751_136,
    sha256: '9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 99,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: true,
    tags: ['轻量', '可译英文'],
  }),
  Object.freeze({
    id: 'handy-computer/whisper-base-gguf',
    revision: 'e0f69524f648720eca44c024d1d0dbb7027d1fa0',
    name: 'Whisper Base (Q8_0)',
    description: '81 MB 超轻量 Whisper 模型，极低内存占用，适合老旧设备离线听写。',
    filename: 'whisper-base-Q8_0.gguf',
    size: 84_962_880,
    sha256: '81c069428bc8a24551a8169cf31cf09bcfd9d4cf50389ae281323c9aa9648c81',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 99,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: true,
    tags: ['超轻量', '可译英文'],
  }),
  Object.freeze({
    id: 'handy-computer/whisper-tiny-gguf',
    revision: '6687f30c99641ee265df421e582354adbc8848fc',
    name: 'Whisper Tiny (Q8_0)',
    description: '仅 44 MB 的极速尝鲜模型，秒级下载并离线可用。',
    filename: 'whisper-tiny-Q8_0.gguf',
    size: 45_981_088,
    sha256: '325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834',
    languages: ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 99,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: true,
    tags: ['极小', '秒级下载'],
  }),
  Object.freeze({
    id: 'handy-computer/canary-180m-flash-gguf',
    revision: '46b86384d1db59108d6e060a0fc00924cb58499f',
    name: 'Canary 180M Flash (Q8_0)',
    description: 'NVIDIA Canary 欧洲四语极速识别与互译模型（英/德/西/法）。',
    filename: 'canary-180m-flash-Q8_0.gguf',
    size: 218_447_648,
    sha256: 'f942ab746040b531a29ab78ca3afc8dc9564efd8e4c942b5541e53644be9c408',
    languages: ['en', 'de', 'es', 'fr'],
    languageCount: 4,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: true,
    tags: ['欧美语种', '极速'],
  }),
  Object.freeze({
    id: 'handy-computer/Qwen3-ASR-1.7B-gguf',
    revision: '92282af1610a2db19d66f2bef1e260f5deca782d',
    name: 'Qwen3-ASR 1.7B (Q8_0)',
    description: '通义千问旗舰级本地语音识别模型，中英专业词汇准确率最高（需较大内存/显存）。',
    filename: 'Qwen3-ASR-1.7B-Q8_0.gguf',
    size: 2_185_030_624,
    sha256: '9a0d81792dfea2d5f278b8a63deb3ea6e02139ce42c2301f32ea19c4f77526b7',
    languages: ['zh', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'es'],
    languageCount: 30,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    tags: ['旗舰高精度', '中英混说'],
  }),
]);

export function getLocalSpeechModel(id) {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.trim();
  return LOCAL_SPEECH_MODELS.find((m) => m.id === trimmed || m.filename === trimmed) || null;
}

export function normalizeHfMirrorUrl(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_HF_MIRROR_URL;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_HF_MIRROR_URL;
  if (!/^https?:\/\//i.test(trimmed)) return DEFAULT_HF_MIRROR_URL;
  return trimmed;
}

export function buildModelDownloadUrl(model, hfMirrorUrl = DEFAULT_HF_MIRROR_URL) {
  const base = normalizeHfMirrorUrl(hfMirrorUrl);
  return `${base}/${model.id}/resolve/${model.revision}/${model.filename}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

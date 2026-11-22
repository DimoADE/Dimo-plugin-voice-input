import { stripBase64DataUrlPrefix } from './audio.mjs';
import { isLocalhostUrl } from './config.mjs';
import { buildWhisperPrompt, parseVocabularyList } from './textProcessing.mjs';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const XAI_BASE_URL = 'https://api.x.ai/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function resolveMimeExtension(mimeType = 'audio/wav') {
  const lower = String(mimeType || '').toLowerCase();
  if (lower.includes('webm')) return { ext: 'webm', format: 'webm', mime: 'audio/webm' };
  if (lower.includes('ogg') || lower.includes('opus')) return { ext: 'ogg', format: 'ogg', mime: 'audio/ogg' };
  if (lower.includes('mp4') || lower.includes('m4a')) return { ext: 'm4a', format: 'm4a', mime: 'audio/mp4' };
  if (lower.includes('mp3') || lower.includes('mpeg')) return { ext: 'mp3', format: 'mp3', mime: 'audio/mpeg' };
  if (lower.includes('flac')) return { ext: 'flac', format: 'flac', mime: 'audio/flac' };
  return { ext: 'wav', format: 'wav', mime: 'audio/wav' };
}

export function buildMultipartBuffer(fields, filePart) {
  const boundary = `----DimoVoiceBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const chunks = [];

  for (const [name, value] of fields) {
    if (value === undefined || value === null || value === '') continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
        'utf8',
      ),
    );
  }

  if (filePart) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${filePart.fieldName || 'file'}"; filename="${filePart.filename}"\r\nContent-Type: ${filePart.contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(filePart.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

function isDefaultOpenAiBase(baseUrl) {
  const cleaned = String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
  return !cleaned || cleaned === 'https://api.openai.com/v1';
}

export function buildMultipartAudioRequest({
  baseUrl = 'https://api.openai.com/v1',
  apiKey = '',
  providerProtocol = 'openai-whisper',
  model = 'gpt-4o-mini-transcribe',
  audioBase64 = '',
  mimeType = 'audio/wav',
  language = 'auto',
  translateToEnglish = false,
  vocabulary = '',
  correctionCue = '',
}) {
  const cleanB64 = stripBase64DataUrlPrefix(audioBase64);
  const audioBuffer = Buffer.from(cleanB64, 'base64');
  const { ext, mime } = resolveMimeExtension(mimeType);

  let effectiveBase = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let effectiveModel = String(model || 'gpt-4o-mini-transcribe').trim();

  if (providerProtocol === 'groq-whisper') {
    if (isDefaultOpenAiBase(effectiveBase)) {
      effectiveBase = GROQ_BASE_URL;
    }
    if (
      !effectiveModel ||
      effectiveModel === 'gpt-4o-mini-transcribe' ||
      effectiveModel === 'gpt-4o-transcribe' ||
      effectiveModel === 'whisper-1'
    ) {
      effectiveModel = 'whisper-large-v3-turbo';
    }
  }

  const prompt = buildWhisperPrompt(vocabulary, language, correctionCue);
  const endpoint = translateToEnglish ? 'audio/translations' : 'audio/transcriptions';

  const fields = [
    ['model', effectiveModel],
    ['response_format', 'json'],
  ];
  if (!translateToEnglish && language && language !== 'auto') {
    fields.push(['language', language]);
  }
  if (prompt) {
    fields.push(['prompt', prompt]);
  }

  const { boundary, body } = buildMultipartBuffer(fields, {
    fieldName: 'file',
    filename: `speech.${ext}`,
    contentType: mime,
    data: audioBuffer,
  });

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  return {
    url: `${effectiveBase}/${endpoint}`,
    method: 'POST',
    headers,
    model: effectiveModel,
    body,
    requiresApiKey: !(providerProtocol === 'custom-openai' && isLocalhostUrl(effectiveBase)),
  };
}

/**
 * xAI / Grok Speech-to-Text (`POST https://api.x.ai/v1/stt`)
 * Supports keyterm biasing, filler_words control, and vad_threshold. File part is placed last.
 */
export function buildXaiSttRequest({
  baseUrl = '',
  apiKey = '',
  model = 'grok-voice-transcribe-2.0',
  audioBase64 = '',
  mimeType = 'audio/wav',
  language = 'auto',
  vocabulary = '',
  correctionCue = '',
  removeFillerWords = true,
}) {
  const cleanB64 = stripBase64DataUrlPrefix(audioBase64);
  const audioBuffer = Buffer.from(cleanB64, 'base64');
  const { ext, mime } = resolveMimeExtension(mimeType);

  const effectiveBase = isDefaultOpenAiBase(baseUrl)
    ? XAI_BASE_URL
    : String(baseUrl).replace(/\/+$/, '');
  const effectiveModel =
    !model || model === 'gpt-4o-mini-transcribe'
      ? 'grok-voice-transcribe-2.0'
      : String(model).trim();

  const terms = parseVocabularyList(vocabulary);
  const cue = typeof correctionCue === 'string' ? correctionCue.trim() : '';
  if (cue && !terms.includes(cue)) terms.push(cue);

  const fields = [['model', effectiveModel]];
  if (language && language !== 'auto') {
    fields.push(['language', language]);
  }
  if (removeFillerWords) {
    fields.push(['filler_words', 'false']);
  }
  if (terms.length > 0) {
    for (const term of terms.slice(0, 50)) {
      fields.push(['keyterm', term]);
    }
  }

  const { boundary, body } = buildMultipartBuffer(fields, {
    fieldName: 'file',
    filename: `speech.${ext}`,
    contentType: mime,
    data: audioBuffer,
  });

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  return {
    url: `${effectiveBase}/stt`,
    method: 'POST',
    headers,
    model: effectiveModel,
    body,
    requiresApiKey: true,
  };
}

/**
 * OpenRouter Audio Transcriptions (`POST https://openrouter.ai/api/v1/audio/transcriptions`)
 * Uses JSON `input_audio` payload compatible with OpenRouter's unified audio endpoint.
 */
export function buildOpenRouterAudioRequest({
  baseUrl = '',
  apiKey = '',
  model = 'openai/gpt-4o-mini-transcribe',
  audioBase64 = '',
  mimeType = 'audio/wav',
  language = 'auto',
  vocabulary = '',
  correctionCue = '',
  zdr = false,
}) {
  const cleanB64 = stripBase64DataUrlPrefix(audioBase64);
  const { format } = resolveMimeExtension(mimeType);
  const effectiveBase = isDefaultOpenAiBase(baseUrl)
    ? OPENROUTER_BASE_URL
    : String(baseUrl).replace(/\/+$/, '');
  const effectiveModel =
    !model || model === 'gpt-4o-mini-transcribe'
      ? 'openai/gpt-4o-mini-transcribe'
      : String(model).trim();

  const prompt = buildWhisperPrompt(vocabulary, language, correctionCue);
  const payload = {
    model: effectiveModel,
    input_audio: {
      data: cleanB64,
      format,
    },
  };
  if (language && language !== 'auto') {
    payload.language = language;
  }
  if (prompt) {
    payload.prompt = prompt;
  }
  if (zdr) {
    payload.provider = { zdr: true };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Title': 'Dimo Voice Input',
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  return {
    url: `${effectiveBase}/audio/transcriptions`,
    method: 'POST',
    headers,
    model: effectiveModel,
    body: JSON.stringify(payload),
    requiresApiKey: true,
  };
}

export function buildChatAudioRequest({
  baseUrl = 'https://api.openai.com/v1',
  apiKey = '',
  model = 'gpt-4o-audio-preview',
  audioBase64 = '',
  mimeType = 'audio/wav',
  language = 'auto',
  translateToEnglish = false,
  vocabulary = '',
  correctionCue = '',
}) {
  const cleanBase = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const cleanB64 = stripBase64DataUrlPrefix(audioBase64);
  const { format } = resolveMimeExtension(mimeType);
  const prompt = buildWhisperPrompt(vocabulary, language, correctionCue);
  const instruction = [
    translateToEnglish
      ? 'Transcribe this speech audio and translate it accurately into natural English.'
      : 'Transcribe this speech audio accurately verbatim with proper punctuation.',
    language && language !== 'auto' && !translateToEnglish
      ? `Preferred language: ${language}.`
      : '',
    prompt,
    'Return ONLY the transcribed text with no commentary.',
  ]
    .filter(Boolean)
    .join(' ');

  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }

  return {
    url: `${cleanBase}/chat/completions`,
    method: 'POST',
    headers,
    model,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            {
              type: 'input_audio',
              input_audio: {
                data: cleanB64,
                format: format === 'mp3' ? 'mp3' : 'wav',
              },
            },
          ],
        },
      ],
    }),
    requiresApiKey: !isLocalhostUrl(cleanBase),
  };
}

export function extractTranscriptionText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  if (typeof payload.text === 'string') return payload.text.trim();
  if (typeof payload.transcript === 'string') return payload.transcript.trim();
  const choiceContent = payload?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return choiceContent.trim();
  if (Array.isArray(choiceContent)) {
    return choiceContent
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }
  return '';
}

export function classifyCloudError(status, detail = '', provider = 'cloud') {
  const cleanDetail = String(detail || '').trim();
  const suffix = cleanDetail ? `（${cleanDetail.slice(0, 140)}）` : '';

  if (status === 401 || status === 402 || status === 403) {
    return {
      code: 'rejected-key',
      action: 'settings',
      retryable: false,
      message: `API 密钥无效或额度不足（HTTP ${status}）${suffix}`,
    };
  }
  if (status === 404) {
    return {
      code: 'model-unavailable',
      action: 'settings',
      retryable: false,
      message: `语音模型或接口路径不可用（HTTP 404）${suffix}`,
    };
  }
  if (status === 429) {
    return {
      code: 'rate-limit',
      action: 'retry',
      retryable: true,
      message: `请求过于频繁（HTTP 429），请稍后重试${suffix}`,
    };
  }
  if (status >= 500) {
    return {
      code: 'unavailable',
      action: 'retry',
      retryable: true,
      message: `${provider} 语音服务暂时不可用（HTTP ${status}）${suffix}`,
    };
  }
  return {
    code: 'transcription-failed',
    action: 'retry',
    retryable: true,
    message: `语音转写请求失败（HTTP ${status || 'ERR'}）${suffix}`,
  };
}

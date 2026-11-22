import {
  computeChunkRms,
  computeSmoothedLevel,
  concatFloat32Chunks,
  encodeMonoWavBase64,
} from './pcmResampler.js';

export const MIC_ORDER_STORAGE_KEY = 'dimo.voice-input.mic-order';

export function normalizeDeviceId(id) {
  if (typeof id !== 'string') return 'default';
  const trimmed = id.trim();
  return trimmed || 'default';
}

export function loadMicrophoneOrder() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(MIC_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.deviceId === 'string' && item.deviceId.trim())
      .map((item) => ({
        deviceId: item.deviceId.trim(),
        label: typeof item.label === 'string' ? item.label.trim() : '',
      }));
  } catch {
    return [];
  }
}

export function saveMicrophoneOrder(order) {
  try {
    if (typeof localStorage === 'undefined' || !Array.isArray(order)) return;
    localStorage.setItem(MIC_ORDER_STORAGE_KEY, JSON.stringify(order.slice(0, 12)));
  } catch {
    // ignore storage errors
  }
}

/**
 * Remember connected microphones while preserving user-chosen fallback priority order.
 */
export function rememberMicrophones(existingOrder = [], devices = []) {
  const byId = new Map();
  for (const item of Array.isArray(existingOrder) ? existingOrder : []) {
    if (!item?.deviceId || item.deviceId === 'default') continue;
    byId.set(item.deviceId, {
      deviceId: item.deviceId,
      label: item.label || '',
    });
  }

  const ordered = Array.from(byId.values());
  for (const dev of Array.isArray(devices) ? devices : []) {
    const id = normalizeDeviceId(dev?.deviceId);
    if (id === 'default') continue;
    const label = String(dev?.label || '').trim();
    const existing = byId.get(id);
    if (existing) {
      if (label) existing.label = label;
    } else {
      const entry = { deviceId: id, label: label || `麦克风 (${id.slice(0, 6)})` };
      byId.set(id, entry);
      ordered.push(entry);
    }
  }
  return ordered;
}

export function moveMicrophoneInOrder(order = [], deviceId, direction = 'up') {
  const list = [...order];
  const idx = list.findIndex((item) => item.deviceId === deviceId);
  if (idx < 0) return list;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= list.length) return list;
  const [moved] = list.splice(idx, 1);
  list.splice(targetIdx, 0, moved);
  return list;
}

export function forgetMicrophoneFromOrder(order = [], deviceId) {
  return order.filter((item) => item.deviceId !== deviceId);
}

/**
 * Resolve the best available microphone ID:
 * 1) Explicit non-default audioDeviceId if currently connected
 * 2) First connected device in user's preferred microphoneOrder
 * 3) Explicit audioDeviceId (or 'default')
 */
export function resolvePreferredMicrophone(order = [], devices = [], explicitDeviceId = 'default') {
  const explicit = normalizeDeviceId(explicitDeviceId);
  const availableIds = new Set(
    (Array.isArray(devices) ? devices : [])
      .map((d) => normalizeDeviceId(d?.deviceId))
      .filter(Boolean),
  );

  if (explicit !== 'default') {
    if (availableIds.size === 0 || availableIds.has(explicit)) {
      return explicit;
    }
  }

  for (const pref of Array.isArray(order) ? order : []) {
    if (pref?.deviceId && availableIds.has(pref.deviceId)) {
      return pref.deviceId;
    }
  }

  return 'default';
}

export async function enumerateAudioInputs() {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return [];
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d && d.kind === 'audioinput')
      .map((d, idx) => ({
        deviceId: normalizeDeviceId(d.deviceId),
        groupId: d.groupId || '',
        label:
          (d.label && d.label.trim()) ||
          (d.deviceId === 'default' ? '系统默认麦克风' : `麦克风 ${idx + 1}`),
      }));
  } catch {
    return [];
  }
}

/**
 * Local 10-second loopback microphone tester:
 * Captures PCM locally, streams live RMS level, and exposes a local Blob URL for playback
 * without uploading a single byte to any cloud server.
 */
export function createMicrophoneTester({ onUpdate, getUserMedia } = {}) {
  let state = 'idle'; // idle | recording | recorded | playing | error
  let level = 0;
  let durationMs = 0;
  let error = null;
  let audioUrl = null;
  let audioEl = null;
  let stream = null;
  let audioCtx = null;
  let processor = null;
  let chunks = [];
  let sampleRate = 16000;
  let startedAt = 0;
  let timerId = null;

  const emit = () => {
    if (typeof onUpdate === 'function') {
      onUpdate({
        state,
        level,
        durationMs,
        error,
        hasRecording: Boolean(audioUrl),
      });
    }
  };

  const cleanupCapture = () => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    if (processor) {
      try {
        processor.disconnect();
      } catch {
        // ignore
      }
      processor = null;
    }
    if (audioCtx) {
      try {
        void audioCtx.close();
      } catch {
        // ignore
      }
      audioCtx = null;
    }
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      stream = null;
    }
  };

  const revokePlayback = () => {
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        // ignore
      }
      audioEl = null;
    }
    if (audioUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(audioUrl);
      } catch {
        // ignore
      }
    }
    audioUrl = null;
  };

  const stopRecording = () => {
    if (state !== 'recording') return;
    cleanupCapture();
    const merged = concatFloat32Chunks(chunks);
    chunks = [];
    level = 0;
    if (merged.length > 0 && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      const b64 = encodeMonoWavBase64(merged, sampleRate, 16000);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      revokePlayback();
      audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      state = 'recorded';
    } else {
      state = 'idle';
    }
    emit();
  };

  const startRecording = async (deviceId = 'default') => {
    revokePlayback();
    cleanupCapture();
    chunks = [];
    error = null;
    level = 0;
    durationMs = 0;

    const gum =
      getUserMedia ||
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (c) => navigator.mediaDevices.getUserMedia(c)
        : null);

    if (!gum) {
      state = 'error';
      error = '当前环境不支持麦克风录音测试';
      emit();
      return false;
    }

    try {
      const audioConstraint =
        deviceId && deviceId !== 'default'
          ? { deviceId: { ideal: deviceId }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true };
      stream = await gum({ audio: audioConstraint });
      const AudioCtx =
        typeof window !== 'undefined'
          ? window.AudioContext || window.webkitAudioContext
          : null;
      if (!AudioCtx) {
        cleanupCapture();
        state = 'error';
        error = '浏览器缺少 AudioContext 支持';
        emit();
        return false;
      }

      audioCtx = new AudioCtx();
      sampleRate = audioCtx.sampleRate || 16000;
      const source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (ev) => {
        const data = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        level = computeSmoothedLevel(computeChunkRms(data), level, 2048 / sampleRate);
        emit();
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);

      startedAt = Date.now();
      state = 'recording';
      timerId = setInterval(() => {
        durationMs = Date.now() - startedAt;
        emit();
        if (durationMs >= 10_000) {
          stopRecording();
        }
      }, 100);
      emit();
      return true;
    } catch (err) {
      cleanupCapture();
      state = 'error';
      error =
        err?.name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在系统/浏览器设置中允许访问'
          : `无法打开麦克风：${String(err?.message || err)}`;
      emit();
      return false;
    }
  };

  const playRecording = () => {
    if (!audioUrl || typeof Audio === 'undefined') return false;
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        // ignore
      }
    }
    audioEl = new Audio(audioUrl);
    state = 'playing';
    audioEl.onended = () => {
      state = 'recorded';
      emit();
    };
    audioEl.onerror = () => {
      state = 'error';
      error = '录音回放失败';
      emit();
    };
    void audioEl.play().catch(() => {
      state = 'recorded';
      emit();
    });
    emit();
    return true;
  };

  const dispose = () => {
    cleanupCapture();
    revokePlayback();
    state = 'idle';
    level = 0;
  };

  return {
    startRecording,
    stopRecording,
    playRecording,
    dispose,
  };
}

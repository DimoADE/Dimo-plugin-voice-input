/**
 * High-quality audio resampling & capture helpers inspired by T3 Code's PcmResampler:
 * - 63-tap Blackman-windowed-sinc low-pass FIR anti-aliasing filter when downsampling to 16 kHz mono
 * - Smooth attack (0.075s) / release (0.2s) RMS audio level metering
 * - Inline AudioWorklet processor builder (with safe fallback when AudioWorklet/Blob is unavailable)
 */

const FIR_TAPS = 63;
const FIR_HALF = (FIR_TAPS - 1) / 2;

function buildLowPassKernel(cutoffRatio) {
  const kernel = new Float32Array(FIR_TAPS);
  const fc = Math.max(0.01, Math.min(0.49, cutoffRatio));
  let sum = 0;

  for (let i = 0; i < FIR_TAPS; i += 1) {
    const n = i - FIR_HALF;
    const sinc =
      n === 0
        ? 2 * fc
        : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
    // Blackman window for ~74 dB stopband attenuation
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (FIR_TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (FIR_TAPS - 1));
    kernel[i] = sinc * w;
    sum += kernel[i];
  }

  if (sum !== 0) {
    for (let i = 0; i < FIR_TAPS; i += 1) {
      kernel[i] /= sum;
    }
  }
  return kernel;
}

export class PcmResampler {
  constructor(inputSampleRate, targetSampleRate = 16000) {
    this.inputSampleRate = Math.max(8000, Math.round(inputSampleRate || 16000));
    this.targetSampleRate = Math.max(8000, Math.round(targetSampleRate || 16000));
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    this.needsResample = this.inputSampleRate !== this.targetSampleRate;
    this.kernel =
      this.ratio > 1
        ? buildLowPassKernel(0.45 / this.ratio)
        : null;
  }

  resample(inputSamples) {
    if (!inputSamples || inputSamples.length === 0) {
      return new Float32Array(0);
    }
    if (!this.needsResample) {
      return inputSamples instanceof Float32Array
        ? inputSamples
        : new Float32Array(inputSamples);
    }

    const inputLen = inputSamples.length;
    const outputLen = Math.max(1, Math.floor(inputLen / this.ratio));
    const output = new Float32Array(outputLen);

    if (this.kernel) {
      // Anti-aliased FIR low-pass filter + linear interpolation at target sample positions
      const kernel = this.kernel;
      for (let outIdx = 0; outIdx < outputLen; outIdx += 1) {
        const center = outIdx * this.ratio;
        const base = Math.floor(center);
        const frac = center - base;

        let s0 = 0;
        let s1 = 0;
        for (let k = 0; k < FIR_TAPS; k += 1) {
          const offset = k - FIR_HALF;
          const idx0 = base + offset;
          const idx1 = idx0 + 1;
          const coeff = kernel[k];
          if (idx0 >= 0 && idx0 < inputLen) s0 += inputSamples[idx0] * coeff;
          if (idx1 >= 0 && idx1 < inputLen) s1 += inputSamples[idx1] * coeff;
        }
        output[outIdx] = s0 + (s1 - s0) * frac;
      }
      return output;
    }

    // Upsampling via linear interpolation
    for (let outIdx = 0; outIdx < outputLen; outIdx += 1) {
      const pos = outIdx * this.ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = inputSamples[idx] || 0;
      const b = inputSamples[Math.min(inputLen - 1, idx + 1)] || a;
      output[outIdx] = a + (b - a) * frac;
    }
    return output;
  }
}

export function encodeMonoWavBase64(
  float32Samples,
  inputSampleRate = 16000,
  targetSampleRate = 16000,
) {
  const resampler = new PcmResampler(inputSampleRate, targetSampleRate);
  const mono = resampler.resample(float32Samples);
  const length = mono.length;
  const dataBytes = length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    const s = Math.max(-1, Math.min(1, mono[i] || 0));
    view.setInt16(offset, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function computeSmoothedLevel(rawRms, prevLevel = 0, dtSeconds = 0.05) {
  const normalized = Math.max(0, Math.min(1, rawRms * 5.2));
  const tau = normalized > prevLevel ? 0.075 : 0.2;
  const alpha = 1 - Math.exp(-Math.max(0.005, dtSeconds) / tau);
  return prevLevel + (normalized - prevLevel) * alpha;
}

export function computeChunkRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

export function buildAudioWorkletProcessorSource() {
  return `
class DimoVoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._sampleCount = 0;
    this._flushThreshold = 2048;
  }
  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (input && input.length > 0) {
      const copy = new Float32Array(input.length);
      copy.set(input);
      this._buffer.push(copy);
      this._sampleCount += copy.length;
      if (this._sampleCount >= this._flushThreshold) {
        const merged = new Float32Array(this._sampleCount);
        let offset = 0;
        for (const chunk of this._buffer) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this._buffer = [];
        this._sampleCount = 0;
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('dimo-voice-pcm-processor', DimoVoicePcmProcessor);
`;
}

export function concatFloat32Chunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return new Float32Array(0);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

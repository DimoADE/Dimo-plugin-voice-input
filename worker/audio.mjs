/**
 * WAV PCM decoding, encoding, and VAD/energy silence filtering for voice-input worker.
 * Trims dead-air silence before cloud upload to reduce latency, cost, and Whisper hallucinations.
 */

export function stripBase64DataUrlPrefix(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const idx = trimmed.indexOf('base64,');
  return idx >= 0 ? trimmed.slice(idx + 'base64,'.length).trim() : trimmed;
}

export function parseWavBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (bodyStart + chunkSize > buffer.length && chunkId !== 'data') {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(bodyStart);
      numChannels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataSize = Math.min(chunkSize, Math.max(0, buffer.length - bodyStart));
      break;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (
    dataOffset < 0 ||
    numChannels < 1 ||
    sampleRate < 8000 ||
    (audioFormat !== 1 && audioFormat !== 3)
  ) {
    return null;
  }

  const bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample !== 2 && bytesPerSample !== 4) {
    return null;
  }

  const frameSize = bytesPerSample * numChannels;
  const frameCount = Math.floor(dataSize / frameSize);
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch += 1) {
      const samplePos = dataOffset + i * frameSize + ch * bytesPerSample;
      if (audioFormat === 3 && bytesPerSample === 4) {
        sum += buffer.readFloatLE(samplePos);
      } else if (audioFormat === 1 && bytesPerSample === 2) {
        sum += buffer.readInt16LE(samplePos) / 32768;
      }
    }
    mono[i] = sum / numChannels;
  }

  return {
    sampleRate,
    numChannels: 1,
    samples: mono,
    durationMs: Math.round((frameCount / sampleRate) * 1000),
  };
}

export function encodePcm16WavBuffer(samples, sampleRate = 16000) {
  const length = samples.length;
  const dataBytes = length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] || 0));
    const int16 = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buffer.writeInt16LE(int16, 44 + i * 2);
  }
  return buffer;
}

export function detectSilenceAndTrimPcm(samples, sampleRate = 16000, options = {}) {
  const frameMs = options.frameMs ?? 20;
  const frameLen = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const frameCount = Math.floor(samples.length / frameLen);

  if (frameCount === 0) {
    return {
      hasSpeech: false,
      trimmedSamples: new Float32Array(0),
      speechRatio: 0,
      peakRms: 0,
      originalDurationMs: 0,
      trimmedDurationMs: 0,
    };
  }

  const rmsValues = new Float32Array(frameCount);
  let peakRms = 0;
  for (let f = 0; f < frameCount; f += 1) {
    let sumSq = 0;
    const start = f * frameLen;
    for (let i = 0; i < frameLen; i += 1) {
      const s = samples[start + i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    rmsValues[f] = rms;
    if (rms > peakRms) peakRms = rms;
  }

  const minSpeechRms = options.minSpeechRms ?? 0.008;
  // Adaptive noise floor: 20th percentile RMS * 2.2, bounded by minSpeechRms
  const sortedRms = Array.from(rmsValues).sort((a, b) => a - b);
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.2)] || 0;
  const threshold = Math.max(
    minSpeechRms,
    Math.min(0.035, noiseFloor * 2.2 + 0.003),
  );

  const active = new Uint8Array(frameCount);
  let activeCount = 0;
  for (let f = 0; f < frameCount; f += 1) {
    if (rmsValues[f] >= threshold) {
      active[f] = 1;
      activeCount += 1;
    }
  }

  const originalDurationMs = Math.round((samples.length / sampleRate) * 1000);
  // Require at least 2 active frames (~40ms) and minimum peak RMS to consider it speech
  if (peakRms < minSpeechRms || activeCount < 2) {
    return {
      hasSpeech: false,
      trimmedSamples: new Float32Array(0),
      speechRatio: 0,
      peakRms,
      originalDurationMs,
      trimmedDurationMs: 0,
    };
  }

  // Pad around active speech by ~200ms and collapse long silent gaps (> 1.4s -> 360ms)
  const padFrames = Math.max(1, Math.round(200 / frameMs));
  const maxGapFrames = Math.max(10, Math.round(1400 / frameMs));
  const keptGapFrames = Math.max(4, Math.round(360 / frameMs));

  const keep = new Uint8Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    if (!active[f]) continue;
    const from = Math.max(0, f - padFrames);
    const to = Math.min(frameCount - 1, f + padFrames);
    for (let k = from; k <= to; k += 1) {
      keep[k] = 1;
    }
  }

  // Also bridge short silent gaps between kept segments
  let firstKept = -1;
  let lastKept = -1;
  for (let f = 0; f < frameCount; f += 1) {
    if (keep[f]) {
      if (firstKept < 0) firstKept = f;
      lastKept = f;
    }
  }

  const outputChunks = [];
  let keptTotalSamples = 0;
  let silentRun = 0;

  for (let f = firstKept; f <= lastKept; f += 1) {
    if (keep[f]) {
      silentRun = 0;
      const start = f * frameLen;
      const slice = samples.subarray(start, Math.min(samples.length, start + frameLen));
      outputChunks.push(slice);
      keptTotalSamples += slice.length;
    } else {
      silentRun += 1;
      if (silentRun <= keptGapFrames || silentRun > maxGapFrames) {
        if (silentRun <= keptGapFrames) {
          const start = f * frameLen;
          const slice = samples.subarray(start, Math.min(samples.length, start + frameLen));
          outputChunks.push(slice);
          keptTotalSamples += slice.length;
        }
      }
    }
  }

  const trimmedSamples = new Float32Array(keptTotalSamples);
  let writeOffset = 0;
  for (const chunk of outputChunks) {
    trimmedSamples.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  return {
    hasSpeech: true,
    trimmedSamples,
    speechRatio: activeCount / frameCount,
    peakRms,
    originalDurationMs,
    trimmedDurationMs: Math.round((trimmedSamples.length / sampleRate) * 1000),
  };
}

export function filterSilenceFromWavBase64(wavBase64, options = {}) {
  const cleanB64 = stripBase64DataUrlPrefix(wavBase64);
  if (!cleanB64) {
    return {
      analyzed: false,
      hasSpeech: false,
      wavBase64: '',
      originalDurationMs: 0,
      trimmedDurationMs: 0,
    };
  }
  const rawBuffer = Buffer.from(cleanB64, 'base64');
  const parsed = parseWavBuffer(rawBuffer);
  if (!parsed) {
    // Non-WAV or compressed format (e.g. webm/ogg) — pass through untouched
    return {
      analyzed: false,
      hasSpeech: true,
      wavBase64: cleanB64,
      originalDurationMs: 0,
      trimmedDurationMs: 0,
    };
  }

  const result = detectSilenceAndTrimPcm(parsed.samples, parsed.sampleRate, options);
  if (!result.hasSpeech) {
    return {
      analyzed: true,
      hasSpeech: false,
      wavBase64: '',
      speechRatio: 0,
      peakRms: result.peakRms,
      originalDurationMs: result.originalDurationMs,
      trimmedDurationMs: 0,
    };
  }

  const trimmedBuf = encodePcm16WavBuffer(result.trimmedSamples, parsed.sampleRate);
  return {
    analyzed: true,
    hasSpeech: true,
    wavBase64: trimmedBuf.toString('base64'),
    speechRatio: result.speechRatio,
    peakRms: result.peakRms,
    originalDurationMs: result.originalDurationMs,
    trimmedDurationMs: result.trimmedDurationMs,
  };
}

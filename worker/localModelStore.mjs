/**
 * Local GGUF speech model store for Dimo Voice Input.
 *
 * Capabilities:
 * - Curated model lookup, cheap stat-based readiness checks, and `.verified` identity markers
 * - Resumable HTTP streaming downloads with Range retry, speed tracking, and SHA-256 verification
 * - Zero-copy symlink (with Windows hardlink + `.source` fallback) reuse from HuggingFace cache,
 *   T3 Code (`~/.t3/userdata/speech/models`), Handy, or user-specified directories
 * - Safe removal that deletes only the store entry/link without ever touching external source files
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_HF_MIRROR_URL,
  LOCAL_SPEECH_MODELS,
  buildModelDownloadUrl,
  formatBytes,
  getLocalSpeechModel,
} from './localCatalog.mjs';

const MAX_RESUME_ATTEMPTS = 3;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ENTRIES = 5000;
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.venv', 'target', 'dist']);

export function getDefaultModelsDir(env = process.env) {
  if (env?.DIMO_VOICE_MODELS_DIR && String(env.DIMO_VOICE_MODELS_DIR).trim()) {
    return path.resolve(String(env.DIMO_VOICE_MODELS_DIR).trim());
  }
  return path.join(os.homedir(), '.dimo', 'voice-input', 'models');
}

function getDefaultKnownSearchRoots(env = process.env) {
  const home = os.homedir();
  const roots = [];

  // 1. T3 Code speech model store (if user already downloaded models in T3 Code!)
  if (env?.T3_STATE_DIR) {
    roots.push(path.join(env.T3_STATE_DIR, 'speech', 'models'));
  }
  roots.push(path.join(home, '.t3', 'userdata', 'speech', 'models'));

  // 2. HuggingFace Hub cache
  if (env?.HF_HUB_CACHE) {
    roots.push(env.HF_HUB_CACHE);
  } else if (env?.HF_HOME) {
    roots.push(path.join(env.HF_HOME, 'hub'));
  }
  roots.push(path.join(home, '.cache', 'huggingface', 'hub'));

  // 3. Handy app models directory
  if (process.platform === 'win32') {
    const appData = env?.APPDATA || path.join(home, 'AppData', 'Roaming');
    roots.push(path.join(appData, 'com.pais.handy', 'models'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'com.pais.handy', 'models'));
  } else {
    const xdg = env?.XDG_DATA_HOME || path.join(home, '.local', 'share');
    roots.push(path.join(xdg, 'com.pais.handy', 'models'));
  }

  return roots;
}

export async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function buildIdentityMarker(sha256, st) {
  return `${sha256}:${st.size}:${Math.trunc(st.mtimeMs)}:${st.dev}:${st.ino}`;
}

async function safeUnlink(filePath) {
  try {
    await unlink(filePath);
  } catch {
    // ignore ENOENT or cleanup race
  }
}

export class LocalModelStore {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.modelsDir = options.modelsDir
      ? path.resolve(options.modelsDir)
      : getDefaultModelsDir(this.env);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.catalog = options.catalog || LOCAL_SPEECH_MODELS;
    this.knownSearchRoots = Array.isArray(options.knownSearchRoots)
      ? options.knownSearchRoots
      : getDefaultKnownSearchRoots(this.env);
    this.activeDownloads = new Map();
    this._corruptIds = new Set();
    this._cleanupDone = false;
  }

  setModelsDir(dir) {
    const next = dir && String(dir).trim()
      ? path.resolve(String(dir).trim())
      : getDefaultModelsDir(this.env);
    if (next !== this.modelsDir) {
      this.modelsDir = next;
      this._corruptIds.clear();
      this._cleanupDone = false;
    }
  }

  getModelPath(model) {
    return path.join(this.modelsDir, model.filename);
  }

  _verifiedMarkerPath(model) {
    return `${this.getModelPath(model)}.verified`;
  }

  _sourceMarkerPath(model) {
    return `${this.getModelPath(model)}.source`;
  }

  async ensureDir() {
    await mkdir(this.modelsDir, { recursive: true });
    if (!this._cleanupDone) {
      this._cleanupDone = true;
      await this.cleanupOrphanedParts();
    }
  }

  async cleanupOrphanedParts() {
    try {
      const entries = await readdir(this.modelsDir);
      const activePartPaths = new Set(
        [...this.activeDownloads.values()].map((d) => d.partPath).filter(Boolean),
      );
      for (const name of entries) {
        if (name.endsWith('.part') || name.endsWith('.linktmp')) {
          const full = path.join(this.modelsDir, name);
          if (!activePartPaths.has(full)) {
            await safeUnlink(full);
          }
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  async _writeVerifiedMarker(model, filePath) {
    const st = await stat(filePath);
    const marker = buildIdentityMarker(model.sha256, st);
    await writeFile(this._verifiedMarkerPath(model), `${marker}\n`, 'utf8');
  }

  async _hasValidMarker(model, filePath) {
    try {
      const [st, rawMarker] = await Promise.all([
        stat(filePath),
        readFile(this._verifiedMarkerPath(model), 'utf8'),
      ]);
      if (st.size !== model.size) return false;
      return rawMarker.trim() === buildIdentityMarker(model.sha256, st);
    } catch {
      return false;
    }
  }

  /**
   * Cheap O(1) readiness check (used by status polling — never hashes gigabyte files).
   */
  async isReady(model) {
    if (!model || this._corruptIds.has(model.id)) return false;
    try {
      const st = await stat(this.getModelPath(model));
      return st.isFile() && st.size === model.size;
    } catch {
      return false;
    }
  }

  /**
   * Returns verified model path (checks `.verified` identity marker; hashes once if unverified).
   */
  async getInstalledPath(model) {
    if (!model) return null;
    const targetPath = this.getModelPath(model);
    let st;
    try {
      st = await stat(targetPath);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size !== model.size) {
      this._corruptIds.add(model.id);
      return null;
    }

    if (await this._hasValidMarker(model, targetPath)) {
      this._corruptIds.delete(model.id);
      return targetPath;
    }

    const actualHash = await sha256File(targetPath);
    if (actualHash !== model.sha256) {
      this._corruptIds.add(model.id);
      await safeUnlink(this._verifiedMarkerPath(model));
      return null;
    }

    this._corruptIds.delete(model.id);
    await this._writeVerifiedMarker(model, targetPath).catch(() => {});
    return targetPath;
  }

  async getLinkedFrom(model) {
    const targetPath = this.getModelPath(model);
    try {
      const ls = await lstat(targetPath);
      if (ls.isSymbolicLink()) {
        const rawTarget = await readlink(targetPath);
        return path.resolve(path.dirname(targetPath), rawTarget);
      }
    } catch {
      return null;
    }
    try {
      const sourceText = (await readFile(this._sourceMarkerPath(model), 'utf8')).trim();
      return sourceText || null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a zero-copy link (symlink preferred; hardlink + `.source` fallback on Windows)
   * from a verified external file into the Dimo model store.
   */
  async _createZeroCopyLink(model, sourceFilePath) {
    await this.ensureDir();
    const resolvedSource = path.resolve(sourceFilePath);
    const finalPath = this.getModelPath(model);
    if (resolvedSource === path.resolve(finalPath)) {
      await this._writeVerifiedMarker(model, finalPath);
      this._corruptIds.delete(model.id);
      return finalPath;
    }

    const stagedPath = `${finalPath}.${randomUUID()}.linktmp`;
    let usedHardlink = false;

    try {
      await symlink(resolvedSource, stagedPath, 'file');
    } catch {
      // Windows without Developer Mode blocks symlinks with EPERM — fall back to hardlink
      try {
        await link(resolvedSource, stagedPath);
        usedHardlink = true;
      } catch (hardlinkErr) {
        await safeUnlink(stagedPath);
        throw new Error(
          `无法零拷贝链接本地模型文件（跨磁盘分区或权限受限）：${String(hardlinkErr?.message || hardlinkErr)}`,
        );
      }
    }

    try {
      await safeUnlink(finalPath);
      await rename(stagedPath, finalPath);
    } catch (renameErr) {
      await safeUnlink(stagedPath);
      throw renameErr;
    }

    if (usedHardlink) {
      await writeFile(this._sourceMarkerPath(model), `${resolvedSource}\n`, 'utf8').catch(() => {});
    } else {
      await safeUnlink(this._sourceMarkerPath(model));
    }

    await this._writeVerifiedMarker(model, finalPath);
    this._corruptIds.delete(model.id);
    return finalPath;
  }

  /**
   * Checks known local caches (T3 Code, HuggingFace Hub, Handy) for an already-downloaded copy.
   */
  async findExistingVerifiedCopy(model) {
    const candidates = [];
    const hfSlug = `models--${model.id.replace('/', '--')}`;

    for (const root of this.knownSearchRoots) {
      if (!root) continue;
      // Direct filename (T3 Code / Handy / flat models folder)
      candidates.push(path.join(root, model.filename));
      // HuggingFace hub cache snapshot layout
      candidates.push(path.join(root, hfSlug, 'snapshots', model.revision, model.filename));
    }

    const ownFinal = path.resolve(this.getModelPath(model));
    for (const candidate of candidates) {
      if (path.resolve(candidate) === ownFinal) continue;
      try {
        const st = await stat(candidate);
        if (!st.isFile() || st.size !== model.size) continue;
        const hash = await sha256File(candidate);
        if (hash === model.sha256) {
          return candidate;
        }
      } catch {
        // Not present at this candidate path
      }
    }
    return null;
  }

  /**
   * Scans a user-provided file or directory (bounded depth & entries) and zero-copy links
   * any matching verified GGUF models into the Dimo model store.
   */
  async linkFromSource(sourcePath, models = this.catalog) {
    if (!sourcePath || typeof sourcePath !== 'string' || !sourcePath.trim()) {
      throw new Error('请提供有效的本地模型文件或目录路径');
    }

    const resolved = path.resolve(sourcePath.trim());
    const rootStat = await stat(resolved).catch(() => null);
    if (!rootStat) {
      throw new Error(`路径不存在：${resolved}`);
    }

    const modelsBySize = new Map();
    for (const m of models) {
      if (!modelsBySize.has(m.size)) modelsBySize.set(m.size, []);
      modelsBySize.get(m.size).push(m);
    }

    const linked = [];
    let scanned = 0;
    let skipped = 0;

    const inspectFile = async (filePath, fileStat) => {
      scanned += 1;
      const bucket = modelsBySize.get(fileStat.size);
      if (!bucket || bucket.length === 0) {
        skipped += 1;
        return;
      }
      const actualHash = await sha256File(filePath);
      const matched = bucket.find((m) => m.sha256 === actualHash);
      if (!matched) {
        skipped += 1;
        return;
      }
      if (await this.isReady(matched)) {
        skipped += 1;
        return;
      }
      await this._createZeroCopyLink(matched, filePath);
      linked.push({
        modelId: matched.id,
        name: matched.name,
        sourcePath: filePath,
      });
    };

    if (rootStat.isFile()) {
      await inspectFile(resolved, rootStat);
    } else if (rootStat.isDirectory()) {
      const queue = [{ dir: resolved, depth: 0 }];
      while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
        const { dir, depth } = queue.shift();
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (scanned >= MAX_SCAN_ENTRIES) break;
          if (SKIP_SCAN_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_SCAN_DEPTH) {
              queue.push({ dir: full, depth: depth + 1 });
            }
          } else if (entry.isFile() || entry.isSymbolicLink()) {
            try {
              const st = await stat(full);
              if (st.isFile()) {
                await inspectFile(full, st);
              }
            } catch {
              // ignore broken symlinks / permission denied
            }
          }
        }
      }
    }

    return {
      sourcePath: resolved,
      linked,
      scanned,
      skipped,
    };
  }

  /**
   * Downloads (or zero-copy reuses) a curated model with Range resume and SHA-256 verification.
   */
  async download(model, options = {}) {
    if (!model) {
      throw new Error('未知的本地语音模型 ID');
    }
    await this.ensureDir();

    // 1. Already installed & verified?
    const existing = await this.getInstalledPath(model);
    if (existing) {
      return {
        modelId: model.id,
        path: existing,
        reused: true,
        linkedFrom: await this.getLinkedFrom(model),
      };
    }

    // 2. Check known local caches (T3 Code / HF cache / Handy) for instant zero-copy link!
    if (options.skipLocalReuse !== true) {
      const reusable = await this.findExistingVerifiedCopy(model);
      if (reusable) {
        const linkedPath = await this._createZeroCopyLink(model, reusable);
        options.onProgress?.({
          downloadedBytes: model.size,
          totalBytes: model.size,
          percent: 100,
          speedBps: 0,
        });
        return {
          modelId: model.id,
          path: linkedPath,
          reused: true,
          linkedFrom: reusable,
        };
      }
    }

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前运行环境缺少 fetch 实现，无法下载模型');
    }

    const url = buildModelDownloadUrl(model, options.hfMirrorUrl || DEFAULT_HF_MIRROR_URL);
    const finalPath = this.getModelPath(model);
    const partPath = `${finalPath}.${randomUUID()}.part`;
    const signal = options.signal;
    if (options._record) {
      options._record.partPath = partPath;
    }

    let downloadedBytes = 0;
    let lastReportAt = Date.now();
    let lastReportBytes = 0;

    try {
      for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) {
          throw Object.assign(new Error('模型下载已取消'), { name: 'AbortError' });
        }

        const headers = {};
        if (downloadedBytes > 0) {
          headers.Range = `bytes=${downloadedBytes}-`;
        }

        let response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            headers,
            signal,
          });
        } catch (err) {
          if (err?.name === 'AbortError' || signal?.aborted) {
            throw Object.assign(new Error('模型下载已取消'), { name: 'AbortError' });
          }
          if (attempt < MAX_RESUME_ATTEMPTS) continue;
          throw new Error(`下载模型失败（网络错误）：${String(err?.message || err)}`);
        }

        if (!response.ok && response.status !== 206) {
          if (response.status >= 500 && attempt < MAX_RESUME_ATTEMPTS) continue;
          throw new Error(
            `下载模型失败 (HTTP ${response.status})：请检查网络或切换 HF-Mirror 镜像源`,
          );
        }

        // If we requested a Range resume but server returned 200 (full file), restart from byte 0
        let appendMode = false;
        if (downloadedBytes > 0 && response.status === 206) {
          const contentRange = response.headers?.get?.('content-range') || '';
          const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange);
          if (match && Number(match[1]) === downloadedBytes) {
            appendMode = true;
          } else {
            downloadedBytes = 0;
          }
        } else {
          downloadedBytes = 0;
        }

        const writeStream = createWriteStream(partPath, {
          flags: appendMode ? 'a' : 'w',
        });

        try {
          await this._pipeResponseToStream(response, writeStream, {
            expectedSize: model.size,
            signal,
            onChunk: (chunkLen) => {
              downloadedBytes += chunkLen;
              if (downloadedBytes > model.size) {
                throw new Error('下载字节数超出模型预期大小，文件可能已损坏');
              }
              const now = Date.now();
              const dt = (now - lastReportAt) / 1000;
              if (dt >= 0.25 || downloadedBytes === model.size) {
                const speedBps = dt > 0 ? Math.round((downloadedBytes - lastReportBytes) / dt) : 0;
                lastReportAt = now;
                lastReportBytes = downloadedBytes;
                options.onProgress?.({
                  downloadedBytes,
                  totalBytes: model.size,
                  percent: Math.min(100, Math.round((downloadedBytes / model.size) * 100)),
                  speedBps,
                });
              }
            },
          });
        } catch (streamErr) {
          if (streamErr?.name === 'AbortError' || signal?.aborted) {
            throw Object.assign(new Error('模型下载已取消'), { name: 'AbortError' });
          }
          if (attempt < MAX_RESUME_ATTEMPTS && downloadedBytes > 0 && downloadedBytes < model.size) {
            continue;
          }
          throw streamErr;
        }

        if (downloadedBytes === model.size) {
          break;
        }
        if (attempt >= MAX_RESUME_ATTEMPTS) {
          throw new Error(
            `模型下载不完整（已下载 ${formatBytes(downloadedBytes)} / 预期 ${formatBytes(model.size)}）`,
          );
        }
      }

      // Streaming SHA-256 verification before atomic rename
      options.onVerificationStart?.();
      const actualHash = await sha256File(partPath);
      if (actualHash !== model.sha256) {
        throw new Error(
          `模型 SHA-256 完整性校验失败（预期 ${model.sha256.slice(0, 12)}…，实际 ${actualHash.slice(0, 12)}…）`,
        );
      }

      await safeUnlink(finalPath);
      await safeUnlink(this._sourceMarkerPath(model));
      await rename(partPath, finalPath);
      await this._writeVerifiedMarker(model, finalPath);
      this._corruptIds.delete(model.id);

      return {
        modelId: model.id,
        path: finalPath,
        reused: false,
        linkedFrom: null,
      };
    } catch (err) {
      await safeUnlink(partPath);
      throw err;
    }
  }

  async _pipeResponseToStream(response, writeStream, { expectedSize, signal, onChunk }) {
    const closeStream = () =>
      new Promise((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.once('error', reject);
      });

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel().catch(() => {});
            throw Object.assign(new Error('模型下载已取消'), { name: 'AbortError' });
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          onChunk(buf.length);
          if (!writeStream.write(buf)) {
            await new Promise((resolve, reject) => {
              writeStream.once('drain', resolve);
              writeStream.once('error', reject);
            });
          }
        }
        await closeStream();
      } catch (err) {
        writeStream.destroy();
        throw err;
      }
      return;
    }

    // Fallback for test mocks returning arrayBuffer()
    if (typeof response.arrayBuffer === 'function') {
      const ab = await response.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length > expectedSize) {
        writeStream.destroy();
        throw new Error('下载字节数超出模型预期大小，文件可能已损坏');
      }
      onChunk(buf.length);
      writeStream.write(buf);
      await closeStream();
      return;
    }

    writeStream.destroy();
    throw new Error('响应流不可读');
  }

  /**
   * Starts a tracked background download (idempotent if already active).
   */
  startDownload(modelId, options = {}) {
    const model = this.catalog.find((m) => m.id === modelId) || getLocalSpeechModel(modelId);
    if (!model) {
      throw new Error(`未找到本地语音模型：${String(modelId)}`);
    }

    const existing = this.activeDownloads.get(model.id);
    if (existing && (existing.status === 'downloading' || existing.status === 'verifying')) {
      return this._serializeDownload(existing);
    }

    const abortController = new AbortController();
    const record = {
      modelId: model.id,
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: model.size,
      percent: 0,
      speedBps: 0,
      error: null,
      partPath: null,
      abortController,
      promise: null,
    };
    this.activeDownloads.set(model.id, record);

    record.promise = this.download(model, {
      hfMirrorUrl: options.hfMirrorUrl,
      skipLocalReuse: options.skipLocalReuse,
      signal: abortController.signal,
      _record: record,
      onProgress: (prog) => {
        if (record.status === 'cancelled') return;
        record.downloadedBytes = prog.downloadedBytes;
        record.totalBytes = prog.totalBytes;
        record.percent = prog.percent;
        record.speedBps = prog.speedBps;
      },
      onVerificationStart: () => {
        if (record.status === 'cancelled') return;
        record.status = 'verifying';
        record.percent = 100;
        record.speedBps = 0;
      },
    })
      .then((res) => {
        record.status = 'completed';
        record.downloadedBytes = model.size;
        record.percent = 100;
        record.speedBps = 0;
        record.error = null;
        return res;
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || abortController.signal.aborted) {
          record.status = 'cancelled';
          record.error = null;
        } else {
          record.status = 'error';
          record.error = String(err?.message || err);
        }
        return null;
      });

    return this._serializeDownload(record);
  }

  cancelDownload(modelId) {
    const record = this.activeDownloads.get(modelId);
    if (!record) return { cancelled: false, modelId };
    record.status = 'cancelled';
    record.abortController.abort();
    if (record.partPath) {
      void safeUnlink(record.partPath);
    }
    this.activeDownloads.delete(modelId);
    return { cancelled: true, modelId };
  }

  async remove(modelId) {
    const model = this.catalog.find((m) => m.id === modelId) || getLocalSpeechModel(modelId);
    if (!model) {
      throw new Error(`未找到本地语音模型：${String(modelId)}`);
    }
    this.cancelDownload(model.id);
    // Only unlinks Dimo's own store file/symlink — never deletes external linked source
    await Promise.all([
      safeUnlink(this.getModelPath(model)),
      safeUnlink(this._verifiedMarkerPath(model)),
      safeUnlink(this._sourceMarkerPath(model)),
    ]);
    this._corruptIds.delete(model.id);
    return { removed: true, modelId: model.id };
  }

  _serializeDownload(record) {
    if (!record) return null;
    return {
      status: record.status,
      downloadedBytes: record.downloadedBytes,
      totalBytes: record.totalBytes,
      percent: record.percent,
      speedBps: record.speedBps,
      error: record.error,
    };
  }

  async listModels(activeModelId = '') {
    const items = await Promise.all(
      this.catalog.map(async (model) => {
        const installed = await this.isReady(model);
        const linkedFrom = installed ? await this.getLinkedFrom(model) : null;
        const activeRecord = this.activeDownloads.get(model.id);
        const download =
          activeRecord && activeRecord.status !== 'completed' && activeRecord.status !== 'cancelled'
            ? this._serializeDownload(activeRecord)
            : null;
        return {
          ...model,
          sizeLabel: formatBytes(model.size),
          installed,
          linkedFrom,
          active: model.id === activeModelId,
          download,
        };
      }),
    );
    return items;
  }

  dispose() {
    for (const [id] of this.activeDownloads) {
      this.cancelDownload(id);
    }
  }
}

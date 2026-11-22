/**
 * Isolated local speech recognition runtime for Dimo Voice Input.
 *
 * Architecture (inspired by T3 Code's `transcribe-cpp` isolated child process):
 * - On-demand `transcribe-cpp@0.4.2` installation into `~/.dimo/voice-input/runtime/`
 * - Native GGML/Vulkan/Metal inference executes in an isolated killable Node IPC child process
 *   so native crashes or hung GPU calls never bring down the plugin worker
 * - Keeps the active model warm in memory across dictations with an idle auto-unload timer
 * - Recursive split fallback on `InputTooLong` / `OutputTruncated`
 * - Automatic CPU fallback when `acceleration === 'auto'` and GPU initialization fails
 * - Optional `whisper-cli` binary fallback if present on PATH
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { encodePcm16WavBuffer } from './audio.mjs';

export const TRANSCRIBE_CPP_VERSION = '0.4.2';

export function getDefaultRuntimeDir(env = process.env) {
  if (env?.DIMO_VOICE_RUNTIME_DIR && String(env.DIMO_VOICE_RUNTIME_DIR).trim()) {
    return path.resolve(String(env.DIMO_VOICE_RUNTIME_DIR).trim());
  }
  return path.join(os.homedir(), '.dimo', 'voice-input', 'runtime');
}

const MIN_SPLIT_SAMPLES = 16_000; // 1 second at 16kHz
const GPU_LOAD_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;

/**
 * Self-contained Node ESM script executed inside the isolated inference child process.
 * Communicates via Node IPC (`process.send` / `process.on('message')`).
 */
const CHILD_RUNNER_SOURCE = `
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const entry = process.env.DIMO_TRANSCRIBE_CPP_ENTRY;
let api = null;
let loadedModel = null;
let loadedKey = '';

async function loadApi() {
  if (api) return api;
  try {
    api = await import(pathToFileURL(entry).href);
  } catch {
    const req = createRequire(entry);
    api = req(entry);
  }
  return api;
}

async function transcribeWithSplit(model, samples, opts, depth = 0) {
  try {
    const res = await model.transcribe(samples, opts);
    if (typeof res === 'string') return res.trim();
    if (res && typeof res.text === 'string') return res.text.trim();
    return '';
  } catch (err) {
    const msg = String(err?.message || err || '');
    const splittable = /InputTooLong|OutputTruncated|too long|truncated/i.test(msg);
    if (splittable && depth < 6 && samples.length >= ${MIN_SPLIT_SAMPLES * 2}) {
      const mid = Math.floor(samples.length / 2);
      const left = await transcribeWithSplit(model, samples.subarray(0, mid), opts, depth + 1);
      const right = await transcribeWithSplit(model, samples.subarray(mid), opts, depth + 1);
      return [left, right].filter(Boolean).join(' ').trim();
    }
    throw err;
  }
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { id, type } = msg;
  try {
    const mod = await loadApi();
    if (type === 'discover') {
      let backends = [];
      if (typeof mod.getAvailableBackends === 'function') {
        backends = await mod.getAvailableBackends();
      } else if (typeof mod.listBackends === 'function') {
        backends = await mod.listBackends();
      }
      process.send({ id, ok: true, result: { backends: Array.isArray(backends) ? backends : [] } });
      return;
    }

    if (type === 'unload') {
      if (loadedModel) {
        if (typeof loadedModel.dispose === 'function') await loadedModel.dispose();
        else if (typeof loadedModel.free === 'function') await loadedModel.free();
        else if (typeof loadedModel.close === 'function') await loadedModel.close();
      }
      loadedModel = null;
      loadedKey = '';
      process.send({ id, ok: true, result: { unloaded: true } });
      return;
    }

    if (type === 'transcribe') {
      const { modelPath, useGpu, language, translateToEnglish, pcmFloat32Base64 } = msg;
      const key = modelPath + '|' + (useGpu ? 'gpu' : 'cpu');
      if (!loadedModel || loadedKey !== key) {
        if (loadedModel) {
          try {
            if (typeof loadedModel.dispose === 'function') await loadedModel.dispose();
            else if (typeof loadedModel.free === 'function') await loadedModel.free();
            else if (typeof loadedModel.close === 'function') await loadedModel.close();
          } catch {}
          loadedModel = null;
          loadedKey = '';
        }
        const Loader = mod.TranscribeModel || mod.default?.TranscribeModel || mod.default;
        const loadOpts = useGpu ? { gpu: true, useGpu: true } : { gpu: false, useGpu: false };
        if (Loader && typeof Loader.load === 'function') {
          loadedModel = await Loader.load(modelPath, loadOpts);
        } else if (typeof mod.loadModel === 'function') {
          loadedModel = await mod.loadModel(modelPath, loadOpts);
        } else if (typeof Loader === 'function') {
          loadedModel = new Loader(modelPath, loadOpts);
        } else {
          throw new Error('Unsupported transcribe-cpp module export');
        }
        loadedKey = key;
      }

      const buf = Buffer.from(pcmFloat32Base64, 'base64');
      const samples = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        Math.floor(buf.byteLength / 4),
      );
      const opts = {};
      if (language && language !== 'auto') opts.language = language;
      if (translateToEnglish) opts.translate = true;

      const text = await transcribeWithSplit(loadedModel, samples, opts);
      process.send({
        id,
        ok: true,
        result: { text, backend: useGpu ? 'gpu' : 'cpu' },
      });
      return;
    }

    process.send({ id, ok: false, error: 'Unknown IPC command: ' + String(type) });
  } catch (err) {
    process.send({ id, ok: false, error: String(err?.message || err) });
  }
});
`;

export class LocalSpeechRuntime {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.runtimeDir = options.runtimeDir
      ? path.resolve(options.runtimeDir)
      : getDefaultRuntimeDir(this.env);
    this.spawnImpl = options.spawnImpl || spawn;
    this.execFileImpl = options.execFileImpl || execFile;
    this.customTranscribeImpl = options.customTranscribeImpl || null;

    this._child = null;
    this._childEntry = null;
    this._pending = new Map();
    this._nextReqId = 1;
    this._loadedModelId = null;
    this._loadedBackend = null;
    this._unloadTimer = null;
    this._cachedBackends = null;
    this._whisperCliPath = undefined;
    this._installPromise = null;
    this._installAbort = null;
    this.installState = {
      status: 'idle',
      message: '',
      error: null,
      startedAt: null,
    };
  }

  /**
   * Resolves an installed `transcribe-cpp` package entry path and version, if available.
   */
  async resolveTranscribeCpp() {
    const candidates = [
      path.join(this.runtimeDir, 'node_modules', 'transcribe-cpp'),
    ];

    for (const pkgDir of candidates) {
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
        const entryRel =
          (typeof pkg.exports === 'string' && pkg.exports) ||
          pkg.exports?.['.']?.import ||
          pkg.exports?.['.']?.default ||
          pkg.exports?.['.']?.require ||
          pkg.module ||
          pkg.main ||
          'index.js';
        const entryPath = path.resolve(pkgDir, entryRel);
        if (existsSync(entryPath)) {
          return {
            installed: true,
            version: pkg.version || TRANSCRIBE_CPP_VERSION,
            entryPath,
            runtimeDir: this.runtimeDir,
          };
        }
      } catch {
        // Malformed package.json — treat as not installed
      }
    }

    // Fallback: check if `transcribe-cpp` is resolvable from surrounding node_modules
    try {
      const req = createRequire(import.meta.url);
      const pkgJsonPath = req.resolve('transcribe-cpp/package.json');
      const pkgDir = path.dirname(pkgJsonPath);
      const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
      const entryPath = req.resolve('transcribe-cpp');
      return {
        installed: true,
        version: pkg.version || TRANSCRIBE_CPP_VERSION,
        entryPath,
        runtimeDir: pkgDir,
      };
    } catch {
      return {
        installed: false,
        version: null,
        entryPath: null,
        runtimeDir: this.runtimeDir,
      };
    }
  }

  async detectWhisperCli() {
    if (this._whisperCliPath !== undefined) return this._whisperCliPath;
    const candidates =
      process.platform === 'win32'
        ? ['whisper-cli.exe', 'whisper-cpp.exe']
        : ['whisper-cli', 'whisper-cpp'];
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';

    for (const bin of candidates) {
      const found = await new Promise((resolve) => {
        this.execFileImpl(whichCmd, [bin], { timeout: 2500 }, (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
          resolve(first || null);
        });
      });
      if (found) {
        this._whisperCliPath = found;
        return found;
      }
    }
    this._whisperCliPath = null;
    return null;
  }

  async getEngineStatus() {
    if (this.customTranscribeImpl) {
      return {
        engine: 'transcribe-cpp',
        installed: true,
        version: TRANSCRIBE_CPP_VERSION,
        runtimeDir: this.runtimeDir,
        loadedModelId: this._loadedModelId,
        loadedBackend: this._loadedBackend,
        backends: this._cachedBackends || [],
        whisperCliPath: null,
        installState: { ...this.installState, status: 'installed' },
      };
    }

    const tc = await this.resolveTranscribeCpp();
    const whisperCliPath = tc.installed ? null : await this.detectWhisperCli();
    const status =
      this.installState.status === 'installing'
        ? 'installing'
        : tc.installed
          ? 'installed'
          : this.installState.status === 'error'
            ? 'error'
            : 'idle';

    return {
      engine: tc.installed ? 'transcribe-cpp' : whisperCliPath ? 'whisper-cli' : 'none',
      installed: tc.installed || Boolean(whisperCliPath),
      transcribeCppInstalled: tc.installed,
      version: tc.version,
      targetVersion: TRANSCRIBE_CPP_VERSION,
      runtimeDir: this.runtimeDir,
      loadedModelId: this._loadedModelId,
      loadedBackend: this._loadedBackend,
      backends: this._cachedBackends || [],
      whisperCliPath,
      installState: {
        ...this.installState,
        status,
      },
    };
  }

  /**
   * Installs `transcribe-cpp@0.4.2` on-demand into `~/.dimo/voice-input/runtime/`.
   * Keeps the plugin bundle lean and avoids hard native dependency coupling in workspace lockfile.
   */
  async installEngine(options = {}) {
    const existing = await this.resolveTranscribeCpp();
    if (existing.installed && options.force !== true) {
      this.installState = {
        status: 'installed',
        message: `transcribe.cpp v${existing.version} 已就绪`,
        error: null,
        startedAt: null,
      };
      return await this.getEngineStatus();
    }

    if (this._installPromise) {
      return await this._installPromise;
    }

    this.installState = {
      status: 'installing',
      message: `正在安装本地推理引擎 transcribe-cpp@${TRANSCRIBE_CPP_VERSION}…`,
      error: null,
      startedAt: Date.now(),
    };

    const run = async () => {
      try {
        await mkdir(this.runtimeDir, { recursive: true });
        const pkgPath = path.join(this.runtimeDir, 'package.json');
        if (!existsSync(pkgPath)) {
          await writeFile(
            pkgPath,
            `${JSON.stringify({ name: 'dimo-voice-local-runtime', private: true }, null, 2)}\n`,
            'utf8',
          );
        }

        const pkgSpec = `transcribe-cpp@${TRANSCRIBE_CPP_VERSION}`;
        const isWin = process.platform === 'win32';
        const cmd = isWin ? this.env.ComSpec || 'cmd.exe' : 'npm';
        const args = isWin
          ? [
              '/d',
              '/s',
              '/c',
              `npm install --no-audit --no-fund --no-save --prefix "${this.runtimeDir}" ${pkgSpec}`,
            ]
          : [
              'install',
              '--no-audit',
              '--no-fund',
              '--no-save',
              '--prefix',
              this.runtimeDir,
              pkgSpec,
            ];

        await new Promise((resolve, reject) => {
          const child = this.spawnImpl(cmd, args, {
            cwd: this.runtimeDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...this.env },
          });
          this._installAbort = () => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          };

          let stderrTail = '';
          child.stdout?.on('data', (buf) => {
            const line = String(buf).trim().split(/\r?\n/).pop();
            if (line) {
              this.installState.message = line.slice(0, 120);
            }
          });
          child.stderr?.on('data', (buf) => {
            stderrTail = `${stderrTail}${String(buf)}`.slice(-600);
          });
          child.on('error', (err) => {
            reject(new Error(`无法执行 npm 安装推理引擎：${String(err?.message || err)}`));
          });
          child.on('close', (code) => {
            this._installAbort = null;
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `安装 transcribe-cpp 失败 (exit ${code})${stderrTail ? `：${stderrTail.trim().slice(-240)}` : ''}`,
                ),
              );
            }
          });
        });

        const verified = await this.resolveTranscribeCpp();
        if (!verified.installed) {
          throw new Error('npm 安装完成但未找到 transcribe-cpp 入口模块');
        }

        this.installState = {
          status: 'installed',
          message: `transcribe.cpp v${verified.version} 安装完成`,
          error: null,
          startedAt: null,
        };
        return await this.getEngineStatus();
      } catch (err) {
        this.installState = {
          status: 'error',
          message: '',
          error: String(err?.message || err),
          startedAt: null,
        };
        throw err;
      } finally {
        this._installPromise = null;
        this._installAbort = null;
      }
    };

    this._installPromise = run();
    return await this._installPromise;
  }

  _clearUnloadTimer() {
    if (this._unloadTimer) {
      clearTimeout(this._unloadTimer);
      this._unloadTimer = null;
    }
  }

  _scheduleIdleUnload(unloadTimeoutSec) {
    this._clearUnloadTimer();
    const sec = Number(unloadTimeoutSec);
    if (!Number.isFinite(sec) || sec <= 0) return;
    this._unloadTimer = setTimeout(() => {
      void this.unload();
    }, sec * 1000);
    if (typeof this._unloadTimer.unref === 'function') {
      this._unloadTimer.unref();
    }
  }

  _killChild(reason = '本地语音推理进程已终止') {
    this._clearUnloadTimer();
    const child = this._child;
    this._child = null;
    this._childEntry = null;
    this._loadedModelId = null;
    this._loadedBackend = null;

    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    for (const [, waiter] of this._pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this._pending.clear();
  }

  _ensureChild(entryPath) {
    if (this._child && !this._child.killed && this._childEntry === entryPath) {
      return this._child;
    }
    this._killChild('重新初始化本地推理进程');

    const childEnv = {
      ...this.env,
      DIMO_TRANSCRIBE_CPP_ENTRY: entryPath,
      // Avoid NVIDIA ReBAR Vulkan hangs on Windows/Linux (aligned with T3 Code)
      GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM:
        this.env.GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM ?? '1',
    };

    const child = this.spawnImpl(
      process.execPath,
      ['--input-type=module', '-e', CHILD_RUNNER_SOURCE],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: childEnv,
      },
    );

    let stderrBuf = '';
    child.stderr?.on('data', (chunk) => {
      stderrBuf = `${stderrBuf}${String(chunk)}`.slice(-800);
    });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const waiter = this._pending.get(msg.id);
      if (!waiter) return;
      this._pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) {
        waiter.resolve(msg.result);
      } else {
        waiter.reject(new Error(String(msg.error || '本地推理失败')));
      }
    });

    child.on('exit', (code, sig) => {
      if (this._child === child) {
        this._child = null;
        this._childEntry = null;
        this._loadedModelId = null;
        this._loadedBackend = null;
      }
      const detail = stderrBuf.trim().slice(-200);
      const reason = `本地语音推理进程意外退出 (${sig || code})${detail ? `：${detail}` : ''}`;
      for (const [, waiter] of this._pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      this._pending.clear();
    });

    this._child = child;
    this._childEntry = entryPath;
    return child;
  }

  _sendChildRequest(entryPath, payload, { timeoutMs = TRANSCRIBE_TIMEOUT_MS, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error('本地语音转写已取消'), { name: 'AbortError' }));
        return;
      }
      const child = this._ensureChild(entryPath);
      const id = this._nextReqId++;

      const onAbort = () => {
        this._killChild('本地语音转写已取消');
        reject(Object.assign(new Error('本地语音转写已取消'), { name: 'AbortError' }));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        this._pending.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        this._killChild('本地语音推理超时，已安全终止子进程');
        reject(new Error('本地语音推理超时，请尝试切换为 CPU 模式或更轻量的模型'));
      }, timeoutMs);

      this._pending.set(id, {
        timer,
        resolve: (val) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        reject: (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      child.send({ id, ...payload });
    });
  }

  async discoverBackends() {
    if (this.customTranscribeImpl) return [];
    const tc = await this.resolveTranscribeCpp();
    if (!tc.installed) return [];
    try {
      const res = await this._sendChildRequest(
        tc.entryPath,
        { type: 'discover' },
        { timeoutMs: 8000 },
      );
      this._cachedBackends = Array.isArray(res?.backends) ? res.backends : [];
      return this._cachedBackends;
    } catch {
      return this._cachedBackends || [];
    }
  }

  async _transcribeWithWhisperCli({ whisperCliPath, modelPath, pcmFloat32, language, translateToEnglish, signal }) {
    const tmpWav = path.join(
      os.tmpdir(),
      `dimo-voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`,
    );
    const wavBuf = encodePcm16WavBuffer(pcmFloat32, 16000);
    await writeFile(tmpWav, wavBuf);

    const args = ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '-nt'];
    if (language && language !== 'auto') {
      args.push('-l', language);
    }
    if (translateToEnglish) {
      args.push('-tr');
    }

    try {
      const stdout = await new Promise((resolve, reject) => {
        const proc = this.execFileImpl(
          whisperCliPath,
          args,
          { timeout: TRANSCRIBE_TIMEOUT_MS, windowsHide: true },
          (err, out, stderr) => {
            if (err) {
              reject(new Error(`whisper-cli 执行失败：${String(stderr || err.message || err)}`));
              return;
            }
            resolve(String(out || ''));
          },
        );
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              try {
                proc.kill('SIGKILL');
              } catch {
                // ignore
              }
            },
            { once: true },
          );
        }
      });

      return {
        text: stdout
          .split(/\r?\n/)
          .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim(),
        backend: 'whisper-cli',
      };
    } finally {
      await unlink(tmpWav).catch(() => {});
    }
  }

  async transcribePcm(options = {}) {
    const {
      modelPath,
      modelId,
      pcmFloat32,
      language = 'auto',
      translateToEnglish = false,
      acceleration = 'auto',
      unloadTimeoutSec = 300,
      signal,
    } = options;

    if (!pcmFloat32 || pcmFloat32.length === 0) {
      return { text: '', backend: 'none' };
    }

    // Injectable hook for deterministic testing
    if (typeof this.customTranscribeImpl === 'function') {
      const res = await this.customTranscribeImpl(options);
      this._loadedModelId = modelId || modelPath;
      this._loadedBackend = res?.backend || acceleration || 'cpu';
      return {
        text: typeof res === 'string' ? res : String(res?.text || ''),
        backend: res?.backend || 'mock-local',
      };
    }

    const tc = await this.resolveTranscribeCpp();
    if (!tc.installed) {
      const whisperCliPath = await this.detectWhisperCli();
      if (whisperCliPath) {
        return await this._transcribeWithWhisperCli({
          whisperCliPath,
          modelPath,
          pcmFloat32,
          language,
          translateToEnglish,
          signal,
        });
      }
      const err = new Error(
        '尚未安装本地语音推理引擎（transcribe.cpp），请在状态栏「本地模型」面板点击「安装推理引擎」。',
      );
      err.code = 'local-engine-missing';
      err.action = 'models';
      err.retryable = false;
      throw err;
    }

    const pcmBuf = Buffer.from(
      pcmFloat32.buffer,
      pcmFloat32.byteOffset,
      pcmFloat32.byteLength,
    );
    const pcmFloat32Base64 = pcmBuf.toString('base64');

    const tryRun = async (useGpu, timeoutMs) => {
      const res = await this._sendChildRequest(
        tc.entryPath,
        {
          type: 'transcribe',
          modelPath,
          useGpu,
          language,
          translateToEnglish: Boolean(translateToEnglish),
          pcmFloat32Base64,
        },
        { timeoutMs, signal },
      );
      this._loadedModelId = modelId || modelPath;
      this._loadedBackend = res?.backend || (useGpu ? 'gpu' : 'cpu');
      this._scheduleIdleUnload(unloadTimeoutSec);
      return {
        text: String(res?.text || '').trim(),
        backend: this._loadedBackend,
      };
    };

    if (acceleration === 'cpu') {
      return await tryRun(false, TRANSCRIBE_TIMEOUT_MS);
    }
    if (acceleration === 'gpu') {
      return await tryRun(true, TRANSCRIBE_TIMEOUT_MS);
    }

    // `auto`: try GPU acceleration first with shorter guard timeout, gracefully fall back to CPU
    try {
      return await tryRun(true, Math.max(GPU_LOAD_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS));
    } catch (gpuErr) {
      if (gpuErr?.name === 'AbortError' || signal?.aborted) throw gpuErr;
      this._killChild('GPU 加速不可用，正在回退到 CPU 本地推理');
      return await tryRun(false, TRANSCRIBE_TIMEOUT_MS);
    }
  }

  async unload() {
    this._clearUnloadTimer();
    const hadLoaded = Boolean(this._loadedModelId || this._child);
    this._killChild('已手动卸载本地语音模型释放内存');
    return { unloaded: hadLoaded };
  }

  dispose() {
    if (typeof this._installAbort === 'function') {
      this._installAbort();
    }
    this._killChild('插件已卸载');
  }
}

import { MAX_RECORDING_MS, VoiceSessionController } from './controller.js';
import {
  VOICE_HUD_POSITION_STORAGE_KEY,
  createFloatingHudController,
} from './hud.js';
import {
  enumerateAudioInputs,
  forgetMicrophoneFromOrder,
  moveMicrophoneInOrder,
  rememberMicrophones,
  resolvePreferredMicrophone,
} from './microphones.js';
import {
  PcmResampler,
  computeSmoothedLevel,
  encodeMonoWavBase64,
} from './pcmResampler.js';
import {
  HOLD_THRESHOLD_MS,
  createDictationShortcutHandler,
  doesEventMatchShortcut,
  formatDuration,
  formatKeyboardEventToShortcut,
  parseShortcut,
} from './shortcuts.js';
import { createVoiceUiComponents } from './studioPopover.js';
import {
  DEFAULT_VOICE_CONFIG,
  PLUGIN_ID,
  cleanTranscriptText,
  formatTranscriptInsertion,
  normalizeVoiceConfig,
  readComposerDraftContext,
} from './textInsertion.js';

export {
  DEFAULT_VOICE_CONFIG,
  HOLD_THRESHOLD_MS,
  MAX_RECORDING_MS,
  PLUGIN_ID,
  PcmResampler,
  VOICE_HUD_POSITION_STORAGE_KEY,
  VoiceSessionController,
  cleanTranscriptText,
  computeSmoothedLevel,
  createDictationShortcutHandler,
  doesEventMatchShortcut,
  encodeMonoWavBase64,
  enumerateAudioInputs,
  forgetMicrophoneFromOrder,
  formatDuration,
  formatKeyboardEventToShortcut,
  formatTranscriptInsertion,
  moveMicrophoneInOrder,
  normalizeVoiceConfig,
  parseShortcut,
  readComposerDraftContext,
  rememberMicrophones,
  resolvePreferredMicrophone,
};

const VOICE_CONFIG_STORAGE_KEY = 'dimo.voice-input.config';

function loadPersistedConfig() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VOICE_CONFIG_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    }
  } catch {
    // ignore
  }
  return {};
}

function savePersistedConfig(config) {
  try {
    if (typeof localStorage !== 'undefined' && config && typeof config === 'object') {
      // Never mirror API keys into localStorage (persisted securely in host plugin config)
      const { apiKey: _ignored, ...safe } = config;
      localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(safe));
    }
  } catch {
    // ignore
  }
}

const appPlugin = {
  id: PLUGIN_ID,

  activate(context = {}) {
    if (typeof globalThis.__dimoVoiceInputActiveCleanup__ === 'function') {
      try {
        globalThis.__dimoVoiceInputActiveCleanup__();
      } catch {
        // ignore
      }
    }

    const initialCfg = normalizeVoiceConfig({
      ...DEFAULT_VOICE_CONFIG,
      ...loadPersistedConfig(),
      ...(typeof context?.config?.getAll === 'function'
        ? context.config.getAll()
        : context?.config && typeof context.config === 'object'
          ? context.config
          : {}),
    });

    const invokeWorker = async (handler, params = {}) => {
      if (typeof context?.worker?.invoke === 'function') {
        return await context.worker.invoke(handler, params);
      }
      if (typeof context?.invokeContribution === 'function') {
        return await context.invokeContribution(handler, params);
      }
      if (typeof context?.host?.invokeWorker === 'function') {
        return await context.host.invokeWorker(handler, params);
      }
      return null;
    };

    const getEditorBridge = () => {
      if (typeof context?.services?.get === 'function') {
        try {
          return context.services.get('dimo.code-editor');
        } catch {
          return null;
        }
      }
      return null;
    };

    const insertIntoComposer = async (text) => {
      if (typeof context?.conversation?.call === 'function') {
        const res = await context.conversation.call('draft.insert', {
          text,
          token: { label: '', markdown: '', text },
        });
        return Boolean(res && res.inserted !== false);
      }
      return false;
    };

    const openPluginSettings = () => {
      const targetPath = `/plugins/${PLUGIN_ID}`;
      try {
        if (typeof context?.ui?.openPluginSettings === 'function') {
          void context.ui.openPluginSettings(PLUGIN_ID);
          return;
        }
        if (typeof window !== 'undefined') {
          if (window.dimoDesktop && typeof window.dimoDesktop.invoke === 'function') {
            void window.dimoDesktop.invoke('open_settings_window', {
              title: '设置',
              path: targetPath,
            });
            return;
          }
          if (
            window.__TAURI_INTERNALS__ &&
            typeof window.__TAURI_INTERNALS__.invoke === 'function'
          ) {
            void window.__TAURI_INTERNALS__.invoke('open_settings_window', {
              title: '设置',
              path: targetPath,
            });
            return;
          }
          window.dispatchEvent(
            new CustomEvent('dimo:navigate', {
              detail: { path: `/settings${targetPath}` },
            }),
          );
        }
      } catch {
        // ignore
      }
    };

    const controller = new VoiceSessionController({
      config: initialCfg,
      invokeWorker,
      getEditorBridge,
      insertIntoComposer,
    });

    const persistAndSyncConfig = (partial) => {
      const next = controller.updateConfig(partial);
      savePersistedConfig(next);
      void invokeWorker('voice.configure', next).catch(() => {});
      if (typeof context?.settings?.set === 'function') {
        void context.settings.set(next).catch(() => {});
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(
          new CustomEvent('dimo:plugin-config-updated', {
            detail: { pluginId: PLUGIN_ID, config: next },
          }),
        );
      }
      return next;
    };

    const disposers = [];

    // 1. Provide cross-plugin service bridge
    if (typeof context?.services?.provide === 'function') {
      try {
        const disp = context.services.provide(PLUGIN_ID, {
          startRecording: (opts) => controller.startRecording(opts),
          stopRecording: (opts) => controller.stopRecording(opts),
          toggleRecording: (opts) => controller.toggleRecording(opts),
          cancelRecording: () => controller.cancelRecording(),
          retryLastRecording: () => controller.retryLastRecording(),
          skipPostProcessing: () => controller.skipPostProcessing(),
          getSnapshot: () => controller.getSnapshot(),
          updateConfig: (cfg) => persistAndSyncConfig(cfg),
        });
        if (typeof disp === 'function') disposers.push(disp);
      } catch {
        // ignore
      }
    }

    // 2. Register React UI slots & views if React is available in Host
    const React = globalThis.React || globalThis.__DIMO_HOST_MODULES__?.react;
    if (React && typeof React.createElement === 'function') {
      const { VoiceComposerToolbarButton, VoiceStatusPopoverView } =
        createVoiceUiComponents(React, {
          controller,
          invokeWorker,
          persistAndSyncConfig,
          openPluginSettings,
        });

      if (typeof context?.registerSlot === 'function') {
        const slotDisp = context.registerSlot({
          id: 'voice-composer-button',
          slot: 'composer.toolbar',
          label: 'AI 语音输入',
          tooltip: `开始/停止语音输入 (${initialCfg.shortcut})`,
          order: 20,
          onActivate: () => controller.toggleRecording(),
          component: VoiceComposerToolbarButton,
        });
        if (typeof slotDisp === 'function') disposers.push(slotDisp);
      }

      if (typeof context?.registerView === 'function') {
        const viewDisp = context.registerView({
          id: 'voice-input-status',
          title: 'AI语音输入',
          slot: 'status.after-mcp',
          component: VoiceStatusPopoverView,
        });
        if (typeof viewDisp === 'function') disposers.push(viewDisp);
      }
    }

    // 3. Floating HUD capsule + preview comparison + error banner
    const floatingHud = createFloatingHudController(controller, {
      openPluginSettings,
    });
    disposers.push(controller.subscribe(floatingHud.render));

    // 4. Global Keyboard Shortcut Listener (`auto` / `push-to-talk` / `toggle` + Esc/Enter/blur)
    const shortcutHandler = createDictationShortcutHandler(controller);
    const onWindowConfigUpdated = (event) => {
      const detail = event?.detail;
      if (
        detail &&
        (detail.pluginId === PLUGIN_ID || detail.pluginId === 'voice-input') &&
        detail.config &&
        typeof detail.config === 'object'
      ) {
        controller.updateConfig(detail.config);
        savePersistedConfig(controller.config);
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', shortcutHandler.onKeyDown, true);
      window.addEventListener('keyup', shortcutHandler.onKeyUp, true);
      window.addEventListener('blur', shortcutHandler.onBlur);
      window.addEventListener('dimo:plugin-config-updated', onWindowConfigUpdated);
    }

    // 5. Register command & status handlers
    const registerHandler = (name, fn) => {
      if (typeof context?.registerHandler === 'function') {
        context.registerHandler(name, fn);
      }
      if (typeof context?.commands?.register === 'function') {
        context.commands.register(name, fn);
      }
    };

    registerHandler('voice.status', async () => {
      const workerStatus =
        (await invokeWorker('voice.status', {}).catch(() => null)) || {};
      const snap = controller.getSnapshot();
      return {
        ...workerStatus,
        ...snap.config,
        state: snap.state,
        lastError: snap.lastError || workerStatus.metrics?.lastError || null,
        errorCode: snap.errorCode || workerStatus.metrics?.lastErrorCode || null,
        text: snap.config.enabled
          ? snap.state === 'recording'
            ? `录音中 ${snap.durationLabel}`
            : snap.state === 'transcribing'
              ? '语音转写中…'
              : snap.state === 'post-processing'
                ? '语音润色中…'
                : `语音输入 (${snap.config.shortcut})`
          : '语音输入 (已禁用)',
        tooltip: snap.config.enabled
          ? `AI 语音输入 (${snap.config.providerProtocol}) · 快捷键 ${snap.config.shortcut}`
          : 'AI 语音输入已禁用',
      };
    });

    registerHandler('voice.toggle', async (params) => {
      if (params && typeof params.enabled === 'boolean') {
        const next = persistAndSyncConfig({ enabled: params.enabled });
        return { enabled: next.enabled, state: controller.state };
      }
      return await controller.toggleRecording();
    });

    registerHandler('voice.transcribe', async (params) => {
      if (controller.state === 'recording') {
        return await controller.stopRecording(params || {});
      }
      const res = await invokeWorker('voice.transcribe', params || {});
      if (res?.text && params?.autoInsert !== false) {
        await controller.insertTranscriptIntoTarget(res.text);
      }
      return res;
    });

    registerHandler('voice.cleanup', async (params) => {
      return await invokeWorker('voice.cleanup', params || {});
    });

    registerHandler('voice.configure', async (params) => {
      if (params && typeof params === 'object') {
        persistAndSyncConfig(params);
      }
      return controller.getSnapshot();
    });

    registerHandler('voice.cancel', async () => {
      return controller.cancelRecording();
    });

    registerHandler('voice.local.models', async (params) => {
      return await invokeWorker('voice.local.models', params || {});
    });
    registerHandler('voice.local.download', async (params) => {
      return await invokeWorker('voice.local.download', params || {});
    });
    registerHandler('voice.local.cancelDownload', async (params) => {
      return await invokeWorker('voice.local.cancelDownload', params || {});
    });
    registerHandler('voice.local.remove', async (params) => {
      return await invokeWorker('voice.local.remove', params || {});
    });
    registerHandler('voice.local.link', async (params) => {
      return await invokeWorker('voice.local.link', params || {});
    });
    registerHandler('voice.local.installEngine', async (params) => {
      return await invokeWorker('voice.local.installEngine', params || {});
    });
    registerHandler('voice.local.unload', async () => {
      return await invokeWorker('voice.local.unload', {});
    });

    const disposeInstance = () => {
      if (globalThis.__dimoVoiceInputActiveCleanup__ === disposeInstance) {
        globalThis.__dimoVoiceInputActiveCleanup__ = null;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('keydown', shortcutHandler.onKeyDown, true);
        window.removeEventListener('keyup', shortcutHandler.onKeyUp, true);
        window.removeEventListener('blur', shortcutHandler.onBlur);
        window.removeEventListener('dimo:plugin-config-updated', onWindowConfigUpdated);
      }
      floatingHud.dispose();
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          // ignore
        }
      }
      controller.dispose();
    };

    globalThis.__dimoVoiceInputActiveCleanup__ = disposeInstance;

    return Object.assign(disposeInstance, {
      controller,
      dispose: disposeInstance,
    });
  },
};

export default appPlugin;

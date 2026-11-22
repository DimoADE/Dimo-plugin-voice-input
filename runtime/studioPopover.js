import { getLocalSpeechModel } from '../worker/localCatalog.mjs';
import { createLocalModelsTab } from './localModelsTab.js';
import {
  createMicrophoneTester,
  moveMicrophoneInOrder,
} from './microphones.js';
import {
  HOLD_THRESHOLD_MS,
  formatDuration,
  formatKeyboardEventToShortcut,
} from './shortcuts.js';

const PROTOCOL_OPTIONS = [
  { value: 'hybrid', label: '混合流式 + 云端 Whisper' },
  { value: 'local-model', label: '本地离线模型 (GGUF · 免费隐私)' },
  { value: 'openai-whisper', label: 'OpenAI Whisper' },
  { value: 'groq-whisper', label: 'Groq 极速 Whisper' },
  { value: 'xai-stt', label: 'xAI Grok STT' },
  { value: 'openrouter-stt', label: 'OpenRouter Audio' },
  { value: 'openai-chat-audio', label: 'Chat Audio 多模态' },
  { value: 'custom-openai', label: '自定义 / 本地 OpenAI 兼容' },
  { value: 'browser-speech', label: '浏览器 / 系统原生（免 Key）' },
];

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
];

const RECORDING_MODE_OPTIONS = [
  { value: 'auto', label: '智能混合（轻按切换 / 长按说话）' },
  { value: 'toggle', label: '单击切换开始 / 结束' },
  { value: 'push-to-talk', label: '按住说话，松开即转写' },
];

const CLEANUP_MODE_OPTIONS = [
  { value: 'auto-clean', label: '自动润色插入' },
  { value: 'preview', label: '对照预览确认' },
  { value: 'off', label: '仅输出原文' },
];

export function createVoiceUiComponents(React, deps) {
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;
  const { controller, invokeWorker, persistAndSyncConfig, openPluginSettings } = deps;
  const LocalModelsTab = createLocalModelsTab(React, {
    invokeWorker:
      invokeWorker ||
      ((handler, params) =>
        typeof controller.invokeWorker === 'function'
          ? controller.invokeWorker(handler, params)
          : Promise.resolve(null)),
    persistAndSyncConfig,
  });

  function useVoiceSnapshot() {
    const [snap, setSnap] = useState(() => controller.getSnapshot());
    useEffect(() => controller.subscribe(setSnap), []);
    return snap;
  }

  // 1. Composer Toolbar Microphone Button (`composer.toolbar` slot)
  function VoiceComposerToolbarButton(props = {}) {
    const snap = useVoiceSnapshot();
    const pointerPressRef = useRef(null);

    if (!snap.config.enabled) return null;

    const state = snap.state;
    const isRecording = state === 'recording';
    const isBusy =
      state === 'preparing' ||
      state === 'transcribing' ||
      state === 'post-processing';
    const isError = state === 'error';
    const mode = snap.config.recordingMode || 'auto';
    const shortcut = snap.config.shortcut || 'Alt+V';
    const disabled = props.isEditable === false || isBusy;

    const handlePointerDown = (ev) => {
      if (disabled) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      if (mode === 'push-to-talk') {
        ev.preventDefault();
        pointerPressRef.current = { startedAt: Date.now(), mode: 'push-to-talk' };
        void controller.startRecording();
      } else if (mode === 'auto' && (state === 'idle' || state === 'error')) {
        ev.preventDefault();
        pointerPressRef.current = { startedAt: Date.now(), mode: 'auto' };
        void controller.startRecording();
      }
    };

    const handlePointerUp = (ev) => {
      const press = pointerPressRef.current;
      pointerPressRef.current = null;
      if (!press) return;
      ev.preventDefault();
      if (press.mode === 'push-to-talk') {
        if (controller.state === 'recording' || controller.state === 'preparing') {
          void controller.stopRecording();
        }
        return;
      }
      if (press.mode === 'auto') {
        const heldMs = Date.now() - press.startedAt;
        if (heldMs >= HOLD_THRESHOLD_MS) {
          if (controller.state === 'recording' || controller.state === 'preparing') {
            void controller.stopRecording();
          }
        }
      }
    };

    const handleClick = (ev) => {
      if (disabled) return;
      if (mode === 'push-to-talk') return;
      if (mode === 'auto' && pointerPressRef.current) return;
      ev.preventDefault();
      if (state === 'recording') {
        void controller.stopRecording();
      } else if (state === 'preview') {
        void controller.commitPreview(false);
      } else if (mode === 'toggle') {
        void controller.toggleRecording();
      }
    };

    if (isRecording) {
      return h(
        'button',
        {
          type: 'button',
          onClick: handleClick,
          onPointerUp: handlePointerUp,
          title: `正在录音 (${snap.durationLabel}) · 点击停止 (${shortcut})`,
          'aria-label': '停止语音输入',
          'data-testid': 'voice-composer-recording-button',
          className:
            'inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary/15 px-2.5 text-sm font-medium tabular-nums text-primary transition-colors hover:bg-primary/25',
        },
        h('span', { className: 'h-2 w-2 rounded-full bg-primary animate-pulse' }),
        h('span', { className: 'tabular-nums' }, snap.durationLabel),
      );
    }

    if (isBusy) {
      const label =
        state === 'post-processing'
          ? '正在润色语音文本…'
          : state === 'preparing'
            ? '正在准备麦克风…'
            : '正在转写语音…';
      return h(
        'button',
        {
          type: 'button',
          disabled: state !== 'post-processing',
          onClick:
            state === 'post-processing'
              ? () => controller.skipPostProcessing()
              : undefined,
          title:
            state === 'post-processing' ? `${label} 点击跳过润色` : label,
          'aria-label': label,
          'data-testid': 'voice-composer-transcribing-button',
          className:
            'inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary',
        },
        h('span', {
          className:
            'h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin',
        }),
      );
    }

    const titleText = isError
      ? `${snap.lastError || '语音识别失败'} · 点击重试 (${shortcut})`
      : mode === 'push-to-talk'
        ? `按住说话 (${shortcut})`
        : mode === 'auto'
          ? `AI 语音输入 · 轻按切换 / 长按说话 (${shortcut})`
          : `AI 语音输入 (${shortcut})`;

    return h(
      'button',
      {
        type: 'button',
        disabled,
        onClick: handleClick,
        onPointerDown: handlePointerDown,
        onPointerUp: handlePointerUp,
        title: titleText,
        'aria-label': 'AI 语音输入',
        'data-testid': 'voice-composer-mic-button',
        className: isError
          ? 'inline-flex h-8 w-8 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10'
          : 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50',
      },
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.8',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          className: 'h-[18px] w-[18px]',
        },
        h('rect', { x: '9', y: '2', width: '6', height: '11', rx: '3' }),
        h('path', { d: 'M5 10a7 7 0 0 0 14 0' }),
        h('line', { x1: '12', y1: '17', x2: '12', y2: '21' }),
        h('line', { x1: '8', y1: '21', x2: '16', y2: '21' }),
      ),
    );
  }

  // 2. Status Bar Compact Voice Studio Popover (`status.after-mcp` slot)
  function VoiceStatusPopoverView() {
    const snap = useVoiceSnapshot();
    const [activeTab, setActiveTab] = useState('controls'); // controls | audio | history
    const [recordingShortcut, setRecordingShortcut] = useState(false);
    const [micTest, setMicTest] = useState({
      state: 'idle',
      level: 0,
      durationMs: 0,
      error: null,
      hasRecording: false,
    });
    const testerRef = useRef(null);

    const cfg = snap.config;
    const enabled = Boolean(cfg.enabled);
    const isRecording = snap.state === 'recording';
    const isBusy =
      snap.state === 'preparing' ||
      snap.state === 'transcribing' ||
      snap.state === 'post-processing';

    useEffect(() => {
      void controller.refreshMicrophones();
      return () => {
        if (testerRef.current) {
          testerRef.current.dispose();
          testerRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      if (!recordingShortcut || typeof window === 'undefined') return undefined;
      const handleKeyDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          setRecordingShortcut(false);
          return;
        }
        const nextSc = formatKeyboardEventToShortcut(e);
        if (nextSc) {
          persistAndSyncConfig({ shortcut: nextSc });
          setRecordingShortcut(false);
        }
      };
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [recordingShortcut]);

    const ensureMicTester = () => {
      if (!testerRef.current) {
        testerRef.current = createMicrophoneTester({
          onUpdate: (next) => setMicTest({ ...next }),
        });
      }
      return testerRef.current;
    };

    const handleToggleMicTest = () => {
      const tester = ensureMicTester();
      if (micTest.state === 'recording') {
        tester.stopRecording();
      } else {
        void tester.startRecording(cfg.audioDeviceId);
      }
    };

    const handlePlayMicTest = () => {
      ensureMicTester().playRecording();
    };

    const handleToggleSttTest = () => {
      if (isRecording && snap.isTestSession) {
        void controller.stopRecording({ testOnly: true });
      } else {
        void controller.startRecording({ testOnly: true });
      }
    };

    const copyText = (txt) => {
      if (txt && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(txt).catch(() => {});
      }
    };

    const selectCls =
      'h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary';

    const stateLabel = !enabled
      ? '已禁用'
      : isRecording
        ? `录音中 ${snap.durationLabel}`
        : snap.state === 'transcribing'
          ? '转写中'
          : snap.state === 'post-processing'
            ? '润色中'
            : snap.state === 'preview'
              ? '待确认'
              : snap.state === 'error'
                ? '识别失败'
                : '就绪';

    return h(
      'div',
      {
        className: 'flex w-[352px] flex-col gap-2.5 p-3 text-xs text-foreground',
        'data-testid': 'voice-status-popover',
      },
      // Header
      h(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        h(
          'div',
          { className: 'flex items-center gap-2 min-w-0' },
          h('span', { className: 'font-semibold text-sm truncate' }, 'AI 语音输入'),
          h(
            'span',
            {
              className:
                'rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground',
            },
            stateLabel,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            onClick: () => persistAndSyncConfig({ enabled: !enabled }),
            className: `relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              enabled ? 'bg-primary' : 'bg-muted'
            }`,
          },
          h('span', {
            className: `pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`,
          }),
        ),
      ),

      // Primary Dictation CTA + Retry
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        h(
          'button',
          {
            type: 'button',
            disabled: !enabled || (isBusy && snap.state !== 'post-processing'),
            onClick: () => {
              if (snap.state === 'post-processing') {
                controller.skipPostProcessing();
              } else {
                void controller.toggleRecording();
              }
            },
            className: `inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-50 ${
              isRecording
                ? 'bg-destructive text-destructive-foreground hover:opacity-90'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            }`,
          },
          h(
            'span',
            { className: 'tabular-nums' },
            isRecording
              ? `停止并转写 (${snap.durationLabel})`
              : snap.state === 'post-processing'
                ? '跳过润色直接插入'
                : `开始语音输入 (${cfg.shortcut})`,
          ),
        ),
        snap.canRetry && snap.state === 'error'
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => void controller.retryLastRecording(),
                className:
                  'inline-flex h-8 items-center justify-center rounded-md border border-border px-2.5 text-xs font-medium hover:bg-accent',
              },
              '重试',
            )
          : null,
      ),

      // Error notice inline
      snap.lastError
        ? h(
            'div',
            {
              className:
                'flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive',
            },
            h('span', { className: 'flex-1 break-words' }, snap.lastError),
            snap.errorAction === 'models'
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setActiveTab('models'),
                    className:
                      'shrink-0 rounded bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/25',
                  },
                  '管理模型',
                )
              : null,
          )
        : null,

      // Tabs (4 tabs: Controls | Local Models | Device & Test | History)
      h(
        'div',
        { className: 'grid grid-cols-4 gap-1 rounded-md bg-muted/60 p-0.5' },
        [
          { id: 'controls', label: '控制' },
          { id: 'models', label: '本地模型' },
          { id: 'audio', label: '设备测试' },
          { id: 'history', label: `历史(${snap.history.length})` },
        ].map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              onClick: () => setActiveTab(tab.id),
              className: `h-6 rounded text-[11px] font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`,
            },
            tab.label,
          ),
        ),
      ),

      // Tab 1: Controls
      activeTab === 'controls'
        ? h(
            'div',
            { className: 'flex flex-col gap-2' },
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'text-[11px] text-muted-foreground' }, '识别引擎'),
              h(
                'select',
                {
                  value: cfg.providerProtocol,
                  onChange: (e) =>
                    persistAndSyncConfig({ providerProtocol: e.target.value }),
                  className: selectCls,
                },
                PROTOCOL_OPTIONS.map((opt) =>
                  h('option', { key: opt.value, value: opt.value }, opt.label),
                ),
              ),
            ),
            cfg.providerProtocol === 'local-model'
              ? h(
                  'div',
                  {
                    className:
                      'flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-[11px]',
                  },
                  h(
                    'span',
                    { className: 'truncate text-foreground' },
                    `本地模型：${getLocalSpeechModel(cfg.localModelId)?.name || cfg.localModelId}`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => setActiveTab('models'),
                      className:
                        'shrink-0 rounded bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/25',
                    },
                    '管理模型',
                  ),
                )
              : null,
            h(
              'div',
              { className: 'grid grid-cols-2 gap-2' },
              h(
                'label',
                { className: 'flex flex-col gap-1' },
                h('span', { className: 'text-[11px] text-muted-foreground' }, '识别语言'),
                h(
                  'select',
                  {
                    value: cfg.language,
                    onChange: (e) => persistAndSyncConfig({ language: e.target.value }),
                    className: selectCls,
                  },
                  LANGUAGE_OPTIONS.map((opt) =>
                    h('option', { key: opt.value, value: opt.value }, opt.label),
                  ),
                ),
              ),
              h(
                'label',
                { className: 'flex flex-col gap-1' },
                h('span', { className: 'text-[11px] text-muted-foreground' }, '润色模式'),
                h(
                  'select',
                  {
                    value: cfg.cleanupMode,
                    onChange: (e) =>
                      persistAndSyncConfig({ cleanupMode: e.target.value }),
                    className: selectCls,
                  },
                  CLEANUP_MODE_OPTIONS.map((opt) =>
                    h('option', { key: opt.value, value: opt.value }, opt.label),
                  ),
                ),
              ),
            ),
            h(
              'label',
              { className: 'flex flex-col gap-1' },
              h('span', { className: 'text-[11px] text-muted-foreground' }, '触发方式'),
              h(
                'select',
                {
                  value: cfg.recordingMode,
                  onChange: (e) =>
                    persistAndSyncConfig({ recordingMode: e.target.value }),
                  className: selectCls,
                },
                RECORDING_MODE_OPTIONS.map((opt) =>
                  h('option', { key: opt.value, value: opt.value }, opt.label),
                ),
              ),
            ),
            h(
              'div',
              { className: 'flex items-center justify-between gap-2 pt-0.5' },
              h('span', { className: 'text-[11px] text-muted-foreground' }, '快捷键'),
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setRecordingShortcut((v) => !v),
                  className: `h-7 rounded-md border px-2.5 text-[11px] font-medium transition-colors ${
                    recordingShortcut
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-foreground hover:bg-accent'
                  }`,
                },
                recordingShortcut ? '按下组合键… (Esc 取消)' : cfg.shortcut,
              ),
            ),
            h(
              'div',
              { className: 'flex items-center justify-between gap-2 pt-0.5' },
              h(
                'label',
                { className: 'inline-flex items-center gap-1.5 cursor-pointer' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(cfg.silenceFiltering),
                  onChange: (e) =>
                    persistAndSyncConfig({ silenceFiltering: e.target.checked }),
                }),
                h('span', { className: 'text-[11px]' }, '静音过滤 (VAD)'),
              ),
              h(
                'label',
                { className: 'inline-flex items-center gap-1.5 cursor-pointer' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(cfg.useLlmCleanup),
                  onChange: (e) =>
                    persistAndSyncConfig({ useLlmCleanup: e.target.checked }),
                }),
                h('span', { className: 'text-[11px]' }, 'LLM 上下文润色'),
              ),
            ),
          )
        : null,

      // Tab 2: Local Offline Speech Models (GGUF + transcribe.cpp)
      activeTab === 'models' ? h(LocalModelsTab, { config: cfg }) : null,

      // Tab 3: Audio Device Picker & Loopback / STT Diagnostics
      activeTab === 'audio'
        ? h(
            'div',
            { className: 'flex flex-col gap-2.5' },
            h(
              'div',
              { className: 'flex flex-col gap-1' },
              h(
                'div',
                { className: 'flex items-center justify-between' },
                h('span', { className: 'text-[11px] text-muted-foreground' }, '麦克风输入设备'),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void controller.refreshMicrophones(),
                    className:
                      'text-[11px] text-muted-foreground hover:text-foreground',
                  },
                  '刷新',
                ),
              ),
              h(
                'select',
                {
                  value: cfg.audioDeviceId || 'default',
                  onChange: (e) =>
                    persistAndSyncConfig({ audioDeviceId: e.target.value }),
                  className: selectCls,
                },
                h('option', { value: 'default' }, '系统默认（按优先级回退）'),
                (snap.availableMicrophones || [])
                  .filter((d) => d.deviceId !== 'default')
                  .map((dev) =>
                    h('option', { key: dev.deviceId, value: dev.deviceId }, dev.label),
                  ),
              ),
            ),
            // Preferred fallback priority list if multiple mics detected
            (snap.microphoneOrder || []).length > 1
              ? h(
                  'div',
                  { className: 'flex flex-col gap-1' },
                  h(
                    'span',
                    { className: 'text-[11px] text-muted-foreground' },
                    '回退优先级',
                  ),
                  h(
                    'div',
                    { className: 'flex flex-col gap-1 max-h-20 overflow-y-auto' },
                    snap.microphoneOrder.slice(0, 4).map((item, idx) =>
                      h(
                        'div',
                        {
                          key: item.deviceId,
                          className:
                            'flex items-center justify-between gap-1 rounded border border-border/60 px-2 py-1 text-[11px]',
                        },
                        h('span', { className: 'truncate' }, `${idx + 1}. ${item.label || item.deviceId}`),
                        h(
                          'div',
                          { className: 'inline-flex items-center gap-1 shrink-0' },
                          h(
                            'button',
                            {
                              type: 'button',
                              disabled: idx === 0,
                              onClick: () =>
                                controller.setMicrophoneOrder(
                                  moveMicrophoneInOrder(snap.microphoneOrder, item.deviceId, 'up'),
                                ),
                              className: 'px-1 text-muted-foreground hover:text-foreground disabled:opacity-30',
                            },
                            '↑',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              disabled: idx === snap.microphoneOrder.length - 1,
                              onClick: () =>
                                controller.setMicrophoneOrder(
                                  moveMicrophoneInOrder(snap.microphoneOrder, item.deviceId, 'down'),
                                ),
                              className: 'px-1 text-muted-foreground hover:text-foreground disabled:opacity-30',
                            },
                            '↓',
                          ),
                        ),
                      ),
                    ),
                  ),
                )
              : null,

            // Local Loopback Mic Test
            h(
              'div',
              { className: 'flex flex-col gap-1.5 rounded-md border border-border/70 p-2' },
              h(
                'div',
                { className: 'flex items-center justify-between gap-2' },
                h('span', { className: 'font-medium text-[11px]' }, '本地麦克风回放测试'),
                h(
                  'span',
                  { className: 'text-[10px] tabular-nums text-muted-foreground' },
                  micTest.state === 'recording'
                    ? `${formatDuration(micTest.durationMs)} / 0:10`
                    : '仅本地不上传',
                ),
              ),
              h(
                'div',
                { className: 'h-1.5 w-full overflow-hidden rounded-full bg-muted' },
                h('div', {
                  className: 'h-full bg-primary transition-all duration-75',
                  style: { width: `${Math.round((micTest.level || 0) * 100)}%` },
                }),
              ),
              h(
                'div',
                { className: 'flex items-center gap-1.5' },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: handleToggleMicTest,
                    className:
                      'inline-flex h-6 flex-1 items-center justify-center rounded border border-border px-2 text-[11px] hover:bg-accent',
                  },
                  micTest.state === 'recording' ? '停止录测' : '录制试音',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !micTest.hasRecording || micTest.state === 'recording',
                    onClick: handlePlayMicTest,
                    className:
                      'inline-flex h-6 items-center justify-center rounded border border-border px-2.5 text-[11px] hover:bg-accent disabled:opacity-40',
                  },
                  micTest.state === 'playing' ? '播放中…' : '回放',
                ),
              ),
              micTest.error
                ? h('span', { className: 'text-[10px] text-destructive' }, micTest.error)
                : null,
            ),

            // Live STT Engine Test (isolated from composer draft)
            h(
              'div',
              { className: 'flex flex-col gap-1.5 rounded-md border border-border/70 p-2' },
              h(
                'div',
                { className: 'flex items-center justify-between gap-2' },
                h('span', { className: 'font-medium text-[11px]' }, '测试识别引擎'),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !enabled || isBusy,
                    onClick: handleToggleSttTest,
                    className:
                      'inline-flex h-6 items-center justify-center rounded border border-border px-2.5 text-[11px] hover:bg-accent disabled:opacity-40',
                  },
                  isRecording && snap.isTestSession ? '停止并识别' : '开始试说',
                ),
              ),
              snap.lastTestResult
                ? h(
                    'div',
                    { className: 'flex flex-col gap-0.5 rounded bg-muted/50 p-1.5 text-[11px]' },
                    h('span', { className: 'text-foreground break-words' }, snap.lastTestResult.text),
                    h(
                      'span',
                      { className: 'text-[10px] tabular-nums text-muted-foreground' },
                      `${snap.lastTestResult.provider || cfg.providerProtocol} · ${snap.lastTestResult.latencyMs || 0}ms`,
                    ),
                  )
                : h(
                    'span',
                    { className: 'text-[10px] text-muted-foreground' },
                    '仅测试识别效果，不会写入当前输入框。',
                  ),
            ),
          )
        : null,

      // Tab 3: Dictation History
      activeTab === 'history'
        ? h(
            'div',
            { className: 'flex flex-col gap-1.5' },
            snap.history.length === 0
              ? h(
                  'div',
                  { className: 'py-5 text-center text-[11px] text-muted-foreground' },
                  '暂无听写记录',
                )
              : h(
                  'div',
                  { className: 'flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-0.5' },
                  snap.history.map((item) =>
                    h(
                      'div',
                      {
                        key: item.id,
                        className:
                          'flex flex-col gap-1 rounded-md border border-border/60 p-2',
                      },
                      h(
                        'p',
                        { className: 'line-clamp-2 text-[11px] leading-snug text-foreground' },
                        item.text,
                      ),
                      h(
                        'div',
                        { className: 'flex items-center justify-between gap-2' },
                        h(
                          'span',
                          { className: 'text-[10px] tabular-nums text-muted-foreground' },
                          `${item.provider || ''} ${item.latencyMs ? `· ${item.latencyMs}ms` : ''}`.trim(),
                        ),
                        h(
                          'div',
                          { className: 'inline-flex items-center gap-1' },
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => copyText(item.text),
                              className:
                                'rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground',
                            },
                            '复制',
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              onClick: () => void controller.reinsertHistoryItem(item.id, false),
                              className:
                                'rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20',
                            },
                            '插入',
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            snap.history.length > 0
              ? h(
                  'div',
                  { className: 'flex justify-end' },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => controller.clearHistory(),
                      className: 'text-[11px] text-muted-foreground hover:text-foreground',
                    },
                    '清空历史',
                  ),
                )
              : null,
          )
        : null,

      // Footer
      h(
        'div',
        { className: 'flex items-center justify-between border-t border-border/60 pt-2' },
        h(
          'span',
          { className: 'text-[11px] text-muted-foreground truncate' },
          cfg.vocabulary ? `热词 ${cfg.vocabulary.split(/[,，\n]+/).filter(Boolean).length} 条` : '未设置热词',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: openPluginSettings,
            className:
              'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          },
          '前往设置',
        ),
      ),
    );
  }

  return {
    VoiceComposerToolbarButton,
    VoiceStatusPopoverView,
  };
}

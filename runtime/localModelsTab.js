/**
 * Local offline speech models management tab for the Dimo Voice Studio Popover.
 * Pure React.createElement (no JSX, zero external runtime imports) so it bundles
 * cleanly into single-file ESM `app/main.js`.
 */

import {
  CN_HF_MIRROR_URL,
  DEFAULT_HF_MIRROR_URL,
  LOCAL_SPEECH_MODELS,
  formatBytes,
} from '../worker/localCatalog.mjs';

const ACCEL_OPTIONS = [
  { value: 'auto', label: '自动 (GPU/CPU)' },
  { value: 'cpu', label: '仅 CPU' },
  { value: 'gpu', label: '强制 GPU' },
];

export function createLocalModelsTab(React, deps) {
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;
  const { invokeWorker, persistAndSyncConfig } = deps;

  return function LocalModelsTab(props) {
    const cfg = props.config;
    const [state, setState] = useState(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('recommended'); // recommended | zh | all
    const [linkPath, setLinkPath] = useState('');
    const [linkNotice, setLinkNotice] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [busyId, setBusyId] = useState(null);

    const refresh = useCallback(async () => {
      try {
        const res = await invokeWorker('voice.local.models', {});
        if (res && typeof res === 'object') {
          setState(res);
          setActionError(null);
        }
      } catch (err) {
        setActionError(String(err?.message || err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void refresh();
    }, [refresh]);

    // Poll every 1s strictly while a download or engine installation is active
    const hasActiveJob = Boolean(
      state?.engine?.installState?.status === 'installing' ||
        (state?.models || []).some(
          (m) =>
            m.download &&
            (m.download.status === 'downloading' || m.download.status === 'verifying'),
        ),
    );

    useEffect(() => {
      if (!hasActiveJob) return undefined;
      const id = setInterval(() => {
        void refresh();
      }, 1000);
      return () => clearInterval(id);
    }, [hasActiveJob, refresh]);

    const models = state?.models || LOCAL_SPEECH_MODELS.map((m) => ({
      ...m,
      sizeLabel: formatBytes(m.size),
      installed: false,
      linkedFrom: null,
      active: m.id === cfg.localModelId,
      download: null,
    }));

    const engine = state?.engine || {
      engine: 'none',
      installed: false,
      transcribeCppInstalled: false,
      version: null,
      loadedModelId: null,
      loadedBackend: null,
      installState: { status: 'idle', message: '', error: null },
    };

    const filteredModels = models.filter((m) => {
      if (filter === 'recommended') return m.recommended || m.installed || m.active;
      if (filter === 'zh') return Array.isArray(m.languages) && m.languages.includes('zh');
      return true;
    });

    const handleInstallEngine = async () => {
      setActionError(null);
      try {
        const res = await invokeWorker('voice.local.installEngine', { background: true });
        if (res?.state) setState(res.state);
        else await refresh();
      } catch (err) {
        setActionError(String(err?.message || err));
      }
    };

    const handleUnload = async () => {
      setActionError(null);
      try {
        const res = await invokeWorker('voice.local.unload', {});
        if (res?.state) setState(res.state);
        else await refresh();
      } catch (err) {
        setActionError(String(err?.message || err));
      }
    };

    const handleDownload = async (modelId) => {
      setActionError(null);
      setBusyId(modelId);
      try {
        const res = await invokeWorker('voice.local.download', {
          modelId,
          hfMirrorUrl: cfg.hfMirrorUrl,
          autoInstallEngine: !engine.installed,
        });
        if (res?.state) setState(res.state);
        else await refresh();
      } catch (err) {
        setActionError(String(err?.message || err));
      } finally {
        setBusyId(null);
      }
    };

    const handleCancelDownload = async (modelId) => {
      setActionError(null);
      try {
        const res = await invokeWorker('voice.local.cancelDownload', { modelId });
        if (res?.state) setState(res.state);
        else await refresh();
      } catch (err) {
        setActionError(String(err?.message || err));
      }
    };

    const handleRemove = async (modelId) => {
      setActionError(null);
      setBusyId(modelId);
      try {
        const res = await invokeWorker('voice.local.remove', { modelId });
        if (res?.state) setState(res.state);
        else await refresh();
      } catch (err) {
        setActionError(String(err?.message || err));
      } finally {
        setBusyId(null);
      }
    };

    const handleActivateModel = (modelId) => {
      persistAndSyncConfig({
        providerProtocol: 'local-model',
        localModelId: modelId,
      });
      void refresh();
    };

    const handleLinkSource = async () => {
      const trimmed = linkPath.trim();
      if (!trimmed) return;
      setActionError(null);
      setLinkNotice(null);
      setBusyId('__link__');
      try {
        const res = await invokeWorker('voice.local.link', { sourcePath: trimmed });
        if (res?.state) setState(res.state);
        const count = Array.isArray(res?.linked) ? res.linked.length : 0;
        setLinkNotice(
          count > 0
            ? `已零拷贝链接 ${count} 个模型（扫描 ${res.scanned || count} 项）`
            : `扫描 ${res?.scanned || 0} 个文件，未发现新匹配的 GGUF 模型`,
        );
        if (count > 0) setLinkPath('');
      } catch (err) {
        setActionError(String(err?.message || err));
      } finally {
        setBusyId(null);
      }
    };

    const isCnMirror = (cfg.hfMirrorUrl || '').includes('hf-mirror.com');
    const selectCls =
      'h-6 rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary';

    const engineInstalling = engine.installState?.status === 'installing';
    const engineLabel = engineInstalling
      ? engine.installState?.message || '正在安装 transcribe.cpp…'
      : engine.transcribeCppInstalled
        ? `transcribe.cpp v${engine.version || '0.4.2'} 就绪`
        : engine.whisperCliPath
          ? 'whisper-cli 就绪'
          : '未安装推理引擎 (transcribe.cpp)';

    return h(
      'div',
      { className: 'flex flex-col gap-2', 'data-testid': 'voice-local-models-tab' },

      // Engine status banner
      h(
        'div',
        {
          className:
            'flex flex-col gap-1.5 rounded-md border border-border/70 bg-muted/30 p-2',
        },
        h(
          'div',
          { className: 'flex items-center justify-between gap-2' },
          h(
            'div',
            { className: 'flex items-center gap-1.5 min-w-0' },
            h('span', {
              className: `h-2 w-2 shrink-0 rounded-full ${
                engine.installed
                  ? 'bg-primary'
                  : engineInstalling
                    ? 'bg-primary animate-pulse'
                    : 'bg-muted-foreground/50'
              }`,
            }),
            h(
              'span',
              { className: 'truncate text-[11px] font-medium text-foreground' },
              engineLabel,
            ),
          ),
          !engine.installed
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: engineInstalling,
                  onClick: handleInstallEngine,
                  className:
                    'inline-flex h-6 shrink-0 items-center rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50',
                },
                engineInstalling ? '安装中…' : '安装引擎',
              )
            : engine.loadedModelId
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: handleUnload,
                    className:
                      'inline-flex h-6 shrink-0 items-center rounded border border-border px-2 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground',
                  },
                  `卸载内存 (${engine.loadedBackend || 'ram'})`,
                )
              : null,
        ),
        engine.installState?.error
          ? h(
              'span',
              { className: 'text-[10px] text-destructive break-words' },
              engine.installState.error,
            )
          : null,

        // Acceleration & Mirror quick settings
        h(
          'div',
          { className: 'flex items-center justify-between gap-1.5 pt-0.5' },
          h(
            'select',
            {
              value: cfg.localAcceleration || 'auto',
              onChange: (e) =>
                persistAndSyncConfig({ localAcceleration: e.target.value }),
              className: `${selectCls} flex-1`,
              'aria-label': '硬件加速',
            },
            ACCEL_OPTIONS.map((opt) =>
              h('option', { key: opt.value, value: opt.value }, opt.label),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () =>
                persistAndSyncConfig({
                  hfMirrorUrl: isCnMirror ? DEFAULT_HF_MIRROR_URL : CN_HF_MIRROR_URL,
                }),
              title: isCnMirror
                ? '当前使用 hf-mirror.com 国内镜像源，点击切回 huggingface.co'
                : '当前使用 huggingface.co，点击切换 hf-mirror.com 国内镜像加速',
              className: `inline-flex h-6 shrink-0 items-center rounded border px-2 text-[10px] transition-colors ${
                isCnMirror
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`,
            },
            isCnMirror ? '镜像: HF-Mirror' : '源: HuggingFace',
          ),
        ),
      ),

      actionError
        ? h(
            'div',
            {
              className:
                'rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive break-words',
            },
            actionError,
          )
        : null,

      // Filter pills
      h(
        'div',
        { className: 'flex items-center justify-between gap-1' },
        h(
          'div',
          { className: 'inline-flex items-center gap-1' },
          [
            { id: 'recommended', label: '推荐' },
            { id: 'zh', label: '中文' },
            { id: 'all', label: `全部 (${models.length})` },
          ].map((f) =>
            h(
              'button',
              {
                key: f.id,
                type: 'button',
                onClick: () => setFilter(f.id),
                className: `h-5 rounded px-2 text-[10px] font-medium transition-colors ${
                  filter === f.id
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`,
              },
              f.label,
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void refresh(),
            className: 'text-[10px] text-muted-foreground hover:text-foreground',
          },
          loading ? '加载中…' : '刷新',
        ),
      ),

      // Curated GGUF model list
      h(
        'div',
        { className: 'flex max-h-52 flex-col gap-1.5 overflow-y-auto pr-0.5' },
        filteredModels.map((model) => {
          const dl = model.download;
          const isDownloading = dl && dl.status === 'downloading';
          const isVerifying = dl && dl.status === 'verifying';
          const isActiveLocal =
            cfg.providerProtocol === 'local-model' && cfg.localModelId === model.id;

          return h(
            'div',
            {
              key: model.id,
              className: `flex flex-col gap-1 rounded-md border p-2 ${
                isActiveLocal
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/60 bg-background'
              }`,
            },
            h(
              'div',
              { className: 'flex items-start justify-between gap-1.5' },
              h(
                'div',
                { className: 'min-w-0 flex-1' },
                h(
                  'div',
                  { className: 'flex items-center gap-1.5 flex-wrap' },
                  h(
                    'span',
                    { className: 'text-[11px] font-medium text-foreground truncate' },
                    model.name,
                  ),
                  h(
                    'span',
                    { className: 'text-[10px] tabular-nums text-muted-foreground' },
                    model.sizeLabel,
                  ),
                  isActiveLocal
                    ? h(
                        'span',
                        {
                          className:
                            'rounded bg-primary/15 px-1 py-0.5 text-[9px] font-medium text-primary',
                        },
                        '使用中',
                      )
                    : model.installed
                      ? h(
                          'span',
                          {
                            className:
                              'rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground',
                          },
                          model.linkedFrom ? '已链接' : '已安装',
                        )
                      : null,
                ),
                h(
                  'p',
                  { className: 'mt-0.5 line-clamp-1 text-[10px] text-muted-foreground' },
                  model.description,
                ),
              ),
              h(
                'div',
                { className: 'flex shrink-0 items-center gap-1' },
                isDownloading || isVerifying
                  ? h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => void handleCancelDownload(model.id),
                        className:
                          'rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground',
                      },
                      '取消',
                    )
                  : model.installed
                    ? [
                        !isActiveLocal
                          ? h(
                              'button',
                              {
                                key: 'use',
                                type: 'button',
                                onClick: () => handleActivateModel(model.id),
                                className:
                                  'rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/25',
                              },
                              '启用',
                            )
                          : null,
                        h(
                          'button',
                          {
                            key: 'del',
                            type: 'button',
                            disabled: busyId === model.id,
                            title: model.linkedFrom
                              ? `仅移除链接，不删除源文件：${model.linkedFrom}`
                              : '删除本地模型文件释放磁盘空间',
                            onClick: () => void handleRemove(model.id),
                            className:
                              'rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
                          },
                          '删除',
                        ),
                      ]
                    : h(
                        'button',
                        {
                          type: 'button',
                          disabled: busyId === model.id,
                          onClick: () => void handleDownload(model.id),
                          className:
                            'rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50',
                        },
                        '下载',
                      ),
              ),
            ),

            // Progress bar during download / SHA-256 verification
            isDownloading || isVerifying
              ? h(
                  'div',
                  { className: 'flex flex-col gap-0.5 pt-0.5' },
                  h(
                    'div',
                    { className: 'h-1.5 w-full overflow-hidden rounded-full bg-muted' },
                    h('div', {
                      className: `h-full bg-primary transition-all duration-150 ${
                        isVerifying ? 'animate-pulse' : ''
                      }`,
                      style: { width: `${dl.percent || 0}%` },
                    }),
                  ),
                  h(
                    'div',
                    {
                      className:
                        'flex items-center justify-between text-[10px] tabular-nums text-muted-foreground',
                    },
                    h(
                      'span',
                      null,
                      isVerifying
                        ? 'SHA-256 完整性校验中…'
                        : `${dl.percent || 0}% · ${formatBytes(dl.downloadedBytes)} / ${formatBytes(dl.totalBytes)}`,
                    ),
                    dl.speedBps > 0
                      ? h('span', null, `${formatBytes(dl.speedBps)}/s`)
                      : null,
                  ),
                )
              : null,

            dl && dl.status === 'error' && dl.error
              ? h(
                  'span',
                  { className: 'text-[10px] text-destructive break-words' },
                  dl.error,
                )
              : null,
          );
        }),
      ),

      // Zero-copy link/import bar for existing local models (HF cache / T3 Code / custom folder)
      h(
        'div',
        { className: 'flex flex-col gap-1 border-t border-border/50 pt-1.5' },
        h(
          'div',
          { className: 'flex items-center gap-1' },
          h('input', {
            type: 'text',
            value: linkPath,
            onChange: (e) => setLinkPath(e.target.value),
            placeholder: '粘贴本地 GGUF 目录或文件路径（零拷贝链接）',
            className:
              'h-6 flex-1 rounded border border-border bg-background px-2 text-[10px] text-foreground placeholder:text-muted-foreground outline-none focus:border-primary',
          }),
          h(
            'button',
            {
              type: 'button',
              disabled: !linkPath.trim() || busyId === '__link__',
              onClick: () => void handleLinkSource(),
              className:
                'inline-flex h-6 shrink-0 items-center rounded border border-border px-2 text-[10px] hover:bg-accent disabled:opacity-40',
            },
            busyId === '__link__' ? '扫描中…' : '扫描链接',
          ),
        ),
        linkNotice
          ? h('span', { className: 'text-[10px] text-primary' }, linkNotice)
          : null,
      ),
    );
  };
}

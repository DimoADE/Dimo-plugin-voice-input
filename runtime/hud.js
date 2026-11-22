/**
 * Floating Translucent Frosted-Glass HUD Controller:
 * - Preserves stable `[cancelBtn, waveContainer, confirmBtn]` children[0..2] DOM structure
 *   across rapid waveform updates and persists dragged position (`dimo.voice-input.hud-position`).
 * - Adds live phase/timer indicator (`tabular-nums`), live streaming caption pill,
 *   "跳过润色" skip button during `post-processing`, interactive Preview Comparison Card
 *   (cleaned vs raw toggle + edit + copy + insert) during `preview`, and actionable Error Card
 *   with Retry (using retained failed audio) / Settings buttons during `error`.
 */

export const VOICE_HUD_POSITION_STORAGE_KEY = 'dimo.voice-input.hud-position';

function loadPersistedHudPosition() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VOICE_HUD_POSITION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed.left === 'number' &&
          Number.isFinite(parsed.left) &&
          typeof parsed.top === 'number' &&
          Number.isFinite(parsed.top)
        ) {
          return { left: parsed.left, top: parsed.top };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function savePersistedHudPosition(pos) {
  try {
    if (
      typeof localStorage !== 'undefined' &&
      pos &&
      typeof pos.left === 'number' &&
      typeof pos.top === 'number'
    ) {
      localStorage.setItem(
        VOICE_HUD_POSITION_STORAGE_KEY,
        JSON.stringify({
          left: Math.round(pos.left),
          top: Math.round(pos.top),
        }),
      );
    }
  } catch {
    // ignore
  }
}

function clampHudPosition(left, top, width = 180, height = 36) {
  const vw =
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280;
  const vh =
    typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(vw - width - margin, left)),
    top: Math.max(margin, Math.min(vh - height - margin, top)),
  };
}

export function createFloatingHudController(controller, options = {}) {
  const openPluginSettings =
    typeof options.openPluginSettings === 'function' ? options.openPluginSettings : () => {};

  let hudRoot = null;
  let hudCancelBtn = null;
  let hudWaveContainer = null;
  let hudWaveBars = [];
  let hudPhaseLabel = null;
  let hudConfirmBtn = null;
  let hudSkipBtn = null;
  let hudCaptionChip = null;
  let hudDragCleanup = null;

  // Separate anchored panel for `preview` and `error` states so capsule remains lightweight
  let hudOverlayCard = null;
  let hudOverlayMode = null; // 'preview' | 'error' | null
  let previewTextarea = null;
  let previewCleanedTab = null;
  let previewRawTab = null;
  let previewMetaLabel = null;
  let errorTextEl = null;
  let errorRetryBtn = null;
  let errorSettingsBtn = null;

  const accentColor = 'var(--color-accent, hsl(var(--primary)))';
  const onAccentColor =
    'var(--color-on-accent, hsl(var(--primary-foreground, 0 0% 100%)))';
  const surfaceBg =
    'color-mix(in srgb, var(--surface-popover, rgba(24,24,27,0.84)) 82%, transparent)';
  const borderCol =
    'color-mix(in srgb, var(--color-accent, hsl(var(--primary))) 28%, rgba(255,255,255,0.16))';

  const applyHudPositionStyle = (el) => {
    if (!el) return;
    const saved = loadPersistedHudPosition();
    if (saved) {
      const rect =
        typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect()
          : { width: 148, height: 34 };
      const clamped = clampHudPosition(
        saved.left,
        saved.top,
        rect.width || 148,
        rect.height || 34,
      );
      el.style.left = `${clamped.left}px`;
      el.style.top = `${clamped.top}px`;
      el.style.bottom = 'auto';
      el.style.transform = 'none';
    } else {
      el.style.left = '50%';
      el.style.top = 'auto';
      el.style.bottom = '72px';
      el.style.transform = 'translateX(-50%)';
    }
  };

  const destroyCapsule = () => {
    if (hudDragCleanup) {
      hudDragCleanup();
      hudDragCleanup = null;
    }
    if (hudRoot) {
      hudRoot.remove();
      hudRoot = null;
      hudCancelBtn = null;
      hudWaveContainer = null;
      hudWaveBars = [];
      hudPhaseLabel = null;
      hudConfirmBtn = null;
      hudSkipBtn = null;
      hudCaptionChip = null;
    }
  };

  const destroyOverlayCard = () => {
    if (hudOverlayCard) {
      hudOverlayCard.remove();
      hudOverlayCard = null;
      hudOverlayMode = null;
      previewTextarea = null;
      previewCleanedTab = null;
      previewRawTab = null;
      previewMetaLabel = null;
      errorTextEl = null;
      errorRetryBtn = null;
      errorSettingsBtn = null;
    }
  };

  const ensureCapsule = () => {
    if (hudRoot) return;
    hudRoot = document.createElement('div');
    hudRoot.setAttribute('data-dimo-voice-hud', 'true');
    hudRoot.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:72px',
      'transform:translateX(-50%)',
      'z-index:2147483000',
      'height:34px',
      'padding:0 8px',
      'border-radius:999px',
      `background:${surfaceBg}`,
      'color:var(--text-strong, #fafafa)',
      `border:1px solid ${borderCol}`,
      'box-shadow:0 8px 24px rgba(0,0,0,0.22)',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'gap:8px',
      'backdrop-filter:blur(16px) saturate(160%)',
      '-webkit-backdrop-filter:blur(16px) saturate(160%)',
      'user-select:none',
      'touch-action:none',
      'cursor:grab',
      'font-family:var(--font-sans, system-ui, sans-serif)',
    ].join(';');
    applyHudPositionStyle(hudRoot);

    // children[0]: Cancel button
    hudCancelBtn = document.createElement('button');
    hudCancelBtn.type = 'button';
    hudCancelBtn.setAttribute('aria-label', '取消语音输入');
    hudCancelBtn.setAttribute('data-testid', 'voice-hud-cancel');
    hudCancelBtn.style.cssText = [
      'width:22px',
      'height:22px',
      'border-radius:999px',
      'border:none',
      'background:color-mix(in srgb, var(--text-strong, #fafafa) 10%, transparent)',
      'color:var(--text-muted, rgba(161,161,170,0.95))',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'padding:0',
      'flex-shrink:0',
      'transition:background 0.15s ease, color 0.15s ease',
    ].join(';');
    hudCancelBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    hudCancelBtn.onpointerdown = (ev) => ev.stopPropagation();
    hudCancelBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      controller.cancelRecording();
    };

    // children[1]: Waveform container (contains bars + inline phase/timer label)
    hudWaveContainer = document.createElement('div');
    hudWaveContainer.setAttribute('data-testid', 'voice-hud-waveform');
    hudWaveContainer.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'gap:2.5px',
      'height:18px',
      'padding:0 4px',
      'cursor:grab',
    ].join(';');

    hudWaveBars = Array.from({ length: 10 }, () => {
      const bar = document.createElement('span');
      bar.style.cssText = [
        'width:2.5px',
        'height:4px',
        'border-radius:999px',
        `background:${accentColor}`,
        'transition:height 75ms ease',
        'pointer-events:none',
      ].join(';');
      hudWaveContainer.appendChild(bar);
      return bar;
    });

    hudPhaseLabel = document.createElement('span');
    hudPhaseLabel.setAttribute('data-testid', 'voice-hud-phase');
    hudPhaseLabel.style.cssText = [
      'margin-left:6px',
      'font-size:11px',
      'font-weight:500',
      'font-variant-numeric:tabular-nums',
      'color:var(--text-muted, rgba(212,212,216,0.9))',
      'white-space:nowrap',
      'pointer-events:none',
    ].join(';');
    hudWaveContainer.appendChild(hudPhaseLabel);

    // children[2]: Confirm button (contrast-safe on-accent color)
    hudConfirmBtn = document.createElement('button');
    hudConfirmBtn.type = 'button';
    hudConfirmBtn.setAttribute('aria-label', '完成语音输入');
    hudConfirmBtn.setAttribute('data-testid', 'voice-hud-confirm');
    hudConfirmBtn.style.cssText = [
      'width:22px',
      'height:22px',
      'border-radius:999px',
      'border:none',
      `background:${accentColor}`,
      `color:${onAccentColor}`,
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'cursor:pointer',
      'padding:0',
      'flex-shrink:0',
      'transition:opacity 0.15s ease, transform 0.15s ease',
    ].join(';');
    hudConfirmBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    hudConfirmBtn.onpointerdown = (ev) => ev.stopPropagation();
    hudConfirmBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (controller.state === 'recording') {
        void controller.stopRecording();
      } else if (controller.state === 'preview') {
        void controller.commitPreview(false);
      }
    };

    // Optional skip-cleanup pill (shown only during `post-processing`)
    hudSkipBtn = document.createElement('button');
    hudSkipBtn.type = 'button';
    hudSkipBtn.setAttribute('data-testid', 'voice-hud-skip-cleanup');
    hudSkipBtn.textContent = '跳过润色';
    hudSkipBtn.style.cssText = [
      'display:none',
      'height:22px',
      'padding:0 8px',
      'border-radius:999px',
      'border:1px solid rgba(255,255,255,0.18)',
      'background:transparent',
      'color:var(--text-strong, #fafafa)',
      'font-size:11px',
      'font-weight:500',
      'cursor:pointer',
      'white-space:nowrap',
      'flex-shrink:0',
    ].join(';');
    hudSkipBtn.onpointerdown = (ev) => ev.stopPropagation();
    hudSkipBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      controller.skipPostProcessing();
    };

    // Live caption chip floating cleanly above the capsule when live text is present
    hudCaptionChip = document.createElement('div');
    hudCaptionChip.setAttribute('data-testid', 'voice-hud-caption');
    hudCaptionChip.style.cssText = [
      'display:none',
      'position:absolute',
      'bottom:42px',
      'left:50%',
      'transform:translateX(-50%)',
      'max-width:340px',
      'padding:5px 10px',
      'border-radius:10px',
      `background:${surfaceBg}`,
      `border:1px solid ${borderCol}`,
      'color:var(--text-strong, #fafafa)',
      'font-size:12px',
      'line-height:1.4',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'box-shadow:0 6px 20px rgba(0,0,0,0.2)',
      'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)',
      'pointer-events:none',
    ].join(';');

    // Drag-to-move handling
    let dragState = null;
    const onPointerMove = (ev) => {
      if (!dragState || !hudRoot) return;
      const dx = ev.clientX - dragState.startX;
      const dy = ev.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 3) return;
      dragState.moved = true;
      const clamped = clampHudPosition(
        dragState.initialLeft + dx,
        dragState.initialTop + dy,
        dragState.width,
        dragState.height,
      );
      dragState.currentLeft = clamped.left;
      dragState.currentTop = clamped.top;
      hudRoot.style.left = `${clamped.left}px`;
      hudRoot.style.top = `${clamped.top}px`;
      hudRoot.style.bottom = 'auto';
      hudRoot.style.transform = 'none';
    };
    const stopDrag = () => {
      if (!dragState) return;
      const finished = dragState;
      dragState = null;
      if (hudRoot) hudRoot.style.cursor = 'grab';
      if (hudWaveContainer) hudWaveContainer.style.cursor = 'grab';
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', stopDrag);
        window.removeEventListener('pointercancel', stopDrag);
      }
      if (finished.moved) {
        savePersistedHudPosition({
          left: finished.currentLeft,
          top: finished.currentTop,
        });
      }
    };
    hudDragCleanup = stopDrag;

    hudRoot.onpointerdown = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const target = ev.target;
      if (target && typeof target.closest === 'function' && target.closest('button')) {
        return;
      }
      ev.preventDefault();
      const rect =
        typeof hudRoot.getBoundingClientRect === 'function'
          ? hudRoot.getBoundingClientRect()
          : {
              left: parseFloat(hudRoot.style.left) || 200,
              top: parseFloat(hudRoot.style.top) || 500,
              width: 148,
              height: 34,
            };
      const initialLeft = Number.isFinite(rect.left) ? rect.left : 200;
      const initialTop = Number.isFinite(rect.top) ? rect.top : 500;
      dragState = {
        startX: ev.clientX,
        startY: ev.clientY,
        initialLeft,
        initialTop,
        currentLeft: initialLeft,
        currentTop: initialTop,
        width: rect.width || 148,
        height: rect.height || 34,
        moved: false,
      };
      hudRoot.style.cursor = 'grabbing';
      if (hudWaveContainer) hudWaveContainer.style.cursor = 'grabbing';
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopDrag);
        window.addEventListener('pointercancel', stopDrag);
      }
    };

    hudRoot.append(hudCancelBtn, hudWaveContainer, hudConfirmBtn, hudSkipBtn, hudCaptionChip);
    document.body.appendChild(hudRoot);
  };

  const renderPreviewCard = (snap) => {
    if (hudOverlayMode !== 'preview') {
      destroyOverlayCard();
      hudOverlayMode = 'preview';
      hudOverlayCard = document.createElement('div');
      hudOverlayCard.setAttribute('data-dimo-voice-hud', 'true');
      hudOverlayCard.setAttribute('data-testid', 'voice-hud-preview');
      hudOverlayCard.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:76px',
        'transform:translateX(-50%)',
        'z-index:2147483001',
        'width:min(440px, calc(100vw - 24px))',
        'padding:12px',
        'border-radius:14px',
        `background:${surfaceBg}`,
        'color:var(--text-strong, #fafafa)',
        `border:1px solid ${borderCol}`,
        'box-shadow:0 16px 40px rgba(0,0,0,0.32)',
        'backdrop-filter:blur(18px) saturate(160%)',
        '-webkit-backdrop-filter:blur(18px) saturate(160%)',
        'display:flex',
        'flex-direction:column',
        'gap:10px',
        'font-family:var(--font-sans, system-ui, sans-serif)',
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

      const tabsWrap = document.createElement('div');
      tabsWrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';

      const makeTabBtn = (label, variant, testId) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-testid', testId);
        btn.textContent = label;
        btn.style.cssText =
          'height:24px;padding:0 10px;border-radius:7px;border:none;font-size:12px;font-weight:500;cursor:pointer;';
        btn.onclick = (ev) => {
          ev.preventDefault();
          const draft = controller.previewDraft;
          if (!draft) return;
          const nextText = variant === 'raw' ? draft.rawText : draft.cleanedText;
          controller.updatePreviewText(nextText, variant);
        };
        return btn;
      };

      previewCleanedTab = makeTabBtn('润色版', 'cleaned', 'voice-preview-tab-cleaned');
      previewRawTab = makeTabBtn('原始识别', 'raw', 'voice-preview-tab-raw');
      tabsWrap.append(previewCleanedTab, previewRawTab);

      previewMetaLabel = document.createElement('span');
      previewMetaLabel.style.cssText =
        'font-size:11px;color:var(--text-muted, rgba(161,161,170,0.9));font-variant-numeric:tabular-nums;';
      header.append(tabsWrap, previewMetaLabel);

      previewTextarea = document.createElement('textarea');
      previewTextarea.setAttribute('data-testid', 'voice-preview-textarea');
      previewTextarea.rows = 3;
      previewTextarea.style.cssText = [
        'width:100%',
        'box-sizing:border-box',
        'padding:8px 10px',
        'border-radius:8px',
        'border:1px solid rgba(255,255,255,0.14)',
        'background:color-mix(in srgb, var(--surface-canvas, #09090b) 55%, transparent)',
        'color:var(--text-strong, #fafafa)',
        'font-size:13px',
        'line-height:1.5',
        'resize:vertical',
        'outline:none',
      ].join(';');
      previewTextarea.oninput = (ev) => {
        controller.updatePreviewText(ev.target.value);
      };

      const footer = document.createElement('div');
      footer.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

      const leftActions = document.createElement('div');
      leftActions.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.setAttribute('data-testid', 'voice-preview-cancel');
      cancelBtn.textContent = '取消 (Esc)';
      cancelBtn.style.cssText =
        'height:28px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:var(--text-muted, #a1a1aa);font-size:12px;cursor:pointer;';
      cancelBtn.onclick = () => controller.cancelPreview();

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.setAttribute('data-testid', 'voice-preview-copy');
      copyBtn.textContent = '复制';
      copyBtn.style.cssText =
        'height:28px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.14);background:transparent;color:var(--text-strong, #fafafa);font-size:12px;cursor:pointer;';
      copyBtn.onclick = () => {
        const txt = controller.previewDraft?.editedText || '';
        if (txt && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(txt).catch(() => {});
        }
      };
      leftActions.append(cancelBtn, copyBtn);

      const rightActions = document.createElement('div');
      rightActions.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';

      const insertRawBtn = document.createElement('button');
      insertRawBtn.type = 'button';
      insertRawBtn.setAttribute('data-testid', 'voice-preview-insert-raw');
      insertRawBtn.textContent = '插入原文';
      insertRawBtn.style.cssText =
        'height:28px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:var(--text-strong, #fafafa);font-size:12px;cursor:pointer;';
      insertRawBtn.onclick = () => void controller.commitPreview(true);

      const insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.setAttribute('data-testid', 'voice-preview-confirm');
      insertBtn.textContent = '确认插入 (Enter)';
      insertBtn.style.cssText = [
        'height:28px',
        'padding:0 12px',
        'border-radius:7px',
        'border:none',
        `background:${accentColor}`,
        `color:${onAccentColor}`,
        'font-size:12px',
        'font-weight:500',
        'cursor:pointer',
      ].join(';');
      insertBtn.onclick = () => void controller.commitPreview(false);

      rightActions.append(insertRawBtn, insertBtn);
      footer.append(leftActions, rightActions);
      hudOverlayCard.append(header, previewTextarea, footer);
      document.body.appendChild(hudOverlayCard);
    }

    const draft = snap.previewDraft;
    if (!draft) return;
    if (previewTextarea && previewTextarea.value !== draft.editedText) {
      previewTextarea.value = draft.editedText || '';
    }
    if (previewCleanedTab && previewRawTab) {
      const isRaw = draft.activeVariant === 'raw';
      previewCleanedTab.style.background = isRaw ? 'transparent' : accentColor;
      previewCleanedTab.style.color = isRaw ? 'var(--text-muted, #a1a1aa)' : onAccentColor;
      previewRawTab.style.background = isRaw ? accentColor : 'transparent';
      previewRawTab.style.color = isRaw ? onAccentColor : 'var(--text-muted, #a1a1aa)';
    }
    if (previewMetaLabel) {
      const ms = draft.latencyMs ? `${draft.latencyMs}ms` : '';
      previewMetaLabel.textContent = [draft.provider, draft.usedLlm ? 'LLM 润色' : '', ms]
        .filter(Boolean)
        .join(' · ');
    }
  };

  const renderErrorCard = (snap) => {
    if (hudOverlayMode !== 'error') {
      destroyOverlayCard();
      hudOverlayMode = 'error';
      hudOverlayCard = document.createElement('div');
      hudOverlayCard.setAttribute('data-dimo-voice-hud', 'true');
      hudOverlayCard.setAttribute('data-testid', 'voice-hud-error');
      hudOverlayCard.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:76px',
        'transform:translateX(-50%)',
        'z-index:2147483001',
        'max-width:420px',
        'padding:10px 12px',
        'border-radius:12px',
        `background:${surfaceBg}`,
        'color:var(--text-strong, #fafafa)',
        'border:1px solid rgba(239,68,68,0.45)',
        'box-shadow:0 12px 32px rgba(0,0,0,0.28)',
        'backdrop-filter:blur(16px)',
        '-webkit-backdrop-filter:blur(16px)',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'font-family:var(--font-sans, system-ui, sans-serif)',
      ].join(';');

      errorTextEl = document.createElement('span');
      errorTextEl.style.cssText = 'font-size:12px;line-height:1.4;flex:1;';

      errorRetryBtn = document.createElement('button');
      errorRetryBtn.type = 'button';
      errorRetryBtn.setAttribute('data-testid', 'voice-hud-retry');
      errorRetryBtn.textContent = '重试';
      errorRetryBtn.style.cssText = [
        'height:26px',
        'padding:0 10px',
        'border-radius:7px',
        'border:none',
        `background:${accentColor}`,
        `color:${onAccentColor}`,
        'font-size:12px',
        'font-weight:500',
        'cursor:pointer',
        'flex-shrink:0',
      ].join(';');
      errorRetryBtn.onclick = () => void controller.retryLastRecording();

      errorSettingsBtn = document.createElement('button');
      errorSettingsBtn.type = 'button';
      errorSettingsBtn.setAttribute('data-testid', 'voice-hud-settings');
      errorSettingsBtn.textContent = '设置';
      errorSettingsBtn.style.cssText =
        'height:26px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.18);background:transparent;color:var(--text-strong, #fafafa);font-size:12px;cursor:pointer;flex-shrink:0;';
      errorSettingsBtn.onclick = () => {
        openPluginSettings();
        controller.cancelRecording();
      };

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', '关闭错误提示');
      closeBtn.setAttribute('data-testid', 'voice-hud-error-close');
      closeBtn.textContent = '×';
      closeBtn.style.cssText =
        'width:22px;height:22px;border-radius:999px;border:none;background:transparent;color:var(--text-muted, #a1a1aa);font-size:15px;cursor:pointer;flex-shrink:0;';
      closeBtn.onclick = () => controller.cancelRecording();

      hudOverlayCard.append(errorTextEl, errorRetryBtn, errorSettingsBtn, closeBtn);
      document.body.appendChild(hudOverlayCard);
    }

    if (errorTextEl) {
      errorTextEl.textContent = snap.lastError || '语音识别失败';
    }
    if (errorRetryBtn) {
      errorRetryBtn.textContent = snap.canRetry ? '重新转写' : '重试';
      errorRetryBtn.style.display = 'inline-flex';
    }
    if (errorSettingsBtn) {
      const showSettings = snap.errorAction === 'settings' || snap.errorAction === 'models';
      errorSettingsBtn.style.display = showSettings ? 'inline-flex' : 'none';
      errorSettingsBtn.textContent = snap.errorAction === 'models' ? '模型设置' : '设置';
    }
  };

  const render = (snap) => {
    if (typeof document === 'undefined' || !document.body) return;
    if (!snap.config.enabled || !snap.config.showFloatingHud) {
      destroyCapsule();
      destroyOverlayCard();
      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('[data-dimo-voice-hud]').forEach((n) => n.remove());
      }
      return;
    }

    if (snap.state === 'preview' && snap.previewDraft) {
      destroyCapsule();
      renderPreviewCard(snap);
      return;
    }

    if (snap.state === 'error' && snap.lastError) {
      destroyCapsule();
      renderErrorCard(snap);
      return;
    }

    destroyOverlayCard();

    const showCapsule =
      snap.state === 'preparing' ||
      snap.state === 'recording' ||
      snap.state === 'transcribing' ||
      snap.state === 'post-processing';

    if (!showCapsule) {
      destroyCapsule();
      if (typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('[data-dimo-voice-hud]').forEach((n) => n.remove());
      }
      return;
    }

    ensureCapsule();

    // Update waveform bars in-place without recreating button DOM nodes
    const levels =
      Array.isArray(snap.audioLevels) && snap.audioLevels.length > 0
        ? snap.audioLevels
        : [0.18, 0.28, 0.4, 0.55, 0.35, 0.25, 0.45, 0.3, 0.2, 0.16];
    const nowPhase = Date.now() / 180;
    hudWaveBars.forEach((bar, idx) => {
      const lvl = levels[idx] ?? 0.2;
      const effectiveLvl =
        snap.state === 'transcribing' || snap.state === 'post-processing' || snap.state === 'preparing'
          ? 0.22 + 0.36 * Math.abs(Math.sin(nowPhase + idx * 0.6))
          : lvl;
      const heightPx = Math.max(3, Math.min(16, Math.round(effectiveLvl * 16)));
      bar.style.height = `${heightPx}px`;
    });

    if (hudPhaseLabel) {
      if (snap.state === 'preparing') hudPhaseLabel.textContent = '准备中';
      else if (snap.state === 'recording') hudPhaseLabel.textContent = snap.durationLabel || '0:00';
      else if (snap.state === 'transcribing') hudPhaseLabel.textContent = '转写中';
      else if (snap.state === 'post-processing') hudPhaseLabel.textContent = '润色中';
      else hudPhaseLabel.textContent = '';
    }

    if (hudConfirmBtn) {
      const isBusy =
        snap.state === 'preparing' ||
        snap.state === 'transcribing' ||
        snap.state === 'post-processing';
      hudConfirmBtn.disabled = isBusy;
      hudConfirmBtn.style.cursor = isBusy ? 'wait' : 'pointer';
      hudConfirmBtn.style.opacity = isBusy ? '0.6' : '1';
      hudConfirmBtn.style.display =
        snap.state === 'post-processing' ? 'none' : 'inline-flex';
    }

    if (hudSkipBtn) {
      hudSkipBtn.style.display =
        snap.state === 'post-processing' ? 'inline-flex' : 'none';
    }

    if (hudCaptionChip) {
      const caption = String(snap.liveTranscript || '').trim();
      if (snap.state === 'recording' && caption) {
        hudCaptionChip.textContent = caption.length > 64 ? `…${caption.slice(-64)}` : caption;
        hudCaptionChip.style.display = 'block';
      } else {
        hudCaptionChip.style.display = 'none';
      }
    }
  };

  const dispose = () => {
    destroyCapsule();
    destroyOverlayCard();
  };

  return { render, dispose };
}

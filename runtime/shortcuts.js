/**
 * Dictation shortcut matching, formatting, and T3Code-inspired smart trigger state machine:
 * - `auto` mode: hold >= 300ms acts as push-to-talk (release stops & transcribes); quick tap acts as toggle!
 * - `push-to-talk` mode: press starts, release stops.
 * - `toggle` mode: tap toggles start/stop.
 * - IME composition guard, Escape cancel across all active phases, Enter preview confirm, and window blur safety.
 */

export const HOLD_THRESHOLD_MS = 300;

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function parseShortcut(shortcut = 'Alt+V') {
  const parts = String(shortcut || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const parsed = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: '',
  };

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') parsed.ctrl = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (lower === 'shift') parsed.shift = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') {
      parsed.meta = true;
    } else if (lower === 'space') {
      parsed.key = ' ';
    } else {
      parsed.key = lower;
    }
  }
  return parsed.key ? parsed : null;
}

export function doesEventMatchShortcut(event, shortcut = 'Alt+V') {
  if (!event) return false;
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;

  const eventKey = String(event.key || '').trim().toLowerCase();
  const code = String(event.code || '').trim();
  const codeLetter = code.startsWith('Key') ? code.slice(3).toLowerCase() : '';
  const codeDigit = code.startsWith('Digit') ? code.slice(5) : '';

  if (parsed.key === ' ') {
    return event.key === ' ' || code === 'Space';
  }
  return eventKey === parsed.key || codeLetter === parsed.key || codeDigit === parsed.key;
}

export function formatKeyboardEventToShortcut(event) {
  if (!event) return '';
  const rawKey = String(event.key || '');
  const lower = rawKey.toLowerCase();
  if (
    !rawKey ||
    lower === 'control' ||
    lower === 'alt' ||
    lower === 'shift' ||
    lower === 'meta' ||
    lower === 'dead' ||
    lower === 'process'
  ) {
    return '';
  }

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  let keyLabel = '';
  const code = String(event.code || '');
  if (rawKey === ' ' || code === 'Space') {
    keyLabel = 'Space';
  } else if (code.startsWith('Key') && code.length === 4) {
    keyLabel = code.slice(3).toUpperCase();
  } else if (code.startsWith('Digit') && code.length === 6) {
    keyLabel = code.slice(5);
  } else if (rawKey.length === 1) {
    keyLabel = rawKey.toUpperCase();
  } else {
    keyLabel = rawKey;
  }

  parts.push(keyLabel);
  return parts.join('+');
}

function isReleasedShortcutKey(event, shortcut) {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return true;
  const releasedKey = String(event.key || '').trim().toLowerCase();
  const code = String(event.code || '').trim();
  const codeLetter = code.startsWith('Key') ? code.slice(3).toLowerCase() : '';
  return (
    releasedKey === parsed.key ||
    codeLetter === parsed.key ||
    (parsed.alt && releasedKey === 'alt') ||
    (parsed.ctrl && releasedKey === 'control') ||
    (parsed.shift && releasedKey === 'shift') ||
    (parsed.meta && releasedKey === 'meta')
  );
}

export function createDictationShortcutHandler(controller, options = {}) {
  const now = options.now || (() => Date.now());
  const holdThresholdMs = options.holdThresholdMs ?? HOLD_THRESHOLD_MS;

  // Track press start for `auto` and `push-to-talk`
  let activePress = null; // { mode, startedAt, startedRecording }

  const onKeyDown = (event) => {
    const cfg = controller.config;
    if (!cfg?.enabled) return;

    // Ignore IME composition events so CJK input isn't hijacked
    if (event.isComposing || event.keyCode === 229) return;

    const state = controller.state;

    // Escape cancels any active dictation phase (preparing, recording, transcribing, post-processing, preview, error)
    if (event.key === 'Escape') {
      if (state === 'preview') {
        event.preventDefault?.();
        controller.cancelPreview();
        return;
      }
      if (
        state === 'preparing' ||
        state === 'recording' ||
        state === 'transcribing' ||
        state === 'post-processing' ||
        state === 'error'
      ) {
        event.preventDefault?.();
        controller.cancelRecording();
        activePress = null;
        return;
      }
    }

    // Enter confirms preview card (unless user pressed Shift+Enter for newline)
    if (state === 'preview' && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault?.();
      void controller.commitPreview(false);
      return;
    }

    if (!doesEventMatchShortcut(event, cfg.shortcut)) return;
    if (event.repeat) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    const mode = cfg.recordingMode || 'auto';
    if (mode === 'push-to-talk') {
      activePress = {
        mode: 'push-to-talk',
        startedAt: now(),
        startedRecording: state === 'idle' || state === 'error',
      };
      if (activePress.startedRecording) {
        void controller.startRecording();
      }
      return;
    }

    if (mode === 'auto') {
      if (state === 'recording' || state === 'preparing') {
        // Second tap stops toggle-started recording
        activePress = null;
        void controller.stopRecording();
        return;
      }
      if (state === 'idle' || state === 'error') {
        activePress = {
          mode: 'auto',
          startedAt: now(),
          startedRecording: true,
        };
        void controller.startRecording();
      }
      return;
    }

    // Explicit `toggle` mode
    void controller.toggleRecording();
  };

  const onKeyUp = (event) => {
    if (!activePress) return;
    const cfg = controller.config;
    if (!isReleasedShortcutKey(event, cfg.shortcut)) return;

    const press = activePress;
    activePress = null;

    if (press.mode === 'push-to-talk') {
      if (controller.state === 'recording' || controller.state === 'preparing') {
        void controller.stopRecording();
      }
      return;
    }

    if (press.mode === 'auto' && press.startedRecording) {
      const heldMs = now() - press.startedAt;
      if (heldMs >= holdThresholdMs) {
        // User held the key down -> treat as push-to-talk and stop on release!
        if (controller.state === 'recording' || controller.state === 'preparing') {
          void controller.stopRecording();
        }
      }
      // Otherwise (< 300ms quick tap) -> stay recording as toggle!
    }
  };

  const onBlur = () => {
    if (!activePress) return;
    const press = activePress;
    activePress = null;
    if (press.mode === 'push-to-talk' && controller.state === 'recording') {
      void controller.stopRecording();
    }
  };

  return {
    onKeyDown,
    onKeyUp,
    onBlur,
  };
}

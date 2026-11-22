import {
  DEFAULT_VOICE_CONFIG,
  PLUGIN_ID,
  normalizeVoiceConfig,
} from '../worker/config.mjs';
import { cleanTranscriptText } from '../worker/textProcessing.mjs';

export { DEFAULT_VOICE_CONFIG, PLUGIN_ID, cleanTranscriptText, normalizeVoiceConfig };

const LATIN_OR_DIGIT_END = /[A-Za-z0-9]$/;
const LATIN_OR_DIGIT_START = /^[A-Za-z0-9]/;

/**
 * Smart boundary spacing when inserting dictated text into an existing draft.
 * Inserts a space between adjacent Latin/digit tokens, while respecting CJK scripts
 * and existing whitespace/punctuation.
 */
export function formatTranscriptInsertion(text, context = null) {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return '';
  if (!context || typeof context !== 'object') return clean;

  const before = typeof context.before === 'string' ? context.before : '';
  const after = typeof context.after === 'string' ? context.after : '';

  const needsLeadingSpace =
    before.length > 0 &&
    LATIN_OR_DIGIT_END.test(before) &&
    LATIN_OR_DIGIT_START.test(clean);
  const needsTrailingSpace =
    after.length > 0 &&
    LATIN_OR_DIGIT_END.test(clean) &&
    LATIN_OR_DIGIT_START.test(after);

  return `${needsLeadingSpace ? ' ' : ''}${clean}${needsTrailingSpace ? ' ' : ''}`;
}

/**
 * Capture up to ~500 chars around the active cursor in Monaco editor or DOM composer
 * so LLM post-processing understands domain context and never duplicates surrounding text.
 */
export function readComposerDraftContext(getEditorBridge) {
  // 1. Focused Monaco editor
  try {
    const bridge = typeof getEditorBridge === 'function' ? getEditorBridge() : null;
    const editor =
      bridge && typeof bridge.getActiveEditor === 'function'
        ? bridge.getActiveEditor()
        : null;
    if (editor && typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()) {
      const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
      const selection = typeof editor.getSelection === 'function' ? editor.getSelection() : null;
      if (model && selection && typeof model.getValueInRange === 'function') {
        const startLine = Math.max(1, selection.startLineNumber - 6);
        const endLine = Math.min(model.getLineCount(), selection.endLineNumber + 6);
        const before = model
          .getValueInRange({
            startLineNumber: startLine,
            startColumn: 1,
            endLineNumber: selection.startLineNumber,
            endColumn: selection.startColumn,
          })
          .slice(-400);
        const selected = model.getValueInRange(selection).slice(0, 200);
        const after = model
          .getValueInRange({
            startLineNumber: selection.endLineNumber,
            startColumn: selection.endColumn,
            endLineNumber: endLine,
            endColumn: model.getLineMaxColumn(endLine),
          })
          .slice(0, 300);
        return { source: 'monaco-editor', before, selection: selected, after };
      }
    }
  } catch {
    // ignore editor read errors
  }

  // 2. Active DOM textarea / input / contenteditable
  try {
    if (typeof document !== 'undefined') {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'TEXTAREA' ||
          (active.tagName === 'INPUT' &&
            /^(text|search|url|email)$/i.test(active.type || 'text')))
      ) {
        const val = String(active.value || '');
        const start = typeof active.selectionStart === 'number' ? active.selectionStart : val.length;
        const end = typeof active.selectionEnd === 'number' ? active.selectionEnd : start;
        return {
          source: 'dom-input',
          before: val.slice(Math.max(0, start - 400), start),
          selection: val.slice(start, Math.min(val.length, end)).slice(0, 200),
          after: val.slice(end, end + 300),
        };
      }
      if (active && active.isContentEditable) {
        const text = String(active.textContent || '');
        return {
          source: 'dom-contenteditable',
          before: text.slice(-400),
          selection: '',
          after: '',
        };
      }
    }
  } catch {
    // ignore DOM read errors
  }

  return null;
}

---
name: voice-input
description: Configure and operate the Dimo AI voice dictation and speech-to-text plugin (dimo.voice-input), including local offline GGUF models (transcribe.cpp), multi-provider cloud STT, custom alias vocabulary, VAD silence filtering, and draft-aware transcript cleanup.
---

# Voice Input Skill

Use this skill when the user asks to configure, install local models for, troubleshoot, or invoke AI voice input in Dimo.

## Capabilities

- **Core Handlers**: `voice.status`, `voice.toggle`, `voice.transcribe`, `voice.cleanup`, `voice.configure`, `voice.cancel`, `voice.history`.
- **Local Model Handlers**: `voice.local.models`, `voice.local.download`, `voice.local.cancelDownload`, `voice.local.remove`, `voice.local.link`, `voice.local.installEngine`, `voice.local.unload`.
- **Protocols**: `hybrid`, `local-model` (offline GGUF via managed `transcribe-cpp` isolated child process + optional `whisper-cli` fallback), `openai-whisper`, `groq-whisper`, `xai-stt`, `openrouter-stt`, `openai-chat-audio`, `custom-openai` (unauthenticated localhost servers), and `browser-speech`.
- **Local Models**: 12 curated SHA-256 verified GGUF models (default `handy-computer/SenseVoiceSmall-gguf` for fast CN/EN dictation; also `Qwen3-ASR-0.6B/1.7B`, `whisper-large-v3-turbo`, `Fun-ASR`, `parakeet`, `nemotron`, `canary`). Supports HTTP Range resume, `hf-mirror.com` mirror acceleration, and zero-copy symlink/hardlink reuse of existing copies from `~/.cache/huggingface/hub`, `~/.t3/userdata/speech/models`, or user directories.
- **Trigger Modes**: `auto` (tap to toggle, hold >= 300ms for push-to-talk), `toggle`, `push-to-talk`.
- **Vocabulary & Cleanup**: Supports plain terms and explicit alias rules (`Dimo = vibe x | vibex`), Soundex/Levenshtein fuzzy correction, hyphen-safe filler removal, `correctionCue` self-correction handling, and skippable draft-context LLM cleanup.

## Guidance

1. Inspect readiness with `voice.status` and `voice.local.models` before changing settings.
2. For offline privacy setups, switch `providerProtocol` to `local-model`, ensure the engine is installed (`voice.local.installEngine`), and download or zero-copy link a curated GGUF model (`voice.local.download` / `voice.local.link`).
3. For users in mainland China experiencing slow HuggingFace downloads, set `hfMirrorUrl` to `https://hf-mirror.com`.
4. When adding project jargon to `vocabulary`, preserve existing tokens and optionally include aliases (`Canonical = spoken alias`).
5. Direct users to the status bar voice popover's **本地模型** tab to monitor download progress or **设备测试** tab to test microphones without cloud upload.

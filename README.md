---
summary: AI 语音输入与智能听写：支持本地离线 GGUF 模型一键安装推理（transcribe.cpp）、FIR 降采样、VAD 静音裁剪、多云端协议、热词别名纠错、草稿上下文润色及交互预览。
---

# 语音输入 (`dimo.voice-input`)

为 Dimo 会话输入框与 Monaco 代码编辑器提供低延迟、高准确率的 AI 语音听写与听写后智能润色体验，完整支持纯本地离线模型与云端多协议。

## 核心能力

- **本地离线模型套件 (`local-model`)**：内置 12 个经过 SHA-256 完整性校验的 GGUF 语音模型目录（SenseVoice Small、Qwen3-ASR 0.6B/1.7B、Whisper Large v3 Turbo/Medium/Small/Base/Tiny、Fun-ASR、Parakeet、Nemotron、Canary）；支持按需安装 `transcribe.cpp` 隔离推理子进程、断点续传下载与 `HF-Mirror` 镜像加速、自动复用并零拷贝链接本机 HuggingFace / T3 Code / Handy 缓存模型，以及空闲自动卸载释放内存/显存。
- **多云端与原生协议**：支持 `hybrid`（浏览器流式字幕 + 云端 Whisper）、`openai-whisper`、`groq-whisper`、`xai-stt`（Grok STT）、`openrouter-stt`、`openai-chat-audio`、`custom-openai`（兼容本地 `whisper.cpp` / `faster-whisper` 免 Key 调用）以及 `browser-speech`。
- **高质量音频采集与 VAD**：基于 AudioWorklet 与 63-tap Blackman 窗低通 FIR 重采样至 16 kHz 单声道 WAV；内置静音检测与首尾裁剪，减少延迟与静音幻觉。
- **智能触发与可靠恢复**：默认 `auto` 触发模式（轻按切换、长按 ≥300ms 松开即转写）；支持 5 分钟录音上限、失败音频保留重试（无需重说）、润色阶段一键跳过与交互式「润色 vs 原文」对照预览卡片。
- **术语词典与上下文润色**：热词表支持普通术语及显式别名映射（如 `Dimo = vibe x | vibex`），结合 Soundex + 编辑距离模糊纠错、连字符安全去口水词、口头改口词（`correctionCue`）与输入框上下文 LLM 润色。
- **设备管理与本地诊断**：状态栏面板内置「本地模型」管理页、真实麦克风下拉与回退优先级排序、10 秒本地回放试音（不上传）、隔离识别引擎测试及最近 15 条听写历史一键复用。

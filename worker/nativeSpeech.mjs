import { execFile } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { stripBase64DataUrlPrefix } from './audio.mjs';

const execFileAsync = promisify(execFile);

/**
 * Offline Windows System.Speech WAV recognizer fallback (zero API key required).
 * Safely returns empty string on non-Windows hosts or when no recognizer pack is installed.
 */
export async function transcribeWavWithWindowsSpeech(wavBase64, language = 'auto') {
  if (process.platform !== 'win32') return '';
  const cleanB64 = stripBase64DataUrlPrefix(wavBase64);
  if (!cleanB64) return '';

  const tmpPath = join(
    tmpdir(),
    `dimo-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
  );

  try {
    writeFileSync(tmpPath, Buffer.from(cleanB64, 'base64'));
    const cultureHint =
      language === 'zh'
        ? 'zh-CN'
        : language === 'en'
          ? 'en-US'
          : language === 'ja'
            ? 'ja-JP'
            : language === 'ko'
              ? 'ko-KR'
              : language === 'de'
                ? 'de-DE'
                : language === 'fr'
                  ? 'fr-FR'
                  : language === 'es'
                    ? 'es-ES'
                    : '';

    const psScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if (-not $installed -or $installed.Count -eq 0) { exit 0 }
$preferred = '${cultureHint}'
$chosen = $null
if ($preferred -ne '') {
  $chosen = $installed | Where-Object { $_.Culture.Name -ieq $preferred -or $_.Culture.TwoLetterISOLanguageName -ieq $preferred.Split('-')[0] } | Select-Object -First 1
}
if (-not $chosen) {
  $chosen = $installed | Where-Object { $_.Culture.Name -ieq [System.Globalization.CultureInfo]::CurrentUICulture.Name } | Select-Object -First 1
}
if (-not $chosen) {
  $chosen = $installed | Select-Object -First 1
}
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($chosen)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($args[0])
$parts = New-Object System.Collections.Generic.List[string]
while ($true) {
  $res = $engine.Recognize()
  if ($null -eq $res) { break }
  if ($res.Text -and $res.Text.Trim().Length -gt 0) {
    $parts.Add($res.Text.Trim())
  }
}
$engine.Dispose()
Write-Output ($parts -join ' ')
`;

    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
        tmpPath,
      ],
      {
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    return String(stdout || '').trim();
  } catch {
    return '';
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore temp cleanup failure
    }
  }
}

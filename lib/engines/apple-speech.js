import { HOST, SidecarEngine } from './sidecar.js';

/**
 * Apple's on-device speech recognition (macOS 26 SpeechAnalyzer), run by native/apple-speech/AppleSpeechServer.swift
 * as a small local HTTP server. macOS downloads and keeps the language model itself; nothing leaves the Mac.
 */
export class AppleSpeechEngine extends SidecarEngine {
  supportsPrompt = false;

  constructor({ bin, language, module, onCrash }) {
    super({ onCrash });
    Object.assign(this, { bin, language, module });
  }

  command(port) {
    return {
      name: 'apple-speech',
      bin: this.bin,
      args: ['--host', HOST, '--port', String(port), '--locale', this.language, '--module', this.module],
      missing: 'The Apple speech helper is not built. Run: npm run setup -- apple-dictation',
    };
  }

  async transcribe(samples) {
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength); // float32 PCM, 16 kHz mono
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`apple-speech: ${json.error ?? res.status}`);
    return { text: json.text ?? '' };
  }
}

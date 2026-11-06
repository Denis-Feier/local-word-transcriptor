// @ts-check
import { HOST, SidecarEngine } from './sidecar.js';
/** @import { OnCrash, SidecarCommand, TranscribeResult } from '../../types/engine.ts' */

/**
 * Apple's on-device speech recognition (macOS 26 SpeechAnalyzer), run by native/apple-speech/AppleSpeechServer.swift
 * as a small local HTTP server. macOS downloads and keeps the language model itself; nothing leaves the Mac.
 */
export class AppleSpeechEngine extends SidecarEngine {
  supportsPrompt = false;
  defaultDevice = 'the chip macOS picks'; // SpeechAnalyzer chooses the Neural Engine, GPU or CPU itself

  /** @param {{ bin: string, language: string, module: string, preset?: string, onCrash?: OnCrash }} opts */
  constructor({ bin, language, module, preset = 'long', onCrash }) {
    super({ onCrash });
    this.bin = bin;
    this.language = language;
    this.module = module;
    this.preset = preset;
  }

  /**
   * @param {number} port
   * @returns {SidecarCommand}
   */
  command(port) {
    return {
      name: 'apple-speech',
      bin: this.bin,
      args: ['--host', HOST, '--port', String(port), '--locale', this.language, '--module', this.module, '--preset', this.preset],
      missing: 'The Apple speech helper is not built. Run: npm run setup -- apple-dictation',
    };
  }

  /**
   * @param {Float32Array} samples
   * @returns {Promise<TranscribeResult>}
   */
  async transcribe(samples) {
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength); // float32 PCM, 16 kHz mono
    const res = await this.post('/inference', { body, headers: { 'Content-Type': 'application/octet-stream' } });
    const json = JSON.parse(res.text);
    if (!res.ok || json.error) throw new Error(`apple-speech: ${json.error ?? res.status}`);
    return { text: json.text ?? '' };
  }
}

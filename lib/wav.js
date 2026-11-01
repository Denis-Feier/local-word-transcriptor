import fs from 'node:fs';

export const SAMPLE_RATE = 16000;

function writeHeader(buf, dataBytes, sampleRate) {
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
}

function writePcm16(buf, samples, offset) {
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), offset + i * 2);
  }
}

/** Float32 mono samples (-1..1) -> 16-bit PCM WAV file buffer. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  writeHeader(buf, samples.length * 2, sampleRate);
  writePcm16(buf, samples, 44);
  return buf;
}

/**
 * Appends audio to a new WAV file; the header is rewritten after every chunk so the file is always playable.
 * A file that already exists is never overwritten: opening it fails with EEXIST.
 */
export class WavWriter {
  constructor(file, sampleRate = SAMPLE_RATE) {
    this.fd = fs.openSync(file, 'wx');
    this.sampleRate = sampleRate;
    this.dataBytes = 0;
    this.header = Buffer.alloc(44);
    this.#writeHeader();
  }

  append(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    writePcm16(buf, samples, 0);
    fs.writeSync(this.fd, buf, 0, buf.length, 44 + this.dataBytes);
    this.dataBytes += buf.length;
    this.#writeHeader();
  }

  close() {
    fs.closeSync(this.fd);
  }

  #writeHeader() {
    writeHeader(this.header, this.dataBytes, this.sampleRate);
    fs.writeSync(this.fd, this.header, 0, 44, 0);
  }
}

/** Mono WAV buffer (16-bit PCM or 32-bit float) -> Float32 samples. Used by the test and benchmark tools. */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let format = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      let tag = buf.readUInt16LE(body);
      if (tag === 0xfffe) tag = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: real format in the sub-format GUID
      format = {
        float: tag === 3,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format || format.channels !== 1) throw new Error('Expected mono WAV');
      const bytes = Math.min(size, buf.length - body);
      if (format.float && format.bits === 32) {
        const samples = new Float32Array(Math.floor(bytes / 4));
        for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(body + i * 4);
        return { sampleRate: format.sampleRate, samples };
      }
      if (format.bits !== 16) throw new Error('Expected 16-bit PCM or 32-bit float WAV');
      const samples = new Float32Array(Math.floor(bytes / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2) / 32768;
      return { sampleRate: format.sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}

export function concatFloat32(chunks) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

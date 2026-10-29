// Converts a Hugging Face Whisper checkpoint (model.safetensors + config.json + vocab.json) into
// whisper.cpp's ggml format. A port of whisper.cpp's models/convert-h5-to-ggml.py that needs no PyTorch.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GGML_MAGIC = 0x67676d6c;

// Hugging Face layer names -> whisper.cpp (OpenAI) names.
const LAYER_MAP = {
  'self_attn.k_proj': 'attn.key',
  'self_attn.q_proj': 'attn.query',
  'self_attn.v_proj': 'attn.value',
  'self_attn.out_proj': 'attn.out',
  self_attn_layer_norm: 'attn_ln',
  'encoder_attn.k_proj': 'cross_attn.key',
  'encoder_attn.q_proj': 'cross_attn.query',
  'encoder_attn.v_proj': 'cross_attn.value',
  'encoder_attn.out_proj': 'cross_attn.out',
  encoder_attn_layer_norm: 'cross_attn_ln',
  fc1: 'mlp.0',
  fc2: 'mlp.2',
  final_layer_norm: 'mlp_ln',
};
const TOP_MAP = {
  'encoder.layer_norm.bias': 'encoder.ln_post.bias',
  'encoder.layer_norm.weight': 'encoder.ln_post.weight',
  'encoder.embed_positions.weight': 'encoder.positional_embedding',
  'decoder.layer_norm.bias': 'decoder.ln.bias',
  'decoder.layer_norm.weight': 'decoder.ln.weight',
  'decoder.embed_positions.weight': 'decoder.positional_embedding',
  'decoder.embed_tokens.weight': 'decoder.token_embedding.weight',
};
// Tensors whisper.cpp wants in f32 even in an f16 model.
const KEEP_F32 = new Set(['encoder.conv1.bias', 'encoder.conv2.bias', 'encoder.positional_embedding', 'decoder.positional_embedding']);

function ggmlName(hfName) {
  const parts = hfName.split('.').slice(1); // drop leading "model."
  if (parts[1] !== 'layers') return TOP_MAP[parts.join('.')] ?? parts.join('.');
  const layer = parts.slice(3, -1).join('.');
  const mapped = LAYER_MAP[layer];
  if (!mapped) throw new Error(`Unknown Whisper layer "${hfName}"`);
  return [parts[0], 'blocks', parts[2], mapped, parts.at(-1)].join('.');
}

/** GPT-2 byte-level BPE: the unicode character standing for each byte, reversed. */
function byteDecoder() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  return new Map(cs.map((c, i) => [String.fromCodePoint(c), bs[i]]));
}

/** Read one float32 array out of a numpy .npz archive (OpenAI's mel_filters.npz). */
function readNpzFloat32(npz, member) {
  const res = spawnSync('unzip', ['-p', npz, member], { maxBuffer: 1 << 26 });
  if (res.status !== 0 || !res.stdout?.length) throw new Error(`Could not read ${member} from ${npz}`);
  const buf = res.stdout;
  if (buf.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${member} is not a .npy file`);
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buf.toString('latin1', headerStart, headerStart + headerLen);
  if (!header.includes("'<f4'") || header.includes("'fortran_order': True")) throw new Error(`Unsupported .npy layout: ${header}`);
  const shape = header.match(/'shape': \(([^)]*)\)/)[1].split(',').filter((s) => s.trim()).map(Number);
  const start = headerStart + headerLen;
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + start + shape[0] * shape[1] * 4));
  return { shape, data };
}

function toFloat32(raw, dtype) {
  if (dtype === 'F32') return new Float32Array(raw);
  if (dtype === 'F16') return Float32Array.from(new Float16Array(raw));
  if (dtype === 'BF16') {
    const src = new Uint16Array(raw);
    const out = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i] << 16;
    return new Float32Array(out.buffer);
  }
  throw new Error(`Unsupported tensor dtype ${dtype}`);
}

const int32 = (...values) => Buffer.from(new Int32Array(values).buffer);

/**
 * @param {object} o
 * @param {string} o.sourceDir    folder with model.safetensors, config.json, vocab.json
 * @param {string} o.melFilters   path to OpenAI's mel_filters.npz
 * @param {string} o.out          output ggml file (f16)
 * @param {(fraction: number) => void} [o.onProgress]
 */
export async function convertHfWhisper({ sourceDir, melFilters, out, onProgress = () => {} }) {
  const hp = JSON.parse(fs.readFileSync(path.join(sourceDir, 'config.json'), 'utf8'));
  const vocab = JSON.parse(fs.readFileSync(path.join(sourceDir, 'vocab.json'), 'utf8'));
  const filters = readNpzFloat32(melFilters, `mel_${hp.num_mel_bins}.npy`);

  const src = await fs.promises.open(path.join(sourceDir, 'model.safetensors'), 'r');
  const dst = await fs.promises.open(out, 'w');
  try {
    const lenBuf = Buffer.alloc(8);
    await src.read(lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    const headerBuf = Buffer.alloc(headerLen);
    await src.read(headerBuf, 0, headerLen, 8);
    const tensors = Object.entries(JSON.parse(headerBuf.toString('utf8'))).filter(([name]) => name !== '__metadata__');
    const dataStart = 8 + headerLen;

    // Header: magic, hyperparameters, mel filterbank, vocabulary.
    await dst.write(int32(
      GGML_MAGIC,
      hp.vocab_size, hp.max_source_positions, hp.d_model, hp.encoder_attention_heads, hp.encoder_layers,
      hp.max_target_positions, hp.d_model, hp.decoder_attention_heads, hp.decoder_layers,
      hp.num_mel_bins, 1, // ftype 1 = mostly f16
    ));
    await dst.write(int32(filters.shape[0], filters.shape[1]));
    await dst.write(Buffer.from(filters.data.buffer, filters.data.byteOffset, filters.data.byteLength));
    const decoder = byteDecoder();
    const tokens = Object.entries(vocab).sort((a, b) => a[1] - b[1]);
    const vocabParts = [int32(tokens.length)];
    for (const [token] of tokens) {
      const bytes = Buffer.from([...token].map((ch) => {
        const b = decoder.get(ch);
        if (b === undefined) throw new Error(`Token "${token}" is not byte-level BPE`);
        return b;
      }));
      vocabParts.push(int32(bytes.length), bytes);
    }
    await dst.write(Buffer.concat(vocabParts));

    // Tensors.
    const totalBytes = tensors.reduce((n, [, t]) => n + (t.data_offsets[1] - t.data_offsets[0]), 0);
    let doneBytes = 0;
    for (const [hfName, t] of tensors) {
      const [begin, end] = t.data_offsets;
      doneBytes += end - begin;
      if (hfName === 'proj_out.weight') continue; // tied to the token embedding

      const name = ggmlName(hfName);
      let shape = t.shape.filter((d) => d !== 1); // numpy squeeze()
      if (name === 'encoder.conv1.bias' || name === 'encoder.conv2.bias') shape = [shape[0], 1];
      const f32 = shape.length < 2 || KEEP_F32.has(name);

      const raw = new ArrayBuffer(end - begin);
      await src.read(new Uint8Array(raw), 0, raw.byteLength, dataStart + begin);
      let data;
      if (f32) data = toFloat32(raw, t.dtype);
      else if (t.dtype === 'F16') data = new Uint8Array(raw);
      else data = Float16Array.from(toFloat32(raw, t.dtype));

      const nameBytes = Buffer.from(name, 'utf8');
      await dst.write(int32(shape.length, nameBytes.length, f32 ? 0 : 1, ...[...shape].reverse()));
      await dst.write(nameBytes);
      await dst.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      onProgress(doneBytes / totalBytes);
    }
  } finally {
    await src.close();
    await dst.close();
  }
}

// The open audio the benchmarks run on: the FLEURS Romanian test set (Google, CC-BY-4.0; 883 read sentences with
// checked transcripts, ~500 MB), downloaded once into benchmarks/data/fleurs-ro. Every computer gets the same clips.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../config.ts';
import { download } from '../models.ts';
import { decodeWav } from '../wav.ts';

/** One clip of the set: its file in test/, the checked transcript, and its length. @typedef {{ file: string, ref: string, seconds: number }} Clip */

export const FLEURS_DIR = path.join(ROOT, 'benchmarks', 'data', 'fleurs-ro');
const FLEURS_URL = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data/ro_ro/';

/** @param {string} [dir] */
export const datasetReady = (dir = FLEURS_DIR) => fs.existsSync(path.join(dir, 'test.tsv')) && fs.existsSync(path.join(dir, 'test'));

/**
 * Downloads and unpacks the set the first time (needs `tar`, which macOS, Windows 10+ and Linux all have).
 * @param {string} [dir]
 * @param {(line: string) => void} [log]
 */
export async function ensureDataset(dir = FLEURS_DIR, log = console.log) {
  if (datasetReady(dir)) return;
  log('Downloading the FLEURS Romanian test set (~500 MB, once)…');
  await download(`${FLEURS_URL}test.tsv`, path.join(dir, 'test.tsv'));
  const archive = path.join(dir, 'test.tar.gz');
  await download(`${FLEURS_URL}audio/test.tar.gz`, archive);
  const tar = spawnSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Unpacking FLEURS failed (is `tar` installed?)');
  fs.rmSync(archive);
}

/**
 * Every clip of the set, sorted by file name so the order is the same everywhere: { file, ref, seconds }.
 * TSV columns: id, file, raw transcription, normalized transcription, characters, samples, gender.
 * @param {string} [dir]
 * @returns {Clip[]}
 */
export function loadClips(dir = FLEURS_DIR) {
  return fs.readFileSync(path.join(dir, 'test.tsv'), 'utf8').trim().split('\n')
    .map((line) => line.split('\t'))
    .map(([, file, ref, , , samples]) => ({ file, ref, seconds: Number(samples) / 16000 }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * A fixed selection of n clips spread evenly over the sorted set: the same n gives the same clips on every computer.
 * @template T
 * @param {T[]} clips
 * @param {number} n
 * @returns {T[]}
 */
export function selectClips(clips, n) {
  const count = Math.max(0, Math.min(n, clips.length));
  /** @type {T[]} */
  const out = [];
  for (let i = 0; i < count; i++) out.push(clips[Math.floor((i * clips.length) / count)]);
  return out;
}

/**
 * @param {Clip} clip
 * @param {string} [dir]
 */
export const clipSamples = (clip, dir = FLEURS_DIR) => decodeWav(fs.readFileSync(path.join(dir, 'test', clip.file))).samples;

/** @param {{ seconds: number }[]} clips */
export const audioSeconds = (clips) => clips.reduce((n, c) => n + c.seconds, 0);

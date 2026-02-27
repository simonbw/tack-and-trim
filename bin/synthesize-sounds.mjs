#!/usr/bin/env node
/**
 * Synthesize placeholder sound effects as WAV files.
 * These are meant to be replaced with real recordings later.
 *
 * Generates:
 *   resources/audio/sheet_snap.wav  - Rope snapping taut (short, sharp)
 *   resources/audio/boom_slam.wav   - Boom hitting end of travel (heavier thud)
 */

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RATE = 44100;

/** Write a mono WAV file from float samples in [-1, 1]. */
function writeWav(filepath, samples) {
  const numSamples = samples.length;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * (bitsPerSample / 8);
  const dataSize = numSamples * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);
  let offset = 0;

  // RIFF header
  buffer.write("RIFF", offset);
  offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  buffer.write("WAVE", offset);
  offset += 4;

  // fmt chunk
  buffer.write("fmt ", offset);
  offset += 4;
  buffer.writeUInt32LE(16, offset);
  offset += 4; // chunk size
  buffer.writeUInt16LE(1, offset);
  offset += 2; // PCM
  buffer.writeUInt16LE(1, offset);
  offset += 2; // mono
  buffer.writeUInt32LE(SAMPLE_RATE, offset);
  offset += 4;
  buffer.writeUInt32LE(byteRate, offset);
  offset += 4;
  buffer.writeUInt16LE(bitsPerSample / 8, offset);
  offset += 2; // block align
  buffer.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data chunk
  buffer.write("data", offset);
  offset += 4;
  buffer.writeUInt32LE(dataSize, offset);
  offset += 4;

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const val = Math.round(clamped * 32767);
    buffer.writeInt16LE(val, offset);
    offset += 2;
  }

  writeFileSync(filepath, buffer);
  console.log(`Wrote ${filepath} (${numSamples} samples, ${(numSamples / SAMPLE_RATE).toFixed(3)}s)`);
}

/** Generate filtered noise burst (rope snap). */
function synthesizeSheetSnap() {
  const duration = 0.15; // seconds
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  // White noise with sharp exponential decay
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t * 40); // Fast decay
    const noise = (Math.random() * 2 - 1);
    samples[i] = noise * envelope;
  }

  // Simple one-pole highpass to remove low rumble (rope snap is mid-high)
  const hpAlpha = 0.85;
  let prev = 0;
  let prevIn = 0;
  for (let i = 0; i < numSamples; i++) {
    const out = hpAlpha * (prev + samples[i] - prevIn);
    prevIn = samples[i];
    prev = out;
    samples[i] = out;
  }

  // Bandpass emphasis around 800-2000 Hz using simple resonant filter
  const fc = 1200 / SAMPLE_RATE;
  const bw = 1000 / SAMPLE_RATE;
  const R = 1 - Math.PI * bw;
  const cosTheta = Math.cos(2 * Math.PI * fc);
  const filtered = new Float64Array(numSamples);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < numSamples; i++) {
    filtered[i] = samples[i] - R * R * y2 + 2 * R * cosTheta * y1;
    // Normalize
    filtered[i] *= (1 - R);
    y2 = y1;
    y1 = filtered[i];
  }

  // Add a short transient click at the start
  for (let i = 0; i < Math.min(30, numSamples); i++) {
    const clickEnv = 1 - i / 30;
    filtered[i] += clickEnv * 0.6 * Math.sin(2 * Math.PI * 3000 * i / SAMPLE_RATE);
  }

  // Normalize peak to 0.9
  let peak = 0;
  for (let i = 0; i < numSamples; i++) peak = Math.max(peak, Math.abs(filtered[i]));
  if (peak > 0) for (let i = 0; i < numSamples; i++) filtered[i] *= 0.9 / peak;

  return filtered;
}

/** Generate boom slam (low thud with some mid crack). */
function synthesizeBoomSlam() {
  const duration = 0.35; // seconds
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;

    // Low thud: decaying sine around 80-120 Hz with pitch drop
    const thudFreq = 120 - t * 100; // Pitch drops from 120 to ~85 Hz
    const thudEnv = Math.exp(-t * 12);
    const thud = Math.sin(2 * Math.PI * thudFreq * t) * thudEnv * 0.7;

    // Mid crack: short burst of noise + tone at ~400 Hz
    const crackEnv = Math.exp(-t * 50);
    const crack = (Math.random() * 2 - 1) * crackEnv * 0.3;
    const toneEnv = Math.exp(-t * 25);
    const tone = Math.sin(2 * Math.PI * 400 * t) * toneEnv * 0.2;

    // Wood resonance: damped oscillation around 200 Hz
    const woodEnv = Math.exp(-t * 18) * Math.sin(2 * Math.PI * 2.5 * t); // AM modulation
    const wood = Math.sin(2 * Math.PI * 200 * t) * Math.abs(woodEnv) * 0.15;

    samples[i] = thud + crack + tone + wood;
  }

  // Normalize peak to 0.9
  let peak = 0;
  for (let i = 0; i < numSamples; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak > 0) for (let i = 0; i < numSamples; i++) samples[i] *= 0.9 / peak;

  return samples;
}

// Generate and write
const audioDir = resolve(__dirname, "../resources/audio");

writeWav(resolve(audioDir, "sheet_snap.wav"), synthesizeSheetSnap());
writeWav(resolve(audioDir, "boom_slam.wav"), synthesizeBoomSlam());

console.log("Done!");

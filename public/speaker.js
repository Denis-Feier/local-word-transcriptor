// Speaker: plays the mics in the room through an output the person picks, so everyone hears the person talking.
// Any output the computer lists can be used: its own speakers, a jack, USB or Bluetooth speaker, a projector's HDMI
// sound. Separate from the transcription: its own streams of the mics, at full quality and with the least delay.
import { feedMics, openMics } from '/mics.js';

/** Whether a page may pick the output (Chromium, the desktop app). Elsewhere only the system default plays. */
export const canChooseOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

/** Audio outputs, minus "default" and "communications", which repeat a real output under another name. */
export async function listOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
}

/**
 * Play the given mics (device ids; '' = system default) on the output sinkId ('' = system default) at volume
 * (0–1); a muted mic (per mic in muted) is not played. onChange() runs when a mic disconnects or comes back;
 * reattach() opens it again. Throws if the output or none of the mics can be opened.
 */
export async function openSpeaker(deviceIds, { sinkId, volume, muted, onChange }) {
  // Auto gain turns the room up between sentences, which is when a speaker starts to howl. Chromium shares a mic's
  // processing, though: if the transcription opened the mic first, the speaker gets its auto gain too.
  const processing = { noiseSuppression: false, autoGainControl: false };
  const slots = await openMics(deviceIds, processing, muted);
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  try {
    // Before anything is connected, so not even a moment of sound goes to the wrong output.
    if (canChooseOutput) await ctx.setSinkId(sinkId);
    await ctx.resume();
  } catch (err) {
    slots.forEach((slot) => slot.stream?.getTracks().forEach((t) => t.stop()));
    ctx.close();
    throw err;
  }
  const gain = new GainNode(ctx, { gain: volume });
  gain.connect(ctx.destination);
  const meters = slots.map(() => new AnalyserNode(ctx, { fftSize: 4096 })); // ~0.1 s, like a capture chunk
  const mics = feedMics(ctx, slots, processing, (source, input) => {
    source.connect(gain);
    source.connect(meters[input]);
  }, onChange);
  const samples = new Float32Array(meters[0].fftSize);

  return {
    slots,
    sinkId,
    reattach: mics.reattach,
    mute: mics.mute,
    setVolume: (value) => gain.gain.setTargetAtTime(value, ctx.currentTime, 0.02),
    /** Each mic's RMS level over the last ~0.1 s, before the volume; 0 for a mic that is missing. */
    levels: () => meters.map((meter) => {
      meter.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    }),
    close() {
      mics.close();
      ctx.close();
    },
  };
}

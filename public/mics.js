// Microphones: lists the computer's audio inputs and records several of them at once.
// How a mic is connected (built-in, USB, jack, Bluetooth) doesn't matter: any input the browser lists can be used.
// All mics feed one AudioContext and one worklet, so every chunk holds the same moment from each mic.

/**
 * Audio inputs, minus "default" and "communications", which repeat a real mic under another name.
 * Until the mic is allowed once, browsers list only a nameless placeholder, which is left out too.
 */
export async function listInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const all = devices.filter((d) => d.kind === 'audioinput');
  const inputs = all.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  // The mic behind "System default" right now, so the same mic can't be picked twice.
  const alias = all.find((d) => d.deviceId === 'default');
  const behind = alias && (inputs.find((d) => d.label && alias.label.endsWith(d.label)) ?? inputs.find((d) => d.groupId === alias.groupId));
  return { inputs, defaultId: behind?.deviceId ?? inputs[0]?.deviceId ?? '' };
}

/** processing: the browser's noiseSuppression and autoGainControl for this use of the mic. */
function openStream(deviceId, processing) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false, // it would also cancel the talker's own voice coming back from the room's speaker
      ...processing,
    },
  });
}

/**
 * Open the given mics (device ids; '' = system default) as slots { deviceId, stream, source, rate, error }.
 * A mic that can't be opened has no stream. Throws if none of them can be opened.
 */
export async function openMics(deviceIds, processing) {
  const slots = deviceIds.map((deviceId) => ({ deviceId, stream: null, source: null, rate: null, error: null }));
  const opened = await Promise.allSettled(deviceIds.map((id) => openStream(id, processing)));
  opened.forEach((result, i) => {
    if (result.status === 'fulfilled') slots[i].stream = result.value;
    else slots[i].error = result.reason;
  });
  if (!slots.some((slot) => slot.stream)) throw slots[0].error;
  return slots;
}

/**
 * Feed the slots' mics into ctx, each through connect(source, input), and keep them fed: a mic that ends drops out
 * and onChange() runs; reattach() opens it again. close() stops the mics, not ctx.
 */
export function feedMics(ctx, slots, processing, connect, onChange) {
  const drop = (slot) => {
    slot.source?.disconnect();
    slot.stream?.getTracks().forEach((t) => t.stop());
    Object.assign(slot, { stream: null, source: null });
  };
  const attach = (slot, input) => {
    try {
      slot.source ??= ctx.createMediaStreamSource(slot.stream);
      connect(slot.source, input);
    } catch (err) {
      drop(slot);
      slot.error = err;
      return;
    }
    const track = slot.stream.getAudioTracks()[0];
    slot.rate = track.getSettings().sampleRate ?? null;
    // Unplugged, switched off or out of Bluetooth range.
    track.addEventListener('ended', () => {
      drop(slot);
      onChange();
    });
  };
  slots.forEach((slot, input) => slot.stream && attach(slot, input));
  let closed = false;

  return {
    /** Try again to open a mic that is missing, e.g. because it was just switched back on. */
    async reattach(input, deviceId) {
      const slot = slots[input];
      if (slot.stream || slot.opening) return;
      slot.opening = true;
      try {
        const stream = await openStream(deviceId, processing);
        if (closed) return stream.getTracks().forEach((t) => t.stop());
        Object.assign(slot, { stream, deviceId, error: null });
        attach(slot, input);
      } catch (err) {
        slot.error = err;
      } finally {
        slot.opening = false;
      }
      if (!closed) onChange();
    },
    close() {
      closed = true;
      slots.forEach(drop);
    },
  };
}

/**
 * Record the given mics together (device ids; '' = system default). onChunk(buffer) gets each chunk
 * (see pcm-worklet.js); onChange() runs when a mic disconnects or comes back. A mic that can't be opened records
 * silence until reattach() succeeds. Throws if none of them can be opened.
 */
export async function openCapture(deviceIds, { noiseSuppression, onChunk, onChange }) {
  // The browser's noise filter can eat distant voices; auto gain lifts quiet or far-away speakers.
  const processing = { noiseSuppression, autoGainControl: true };
  const slots = await openMics(deviceIds, processing);
  const first = slots.find((slot) => slot.stream);

  // Ask the browser to resample to 16 kHz; Firefox refuses to mix rates, so fall back to the native rate
  // and let the worklet downsample.
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    first.source = ctx.createMediaStreamSource(first.stream);
  } catch {
    await ctx?.close();
    ctx = new AudioContext();
    first.source = null;
  }
  await ctx.resume();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: slots.length, processorOptions: { mics: slots.length } });
  node.port.onmessage = (e) => onChunk(e.data);
  node.connect(ctx.destination); // keeps the node pulled by the graph; it outputs silence
  const mics = feedMics(ctx, slots, processing, (source, input) => source.connect(node, 0, input), onChange);

  return {
    slots,
    reattach: mics.reattach,
    close() {
      node.port.onmessage = null;
      mics.close();
      ctx.close();
    },
  };
}

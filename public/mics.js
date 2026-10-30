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

function openStream(deviceId, noiseSuppression) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Room setup: no playback to cancel, and the browser's noise filter can eat distant voices.
      echoCancellation: false,
      noiseSuppression,
      autoGainControl: true, // lifts quiet or far-away speakers
    },
  });
}

/**
 * Record the given mics together (device ids; '' = system default). onChunk(buffer) gets each chunk
 * (see pcm-worklet.js); onChange() runs when a mic disconnects or comes back. A mic that can't be opened records
 * silence until reattach() succeeds. Throws if none of them can be opened.
 */
export async function openCapture(deviceIds, { noiseSuppression, onChunk, onChange }) {
  const slots = deviceIds.map((deviceId) => ({ deviceId, stream: null, source: null, rate: null, error: null }));
  const opened = await Promise.allSettled(deviceIds.map((id) => openStream(id, noiseSuppression)));
  opened.forEach((result, i) => {
    if (result.status === 'fulfilled') slots[i].stream = result.value;
    else slots[i].error = result.reason;
  });
  const first = slots.find((slot) => slot.stream);
  if (!first) throw slots[0].error;

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

  const drop = (slot) => {
    slot.source?.disconnect();
    slot.stream?.getTracks().forEach((t) => t.stop());
    Object.assign(slot, { stream: null, source: null });
  };
  const connect = (slot, input) => {
    try {
      slot.source ??= ctx.createMediaStreamSource(slot.stream);
      slot.source.connect(node, 0, input);
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
  slots.forEach((slot, input) => slot.stream && connect(slot, input));
  let closed = false;

  return {
    slots,
    /** Try again to open a mic that is missing, e.g. because it was just switched back on. */
    async reattach(input, deviceId) {
      const slot = slots[input];
      if (slot.stream || slot.opening) return;
      slot.opening = true;
      try {
        const stream = await openStream(deviceId, noiseSuppression);
        if (closed) return stream.getTracks().forEach((t) => t.stop());
        Object.assign(slot, { stream, deviceId, error: null });
        connect(slot, input);
      } catch (err) {
        slot.error = err;
      } finally {
        slot.opening = false;
      }
      if (!closed) onChange();
    },
    close() {
      closed = true;
      node.port.onmessage = null;
      slots.forEach(drop);
      ctx.close();
    },
  };
}

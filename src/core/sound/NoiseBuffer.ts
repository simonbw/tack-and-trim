/**
 * Generate a white noise AudioBuffer for use with synthesis-based sounds.
 */
export function createNoiseBuffer(
  audioContext: AudioContext,
  duration: number = 2,
): AudioBuffer {
  const sampleRate = audioContext.sampleRate;
  const length = Math.ceil(sampleRate * duration);
  const buffer = audioContext.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

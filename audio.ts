import { Encoder } from "@evan/opus";
import {
    TTS_SAMPLE_RATE,
    TTS_FRAME_SIZE_BYTES,
    MIC_SAMPLE_RATE,
    MIC_INPUT_GAIN,
    ADPCM_ENABLED
} from "./config.ts";
import { ADPCMEncoder, ADPCM } from "./adpcm.ts";

// Opus encoder for TTS
export const ttsEncoder = new Encoder({
  application: "audio",
  sample_rate: TTS_SAMPLE_RATE,
  channels: 1,
});

// Set bitrate to 12000 for better compression
ttsEncoder.bitrate = 12000;
console.log(`TTS Opus encoder configured: ${TTS_SAMPLE_RATE}Hz, ${ttsEncoder.channels} channel(s), ${ttsEncoder.bitrate} bitrate`);

export function createTtsBuffer() {
  let leftover = new Uint8Array(0);

  async function encodePcmChunk(rawPcm: Uint8Array): Promise<Uint8Array[]> {
    const combined = new Uint8Array(leftover.length + rawPcm.length);
    combined.set(leftover, 0);
    combined.set(rawPcm, leftover.length);

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + TTS_FRAME_SIZE_BYTES <= combined.length) {
      const slice = combined.subarray(offset, offset + TTS_FRAME_SIZE_BYTES);
      offset += TTS_FRAME_SIZE_BYTES;
      try {
        const opusData = ttsEncoder.encode(slice);
        frames.push(opusData);
      } catch (e) {
        console.error("Opus encode error:", e);
      }
    }
    leftover = combined.subarray(offset);
    return frames;
  }

  function reset() {
    leftover = new Uint8Array(0);
  }

  return { encodePcmChunk, reset };
}

export const ttsState = createTtsBuffer();

// ADPCM TTS encoder for alternative compression
export function createAdpcmTtsBuffer() {
  let leftover = new Uint8Array(0);
  const adpcmEncoder = new ADPCMEncoder();

  async function encodePcmChunk(rawPcm: Uint8Array): Promise<Uint8Array[]> {
    const combined = new Uint8Array(leftover.length + rawPcm.length);
    combined.set(leftover, 0);
    combined.set(rawPcm, leftover.length);

    const frames: Uint8Array[] = [];
    let offset = 0;

    // Process in chunks suitable for ADPCM (ensure even number of samples)
    const samplesPerChunk = Math.floor(TTS_FRAME_SIZE_BYTES / 2); // Convert bytes to samples
    const evenSamplesPerChunk = samplesPerChunk & ~1; // Ensure even number
    const bytesPerChunk = evenSamplesPerChunk * 2; // Convert back to bytes

    while (offset + bytesPerChunk <= combined.length) {
      const slice = combined.subarray(offset, offset + bytesPerChunk);
      offset += bytesPerChunk;

      try {
        // Convert to Int16Array for ADPCM encoding
        const samples = ADPCM.bytesToInt16Array(slice);
        const adpcmData = adpcmEncoder.encode(samples);
        frames.push(adpcmData);
      } catch (e) {
        console.error("ADPCM encode error:", e);
      }
    }
    leftover = combined.subarray(offset);
    return frames;
  }

  function reset() {
    leftover = new Uint8Array(0);
    adpcmEncoder.reset();
  }

  return { encodePcmChunk, reset };
}

export const adpcmTtsState = createAdpcmTtsBuffer();

// AudioFilter for Microphone Input and TTS Output (Upgraded to 2nd Order Biquad)
export class AudioFilter {
    // Biquad filter coefficients (b = numerator/feedforward, a = denominator/feedback)
    private hp_b0 = 1.0; private hp_b1 = 0.0; private hp_b2 = 0.0;
    private hp_a1 = 0.0; private hp_a2 = 0.0; // a0 is implicitly 1
    private lp_b0 = 1.0; private lp_b1 = 0.0; private lp_b2 = 0.0;
    private lp_a1 = 0.0; private lp_a2 = 0.0; // a0 is implicitly 1

    // Filter state variables (delay elements) for high-pass
    private hp_x1 = 0.0; private hp_x2 = 0.0; // Input delays
    private hp_y1 = 0.0; private hp_y2 = 0.0; // Output delays
    // Filter state variables (delay elements) for low-pass
    private lp_x1 = 0.0; private lp_x2 = 0.0; // Input delays
    private lp_y1 = 0.0; private lp_y2 = 0.0; // Output delays

    constructor(
        sampleRate: number,
        highpassCutoff = 40.0, // Adjusted default high-pass cutoff (Hz)
        lowpassCutoff = 9000.0,   // Adjusted default low-pass cutoff (Hz)
        private inputGain = MIC_INPUT_GAIN // Audio input gain multiplier
    ) {
        // --- Basic Validation ---
        if (sampleRate <= 0) throw new Error("Sample rate must be positive.");
        const nyquist = sampleRate / 2;
        if (highpassCutoff < 0 || highpassCutoff >= nyquist) {
             throw new Error(`High-pass cutoff must be non-negative and less than Nyquist (${nyquist} Hz).`);
        }
        if (lowpassCutoff <= 0 || lowpassCutoff >= nyquist) {
            throw new Error(`Low-pass cutoff must be positive and less than Nyquist (${nyquist} Hz).`);
        }
        if (highpassCutoff > 0 && lowpassCutoff > 0 && highpassCutoff >= lowpassCutoff) {
            console.warn(`High-pass cutoff (${highpassCutoff} Hz) is >= low-pass cutoff (${lowpassCutoff} Hz). Filter might block most frequencies.`);
        }
        console.log(`Initializing 2nd Order AudioFilter: SR=${sampleRate}Hz, HP=${highpassCutoff}Hz, LP=${lowpassCutoff}Hz, Gain=${this.inputGain}x`);

        // --- Calculate High-Pass Butterworth Biquad Coefficients ---
        if (highpassCutoff > 0) {
            const wc = 2 * Math.PI * highpassCutoff / sampleRate; // Digital cutoff frequency
            const k = Math.tan(wc / 2);
            const norm = 1 / (1 + Math.SQRT2 * k + k * k); // SQRT2 for Butterworth Q = 0.7071
            this.hp_b0 = norm;
            this.hp_b1 = -2 * this.hp_b0;
            this.hp_b2 = this.hp_b0;
            this.hp_a1 = 2 * (k * k - 1) * norm;
            this.hp_a2 = (1 - Math.SQRT2 * k + k * k) * norm;
        } else {
            // Pass-through coefficients if cutoff is 0
            this.hp_b0 = 1.0; this.hp_b1 = 0.0; this.hp_b2 = 0.0;
            this.hp_a1 = 0.0; this.hp_a2 = 0.0;
        }

        // --- Calculate Low-Pass Butterworth Biquad Coefficients ---
        if (lowpassCutoff > 0 && lowpassCutoff < nyquist) {
            const wc = 2 * Math.PI * lowpassCutoff / sampleRate; // Digital cutoff frequency
            const k = Math.tan(wc / 2);
            const norm = 1 / (1 + Math.SQRT2 * k + k * k);
            this.lp_b0 = k * k * norm;
            this.lp_b1 = 2 * this.lp_b0;
            this.lp_b2 = this.lp_b0;
            this.lp_a1 = 2 * (k * k - 1) * norm;
            this.lp_a2 = (1 - Math.SQRT2 * k + k * k) * norm;
        } else {
             // Pass-through coefficients if cutoff is invalid (e.g., >= Nyquist)
            this.lp_b0 = 1.0; this.lp_b1 = 0.0; this.lp_b2 = 0.0;
            this.lp_a1 = 0.0; this.lp_a2 = 0.0;
        }
    }

    public processAudioInPlace(buffer: Uint8Array) {
        const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
        for (let i = 0; i < samples.length; i++) {
            const xn = samples[i]; // Current input sample

            // Apply High-Pass Filter Stage (Direct Form II Transposed)
            let hp_yn = this.hp_b0 * xn + this.hp_x1;
            this.hp_x1 = this.hp_b1 * xn - this.hp_a1 * hp_yn + this.hp_x2;
            this.hp_x2 = this.hp_b2 * xn - this.hp_a2 * hp_yn;

            // Apply Low-Pass Filter Stage to the output of the high-pass stage
            let lp_yn = this.lp_b0 * hp_yn + this.lp_x1;
            this.lp_x1 = this.lp_b1 * hp_yn - this.lp_a1 * lp_yn + this.lp_x2;
            this.lp_x2 = this.lp_b2 * hp_yn - this.lp_a2 * lp_yn;

            // Apply configurable input gain
            let finalOut = lp_yn * this.inputGain;

            // Clip to Int16 range
            finalOut = Math.max(-32768, Math.min(32767, finalOut));
            samples[i] = Math.round(finalOut); // Round to nearest integer
        }
    }
}

export function boostTtsVolumeInPlace(buffer: Uint8Array, factor = 3.0) {
    // Ensure factor is positive
    const safeFactor = Math.max(0, factor);
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
        let val = samples[i] * safeFactor;
        // Clip the amplified value
        val = Math.max(-32768, Math.min(32767, val));
        samples[i] = val;
    }
} 
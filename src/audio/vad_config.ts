// VAD Configuration Constants
// These can be adjusted based on your microphone and environment

// Energy thresholds (may need tuning based on your microphone sensitivity)
// Higher values = less sensitive (fewer false positives)
// Lower values = more sensitive (may pick up background noise)
export const VAD_SPEECH_THRESHOLD = 1600.0;    // RMS energy threshold for speech start
export const VAD_SILENCE_THRESHOLD = 1200.0;   // RMS energy threshold for speech end (hysteresis)

// Timing parameters (in frames, where each frame = 20ms)
export const VAD_PREFIX_FRAMES = 15;        // 300ms prefix padding (15 * 20ms)
export const VAD_SILENCE_FRAMES = 40;       // 800ms silence detection (40 * 20ms)
export const VAD_MIN_SPEECH_FRAMES = 5;     // 100ms minimum speech duration (5 * 20ms)

// Audio parameters - 20ms frames at 16kHz
export const VAD_SAMPLE_RATE = 16000;       // 16kHz sample rate
export const VAD_FRAME_SIZE = 320;          // 20ms frame at 16kHz (320 samples)

// Smoothing
export const VAD_ENERGY_SMOOTHING = 0.1;    // Low-pass filter factor for energy smoothing

// Debug settings
export const VAD_DEBUG_INTERVAL_MS = 10000; // Debug output every 10 seconds (milliseconds)

// VAD Configuration class
export class VADConfig {
    // Audio parameters
    public sampleRate: number = VAD_SAMPLE_RATE;
    public frameSize: number = VAD_FRAME_SIZE;
    public prefixFrames: number = VAD_PREFIX_FRAMES;
    public silenceFrames: number = VAD_SILENCE_FRAMES;

    // Energy thresholds (these may need tuning based on your microphone)
    public speechThreshold: number = VAD_SPEECH_THRESHOLD;
    public silenceThreshold: number = VAD_SILENCE_THRESHOLD;

    // Smoothing
    public energySmoothingFactor: number = VAD_ENERGY_SMOOTHING;

    // Minimum speech duration to avoid false positives
    public minSpeechFrames: number = VAD_MIN_SPEECH_FRAMES;

    constructor(overrides: Partial<VADConfig> = {}) {
        Object.assign(this, overrides);
    }
}

// VAD States
export enum VADState {
    VAD_SILENCE = 0,        // No speech detected
    VAD_SPEECH_START = 1,   // Speech just started (sending prefix + current)
    VAD_SPEECH_ACTIVE = 2,  // Speech is active - continues until external reset
    VAD_SPEECH_END = 3      // Speech ended, waiting for silence confirmation
}

// Microphone calibration notes:
// - If VAD is too sensitive (picks up background noise):
//   Increase VAD_SPEECH_THRESHOLD and VAD_SILENCE_THRESHOLD
// - If VAD misses quiet speech:
//   Decrease VAD_SPEECH_THRESHOLD and VAD_SILENCE_THRESHOLD
// - If speech gets cut off at the beginning:
//   Increase VAD_PREFIX_FRAMES
// - If speech gets cut off at the end:
//   Increase VAD_SILENCE_FRAMES
// - If short words get ignored:
//   Decrease VAD_MIN_SPEECH_FRAMES

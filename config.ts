import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// Load environment variables from .env file
await load({ export: true, examplePath: null });

// Environment variables
export const isDev = Deno.env.get("DEV_MODE") === "true";

// API Key Management System
class ApiKeyManager {
  private apiKeys: string[];
  private currentIndex: number = 0;
  private allKeysExhausted: boolean = false;

  constructor() {
    // Get the primary API key from environment
    const primaryKey = Deno.env.get("GEMINI_API_KEY") || "";
    if (!primaryKey) {
      console.error("Missing GEMINI_API_KEY! Please set it in env.");
      Deno.exit(1);
    }

    // Initialize API key pool with primary key + additional keys
    this.apiKeys = [
      primaryKey,
      "AIzaSyAwwEL1GPN-bdH0wJFlJG_EugrG5do8cxM",
    ];

    console.log(`Initialized API key pool with ${this.apiKeys.length} keys`);
  }

  /**
   * Get the current active API key
   */
  getCurrentKey(): string {
    return this.apiKeys[this.currentIndex];
  }

  /**
   * Rotate to the next API key
   * @returns true if rotated to a new key, false if all keys are exhausted
   */
  rotateToNextKey(): boolean {
    const nextIndex = (this.currentIndex + 1) % this.apiKeys.length;

    // If we've cycled through all keys, mark as exhausted
    if (nextIndex === 0 && this.currentIndex !== 0) {
      this.allKeysExhausted = true;
      console.log("All API keys have been exhausted. Will retry with delays.");
      return false;
    }

    this.currentIndex = nextIndex;
    console.log(`Rotated to API key ${this.currentIndex + 1}/${this.apiKeys.length}`);
    return true;
  }

  /**
   * Check if all keys have been exhausted
   */
  areAllKeysExhausted(): boolean {
    return this.allKeysExhausted;
  }

  /**
   * Reset the key rotation (used when starting a new retry cycle)
   */
  resetRotation(): void {
    this.currentIndex = 0;
    this.allKeysExhausted = false;
    console.log("Reset API key rotation to start from first key");
  }

  /**
   * Get total number of keys in the pool
   */
  getTotalKeys(): number {
    return this.apiKeys.length;
  }
}

// Create global instance
const apiKeyManager = new ApiKeyManager();

// Export the manager instance and convenience functions
export { apiKeyManager };

// Backward compatibility - deprecated, use apiKeyManager.getCurrentKey() instead
export const GEMINI_API_KEY = apiKeyManager.getCurrentKey();

export const GEMINI_LIVE_URL_TEMPLATE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}";

export const GEMINI_VISION_MODEL = Deno.env.get("GEMINI_VISION_MODEL") || "gemini-2.5-flash-preview-05-20";

/**
 * Get the current Gemini Vision API URL with the active API key
 */
export function getGeminiVisionUrl(): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKeyManager.getCurrentKey()}`;
}

// Deprecated - use getGeminiVisionUrl() instead
export const GEMINI_VISION_URL = getGeminiVisionUrl();

// Microphone Processing
export const MIC_SAMPLE_RATE = 16000;
export const MIC_SAMPLE_BITS = 16; // 16-bit
export const MIC_CHANNELS = 1;
export const MIC_ACCUM_CHUNK_SIZE = 1024; // Process audio in 1k blocks
export const MIC_INPUT_GAIN = 3.0; // Audio input gain multiplier

// ADPCM Configuration
export const ADPCM_ENABLED = true; // Enable ADPCM compression for microphone input
export const ADPCM_COMPRESSION_RATIO = 4; // 4:1 compression ratio (16-bit PCM → 4-bit ADPCM)
export const ADPCM_BUFFER_SIZE = 2048; // Buffer size for ADPCM processing

// TTS Output
export const TTS_SAMPLE_RATE = 24000;
export const TTS_FRAME_SIZE_SAMPLES = 480; // 20ms at 24k
export const TTS_FRAME_SIZE_BYTES = TTS_FRAME_SIZE_SAMPLES * 2; // 960 bytes (16-bit)

// Image Streaming Configuration
export const IMAGE_CHUNK_SIZE = 8192; // 8KB chunks for image streaming
export const IMAGE_CHUNK_TIMEOUT_MS = 10000; // 10 seconds timeout for chunk assembly

// Audio Debug Configuration
export const AUDIO_DEBUG = Deno.env.get("AUDIO_DEBUG") === "true";
export const AUDIO_DEBUG_DIR = Deno.env.get("AUDIO_DEBUG_DIR") || "./debug_audio";
export const AUDIO_DEBUG_MAX_FILES = Number(Deno.env.get("AUDIO_DEBUG_MAX_FILES") || "50");

// TTS Provider Configuration
export type TTSProvider = "GEMINI" | "ELEVEN_LABS" | "OPENAI";

export const TTS_PROVIDER = (Deno.env.get("TTS_PROVIDER") || "GEMINI").toUpperCase() as TTSProvider;

// Validate TTS provider
const validProviders: TTSProvider[] = ["GEMINI", "ELEVEN_LABS", "OPENAI"];
if (!validProviders.includes(TTS_PROVIDER)) {
  console.warn(`Invalid TTS_PROVIDER: ${TTS_PROVIDER}. Falling back to GEMINI.`);
  // We can't reassign the const, but we'll handle this in the validation function
}

// ElevenLabs TTS Configuration
export const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") || "";

// OpenAI TTS Configuration
export const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";

// Backward compatibility
export const USE_ELEVENLABS_TTS = TTS_PROVIDER === "ELEVEN_LABS";

/**
 * Get the effective TTS provider (with fallback logic)
 * @returns The TTS provider to use
 */
export function getEffectiveTTSProvider(): TTSProvider {
  if (!validProviders.includes(TTS_PROVIDER)) {
    console.warn(`Invalid TTS_PROVIDER: ${TTS_PROVIDER}. Falling back to GEMINI.`);
    return "GEMINI";
  }
  return TTS_PROVIDER;
}

/**
 * Validate TTS provider configuration
 * @param provider The TTS provider to validate
 * @returns boolean indicating if the provider is properly configured
 */
export function validateTTSProvider(provider: TTSProvider): boolean {
  switch (provider) {
    case "ELEVEN_LABS":
      return ELEVENLABS_API_KEY !== "" && ELEVENLABS_API_KEY !== "your_elevenlabs_api_key_here";
    case "OPENAI":
      return OPENAI_API_KEY !== "" && OPENAI_API_KEY !== "your_openai_api_key_here";
    case "GEMINI":
      return true; // Gemini TTS is always available if Gemini API is configured
    default:
      return false;
  }
}

// Server Configuration
export const HOST = Deno.env.get("HOST") || "0.0.0.0";
// Default to 8080 unless DEV_MODE is true, then default to 8000
export const PORT = Number(Deno.env.get("PORT") || (isDev ? 8000 : 8080));
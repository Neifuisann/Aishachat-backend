import { load } from 'https://deno.land/std@0.224.0/dotenv/mod.ts';
import { Logger } from '../utils/logger.ts';

const logger = new Logger('[Config]');

// Load environment variables from .env file
await load({ export: true, examplePath: null });

// Environment variables
export const isDev = Deno.env.get('DEV_MODE') === 'true';

// API Key Management System
class ApiKeyManager {
    private apiKeys: string[];
    private currentIndex: number = 0;
    private allKeysExhausted: boolean = false;

    constructor() {
        // Get the primary API key from environment
        const primaryKey = Deno.env.get('GEMINI_API_KEY') || '';
        if (!primaryKey) {
            logger.error('Missing GEMINI_API_KEY! Please set it in env.');
            Deno.exit(1);
        }

        // Initialize API key pool with primary key + additional keys
        this.apiKeys = [
            primaryKey,
            'AIzaSyAwwEL1GPN-bdH0wJFlJG_EugrG5do8cxM',
            'AIzaSyBPcFqnv3ZWHt-pRkGl9V_o_Sd79VNnSug',
            'AIzaSyBYxmLg3eomM-2jCOjyuM68w21QkSTfRkQ',
            'AIzaSyCjbjQNaqBttMGvk5K4W0Q9JbMQExkCI3Q',

        ];

        logger.info(`Initialized API key pool with ${this.apiKeys.length} keys`);
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
            logger.warn('All API keys have been exhausted. Will retry with delays.');
            return false;
        }

        this.currentIndex = nextIndex;
        logger.info(`Rotated to API key ${this.currentIndex + 1}/${this.apiKeys.length}`);
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
        logger.info('Reset API key rotation to start from first key');
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
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}';

export const GEMINI_VISION_MODEL = Deno.env.get('GEMINI_VISION_MODEL') ||
    'gemini-2.5-flash-preview-05-20';

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
export const AUDIO_DEBUG = Deno.env.get('AUDIO_DEBUG') === 'true';
export const AUDIO_DEBUG_DIR = Deno.env.get('AUDIO_DEBUG_DIR') || './debug_audio';
export const AUDIO_DEBUG_MAX_FILES = Number(Deno.env.get('AUDIO_DEBUG_MAX_FILES') || '50');

// TTS Provider Configuration
export type TTSProvider = 'GEMINI' | 'AZURE_TTS';

export const TTS_PROVIDER = (Deno.env.get('TTS_PROVIDER') || 'GEMINI').toUpperCase() as TTSProvider;

// Validate TTS provider
const validProviders: TTSProvider[] = ['GEMINI', 'AZURE_TTS'];
if (!validProviders.includes(TTS_PROVIDER)) {
    logger.warn(`Invalid TTS_PROVIDER: ${TTS_PROVIDER}. Falling back to GEMINI.`);
    // We can't reassign the const, but we'll handle this in the validation function
}

// Azure TTS Configuration
export const AZURE_TTS_DEFAULT_VOICE = Deno.env.get('AZURE_TTS_DEFAULT_VOICE') ||
    'zh-CN-XiaochenMultilingual';
export const AZURE_TTS_ENDPOINT = Deno.env.get('AZURE_TTS_ENDPOINT') ||
    'https://southeastasia.api.cognitive.microsoft.com';
export const AZURE_TTS_KEY = Deno.env.get('AZURE_TTS_KEY');

// STT Provider Configuration
export type STTProvider = 'GEMINI_LIVE' | 'AZURE_STT';

export const STT_PROVIDER = (Deno.env.get('STT_PROVIDER') || 'GEMINI_LIVE').toUpperCase() as STTProvider;

// Validate STT provider
const validSTTProviders: STTProvider[] = ['GEMINI_LIVE', 'AZURE_STT'];
if (!validSTTProviders.includes(STT_PROVIDER)) {
    logger.warn(`Invalid STT_PROVIDER: ${STT_PROVIDER}. Falling back to GEMINI_LIVE.`);
}

// Azure STT Configuration
export const AZURE_STT_LANGUAGE = Deno.env.get('AZURE_STT_LANGUAGE') || 'vi-VN';
export const AZURE_STT_ENDPOINT = Deno.env.get('AZURE_STT_ENDPOINT') ||
    'https://southeastasia.stt.speech.microsoft.com';
// Use AZURE_SPEECH_KEY for consistency with Azure TTS and azure_stt.ts module
export const AZURE_STT_KEY = Deno.env.get('AZURE_SPEECH_KEY');

/**
 * Get the effective TTS provider (with fallback logic)
 * @returns The TTS provider to use
 */
export function getEffectiveTTSProvider(): TTSProvider {
    if (!validProviders.includes(TTS_PROVIDER)) {
        logger.warn(`Invalid TTS_PROVIDER: ${TTS_PROVIDER}. Falling back to GEMINI.`);
        return 'GEMINI';
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
        case 'AZURE_TTS':
            return typeof AZURE_TTS_KEY === 'string' && AZURE_TTS_KEY.length > 0;
        case 'GEMINI':
            return true; // Gemini TTS is always available if Gemini API is configured
        default:
            return false;
    }
}

/**
 * Get the effective STT provider (with fallback logic)
 * @returns The STT provider to use
 */
export function getEffectiveSTTProvider(): STTProvider {
    if (!validSTTProviders.includes(STT_PROVIDER)) {
        logger.warn(`Invalid STT_PROVIDER: ${STT_PROVIDER}. Falling back to GEMINI_LIVE.`);
        return 'GEMINI_LIVE';
    }
    return STT_PROVIDER;
}

/**
 * Validate STT provider configuration
 * @param provider The STT provider to validate
 * @returns boolean indicating if the provider is properly configured
 */
export function validateSTTProvider(provider: STTProvider): boolean {
    switch (provider) {
        case 'AZURE_STT':
            return typeof AZURE_STT_KEY === 'string' && AZURE_STT_KEY.length > 0;
        case 'GEMINI_LIVE':
            return true; // Gemini Live STT is always available if Gemini API is configured
        default:
            return false;
    }
}

// WebSocket Optimization Configuration
export const WEBSOCKET_BINARY_PROTOCOL = true; // Use binary frames for reduced overhead
export const TCP_NODELAY = true; // Disable Nagle's algorithm for lower latency

// Connection Management Configuration
export const CONNECTION_RETRY_CONFIG = {
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterRange: 1000,
};

// Circuit Breaker Configuration
export const CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5, // Open circuit after 5 consecutive failures
    recoveryTimeoutMs: 60000, // 60 seconds recovery timeout
    monitoringWindowMs: 300000, // 5-minute monitoring window
};

// Keep-alive Configuration
export const KEEP_ALIVE_CONFIG = {
    intervalMs: 30000, // 30 seconds keep-alive interval
    timeoutMs: 10000, // 10 seconds timeout for keep-alive response
};

// Session Resumption Configuration
export const SESSION_RESUMPTION_CONFIG = {
    enabled: Deno.env.get('ENABLE_SESSION_RESUMPTION') !== 'false', // Enabled by default, set to 'false' to disable
    timeoutMs: Number(Deno.env.get('SESSION_RESUMPTION_TIMEOUT_MS') || '300000'), // 5 minutes default
};

// Server Configuration
export const HOST = Deno.env.get('HOST') || '0.0.0.0';
// Default to 8080 unless DEV_MODE is true, then default to 1234
export const PORT = Number(Deno.env.get('PORT') || (isDev ? 1234 : 8080));

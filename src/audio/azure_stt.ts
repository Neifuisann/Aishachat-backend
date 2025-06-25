// ---------------------------------------------------------------------------
//  Azure Speech‑to‑Text helper for AISHA            ©2025 aishaai / MIT‐0
// ---------------------------------------------------------------------------
//  Environment variables required
//   • AZURE_SPEECH_KEY      – Primary or secondary key of your Speech resource
//   • AZURE_SPEECH_ENDPOINT – https://southeastasia.api.cognitive.microsoft.com
//
//  This module provides Azure Speech-to-Text functionality for real-time
//  audio transcription to work with Flash 2.5 model.
// ---------------------------------------------------------------------------

import { Logger } from '../utils/logger.ts';
import { MIC_SAMPLE_RATE } from '../config/config.ts';
import { VoiceActivityDetector, VADProcessResult } from './vad.ts';
import { VADConfig, VADState } from './vad_config.ts';

const log = new Logger('[AzureSTT]');

// ---- constants ------------------------------------------------------------
const ENDPOINT = (Deno.env.get('AZURE_STT_ENDPOINT') ??
    'https://southeastasia.stt.speech.microsoft.com').replace(/\/$/, '');
const KEY = Deno.env.get('AZURE_SPEECH_KEY') ?? '';
const DEFAULT_LANGUAGE = 'vi-VN'; // Vietnamese as default based on system prompt
const RECOGNITION_MODE = 'conversation'; // conversation, dictation, or interactive

// ---- types ----------------------------------------------------------------
export interface AzureSTTConfig {
    language?: string;
    profanityOption?: 'masked' | 'removed' | 'raw';
    outputFormat?: 'simple' | 'detailed';
    enableWordLevelTimestamps?: boolean;
    enableDiarization?: boolean;
    enableVAD?: boolean;
    vadConfig?: VADConfig;
}

export interface AzureSTTResponse {
    success: boolean;
    text?: string;
    confidence?: number;
    error?: string;
    isFinal?: boolean;
}

export interface AzureSTTStreamingResponse {
    success: boolean;
    text?: string;
    confidence?: number;
    error?: string;
    isFinal?: boolean;
    offset?: number;
    duration?: number;
}

// ---- validation -----------------------------------------------------------
export function validateAzureSTTConfig(): boolean {
    if (!KEY) {
        log.error('AZURE_SPEECH_KEY is not set');
        return false;
    }
    if (!ENDPOINT) {
        log.error('AZURE_SPEECH_ENDPOINT is not set');
        return false;
    }
    return true;
}

// ---- helpers --------------------------------------------------------------
function buildRecognitionUrl(config: AzureSTTConfig = {}): string {
    const params = new URLSearchParams({
        'language': config.language || DEFAULT_LANGUAGE,
        'format': config.outputFormat || 'simple',
        'profanity': config.profanityOption || 'raw',
    });

    if (config.enableWordLevelTimestamps) {
        params.set('wordLevelTimestamps', 'true');
    }

    if (config.enableDiarization) {
        params.set('diarization', 'true');
    }

    // Use the Azure Speech STT API path format for short audio
    // Reference: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
    return `${ENDPOINT}/speech/recognition/${RECOGNITION_MODE}/cognitiveservices/v1?${params.toString()}`;
}

function buildHeaders(): Record<string, string> {
    return {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': `audio/wav; codecs=audio/pcm; samplerate=${MIC_SAMPLE_RATE}`,
        'Accept': 'application/json',
        'User-Agent': 'AISHA/azure-stt',
    };
}

// Convert PCM audio data to WAV format for Azure STT
function pcmToWav(pcmData: Uint8Array, sampleRate: number = MIC_SAMPLE_RATE): Uint8Array {
    const length = pcmData.length;
    const arrayBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(arrayBuffer);
    
    // WAV header
    const writeString = (offset: number, string: string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, length, true);
    
    // Copy PCM data
    const wavData = new Uint8Array(arrayBuffer);
    wavData.set(pcmData, 44);
    
    return wavData;
}

// ---- public API -----------------------------------------------------------
export async function convertSpeechToText(
    audioData: Uint8Array,
    config: AzureSTTConfig = {}
): Promise<AzureSTTResponse> {
    try {
        if (!validateAzureSTTConfig()) {
            return { success: false, error: 'Azure STT configuration is invalid' };
        }

        const wavData = pcmToWav(audioData);
        const url = buildRecognitionUrl(config);

        log.info(`Converting speech to text with Azure STT (${audioData.length} bytes PCM -> ${wavData.length} bytes WAV)`);

        const response = await fetch(url, {
            method: 'POST',
            headers: buildHeaders(),
            body: wavData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Azure STT HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        
        if (result.RecognitionStatus === 'Success') {
            return {
                success: true,
                text: result.DisplayText || result.NBest?.[0]?.Display || '',
                confidence: result.NBest?.[0]?.Confidence || 1.0,
                isFinal: true,
            };
        } else {
            return {
                success: false,
                error: `Recognition failed: ${result.RecognitionStatus}`,
            };
        }
    } catch (error) {
        log.error('Error in convertSpeechToText:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// ---- streaming API --------------------------------------------------------
export class AzureSTTStreaming {
    private config: AzureSTTConfig;
    private onResult: (result: AzureSTTStreamingResponse) => void;
    private onError: (error: string) => void;
    private isConnected = false;
    private audioBuffer: Uint8Array = new Uint8Array(0);

    constructor(
        config: AzureSTTConfig = {},
        onResult: (result: AzureSTTStreamingResponse) => void,
        onError: (error: string) => void = (err) => log.error('STT Error:', err)
    ) {
        this.config = config;
        this.onResult = onResult;
        this.onError = onError;
    }

    async connect(): Promise<boolean> {
        try {
            if (!validateAzureSTTConfig()) {
                this.onError('Azure STT configuration is invalid');
                return false;
            }

            // For now, we'll use batch processing instead of streaming WebSocket
            // This is more reliable and easier to implement
            log.info('Azure STT Manager ready for batch processing');
            this.isConnected = true;
            return true;
        } catch (error) {
            log.error('Error initializing Azure STT:', error);
            this.onError(error instanceof Error ? error.message : String(error));
            return false;
        }
    }



    sendAudio(audioData: Uint8Array): void {
        if (!this.isConnected) {
            log.warn(`🎤 Azure STT Streaming: Cannot send audio - not connected`);
            return;
        }

        // Buffer audio data for batch processing
        const newBuffer = new Uint8Array(this.audioBuffer.length + audioData.length);
        newBuffer.set(this.audioBuffer);
        newBuffer.set(audioData, this.audioBuffer.length);
        this.audioBuffer = newBuffer;

        //log.info(`🎤 Azure STT Streaming: Buffered ${audioData.length} bytes, total buffer: ${this.audioBuffer.length} bytes`);
    }

    async finishAudio(): Promise<void> {
        if (!this.isConnected) {
            log.warn(`🎤 Azure STT Streaming: Cannot finish audio - not connected`);
            return;
        }

        // Process all buffered audio with batch recognition
        if (this.audioBuffer.length > 0) {
            log.info(`🎤 Azure STT Streaming: Processing ${this.audioBuffer.length} bytes of buffered audio`);
            try {
                const result = await convertSpeechToText(this.audioBuffer, this.config);
                if (result.success && result.text) {
                    log.info(`🎤 Azure STT Streaming: Got transcription result: "${result.text}"`);
                    this.onResult({
                        success: true,
                        text: result.text,
                        confidence: result.confidence || 1.0,
                        isFinal: true,
                    });
                } else {
                    log.warn(`🎤 Azure STT Streaming: No transcription result - ${result.error || 'unknown error'}`);

                    // If Azure STT returns 404, suggest fallback to Gemini Live
                    if (result.error && result.error.includes('404')) {
                        log.error(`🔄 Azure STT API endpoint not available (404). Consider using Gemini Live STT as fallback.`);
                        log.error(`💡 To use Gemini Live STT: Set STT_PROVIDER=GEMINI_LIVE in your .env file`);
                    }

                    // Still call onResult with empty text so it gets passed to Flash 2.5
                    // This allows Flash 2.5 to handle the empty input appropriately
                    this.onResult({
                        success: true,
                        text: '',
                        confidence: 0.0,
                        isFinal: true,
                    });
                }
            } catch (error) {
                log.error(`🎤 Azure STT Streaming: Error processing audio:`, error);
                this.onError(error instanceof Error ? error.message : String(error));
            }
            this.audioBuffer = new Uint8Array(0);
        } else {
            log.info(`🎤 Azure STT Streaming: No buffered audio to process`);
        }
    }

    disconnect(): void {
        this.isConnected = false;
        this.audioBuffer = new Uint8Array(0);
    }

    isReady(): boolean {
        return this.isConnected;
    }
}

// ---- STT Manager for integration with Flash 2.5 -------------------------
export class AzureSTTManager {
    private streaming: AzureSTTStreaming | null = null;
    private audioBuffer: Uint8Array = new Uint8Array(0);
    private onTranscriptionCallback: (text: string, isFinal: boolean) => void;
    private onErrorCallback: (error: string) => void;
    private onResponseCreatedCallback?: () => void;
    private config: AzureSTTConfig;
    private readonly BUFFER_THRESHOLD = 16000; // 1 second at 16kHz
    private speechTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private readonly SPEECH_TIMEOUT_MS = 2000; // 2 seconds of silence before processing

    // VAD support (enabled by default)
    private vad: VoiceActivityDetector | null = null;
    private vadEnabled: boolean = true;
    private lastVadState: VADState = VADState.VAD_SILENCE;

    constructor(
        onTranscription: (text: string, isFinal: boolean) => void,
        onError: (error: string) => void = (err) => log.error('STT Manager Error:', err),
        config: AzureSTTConfig = {},
        onResponseCreated?: () => void
    ) {
        this.onTranscriptionCallback = onTranscription;
        this.onErrorCallback = onError;
        this.onResponseCreatedCallback = onResponseCreated;
        this.config = { language: 'vi-VN', enableVAD: true, ...config };

        // Initialize VAD (enabled by default)
        this.vadEnabled = this.config.enableVAD !== false; // Allow explicit disable
        if (this.vadEnabled) {
            this.vad = new VoiceActivityDetector(this.config.vadConfig || new VADConfig());
            log.info('VAD enabled for Azure STT Manager');
        }
    }

    async initialize(): Promise<boolean> {
        try {
            if (!validateAzureSTTConfig()) {
                this.onErrorCallback('Azure STT configuration is invalid');
                return false;
            }

            this.streaming = new AzureSTTStreaming(
                this.config,
                (result) => this.handleSTTResult(result),
                (error) => this.onErrorCallback(error)
            );

            const connected = await this.streaming.connect();
            if (connected) {
                log.info('Azure STT Manager initialized successfully');
                return true;
            } else {
                this.onErrorCallback('Failed to connect to Azure STT');
                return false;
            }
        } catch (error) {
            this.onErrorCallback(error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    private handleSTTResult(result: AzureSTTStreamingResponse) {
        if (result.success) {
            // Handle both non-empty and empty text results
            const text = result.text || '';
            log.info(`STT Result: "${text}" (final: ${result.isFinal})`);
            this.onTranscriptionCallback(text, result.isFinal || false);
        }
    }

    addAudioChunk(audioChunk: Uint8Array): void {
        if (!this.streaming || !this.streaming.isReady()) {
            log.warn(`🎤 Azure STT: Cannot add audio chunk - streaming not ready (streaming: ${!!this.streaming}, ready: ${this.streaming?.isReady()})`);
            return;
        }

        // Process with VAD if enabled
        if (this.vadEnabled && this.vad) {
            const vadResult = this.vad.processFrame(audioChunk);
            const currentVadState = this.vad.getState();

            // If VAD says we should send prefix buffer, add it to our buffer
            if (vadResult.sendPrefixBuffer && vadResult.prefixFrames) {
                log.info(`🎤 Azure STT VAD: Speech detected, adding prefix buffer (${vadResult.prefixFrames.length} bytes)`);
                const newBuffer = new Uint8Array(this.audioBuffer.length + vadResult.prefixFrames.length);
                newBuffer.set(this.audioBuffer);
                newBuffer.set(vadResult.prefixFrames, this.audioBuffer.length);
                this.audioBuffer = newBuffer;
            }

            // Detect speech end by checking state transition from speech to silence
            const speechEnded = (this.lastVadState === VADState.VAD_SPEECH_ACTIVE || this.lastVadState === VADState.VAD_SPEECH_START) &&
                               currentVadState === VADState.VAD_SILENCE;

            // Update last VAD state
            this.lastVadState = currentVadState;

            // Only continue processing if VAD says we should transmit
            if (!vadResult.shouldTransmit) {
                // If VAD detects end of speech and we have buffered audio, process it
                if (speechEnded && this.audioBuffer.length > 0) {
                    log.info(`🎤 Azure STT VAD: Speech ended, processing buffered audio (${this.audioBuffer.length} bytes)`);
                    this.finishSpeech();
                }
                return; // VAD says no speech, skip processing
            }

            //log.info(`🎤 Azure STT VAD: Transmitting audio chunk (${audioChunk.length} bytes), VAD state: ${currentVadState}`);
        }

        // Clear any existing timeout
        if (this.speechTimeoutId !== null) {
            clearTimeout(this.speechTimeoutId);
        }

        // Buffer audio data
        const newBuffer = new Uint8Array(this.audioBuffer.length + audioChunk.length);
        newBuffer.set(this.audioBuffer);
        newBuffer.set(audioChunk, this.audioBuffer.length);
        this.audioBuffer = newBuffer;

        //log.info(`🎤 Azure STT: Added audio chunk: ${audioChunk.length} bytes, buffer size: ${this.audioBuffer.length}/${this.BUFFER_THRESHOLD}`);

        // Send buffered audio when threshold is reached
        if (this.audioBuffer.length >= this.BUFFER_THRESHOLD) {
            //log.info(`🎤 Azure STT: Buffer threshold reached, sending audio to Azure (${this.audioBuffer.length} bytes)`);
            this.streaming.sendAudio(this.audioBuffer);
            this.audioBuffer = new Uint8Array(0);
        }

        // Set timeout to process audio if no new chunks arrive (speech ended)
        // This acts as a fallback if VAD doesn't detect speech end properly
        this.speechTimeoutId = setTimeout(() => {
            log.info(`🎤 Azure STT: Speech timeout reached, processing buffered audio`);
            this.finishSpeech();
        }, this.SPEECH_TIMEOUT_MS);
    }

    finishSpeech(): void {
        // Clear any pending timeout
        if (this.speechTimeoutId !== null) {
            clearTimeout(this.speechTimeoutId);
            this.speechTimeoutId = null;
        }

        // Process any remaining buffered audio
        if (this.streaming && this.streaming.isReady()) {
            this.streaming.finishAudio();
        }
    }

    // Process accumulated audio for batch recognition
    async processAccumulatedAudio(audioData: Uint8Array): Promise<string | null> {
        try {
            if (!validateAzureSTTConfig()) {
                this.onErrorCallback('Azure STT configuration is invalid');
                return null;
            }

            log.info(`Processing ${audioData.length} bytes of accumulated audio`);
            const result = await convertSpeechToText(audioData, this.config);

            if (result.success && result.text) {
                log.info(`Batch STT Result: "${result.text}"`);
                return result.text;
            } else {
                this.onErrorCallback(result.error || 'Unknown STT error');
                return null;
            }
        } catch (error) {
            this.onErrorCallback(error instanceof Error ? error.message : String(error));
            return null;
        }
    }

    disconnect(): void {
        if (this.streaming) {
            this.streaming.disconnect();
            this.streaming = null;
        }
        this.audioBuffer = new Uint8Array(0);
        log.info('Azure STT Manager disconnected');
    }

    isReady(): boolean {
        return this.streaming?.isReady() || false;
    }

    // VAD control methods
    enableVAD(vadConfig?: VADConfig): void {
        this.vadEnabled = true;
        this.vad = new VoiceActivityDetector(vadConfig || new VADConfig());
        log.info('VAD enabled for Azure STT Manager');
    }

    disableVAD(): void {
        this.vadEnabled = false;
        this.vad = null;
        log.info('VAD disabled for Azure STT Manager');
    }

    isVADEnabled(): boolean {
        return this.vadEnabled;
    }

    getVADState(): number | null {
        return this.vad?.getState() || null;
    }

    getVADEnergy(): number | null {
        return this.vad?.getCurrentEnergy() || null;
    }

    startVADCalibration(durationMs: number = 5000): void {
        if (this.vad) {
            this.vad.startCalibration(durationMs);
            log.info(`Started VAD calibration for ${durationMs}ms`);
        } else {
            log.warn('Cannot start VAD calibration - VAD not enabled');
        }
    }

    setVADThresholds(speechThreshold: number, silenceThreshold: number): void {
        if (this.vad) {
            this.vad.setThresholds(speechThreshold, silenceThreshold);
            log.info(`Updated VAD thresholds: speech=${speechThreshold}, silence=${silenceThreshold}`);
        } else {
            log.warn('Cannot set VAD thresholds - VAD not enabled');
        }
    }

    printVADDebugInfo(): void {
        if (this.vad) {
            this.vad.printDebugInfo();
        } else {
            log.info('VAD Debug: VAD not enabled');
        }
    }
}

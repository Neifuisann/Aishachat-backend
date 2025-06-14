import { Buffer } from 'node:buffer';
import { WebSocket as WSWebSocket } from 'npm:ws';
import type { RawData, WebSocketServer as _WSS } from 'npm:ws';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// Import configurations and utilities
import {
    ADPCM_BUFFER_SIZE,
    ADPCM_ENABLED,
    apiKeyManager,
    GEMINI_LIVE_URL_TEMPLATE,
    IMAGE_CHUNK_TIMEOUT_MS,
    MIC_ACCUM_CHUNK_SIZE,
    MIC_INPUT_GAIN,
    MIC_SAMPLE_RATE,
    SESSION_RESUMPTION_CONFIG,
    TTS_PROVIDER,
    TTS_SAMPLE_RATE,
} from './config.ts';

import { AudioFilter, boostTtsVolumeInPlace, ttsState } from './audio.ts';

import { ADPCMStreamProcessor } from './adpcm.ts';
import { audioDebugManager } from './audio_debug.ts';
import { SetVolume } from './volume_handler.ts';
import { isValidJpegBase64 } from './image_utils.ts';
import { Logger } from './logger.ts';

// TTS imports
import {
    convertTextToSpeechStreaming as convertAzureTTSStreaming,
    validateAzureTTSConfig,
    DEFAULT_VOICE,
    type AzureTTSRequest,
} from './azure_tts.ts';

// Flash handler imports
import {
    createFlash25Session,
    destroyFlash25Session,
    type DeviceOperationCallbacks,
    processUserActionWithSession,
} from './flash_handler.ts';

// Supabase imports
import {
    addConversation,
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getDeviceInfo,
    updateUserSessionTime,
} from './supabase.ts';

// ===== Type Definitions =====

interface ConnectionContext {
    user: any; // Consider defining a stricter type for user
    supabase: SupabaseClient;
    timestamp: string;
}

interface ChunkAssembly {
    chunks: Map<number, string>;
    totalChunks: number;
    receivedCount: number;
    timestamp: number;
    mime?: string;
}

interface PendingVisionCall {
    prompt: string;
    id?: string;
    resolve?: (value: any) => void;
}

interface ConnectionState {
    pipelineActive: boolean;
    deviceClosed: boolean;
    isGeminiConnected: boolean;
    sessionStartTime: number;
    retryCount: number;
    retryTimeoutId: ReturnType<typeof setTimeout> | null;
    keepAliveIntervalId: ReturnType<typeof setInterval> | null;
    sessionId: string;
}

interface ResumableSessionData {
    sessionId: string;
    userId: string;
    timestamp: Date;
    errorType: 'device_error' | 'gemini_error' | 'quota_exceeded' | 'connection_failed';
    errorMessage: string;
    sessionContext?: any;
}

interface AudioState {
    micAccum: Uint8Array;
    lastCompressionRatio: number | undefined;
    micFilter: AudioFilter;
    ttsFilter: AudioFilter;
    adpcmProcessor: ADPCMStreamProcessor;
}

interface TTSState {
    responseCreatedSent: boolean;
    ttsTextBuffer: string;
    ttsTimeout: number | null;
    toolCallInProgress: boolean;
}

interface ImageCaptureState {
    pendingVisionCall: PendingVisionCall | null;
    waitingForImage: boolean;
    photoCaptureFailed: boolean;
    imageTimeoutId: ReturnType<typeof setTimeout> | null;
    imageChunkAssembly: ChunkAssembly | null;
    chunkTimeoutId: ReturnType<typeof setTimeout> | null;
}

// ===== Constants =====

const MAX_RETRIES = 10; // Increased for robust connection handling
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 60000, 120000, 180000, 300000]; // Exponential backoff
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const TTS_DELAY_MS = 100; // Wait 100ms after last generation complete before triggering TTS

// Session resumption configuration (from config.ts)
const ENABLE_SESSION_RESUMPTION = SESSION_RESUMPTION_CONFIG.enabled;
const SESSION_RESUMPTION_TIMEOUT_MS = SESSION_RESUMPTION_CONFIG.timeoutMs;

// ===== Session Error Tracker =====

class SessionErrorTracker {
    private static instance: SessionErrorTracker;
    private resumableSessions: Map<string, ResumableSessionData> = new Map();
    private logger = new Logger('[SessionErrorTracker]');

    static getInstance(): SessionErrorTracker {
        if (!SessionErrorTracker.instance) {
            SessionErrorTracker.instance = new SessionErrorTracker();
        }
        return SessionErrorTracker.instance;
    }

    saveSessionForResumption(
        userId: string,
        sessionId: string,
        errorType: ResumableSessionData['errorType'],
        errorMessage: string,
        sessionContext?: any
    ): void {
        if (!ENABLE_SESSION_RESUMPTION) {
            return;
        }

        const resumableData: ResumableSessionData = {
            sessionId,
            userId,
            timestamp: new Date(),
            errorType,
            errorMessage,
            sessionContext,
        };

        this.resumableSessions.set(userId, resumableData);
        this.logger.info(
            `Saved session ${truncateSessionId(sessionId)} for user ${userId} due to ${errorType}: ${errorMessage}`
        );

        // Clean up old sessions after timeout
        setTimeout(() => {
            if (this.resumableSessions.get(userId)?.sessionId === sessionId) {
                this.resumableSessions.delete(userId);
                this.logger.info(`Expired resumable session ${truncateSessionId(sessionId)} for user ${userId}`);
            }
        }, SESSION_RESUMPTION_TIMEOUT_MS);
    }

    getResumableSession(userId: string): ResumableSessionData | null {
        const resumableData = this.resumableSessions.get(userId);
        if (!resumableData) {
            return null;
        }

        // Check if session has expired
        const now = new Date();
        const sessionAge = now.getTime() - resumableData.timestamp.getTime();
        if (sessionAge > SESSION_RESUMPTION_TIMEOUT_MS) {
            this.resumableSessions.delete(userId);
            this.logger.info(`Resumable session expired for user ${userId}`);
            return null;
        }

        return resumableData;
    }

    clearResumableSession(userId: string): void {
        const resumableData = this.resumableSessions.get(userId);
        if (resumableData) {
            this.resumableSessions.delete(userId);
            this.logger.info(
                `Cleared resumable session ${truncateSessionId(resumableData.sessionId)} for user ${userId}`
            );
        }
    }

    hasResumableSession(userId: string): boolean {
        return this.getResumableSession(userId) !== null;
    }
}

// ===== Utility Functions =====

function truncateSessionId(sessionId: string): string {
    if (sessionId.startsWith('live-')) {
        const parts = sessionId.split('-');
        if (parts.length >= 3) {
            return `${parts[0]}-${parts[1]}...`;
        }
    }
    return sessionId.length > 20 ? sessionId.substring(0, 20) + '...' : sessionId;
}

function extractUserCommand(functionCalls: any[]): string {
    const transferModalCall = functionCalls.find(call => call.name === 'transferModal');
    return transferModalCall?.args?.userCommand || 'N/A';
}

function extractResult(responsePayload: any): string {
    const response = responsePayload?.functionResponses?.[0]?.response?.result;
    if (!response) return 'N/A';
    return response;
}

class TTSManager {
    private logger = new Logger('[TTS]');
    private ttsState: TTSState;
    private deviceWs: WSWebSocket;
    private user: any;
    private ttsFilter: AudioFilter | null = null;

    constructor(deviceWs: WSWebSocket, user: any, ttsState: TTSState) {
        this.deviceWs = deviceWs;
        this.user = user;
        this.ttsState = ttsState;
    }

    setTtsFilter(ttsFilter: AudioFilter) {
        this.ttsFilter = ttsFilter;
    }

    isExternalTTSEnabled(): boolean {
        return TTS_PROVIDER !== 'GEMINI';
    }

    async processPartialText(text: string) {
        if (!this.isExternalTTSEnabled()) {
            return;
        }

        // Simply accumulate text for batch processing - no sentence-level complexity
        this.ttsState.ttsTextBuffer += text;
    }

    async processTextWithTTSStreaming(
        text: string,
        onAudioChunk: (chunk: Uint8Array) => Promise<void>,
    ) {
        switch (TTS_PROVIDER) {
            case 'AZURE_TTS':
                if (!validateAzureTTSConfig()) {
                    this.logger.error(
                        'Azure TTS is enabled but not properly configured. Falling back to Gemini audio.',
                    );
                    return null;
                }
                const azureTTSVoice = this.user.personality?.azure_tts_voice || DEFAULT_VOICE;
                this.logger.info(`Azure TTS: Processing text "${text}" with voice "${azureTTSVoice}"`);

                const request: AzureTTSRequest = {
                    text: text,
                    voice: azureTTSVoice,
                };

                try {
                    const result = await convertAzureTTSStreaming(request, onAudioChunk);
                    if (result.success) {
                        this.logger.info(`Azure TTS: Successfully processed text "${text}"`);
                        return { success: true };
                    } else {
                        this.logger.error(`Azure TTS: Failed to process text "${text}": ${result.error}`);
                        return { success: false, error: result.error };
                    }
                } catch (error) {
                    this.logger.error(`Azure TTS: Failed to process text "${text}":`, error);
                    return { success: false, error: error instanceof Error ? error.message : String(error) };
                }

            case 'GEMINI':
            default:
                return null;
        }
    }

    async processTTSWithDelay(
        _ttsFilter: AudioFilter,
        _supabase: SupabaseClient,
        _userId: string,
    ) {
        if (!this.ttsState.ttsTextBuffer.trim()) {
            this.logger.info('TTS delay timeout reached, but no text to process');
            return;
        }

        try {
            this.logger.info(
                `${TTS_PROVIDER} TTS: Processing delayed text (${this.ttsState.ttsTextBuffer.length} chars)`,
            );

            // Send RESPONSE.CREATED before starting TTS processing
            if (
                !this.ttsState.responseCreatedSent && this.deviceWs.readyState === WSWebSocket.OPEN
            ) {
                this.ttsState.responseCreatedSent = true;
                this.logger.info('Device => Sent RESPONSE.CREATED (delayed TTS)');
            }

            // Use streaming for real-time audio processing
            const ttsResult = await this.processTextWithTTSStreaming(
                this.ttsState.ttsTextBuffer.trim(),
                async (audioChunk: Uint8Array) => {
                    try {
                        const pcmData = Buffer.from(audioChunk);
                        if (this.ttsFilter) {
                            this.ttsFilter.processAudioInPlace(pcmData);
                        }
                        boostTtsVolumeInPlace(pcmData, 3.0);

                        const opusFrames = await ttsState.encodePcmChunk(pcmData);

                        for (const frame of opusFrames) {
                            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                                this.deviceWs.send(frame);
                            } else {
                                this.logger.warn(
                                    'Device WS closed while sending TTS frames. Aborting send.',
                                );
                                break;
                            }
                        }
                    } catch (error) {
                        this.logger.error('Error processing TTS audio chunk:', error);
                    }
                },
            );

            if (!ttsResult) {
                this.logger.error(
                    `${TTS_PROVIDER} TTS: Provider not properly configured or failed to initialize`,
                );
            } else if (!ttsResult.success) {
                this.logger.error(`${TTS_PROVIDER} TTS failed:`, ttsResult.error);
            } else {
                this.logger.info(`${TTS_PROVIDER} TTS streaming completed successfully`);
            }
        } catch (error) {
            this.logger.error(`Error processing ${TTS_PROVIDER} TTS:`, error);
        }

        // Clear the text buffer and reset state
        this.ttsState.ttsTextBuffer = '';
        this.ttsState.ttsTimeout = null;

        // Note: RESPONSE.COMPLETE will be sent by the caller (GeminiConnectionManager)
    }


}

// ===== Image Handler =====

class ImageHandler {
    private logger = new Logger('[Image]');
    private supabase: SupabaseClient;
    private user: any;
    private imageState: ImageCaptureState;

    constructor(supabase: SupabaseClient, user: any, imageState: ImageCaptureState) {
        this.supabase = supabase;
        this.user = user;
        this.imageState = imageState;
    }

    async processCompleteImage(
        base64Jpeg: string,
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean,
    ) {
        if (!base64Jpeg || typeof base64Jpeg !== 'string') {
            this.logger.error("Received image data but 'data' field is missing or not a string.");
            this.handleImageError(
                geminiWs,
                isGeminiConnected,
                'Failed to receive valid image data from device.',
            );
            return;
        }

        this.imageState.waitingForImage = false;

        // Clear timeout since we received the image
        if (this.imageState.imageTimeoutId) {
            clearTimeout(this.imageState.imageTimeoutId);
            this.imageState.imageTimeoutId = null;
        }

        // Return image data to Flash 2.5's GetVision function via callback
        if (this.imageState.pendingVisionCall?.resolve) {
            try {
                this.logger.info(
                    `Image captured successfully (${
                        Math.round(base64Jpeg.length * 3 / 4 / 1024)
                    } KB), returning to Flash 2.5`,
                );
                this.imageState.pendingVisionCall.resolve({
                    success: true,
                    imageData: base64Jpeg,
                    message: 'Image captured successfully',
                });
            } catch (error) {
                this.logger.error('Error returning image to Flash 2.5:', error);
                this.imageState.pendingVisionCall.resolve?.({
                    success: false,
                    message: 'Error processing captured image: ' +
                        (error instanceof Error ? error.message : String(error)),
                });
            }
        } else {
            this.logger.error(
                'No pending vision call or resolve function found - image will not be processed',
            );
        }

        // Upload to Supabase Storage
        await this.uploadImageToStorage(base64Jpeg);

        // Clear the pending call
        this.imageState.pendingVisionCall = null;
    }

    private async uploadImageToStorage(base64Jpeg: string) {
        try {
            this.logger.info(
                `Received image data (${
                    Math.round(base64Jpeg.length * 3 / 4 / 1024)
                } KB), attempting upload...`,
            );
            const imageBuffer = Buffer.from(base64Jpeg, 'base64');
            const fileName = `private/${this.user.user_id}/${Date.now()}.jpg`;
            const bucketName = 'images';

            const { data: uploadData, error: uploadError } = await this.supabase
                .storage
                .from(bucketName)
                .upload(fileName, imageBuffer, {
                    contentType: 'image/jpeg',
                    upsert: true,
                });

            if (uploadError) {
                this.logger.error(
                    `Supabase Storage Error: Failed to upload image to ${bucketName}/${fileName}`,
                    uploadError,
                );
                this.imageState.photoCaptureFailed = true;
            } else if (uploadData) {
                this.logger.info(
                    `Supabase Storage: Image successfully uploaded to ${bucketName}/${uploadData.path}`,
                );
            }
        } catch (storageErr) {
            this.logger.error('Supabase Storage: Unexpected error during upload:', storageErr);
            this.imageState.photoCaptureFailed = true;
        }
    }

    private handleImageError(
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean,
        errorMessage: string,
    ) {
        this.imageState.waitingForImage = false;
        this.imageState.photoCaptureFailed = true;

        if (
            isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN &&
            this.imageState.pendingVisionCall?.id
        ) {
            const functionResponsePayload = {
                functionResponses: [{
                    id: this.imageState.pendingVisionCall.id,
                    name: 'GetVision',
                    response: { result: errorMessage },
                }],
            };
            const functionResponse = { toolResponse: functionResponsePayload };
            try {
                geminiWs.send(JSON.stringify(functionResponse));
                this.logger.info('Gemini Live => Sent Function Response (Image Error)');
            } catch (err) {
                this.logger.error('Failed to send error function response to Gemini:', err);
            }
        }
        this.imageState.pendingVisionCall = null;
    }

    handleImageChunk(msgObj: any, geminiWs: WSWebSocket | null, isGeminiConnected: boolean) {
        this.logger.info(`Received image chunk ${msgObj.chunk_index + 1}/${msgObj.total_chunks}`);

        if (!this.imageState.waitingForImage || !this.imageState.pendingVisionCall) {
            this.logger.warn('Received image chunk but not waiting for image. Ignoring.');
            return;
        }

        // Initialize chunk assembly if this is the first chunk
        if (!this.imageState.imageChunkAssembly) {
            this.imageState.imageChunkAssembly = {
                chunks: new Map(),
                totalChunks: msgObj.total_chunks,
                receivedCount: 0,
                timestamp: Date.now(),
            };

            // Set timeout for chunk assembly
            this.imageState.chunkTimeoutId = setTimeout(() => {
                this.logger.error(
                    `Image chunk assembly timeout after ${IMAGE_CHUNK_TIMEOUT_MS}ms. Received ${this.imageState.imageChunkAssembly?.receivedCount}/${this.imageState.imageChunkAssembly?.totalChunks} chunks.`,
                );
                this.handleChunkTimeout(geminiWs, isGeminiConnected);
            }, IMAGE_CHUNK_TIMEOUT_MS);
        }

        // Store the chunk
        this.imageState.imageChunkAssembly.chunks.set(msgObj.chunk_index, msgObj.data);
        this.imageState.imageChunkAssembly.receivedCount++;

        this.logger.info(
            `Stored chunk ${msgObj.chunk_index}, total received: ${this.imageState.imageChunkAssembly.receivedCount}/${this.imageState.imageChunkAssembly.totalChunks}`,
        );

        // Check if we have all chunks
        if (
            this.imageState.imageChunkAssembly.receivedCount ===
                this.imageState.imageChunkAssembly.totalChunks
        ) {
            this.assembleCompleteImage(geminiWs, isGeminiConnected);
        }
    }

    private async assembleCompleteImage(geminiWs: WSWebSocket | null, isGeminiConnected: boolean) {
        this.logger.info('All chunks received, assembling image...');

        // Clear timeout
        if (this.imageState.chunkTimeoutId) {
            clearTimeout(this.imageState.chunkTimeoutId);
            this.imageState.chunkTimeoutId = null;
        }

        // Assemble the complete base64 image
        let completeBase64 = '';
        for (let i = 0; i < this.imageState.imageChunkAssembly!.totalChunks; i++) {
            const chunk = this.imageState.imageChunkAssembly!.chunks.get(i);
            if (!chunk) {
                this.logger.error(`Missing chunk ${i} during assembly!`);
                this.imageState.imageChunkAssembly = null;
                this.imageState.waitingForImage = false;
                this.imageState.pendingVisionCall = null;
                return;
            }
            completeBase64 += chunk;
        }

        this.logger.info(`Image assembly complete - ${completeBase64.length} characters`);

        // Clean up chunk assembly
        this.imageState.imageChunkAssembly = null;

        // Process the complete image
        await this.processCompleteImage(completeBase64, geminiWs, isGeminiConnected);
    }

    private handleChunkTimeout(geminiWs: WSWebSocket | null, isGeminiConnected: boolean) {
        this.imageState.imageChunkAssembly = null;
        this.imageState.waitingForImage = false;

        if (
            isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN &&
            this.imageState.pendingVisionCall?.id
        ) {
            const functionResponsePayload = {
                functionResponses: [{
                    id: this.imageState.pendingVisionCall.id,
                    name: 'GetVision',
                    response: { result: 'Image capture failed: Incomplete chunk transmission.' },
                }],
            };
            const functionResponse = { toolResponse: functionResponsePayload };
            try {
                geminiWs.send(JSON.stringify(functionResponse));
                this.logger.info('Gemini Live => Sent chunk timeout error response');
            } catch (err) {
                this.logger.error('Failed to send chunk timeout error response to Gemini:', err);
            }
        }

        this.imageState.pendingVisionCall = null;
        this.imageState.chunkTimeoutId = null;
    }
}

// ===== Gemini Connection Manager =====

class GeminiConnectionManager {
    private logger = new Logger('[Gemini]');
    private context: ConnectionContext;
    private connectionState: ConnectionState;
    private audioState: AudioState;
    private ttsState: TTSState;
    private imageState: ImageCaptureState;
    private deviceWs: WSWebSocket;
    private geminiWs: WSWebSocket | null = null;
    private ttsManager: TTSManager;
    public imageHandler: ImageHandler;
    public deviceCallbacks: DeviceOperationCallbacks;

    constructor(
        context: ConnectionContext,
        deviceWs: WSWebSocket,
        connectionState: ConnectionState,
        audioState: AudioState,
        ttsState: TTSState,
        imageState: ImageCaptureState,
    ) {
        this.context = context;
        this.deviceWs = deviceWs;
        this.connectionState = connectionState;
        this.audioState = audioState;
        this.ttsState = ttsState;
        this.imageState = imageState;
        this.ttsManager = new TTSManager(deviceWs, context.user, ttsState);
        this.ttsManager.setTtsFilter(audioState.ttsFilter);
        this.imageHandler = new ImageHandler(context.supabase, context.user, imageState);

        // Create device operation callbacks
        this.deviceCallbacks = {
            requestPhoto: this.requestPhoto.bind(this),
            setVolume: this.setVolume.bind(this),
        };
    }

    private async requestPhoto(callId: string): Promise<any> {
        return new Promise((resolve) => {
            if (this.imageState.waitingForImage) {
                resolve({
                    success: false,
                    message: 'Already waiting for an image. Please try again later.',
                });
                return;
            }

            this.imageState.pendingVisionCall = {
                prompt: 'Flash 2.5 vision request',
                id: callId,
                resolve,
            };
            this.imageState.waitingForImage = true;

            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.logger.info(
                    `Device => Sending REQUEST.PHOTO (triggered by Flash 2.5 GetVision: ${callId})`,
                );
                this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'REQUEST.PHOTO' }));
            } else {
                this.logger.error('Cannot request photo, device WS is not open.');
                this.imageState.waitingForImage = false;
                this.imageState.pendingVisionCall = null;
                resolve({
                    success: false,
                    message: 'Device connection not available for photo capture.',
                });
            }
        });
    }

    private async setVolume(volumeLevel: number, callId: string): Promise<any> {
        this.logger.info(`*SetVolume (ID: ${callId}) called with volume: ${volumeLevel}`);

        if (typeof volumeLevel !== 'number' || volumeLevel < 0 || volumeLevel > 100) {
            return {
                success: false,
                message: 'Invalid volume level. Must be a number between 0 and 100.',
            };
        }

        try {
            const volumeResult = await SetVolume(
                this.context.supabase,
                this.context.user.user_id,
                volumeLevel,
            );
            this.logger.info(`SetVolume result:`, volumeResult);
            return volumeResult;
        } catch (err) {
            this.logger.error(`Error executing SetVolume for ID ${callId}:`, err);
            return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
    }

    async connect(systemPrompt: string, firstMessage: string | null) {
        const currentKey = apiKeyManager.getCurrentKey();
        if (!currentKey) {
            this.logger.error('Cannot connect to Gemini: Missing API Key.');
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.close(1011, 'Server Configuration Error: Missing API Key');
            }
            return;
        }

        const voiceName = this.context.user.personality?.oai_voice || 'Leda';
        this.logger.info(`Using TTS voice: ${voiceName}`);
        this.logger.info(`TTS Provider: ${TTS_PROVIDER}`);

        const gemUrl = GEMINI_LIVE_URL_TEMPLATE.replace('{api_key}', currentKey);
        this.logger.info('Attempting to connect to Gemini Live');

        this.geminiWs = new WSWebSocket(gemUrl);
        this.setupGeminiEventHandlers(systemPrompt, firstMessage, voiceName);
    }

    private setupGeminiEventHandlers(
        systemPrompt: string,
        firstMessage: string | null,
        voiceName: string,
    ) {
        if (!this.geminiWs) return;

        this.geminiWs.on('open', () => {
            this.handleGeminiOpen(systemPrompt, firstMessage, voiceName);
        });

        this.geminiWs.on('message', async (data: RawData) => {
            await this.handleGeminiMessage(data);
        });

        this.geminiWs.on('close', (code, reason) => {
            this.handleGeminiClose(code, reason);
        });

        this.geminiWs.on('error', (err) => {
            this.handleGeminiError(err);
        });
    }

    private handleGeminiOpen(systemPrompt: string, firstMessage: string | null, voiceName: string) {
        this.connectionState.isGeminiConnected = true;
        this.connectionState.sessionStartTime = Date.now();
        this.logger.info('Gemini Live connection established.');
        this.logger.info('Legacy (Flash 2.5 API as base)');

        // Clear any resumable session since we successfully connected
        const sessionErrorTracker = SessionErrorTracker.getInstance();
        if (sessionErrorTracker.hasResumableSession(this.context.user.user_id)) {
            sessionErrorTracker.clearResumableSession(this.context.user.user_id);
            this.logger.info('Cleared resumable session due to successful Gemini connection');
        }

        // Start keep-alive timer
        this.connectionState.keepAliveIntervalId = setInterval(
            () => this.sendKeepAliveAudioChunk(),
            KEEP_ALIVE_INTERVAL,
        );
        this.logger.info(`Started keep-alive timer (${KEEP_ALIVE_INTERVAL / 1000}s interval)`);

        // Configure tools based on mode
        const tools = this.getToolsConfiguration();
        const responseModalities = this.ttsManager.isExternalTTSEnabled() ? ['TEXT'] : ['AUDIO'];

        this.logger.info(
            `Gemini Live setup: Using ${responseModalities[0]} mode for ${TTS_PROVIDER} TTS`,
        );

        const setupMsg = this.createSetupMessage(
            systemPrompt,
            voiceName,
            tools,
            responseModalities,
        );

        try {
            this.geminiWs?.send(JSON.stringify(setupMsg));
            this.logger.info('Sent Gemini setup message with function calling and audio request.');

            // Send initial turn
            this.sendInitialTurn(firstMessage);
        } catch (err) {
            this.logger.error('Failed to send setup or initial turn to Gemini:', err);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.close(1011, 'Gemini setup failed');
            }
        }
    }

    private getToolsConfiguration() {
            return [{
                functionDeclarations: [
                    {
                        name: 'transferModal',
                        description:
                        'Transfers user original speech. Use for all user commands. Preserve user intent and context.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                userCommand: {
                                    type: 'STRING',
                                description: "The user's speech converted to text with correction if needed.",
                                },
                            },
                            required: ['userCommand'],
                        },
                    },
                ],
            }];
    }

    private createSetupMessage(
        systemPrompt: string,
        voiceName: string,
        tools: any[],
        responseModalities: string[],
    ) {
        return {
            setup: {
                model: 'models/gemini-2.0-flash-live-001',
                generationConfig: {
                    responseModalities,
                    speechConfig: this.ttsManager.isExternalTTSEnabled() ? undefined : {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName,
                            },
                        },
                        language_code: 'vi-VN',
                    },
                    temperature: 0.0,
                },
                systemInstruction: {
                    role: 'system',
                    parts: [{ text: systemPrompt }],
                },
                tools,
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        prefixPaddingMs: 20,
                        silenceDurationMs: 500,
                    },
                    activityHandling: 'NO_INTERRUPTION',
                },
                contextWindowCompression: {
                    triggerTokens: 25600,
                    slidingWindow: { targetTokens: 12800 },
                },
            },
        };
    }

    private sendInitialTurn(firstMessage: string | null) {
        if (firstMessage) {
            this.logger.info('Sending first message as initial turn:', firstMessage);
            const userTurn = {
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: firstMessage }] }],
                    turnComplete: true,
                },
            };
            this.geminiWs?.send(JSON.stringify(userTurn));
        } else {
            this.logger.info("No chat history, sending 'Xin chào' as initial turn.");
            const userTurn = {
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text: 'Xin chào!' }] }],
                    turnComplete: true,
                },
            };
            this.geminiWs?.send(JSON.stringify(userTurn));
        }
    }

    private async handleGeminiMessage(data: RawData) {
        if (
            !this.connectionState.pipelineActive || this.connectionState.deviceClosed ||
            !this.geminiWs || this.geminiWs.readyState !== WSWebSocket.OPEN
        ) {
            return;
        }

        try {
            const msg = JSON.parse(data.toString('utf-8'));
            await this.processGeminiMessage(msg);
        } catch (err) {
            this.logger.warn('Received non-JSON message from Gemini:', data.toString('utf-8'));
            this.logger.error('Gemini message parse error:', err);
        }
    }

    private async processGeminiMessage(msg: any) {
        if (!this.connectionState.pipelineActive || this.connectionState.deviceClosed) return;

        // Handle setup complete
        if (msg.setupComplete) {
            this.logger.info('Setup Complete.');
            return;
        }

        // Handle Top-Level Tool Call
        if (msg.toolCall?.functionCalls && Array.isArray(msg.toolCall.functionCalls)) {
            await this.handleToolCalls(msg.toolCall.functionCalls);
            return;
        }

        // Handle Server Content
        if (msg.serverContent?.modelTurn?.parts) {
            await this.handleServerContent(msg.serverContent.modelTurn.parts);
        }

        // Handle Generation Complete
        if (msg.serverContent?.generationComplete) {
            await this.handleGenerationComplete();
        }

        // Handle Transcriptions
        await this.handleTranscriptions(msg);

        // Handle GoAway message
        if (msg.goAway) {
            this.handleGoAway(msg.goAway);
        }
    }

    private async handleToolCalls(functionCalls: any[]) {
        const userCommand = extractUserCommand(functionCalls);
        this.logger.info(`Received toolCall: ${functionCalls.map(c => c.name).join(', ')} | userCommand: "${userCommand}"`);

        if (this.ttsState.toolCallInProgress) {
            this.logger.info(
                'Tool call already in progress, ignoring new tool calls until RESPONSE.COMPLETE is sent',
            );
            return;
        }

        this.ttsState.toolCallInProgress = true;
        this.logger.info(
            'Tool call lock acquired for:',
            functionCalls.map((c) => c.name).join(', '),
        );

        for (const call of functionCalls) {
            if (call.name === 'transferModal' && call.id) {
                await this.handleTransferModalCall(call);
            } else {
                this.logger.warn(
                    `Received unhandled top-level function call: ${call.name} or missing ID.`,
                );
            }
        }
    }

    private async handleTransferModalCall(call: any) {
        const callId = call.id;
        const userCommand = call.args?.userCommand;
        const searchResults = call.args?.searchResults;
        this.logger.info(`*transferModal (ID: ${callId}) | userCommand: "${userCommand}"`);

        // Send RESPONSE.CREATED state to device
        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
            this.logger.info('Device => Sent SPEAKING state (transferModal triggered)');
        }

        let result = { success: false, message: 'Unknown error in transferModal.' };

        if (typeof userCommand === 'string' && userCommand.trim()) {
            try {
                let fullCommand = userCommand.trim();
                if (searchResults && typeof searchResults === 'string' && searchResults.trim()) {
                    fullCommand =
                        `${userCommand.trim()}\n\nSearch Results: ${searchResults.trim()}`;
                }

                result = await processUserActionWithSession(
                    this.connectionState.sessionId,
                    fullCommand,
                    this.context.supabase,
                    this.context.user.user_id,
                );
                this.logger.info(`transferModal result (session: ${truncateSessionId(this.connectionState.sessionId)}): Success`);

                // OPTION 1: Send Flash 2.5 response directly to Azure TTS, skip Gemini Live streaming
                if (result.success && result.message && this.ttsManager.isExternalTTSEnabled()) {
                    this.logger.info('Sending Flash 2.5 response directly to Azure TTS (skipping Gemini streaming)');

                    // Process the Flash 2.5 response directly with TTS
                    const ttsResult = await this.ttsManager.processTextWithTTSStreaming(
                        result.message,
                        async (audioChunk: Uint8Array) => {
                            try {
                                const pcmData = Buffer.from(audioChunk);
                                if (this.audioState.ttsFilter) {
                                    this.audioState.ttsFilter.processAudioInPlace(pcmData);
                                }
                                boostTtsVolumeInPlace(pcmData, 3.0);

                                const opusFrames = await ttsState.encodePcmChunk(pcmData);

                                for (const frame of opusFrames) {
                                    if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                                        this.deviceWs.send(frame);
                                    } else {
                                        this.logger.warn('Device WS closed while sending TTS frames. Aborting send.');
                                        break;
                                    }
                                }
                            } catch (error) {
                                this.logger.error('Error processing TTS audio chunk:', error);
                            }
                        },
                    );

                    if (ttsResult?.success) {
                        this.logger.info('Flash 2.5 response successfully processed by Azure TTS');
                    } else {
                        this.logger.error('Failed to process Flash 2.5 response with Azure TTS:', ttsResult?.error);
                    }

                    // Send RESPONSE.COMPLETE after direct TTS processing
                    await this.sendResponseComplete();

                    // Send a simple acknowledgment to Gemini Live instead of the full response
                    this.sendFunctionResponse(callId, 'transferModal', 'Response processed successfully');
                    return;
                }

            } catch (err) {
                this.logger.error(`Error executing transferModal for ID ${callId}:`, err);
                result = {
                    success: false,
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        } else {
            const errorMsg =
                `Invalid or missing 'userCommand' argument for transferModal (ID: ${callId}). Expected a non-empty string.`;
            this.logger.error(errorMsg);
            result = { success: false, message: errorMsg };
        }

        // Fallback: send full response to Gemini Live (for errors or when external TTS is disabled)
        this.sendFunctionResponse(callId, 'transferModal', result.message);
    }

    private sendFunctionResponse(callId: string, functionName: string, result: string) {
        if (
            this.connectionState.isGeminiConnected && this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            const functionResponsePayload = {
                functionResponses: [{
                    id: callId,
                    name: functionName,
                    response: { result },
                }],
            };
            const functionResponse = { toolResponse: functionResponsePayload };
            try {
                this.geminiWs.send(JSON.stringify(functionResponse));
                const result = extractResult(functionResponsePayload);
                this.logger.info(
                    `Sent Function Response for ${functionName} (ID: ${callId}) | result: "${result}"`,
                );
            } catch (err) {
                this.logger.error(
                    `Failed to send ${functionName} function response (ID: ${callId}) to Gemini:`,
                    err,
                );
            }
        } else {
            this.logger.error(
                `Cannot send ${functionName} function response (ID: ${callId}), Gemini WS not open.`,
            );
        }
    }

    private async handleServerContent(parts: any[]) {
        const partsToLog = parts.filter((part: any) =>
            !(part.inlineData && part.inlineData.mimeType === 'audio/pcm;rate=24000')
        );
        if (partsToLog.length > 0) {
            this.logger.info('Received serverContent parts (excluding audio)');
        }

        for (const part of parts) {
            if (part.functionCall) {
                this.logger.warn(
                    'Detected functionCall within parts (Ignoring in favor of top-level toolCall):',
                    JSON.stringify(part.functionCall),
                );
            } else if (part.executableCode && part.executableCode.language === 'PYTHON') {
                this.logger.warn(
                    'Detected executableCode within parts (Ignoring in favor of top-level toolCall)',
                );
            }

            if (part.text && this.ttsManager.isExternalTTSEnabled()) {
                //this.logger.info('Gemini partial text:', part.text);

                // Use incremental flusher to process partial text and avoid duplicates
                await this.ttsManager.processPartialText(part.text);
            }

            // Check for TTS Audio Data
            if (part.inlineData?.data) {
                await this.handleAudioData(part.inlineData.data);
            }
        }
    }

    private async handleAudioData(audioData: string) {
        // Send RESPONSE.CREATED on the first audio chunk
        if (!this.ttsState.responseCreatedSent && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.ttsState.responseCreatedSent = true;
        }

        try {
            const pcmData = Buffer.from(audioData, 'base64');
            this.audioState.ttsFilter.processAudioInPlace(pcmData);
            boostTtsVolumeInPlace(pcmData, 3.0);
            const opusFrames = await ttsState.encodePcmChunk(pcmData);

            for (const frame of opusFrames) {
                if (
                    this.deviceWs.readyState === WSWebSocket.OPEN &&
                    !this.connectionState.deviceClosed
                ) {
                    this.deviceWs.send(frame);
                } else {
                    this.logger.warn('Device WS closed while sending TTS frames. Aborting send.');
                    break;
                }
            }
        } catch (err) {
            this.logger.error('Error processing/sending TTS audio chunk:', err);
        }
    }

    private async handleGenerationComplete() {
        this.logger.info('Generation Complete.');

        if (this.ttsState.toolCallInProgress && !this.ttsState.responseCreatedSent) {
            this.logger.info('Releasing tool call lock - generation complete without audio');
            this.ttsState.toolCallInProgress = false;
        }

        // Add a small delay to ensure we've collected all text parts
        await new Promise((resolve) => setTimeout(resolve, 100));

        // If external TTS is enabled and we have accumulated text, set up delayed processing
        if (this.ttsManager.isExternalTTSEnabled() && this.ttsState.ttsTextBuffer.trim()) {
            this.logger.info(
                `${TTS_PROVIDER} TTS: Scheduling delayed processing for accumulated text (${this.ttsState.ttsTextBuffer.length} chars)`,
            );

            if (this.ttsState.ttsTimeout) {
                clearTimeout(this.ttsState.ttsTimeout);
            }

            this.ttsState.ttsTimeout = setTimeout(async () => {
                await this.ttsManager.processTTSWithDelay(
                    this.audioState.ttsFilter,
                    this.context.supabase,
                    this.context.user.user_id,
                );
                // Send RESPONSE.COMPLETE after TTS processing is done
                if (this.ttsState.responseCreatedSent) {
                    await this.sendResponseComplete();
                }
            }, TTS_DELAY_MS) as unknown as number;

            this.logger.info(
                `${TTS_PROVIDER} TTS: Will process in ${TTS_DELAY_MS}ms if no more text arrives`,
            );
        }

        // For external TTS, don't send RESPONSE.COMPLETE here - it will be sent after TTS processing
        // For Gemini TTS or no audio, send RESPONSE.COMPLETE immediately
        if (!this.ttsManager.isExternalTTSEnabled()) {
            if (this.ttsState.responseCreatedSent) {
                await this.sendResponseComplete();
            } else {
                this.logger.info(
                    'Generation complete, but no audio was sent (likely function call only or text response). Not sending RESPONSE.COMPLETE.',
                );
            }
        } else {
            this.logger.info('External TTS enabled - RESPONSE.COMPLETE will be sent after TTS processing completes');
        }
    }

    private async sendResponseComplete() {
        this.logger.info('Device => Sending RESPONSE.COMPLETE');
        ttsState.reset();
        this.ttsState.responseCreatedSent = false;
        this.ttsState.toolCallInProgress = false;



        try {
            const devInfo = await getDeviceInfo(this.context.supabase, this.context.user.user_id)
                .catch(() => null);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.send(JSON.stringify({
                    type: 'server',
                    msg: 'RESPONSE.COMPLETE',
                    volume_control: devInfo?.volume ?? 100,
                    pitch_factor: this.context.user.personality?.pitch_factor ?? 1,
                }));
            }
        } catch (err) {
            this.logger.error('Error sending RESPONSE.COMPLETE:', err);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
            }
        }
    }

    private async handleTranscriptions(msg: any) {
        if (msg.inputTranscription?.text) {
            if (msg.inputTranscription.finished && msg.inputTranscription.text.trim()) {
                this.logger.info('User final transcription:', msg.inputTranscription.text);
                await addConversation(
                    this.context.supabase,
                    'user',
                    msg.inputTranscription.text,
                    this.context.user,
                )
                    .catch((err) => this.logger.error('DB Error (User Conv):', err));
            }
        }

        if (msg.outputTranscription?.text) {
            if (msg.outputTranscription.finished && msg.outputTranscription.text.trim()) {
                this.logger.info('Assistant final transcription:', msg.outputTranscription.text);
                await addConversation(
                    this.context.supabase,
                    'assistant',
                    msg.outputTranscription.text,
                    this.context.user,
                )
                    .catch((err) => this.logger.error('DB Error (Asst Conv):', err));
            }
        }
    }

    private handleGoAway(goAway: any) {
        this.logger.warn('Received goAway:', JSON.stringify(goAway));
        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.close(
                1011,
                `Gemini requested disconnect: ${goAway.reason || 'Unknown reason'}`,
            );
        }
    }

    private handleGeminiClose(code: number, reason: Buffer) {
        this.connectionState.isGeminiConnected = false;
        const reasonString = reason.toString();
        this.logger.info('Gemini WS closed:', code, reasonString);

        // Clear keep-alive timer
        if (this.connectionState.keepAliveIntervalId) {
            clearInterval(this.connectionState.keepAliveIntervalId);
            this.connectionState.keepAliveIntervalId = null;
            this.logger.info('Cleared keep-alive timer');
        }

        this.geminiWs = null;

        // Check for quota exceeded error and handle retries
        if (
            code === 1011 &&
            reasonString.toLowerCase().includes('quota') &&
            !this.connectionState.deviceClosed &&
            this.deviceWs.readyState === WSWebSocket.OPEN
        ) {
            this.handleQuotaExceeded();
        } else {
            this.handleNonQuotaClose();
        }
    }

    private handleQuotaExceeded() {
        const rotatedSuccessfully = apiKeyManager.rotateToNextKey();

        if (rotatedSuccessfully) {
            this.logger.info('Quota exceeded. Rotating to next API key and retrying immediately...');
            this.reconnect();
        } else {
            this.logger.info('Device => Sending QUOTA.EXCEEDED - all API keys exhausted.');
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'QUOTA.EXCEEDED' }));

            // Save session for resumption due to quota exceeded
            const sessionErrorTracker = SessionErrorTracker.getInstance();
            sessionErrorTracker.saveSessionForResumption(
                this.context.user.user_id,
                this.connectionState.sessionId,
                'quota_exceeded',
                'All API keys exhausted due to quota limits'
            );

            if (this.connectionState.retryCount < MAX_RETRIES) {
                this.scheduleRetry();
            } else {
                this.logger.error(
                    'Max retries reached for Gemini connection. Closing device connection.',
                );
                if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                    this.deviceWs.close(1011, 'Assistant disconnected - all API keys exhausted');
                }
            }
        }
    }

    private scheduleRetry() {
        const delay = RETRY_DELAYS[this.connectionState.retryCount];
        this.connectionState.retryCount++;
        this.logger.warn(
            `All API keys exhausted. Retrying with delays in ${
                delay / 1000
            }s (Attempt ${this.connectionState.retryCount}/${MAX_RETRIES})...`,
        );

        if (this.connectionState.retryTimeoutId) {
            clearTimeout(this.connectionState.retryTimeoutId);
        }

        this.connectionState.retryTimeoutId = setTimeout(() => {
            apiKeyManager.resetRotation();

            if (
                !this.connectionState.deviceClosed && this.deviceWs.readyState === WSWebSocket.OPEN
            ) {
                this.logger.info(
                    `Attempting Gemini reconnect with reset keys (Attempt ${this.connectionState.retryCount}/${MAX_RETRIES})...`,
                );
                this.reconnect();
            } else {
                this.logger.info('Device closed before Gemini reconnect attempt could execute.');
            }
        }, delay);
    }

    private handleNonQuotaClose() {
        if (this.connectionState.retryCount >= MAX_RETRIES) {
            this.logger.error(
                'Max retries reached for Gemini connection. Closing device connection.',
            );
        }
        if (!this.connectionState.deviceClosed && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.logger.info(
                'Closing device WS due to Gemini WS close (or max retries reached/other error).',
            );
            this.deviceWs.close(1011, 'Assistant disconnected or unrecoverable error');
        }
    }

    private handleGeminiError(err: Error) {
        this.connectionState.isGeminiConnected = false;
        this.logger.error('Gemini WS error:', err);

        // Save session for resumption due to Gemini error
        const sessionErrorTracker = SessionErrorTracker.getInstance();
        sessionErrorTracker.saveSessionForResumption(
            this.context.user.user_id,
            this.connectionState.sessionId,
            'gemini_error',
            `Gemini WebSocket error: ${err.message}`
        );

        if (this.connectionState.keepAliveIntervalId) {
            clearInterval(this.connectionState.keepAliveIntervalId);
            this.connectionState.keepAliveIntervalId = null;
            this.logger.info('Cleared keep-alive timer due to error');
        }

        if (this.geminiWs && this.geminiWs.readyState !== WSWebSocket.CLOSED) {
            this.geminiWs.close();
        }
        this.geminiWs = null;

        if (!this.connectionState.deviceClosed && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(
                JSON.stringify({ type: 'error', message: 'Assistant connection error' }),
            );
            this.deviceWs.close(1011, 'Assistant error');
        }
    }

    private sendKeepAliveAudioChunk() {
        if (
            !this.connectionState.isGeminiConnected || !this.geminiWs ||
            this.geminiWs.readyState !== WSWebSocket.OPEN
        ) {
            return;
        }

        try {
            const silenceChunk = new Uint8Array(1024).fill(0);
            const b64 = Buffer.from(silenceChunk).toString('base64');

            const gemMsg = {
                realtime_input: {
                    media_chunks: [
                        { data: b64, mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}` },
                    ],
                },
            };

            this.geminiWs.send(JSON.stringify(gemMsg));
            //this.logger.info('Sent keep-alive audio chunk to Gemini');
        } catch (err) {
            this.logger.error('Failed to send keep-alive audio chunk:', err);
        }
    }

    private async reconnect() {
        // Get system prompt and first message for reconnection
        const { user, supabase } = this.context;
        const isDoctor = user.user_info?.user_type === 'doctor';
        const chatHistory = await getChatHistory(
            supabase,
            user.user_id,
            user.personality?.key ?? null,
            isDoctor,
        ).catch((err) => {
            this.logger.error('Failed to get chat history:', err);
            return [];
        });

        const currentVolume = await this.getCurrentVolume();
        const systemPromptText = createSystemPrompt(chatHistory, this.context, currentVolume) ||
            'You are a helpful assistant.';
        const firstMessage = createFirstMessage(chatHistory, this.context);

        await this.connect(this.buildFullSystemPrompt(systemPromptText), firstMessage);
    }

    private async getCurrentVolume(): Promise<number> {
        try {
            const deviceInfo = await getDeviceInfo(
                this.context.supabase,
                this.context.user.user_id,
            );
            return deviceInfo?.volume ?? 100;
        } catch (err) {
            this.logger.error('Failed to get device volume:', err);
            return 100;
        }
    }

    private buildFullSystemPrompt(systemPromptText: string): string {
        const legacyPrompt = `
<tool_calling_instructions>
TOOL SYSTEM:
-transferModal: Use for ALL user commands.
+ Pass the user's speech as userCommand.
+ If you suspect the transcription have some words errors, fix it to make sense and suitable for the context.

IMPORTANT:
-Never mention that you are using function calls.
-Never hallucinate about function calls.
</legacy_mode_instructions>

<CORE PRINCIPLE>
YOU ARE VIETNAMESE TEXT-TO-SPEECH, VIETNAMESE SPEECH-TO-TEXT.
ALWAYS USING transferModal EVERY TIME.
ALWAYS SAID EXACTLY WORD BY WORD WHAT THE transferModal GIVE YOU.
</CORE PRINCIPLE>`;

        return legacyPrompt;
    }

    sendAudioChunk(audioChunk: Uint8Array) {
        const b64 = Buffer.from(audioChunk).toString('base64');

        if (
            this.connectionState.isGeminiConnected && this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            const gemMsg = {
                realtime_input: {
                    media_chunks: [
                        { data: b64, mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}` },
                    ],
                },
            };
            try {
                this.geminiWs.send(JSON.stringify(gemMsg));
            } catch (err) {
                this.logger.error('Failed to send audio chunk to Gemini:', err);
            }
        } else {
            this.logger.warn('Cannot send audio chunk, Gemini WS not open.');
        }
    }

    sendTurnComplete() {
        if (
            this.connectionState.isGeminiConnected && this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            this.logger.info('Signaling Turn Complete.');
            const finalizeTurn = {
                clientContent: { turns: [], turnComplete: true },
            };
            try {
                this.geminiWs.send(JSON.stringify(finalizeTurn));
            } catch (err) {
                this.logger.error('Failed to send Turn Complete message to Gemini:', err);
            }
        }
    }

    interruptCurrentTurn() {
        this.audioState.micAccum = new Uint8Array(0);
        ttsState.reset();
        this.ttsState.responseCreatedSent = false;
        this.ttsState.ttsTextBuffer = '';

        if (this.ttsState.ttsTimeout) {
            clearTimeout(this.ttsState.ttsTimeout);
            this.ttsState.ttsTimeout = null;
            this.logger.info('Cleared pending TTS timeout due to interrupt');
        }

        if (
            this.connectionState.isGeminiConnected && this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            this.logger.info('Signaling Turn Complete (Interrupt).');
            const interruptTurn = {
                clientContent: { turns: [], turnComplete: true },
            };
            try {
                this.geminiWs.send(JSON.stringify(interruptTurn));
            } catch (err) {
                this.logger.error('Failed to send Turn Complete (Interrupt) to Gemini:', err);
            }
        }
    }

    close() {
        if (this.connectionState.retryTimeoutId) {
            clearTimeout(this.connectionState.retryTimeoutId);
            this.connectionState.retryTimeoutId = null;
        }

        if (this.connectionState.keepAliveIntervalId) {
            clearInterval(this.connectionState.keepAliveIntervalId);
            this.connectionState.keepAliveIntervalId = null;
        }

        if (
            this.geminiWs && this.geminiWs.readyState !== WSWebSocket.CLOSED &&
            this.geminiWs.readyState !== WSWebSocket.CLOSING
        ) {
            this.geminiWs.close(1000, 'Device disconnected');
        }
        this.geminiWs = null;
    }
}

// ===== Device Message Handler =====

class DeviceMessageHandler {
    private logger = new Logger('[Device]');
    private connectionState: ConnectionState;
    private audioState: AudioState;
    private imageState: ImageCaptureState;
    private geminiManager: GeminiConnectionManager;
    private deviceWs: WSWebSocket;

    constructor(
        deviceWs: WSWebSocket,
        connectionState: ConnectionState,
        audioState: AudioState,
        imageState: ImageCaptureState,
        geminiManager: GeminiConnectionManager,
    ) {
        this.deviceWs = deviceWs;
        this.connectionState = connectionState;
        this.audioState = audioState;
        this.imageState = imageState;
        this.geminiManager = geminiManager;
    }

    async handleMessage(raw: RawData, isBinary: boolean) {
        if (!this.connectionState.pipelineActive || this.connectionState.deviceClosed) return;

        if (isBinary) {
            this.handleBinaryMessage(raw);
        } else {
            await this.handleTextMessage(raw);
        }
    }

    private handleBinaryMessage(raw: RawData) {
        let audioChunk: Uint8Array | null = null;

        if (raw instanceof ArrayBuffer) {
            audioChunk = new Uint8Array(raw);
        } else if (Buffer.isBuffer(raw)) {
            audioChunk = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        } else {
            this.logger.warn('Received unexpected binary data format. Ignoring.', typeof raw);
            return;
        }

        // Decompress ADPCM to PCM if enabled
        let pcmChunk: Uint8Array;
        if (ADPCM_ENABLED) {
            pcmChunk = this.audioState.adpcmProcessor.decodeADPCMChunk(audioChunk);
            this.audioState.lastCompressionRatio = pcmChunk.length / audioChunk.length;
        } else {
            pcmChunk = audioChunk;
            this.audioState.lastCompressionRatio = undefined;
        }

        // Accumulate buffer
        const combined = new Uint8Array(this.audioState.micAccum.length + pcmChunk.length);
        combined.set(this.audioState.micAccum, 0);
        combined.set(pcmChunk, this.audioState.micAccum.length);
        this.audioState.micAccum = combined;

        // Process chunks
        this.processAudioChunks();
    }

    private processAudioChunks() {
        while (this.audioState.micAccum.length >= MIC_ACCUM_CHUNK_SIZE) {
            const chunkToSend = this.audioState.micAccum.slice(0, MIC_ACCUM_CHUNK_SIZE);
            this.audioState.micAccum = this.audioState.micAccum.slice(MIC_ACCUM_CHUNK_SIZE);

            // Apply filtering and gain
            const filteredChunk = new Uint8Array(chunkToSend);
            this.audioState.micFilter.processAudioInPlace(filteredChunk);

            // Add to debug session
            audioDebugManager.addAudioData(
                this.connectionState.sessionId,
                filteredChunk,
                this.audioState.lastCompressionRatio,
            );

            // Send to Gemini
            this.geminiManager.sendAudioChunk(filteredChunk);
        }
    }

    private async handleTextMessage(raw: RawData) {
        let msgObj: any;
        try {
            const rawString = raw.toString('utf-8');
            if (rawString.length > 1000) {
                this.logger.info(
                    `Received large message (${rawString.length} chars), likely image data`,
                );
            } else {
                this.logger.info(
                    `Received message: ${rawString.substring(0, 200)}${
                        rawString.length > 200 ? '...' : ''
                    }`,
                );
            }
            msgObj = JSON.parse(rawString);
        } catch (err) {
            this.logger.error('JSON parse error:', err);
            return;
        }

        try {
            if (msgObj.type === 'image_chunk') {
                this.geminiManager.imageHandler.handleImageChunk(
                    msgObj,
                    null,
                    this.connectionState.isGeminiConnected,
                );
            } else if (msgObj.type === 'image_complete') {
                this.logger.info(
                    `Received image_complete message for ${msgObj.total_chunks} chunks`,
                );
            } else if (msgObj.type === 'instruction' || msgObj.type === 'server') {
                this.handleInstruction(msgObj);
            }
        } catch (err) {
            this.logger.error('Error processing text message:', err);
            if (msgObj.type === 'image' && this.imageState.waitingForImage) {
                this.imageState.waitingForImage = false;
                this.imageState.pendingVisionCall = null;
                this.imageState.photoCaptureFailed = false;
            }
        }
    }

    private handleInstruction(msgObj: any) {
        if (msgObj.msg === 'end_of_speech') {
            this.handleEndOfSpeech();
        } else if (msgObj.msg === 'INTERRUPT') {
            this.handleInterrupt();
        }
    }

    private handleEndOfSpeech() {
        this.logger.info('End of Speech detected.');

        // Flush remaining audio
        if (this.audioState.micAccum.length > 0) {
            this.logger.info(
                `Flushing remaining ${this.audioState.micAccum.length} bytes of audio.`,
            );

            const finalChunk = new Uint8Array(this.audioState.micAccum);
            this.audioState.micFilter.processAudioInPlace(finalChunk);

            audioDebugManager.addAudioData(
                this.connectionState.sessionId,
                finalChunk,
                this.audioState.lastCompressionRatio,
            );

            this.geminiManager.sendAudioChunk(finalChunk);
            this.audioState.micAccum = new Uint8Array(0);
        }

        // Signal turn complete
        this.geminiManager.sendTurnComplete();

        // Acknowlazure device
        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'AUDIO.COMMITTED' }));
        }
    }

    private handleInterrupt() {
        this.logger.info('INTERRUPT received.');
        this.geminiManager.interruptCurrentTurn();
    }
}

// ===== Main Connection Handler =====

export function setupWebSocketConnectionHandler(wss: _WSS) {
    wss.on('connection', async (deviceWs: WSWebSocket, context: ConnectionContext) => {
        const { user, supabase } = context;
        const logger = new Logger('[Main]');
        logger.info(`Device WebSocket connected for user: ${user.user_id}`);

        // Check for resumable session
        const sessionErrorTracker = SessionErrorTracker.getInstance();
        const resumableSession = sessionErrorTracker.getResumableSession(user.user_id);

        let sessionId: string;
        let shouldResumeSession = false;

        if (resumableSession && ENABLE_SESSION_RESUMPTION) {
            sessionId = resumableSession.sessionId;
            shouldResumeSession = true;
            logger.info(
                `🔄 RESUMING SESSION: Found resumable session ${truncateSessionId(sessionId)} for user ${user.user_id} ` +
                `(error: ${resumableSession.errorType}, age: ${Math.round((Date.now() - resumableSession.timestamp.getTime()) / 1000)}s)`
            );
        } else {
            sessionId = `live-${user.user_id}-${Date.now()}-${
                Math.random().toString(36).substring(2, 11)
            }`;
            logger.info(`🆕 FRESH SESSION: Creating new session ${truncateSessionId(sessionId)} for user ${user.user_id}`);
        }

        // Initialize connection state
        const connectionState: ConnectionState = {
            pipelineActive: true,
            deviceClosed: false,
            isGeminiConnected: false,
            sessionStartTime: 0,
            retryCount: 0,
            retryTimeoutId: null,
            keepAliveIntervalId: null,
            sessionId,
        };

        // Initialize audio state
        const audioState: AudioState = {
            micAccum: new Uint8Array(0),
            lastCompressionRatio: undefined,
            micFilter: new AudioFilter(MIC_SAMPLE_RATE, 300, 3500, MIC_INPUT_GAIN),
            ttsFilter: new AudioFilter(TTS_SAMPLE_RATE, 700, 4000, 6.0),
            adpcmProcessor: new ADPCMStreamProcessor(ADPCM_BUFFER_SIZE),
        };

        // Initialize TTS state
        const ttsState: TTSState = {
            responseCreatedSent: false,
            ttsTextBuffer: '',
            ttsTimeout: null,
            toolCallInProgress: false,
        };

        // Initialize image capture state
        const imageState: ImageCaptureState = {
            pendingVisionCall: null,
            waitingForImage: false,
            photoCaptureFailed: false,
            imageTimeoutId: null,
            imageChunkAssembly: null,
            chunkTimeoutId: null,
        };

        // Initialize audio debug session
        audioDebugManager.startSession(connectionState.sessionId);

        // Create Flash 2.5 session
        logger.info(`Creating Flash 2.5 session: ${truncateSessionId(connectionState.sessionId)}`);

        // Create Gemini connection manager
        const geminiManager = new GeminiConnectionManager(
            context,
            deviceWs,
            connectionState,
            audioState,
            ttsState,
            imageState,
        );

        // Create or resume Flash 2.5 session with callbacks from Gemini manager
        if (shouldResumeSession && resumableSession) {
            logger.info(`🔄 Attempting to resume Flash 2.5 session: ${truncateSessionId(connectionState.sessionId)}`);
            // Try to resume the session - if it fails, create a new one
            try {
                createFlash25Session(
                    connectionState.sessionId,
                    user.user_id,
                    geminiManager.deviceCallbacks,
                    user,
                );
                // Clear the resumable session since we successfully resumed
                sessionErrorTracker.clearResumableSession(user.user_id);
                logger.info(`✅ Successfully resumed Flash 2.5 session: ${truncateSessionId(connectionState.sessionId)}`);
            } catch (error) {
                logger.error(`❌ Failed to resume session, creating fresh session:`, error);
                // Create a fresh session if resumption fails
                const freshSessionId = `live-${user.user_id}-${Date.now()}-${
                    Math.random().toString(36).substring(2, 11)
                }`;
                connectionState.sessionId = freshSessionId;
                createFlash25Session(
                    connectionState.sessionId,
                    user.user_id,
                    geminiManager.deviceCallbacks,
                    user,
                );
                sessionErrorTracker.clearResumableSession(user.user_id);
                logger.info(`🆕 Created fallback fresh session: ${truncateSessionId(connectionState.sessionId)}`);
            }
        } else {
            logger.info(`🆕 Creating fresh Flash 2.5 session: ${truncateSessionId(connectionState.sessionId)}`);
            createFlash25Session(
                connectionState.sessionId,
                user.user_id,
                geminiManager.deviceCallbacks,
                user,
            );
        }

        // Create device message handler
        const deviceMessageHandler = new DeviceMessageHandler(
            deviceWs,
            connectionState,
            audioState,
            imageState,
            geminiManager,
        );

        // Initial device setup
        let currentVolume: number | null = null;
        let isOta = false;
        let isReset = false;

        try {
            const deviceInfo = await getDeviceInfo(supabase, user.user_id);
            if (deviceInfo) {
                currentVolume = deviceInfo.volume ?? 70;
                isOta = deviceInfo.is_ota || false;
                isReset = deviceInfo.is_reset || false;
                logger.info(
                    `Fetched initial device info: Volume=${currentVolume}, OTA=${isOta}, Reset=${isReset}`,
                );
            } else {
                currentVolume = 70;
                logger.warn(
                    `No device info found for user ${user.user_id}, defaulting volume to 70.`,
                );
            }
            deviceWs.send(JSON.stringify({
                type: 'auth',
                volume_control: currentVolume,
                pitch_factor: user.personality?.pitch_factor ?? 1,
                is_ota: isOta,
                is_reset: isReset,
            }));
        } catch (err) {
            logger.error('Failed to get initial device info:', err);
            currentVolume = 70;
            deviceWs.send(JSON.stringify({
                type: 'auth',
                volume_control: 70,
                pitch_factor: 1,
                is_ota: false,
                is_reset: false,
            }));
        }

        // Prepare for Gemini connection
        const isDoctor = user.user_info?.user_type === 'doctor';
        const chatHistory = await getChatHistory(
            supabase,
            user.user_id,
            user.personality?.key ?? null,
            isDoctor,
        ).catch((err) => {
            logger.error('Failed to get chat history:', err);
            return [];
        });

        const systemPromptText = createSystemPrompt(chatHistory, context, currentVolume) ||
            'You are a helpful assistant.';
        const firstMessage = createFirstMessage(chatHistory, context);

        // Build full system prompt
        const fullSystemPrompt = geminiManager['buildFullSystemPrompt'](systemPromptText);

        // Connect to Gemini
        await geminiManager.connect(fullSystemPrompt, firstMessage);

        // Set up device event handlers
        deviceWs.on('message', async (raw: RawData, isBinary: boolean) => {
            await deviceMessageHandler.handleMessage(raw, isBinary);
        });

        deviceWs.on('error', (err) => {
            logger.error('Device WS error:', err);
            if (!connectionState.deviceClosed) {
                connectionState.deviceClosed = true;
                connectionState.pipelineActive = false;
                logger.info('Closing Gemini WS due to device error.');

                // Save session for resumption due to device error
                sessionErrorTracker.saveSessionForResumption(
                    user.user_id,
                    connectionState.sessionId,
                    'device_error',
                    `Device WebSocket error: ${err instanceof Error ? err.message : String(err)}`
                );

                if (connectionState.retryTimeoutId) {
                    logger.info('Device error, cancelling pending Gemini reconnect.');
                    clearTimeout(connectionState.retryTimeoutId);
                    connectionState.retryTimeoutId = null;
                }

                audioDebugManager.endSession(connectionState.sessionId, 'device_error').catch(
                    (err) =>
                        logger.error('Failed to end audio debug session on device error:', err),
                );

                geminiManager.close();
            }
        });

        deviceWs.on('close', async (code, reason) => {
            if (connectionState.deviceClosed) return;
            logger.info(`Device WS closed => Code: ${code}, Reason: ${reason.toString()}`);
            connectionState.deviceClosed = true;
            connectionState.pipelineActive = false;

            // Check if this is an abnormal close that should trigger session resumption
            const isAbnormalClose = code !== 1000 && code !== 1001; // 1000 = normal, 1001 = going away
            if (isAbnormalClose) {
                sessionErrorTracker.saveSessionForResumption(
                    user.user_id,
                    connectionState.sessionId,
                    'connection_failed',
                    `Device connection closed abnormally: Code ${code}, Reason: ${reason.toString()}`
                );
            } else {
                // Normal close - clear any existing resumable session
                sessionErrorTracker.clearResumableSession(user.user_id);
                logger.info('Normal device disconnection - cleared any resumable session');
            }

            // Clean up image chunk assembly
            if (imageState.chunkTimeoutId) {
                clearTimeout(imageState.chunkTimeoutId);
                imageState.chunkTimeoutId = null;
            }
            imageState.imageChunkAssembly = null;

            // If waiting for a retry, cancel it
            if (connectionState.retryTimeoutId) {
                logger.info('Device closed, cancelling pending Gemini reconnect.');
                clearTimeout(connectionState.retryTimeoutId);
                connectionState.retryTimeoutId = null;
            }

            // Log session duration
            if (connectionState.sessionStartTime > 0) {
                const durationSeconds = Math.floor(
                    (Date.now() - connectionState.sessionStartTime) / 1000,
                );
                logger.info(`Session duration: ${durationSeconds} seconds.`);
                await updateUserSessionTime(supabase, user, durationSeconds)
                    .catch((err) => logger.error('DB Error (Session Time):', err));
            }

            // Close Gemini connection
            geminiManager.close();

            // End audio debug session
            await audioDebugManager.endSession(connectionState.sessionId, 'connection_closed');

            // Destroy Flash 2.5 session
            logger.info(`Destroying Flash 2.5 session: ${truncateSessionId(connectionState.sessionId)}`);
            destroyFlash25Session(connectionState.sessionId);
        });
    });
}

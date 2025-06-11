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
    IMAGE_CHUNK_SIZE,
    IMAGE_CHUNK_TIMEOUT_MS,
    MIC_ACCUM_CHUNK_SIZE,
    MIC_INPUT_GAIN,
    MIC_SAMPLE_RATE,
    TTS_PROVIDER,
    TTS_SAMPLE_RATE,
    type TTSProvider,
    USE_FLASH_LIVE_AS_BASE,
} from './config.ts';

import { AudioFilter, boostTtsVolumeInPlace, ttsState } from './audio.ts';

import { ADPCM, ADPCMStreamProcessor } from './adpcm.ts';
import { audioDebugManager } from './audio_debug.ts';
import { callGeminiVision } from './vision.ts';
import { SetVolume } from './volume_handler.ts';
import { isValidJpegBase64, rotateImage180 } from './image_utils.ts';
import { Logger } from './logger.ts';

// TTS imports
import {
    convertTextToSpeech as convertTextToSpeechElevenLabs,
    validateElevenLabsConfig,
} from './elevenlabs_tts.ts';
import {
    convertTextToSpeech as convertTextToSpeechOpenAI,
    validateOpenAIConfig,
} from './openai_tts.ts';
import {
    convertTextToSpeech as convertTextToSpeechEdge,
    validateEdgeTTSConfig,
} from './edge_tts.ts';

// Flash handler imports
import {
    createFlash25Session,
    destroyFlash25Session,
    type DeviceOperationCallbacks,
    getFlash25SessionInfo,
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

const MAX_RETRIES = 4;
const RETRY_DELAYS = [15000, 30000, 60000, 180000]; // Delays in ms
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const IMAGE_CAPTURE_TIMEOUT = 15000; // 15 seconds
const TTS_DELAY_MS = 100; // Wait 100ms after last generation complete before triggering TTS

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

// ===== TTS Manager =====

class TTSManager {
    private logger = new Logger('[TTS]');
    private ttsState: TTSState;
    private deviceWs: WSWebSocket;
    private user: any;

    constructor(deviceWs: WSWebSocket, user: any, ttsState: TTSState) {
        this.deviceWs = deviceWs;
        this.user = user;
        this.ttsState = ttsState;
    }

    isExternalTTSEnabled(): boolean {
        return TTS_PROVIDER !== 'GEMINI';
    }

    async processTextWithTTSStreaming(
        text: string,
        onAudioChunk: (chunk: Uint8Array) => Promise<void>,
    ) {
        switch (TTS_PROVIDER) {
            case 'ELEVEN_LABS':
                if (!validateElevenLabsConfig()) {
                    this.logger.error(
                        'ElevenLabs TTS is enabled but not properly configured. Falling back to Gemini audio.',
                    );
                    return null;
                }
                const elevenLabsVoiceId = this.user.personality?.elevenlabs_voice_id ||
                    '21m00Tcm4TlvDq8ikWAM';
                const { convertTextToSpeechStreaming: convertElevenLabsStreaming } = await import(
                    './elevenlabs_tts.ts'
                );
                return await convertElevenLabsStreaming(text, elevenLabsVoiceId, onAudioChunk);

            case 'OPENAI':
                if (!validateOpenAIConfig()) {
                    this.logger.error(
                        'OpenAI TTS is enabled but not properly configured. Falling back to Gemini audio.',
                    );
                    return null;
                }
                const openAIVoice = this.user.personality?.openai_voice || 'alloy';
                const { convertTextToSpeechStreaming: convertOpenAIStreaming } = await import(
                    './openai_tts.ts'
                );
                return await convertOpenAIStreaming(text, onAudioChunk, { voice: openAIVoice });

            case 'EDGE_TTS':
                if (!validateEdgeTTSConfig()) {
                    this.logger.error(
                        'Edge TTS is enabled but not properly configured. Falling back to Gemini audio.',
                    );
                    return null;
                }
                const edgeTTSVoice = this.user.personality?.edge_tts_voice || 'vi-VN-HoaiMyNeural';
                const { convertTextToSpeechStreaming: convertEdgeTTSStreaming } = await import(
                    './edge_tts.ts'
                );
                return await convertEdgeTTSStreaming(text, edgeTTSVoice, onAudioChunk);

            case 'GEMINI':
            default:
                return null;
        }
    }

    async processTTSWithDelay(
        ttsFilter: AudioFilter,
        supabase: SupabaseClient,
        userId: string,
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
                this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
                this.logger.info(`Device => Sent RESPONSE.CREATED (${TTS_PROVIDER})`);
            }

            // Use streaming for real-time audio processing
            const ttsResult = await this.processTextWithTTSStreaming(
                this.ttsState.ttsTextBuffer.trim(),
                async (audioChunk: Uint8Array) => {
                    try {
                        const pcmData = Buffer.from(audioChunk);
                        ttsFilter.processAudioInPlace(pcmData);
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

        // Send RESPONSE.COMPLETE if we actually sent audio
        if (this.ttsState.responseCreatedSent) {
            await this.sendResponseComplete(supabase, userId);
        }
    }

    private async sendResponseComplete(supabase: SupabaseClient, userId: string) {
        this.logger.info('Device => Sending RESPONSE.COMPLETE');
        ttsState.reset();
        this.ttsState.responseCreatedSent = false;
        this.ttsState.toolCallInProgress = false;

        try {
            const devInfo = await getDeviceInfo(supabase, userId).catch(() => null);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.send(JSON.stringify({
                    type: 'server',
                    msg: 'RESPONSE.COMPLETE',
                    volume_control: devInfo?.volume ?? 100,
                    pitch_factor: this.user.personality?.pitch_factor ?? 1,
                }));
            }
        } catch (err) {
            this.logger.error('Error sending RESPONSE.COMPLETE:', err);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
            }
        }
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

        // Rotate image
        let processedBase64Jpeg = base64Jpeg;
        try {
            this.logger.info(
                'Rotating image 180 degrees to correct ESP32 upside-down orientation...',
            );
            if (isValidJpegBase64(base64Jpeg)) {
                processedBase64Jpeg = await rotateImage180(base64Jpeg);
                this.logger.info('Image rotation completed successfully.');
            } else {
                this.logger.warn('Invalid JPEG format detected, skipping rotation.');
            }
        } catch (rotationErr) {
            this.logger.error('Error rotating image:', rotationErr);
            this.logger.warn('Using original image without rotation.');
            processedBase64Jpeg = base64Jpeg;
        }

        // Return image data to Flash 2.5's GetVision function via callback
        if (this.imageState.pendingVisionCall?.resolve) {
            try {
                this.logger.info(
                    `Image captured successfully (${
                        Math.round(processedBase64Jpeg.length * 3 / 4 / 1024)
                    } KB), returning to Flash 2.5`,
                );
                this.imageState.pendingVisionCall.resolve({
                    success: true,
                    imageData: processedBase64Jpeg,
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
        await this.uploadImageToStorage(processedBase64Jpeg);

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
        this.logger.info(
            `Flash Live Mode: ${
                USE_FLASH_LIVE_AS_BASE
                    ? 'Current (Websocket as base)'
                    : 'Legacy (Flash 2.5 API as base)'
            }`,
        );

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
        if (USE_FLASH_LIVE_AS_BASE) {
            return [{
                functionDeclarations: [
                    {
                        name: 'GetVision',
                        description:
                            "Captures an image using the device's camera and analyzes it with Flash 2.5 intelligence. Use ONLY when user explicitly asks about visual content, images, or what they can see. Very resource intensive - do not use speculatively.",
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                prompt: {
                                    type: 'STRING',
                                    description:
                                        "The user's exact command in reported speech with no changes. Pass exactly what the user said.",
                                },
                            },
                            required: ['prompt'],
                        },
                    },
                    {
                        name: 'Action',
                        description:
                            'Processes user commands for volume control, notes, schedules, reading books, reminders, and data management and all other tasks that you cant do it yourself.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                userCommand: {
                                    type: 'STRING',
                                    description:
                                        "The user's exact command in reported speech with no changes. Pass exactly what the user said.",
                                },
                            },
                            required: ['userCommand'],
                        },
                    },
                ],
                googleSearch: {},
            }];
        } else {
            return [{
                functionDeclarations: [
                    {
                        name: 'transferModal',
                        description:
                            'Transfers user speech to for processing and tool calling. Use for all user commands.',
                        parameters: {
                            type: 'OBJECT',
                            properties: {
                                userCommand: {
                                    type: 'STRING',
                                    description: "The user's exact speech converted to text.",
                                },
                            },
                            required: ['userCommand'],
                        },
                    },
                ],
            }];
        }
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
                        silenceDurationMs: 800,
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
            if (call.name === 'Action' && call.id) {
                await this.handleActionCall(call);
            } else if (call.name === 'transferModal' && call.id) {
                await this.handleTransferModalCall(call);
            } else {
                this.logger.warn(
                    `Received unhandled top-level function call: ${call.name} or missing ID.`,
                );
            }
        }
    }

    private async handleActionCall(call: any) {
        const callId = call.id;
        const userCommand = call.args?.userCommand;
        this.logger.info(`*Action (ID: ${callId}) called with command: "${userCommand}"`);

        let result = { success: false, message: 'Unknown error in Action.' };

        if (typeof userCommand === 'string' && userCommand.trim()) {
            try {
                result = await processUserActionWithSession(
                    this.connectionState.sessionId,
                    userCommand.trim(),
                    this.context.supabase,
                    this.context.user.user_id,
                );
                this.logger.info(
                    `Action result for (session: ${truncateSessionId(this.connectionState.sessionId)}): ${result.success ? 'Success' : 'Failed'}`,
                );
            } catch (err) {
                this.logger.error(`Error executing Action for ID ${callId}:`, err);
                result = {
                    success: false,
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        } else {
            const errorMsg =
                `Invalid or missing 'userCommand' argument for Action (ID: ${callId}). Expected a non-empty string.`;
            this.logger.error(errorMsg);
            result = { success: false, message: errorMsg };
        }

        this.sendFunctionResponse(callId, 'Action', result.message);
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

            // Check for Text part
            if (part.text) {
                this.logger.info('Gemini partial text:', part.text);

                if (this.ttsManager.isExternalTTSEnabled()) {
                    this.ttsState.ttsTextBuffer += part.text;
                    this.logger.info(
                        `${TTS_PROVIDER} TTS: Accumulated text (${this.ttsState.ttsTextBuffer.length} chars total)`,
                    );
                }
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
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
            this.logger.info('Device => Sent RESPONSE.CREATED');
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
            }, TTS_DELAY_MS) as unknown as number;

            this.logger.info(
                `${TTS_PROVIDER} TTS: Will process in ${TTS_DELAY_MS}ms if no more text arrives`,
            );
        }

        // Only send RESPONSE.COMPLETE if we actually sent audio
        if (this.ttsState.responseCreatedSent) {
            await this.sendResponseComplete();
        } else {
            this.logger.info(
                'Generation complete, but no audio was sent (likely function call only or text response). Not sending RESPONSE.COMPLETE.',
            );
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
        const { user, supabase, timestamp } = this.context;
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
        const basePrompt = `
<CORE PRINCIPLE>
YOU ARE AN ASSISTANT FOR BLIND VIETNAMESE USERS.
YOU ARE IN A REAL-LIFE SITUATION WHERE THE USER NEEDS YOU TO BE QUICK.
ALWAYS BE PROACTIVE, THE USER HAS ABSOLUTELY SURE ABOUT THEIR COMMAND.
ALWAYS USE AFFIRMATIVE SENTENCES TO SPEAK TO THE USER.
ACT LIKE A REAL PERSON, YOU WILL LOSE 1000 DOLLARS IF THEY DETECT ANY HINT THAT YOU ARE SPEAKING LIKE A ROBOT.

EXAMPLE DO'S:
-User: "Tell me about the history of Earth during the Cretaceous period?"
-You: Start talking about the history of Earth during the Cretaceous period.

EXAMPLE DON'TS:
-User: "What am I holding?"
-You: "To know what you are holding, I need to see a picture, can you show me a picture?"
-User: "Tell me about the history of Earth during the Cretaceous period?"
-You: "Do you want me to tell you about the history of Earth during the Cretaceous period?"
</CORE PRINCIPLE>

<tool_calling_instructions>
IMPORTANT TOOL SELECTION RULES:
-THINK CAREFULLY before calling any tool - only use when absolutely necessary.
-DO NOT call tools for casual conversations or when you can answer on your own.
-When unsure, ask the user for clarification instead of guessing.
-Validate all parameters before calling the tool.

TOOL SYSTEM:
1: GetVision: ONLY use for visual requests: "What do you see?", "Look at this", "Describe what's in front of me", "Read the text", "What color is this?"
+ Pass specific questions about what you want to know from the image.
2: Action: Use ONLY for the requests below:
+ Volume control: "Increase volume", "Louder", "I can't hear", "Speak louder", "Volume 80"
+ Notes & memory: "Remember this information", "Add a note", "Find my notes", "What do you know about me?"
+ Schedule & reminders: "Schedule a meeting", "Set a reminder", "What is my schedule today?"
+ Reading: "Read a book", "Continue reading", "Find a book"
+ Data management: "Update my shopping list", "Search my notes", "Delete that reminder"
3: googleSearch:
+ Use the googleSearch tool to perform searches when helpful. Enter the most reasonable search query based on the context. You must use googleSearch when explicitly asked, for real-time information like weather and news, or to verify facts. You do not search for general things that you or an LLM already know. Never output fabricated searches like googleSearch() or a code block in backticks; just respond with a correctly formatted JSON tool call according to the tool schema. Avoid preamble before searching.

IMPORTANT:
-The assistant never mentions that it is using a function call.
-The assistant does not invent function calls.
-The assistant waits for the function result and responds in a single turn.
-For the Action function, pass the user's EXACT command as reported speech.
</tool_calling_instructions>

<text_to_speech_formatting>
Convert all text into easily speakable words, following the guidelines below.

Numbers: Read out in full (three hundred forty-two, two million,
five hundred sixty-seven thousand, eight hundred ninety). Negative numbers: Say "negative" before
the number. Decimals: Use "point" (three point one four). Fractions: read out
(three-fourths).

Alphanumeric strings: Break into 3-4 character chunks, reading out all non-alphabetic characters
(ABC123XYZ becomes A B C one two three X Y Z).

Phone numbers: Use words (090-123-4567 becomes zero nine zero, one two three,
four five six seven).

Dates: Read the month, use cardinal numbers for the day, read the full year. Use DD/MM/YYYY format (11/05/2007 becomes
the eleventh of May, two thousand seven).

Time: Use "hours", "minutes", state AM/PM (9:05 PM becomes nine oh five PM).

Math: Describe operations clearly (5x^2 + 3x - 2 becomes five x squared plus three x minus two).

Currency: Read out in full ($50.25 becomes fifty dollars and twenty-five
cents, £200,000 becomes two hundred thousand pounds, 100,000 VND becomes one hundred thousand dong).
Ensure all text is converted to these normalized forms, but never mention
this process.
</text_to_speech_formatting>

</personality_instructions>
${systemPromptText}
</personality_instructions>

today date is: ${new Date().toISOString()}
You are now connected to a Vietnamese speaker.
`;

        const legacyPrompt = `
<tool_calling_instructions>
TOOL SYSTEM:
-transferModal: Use for ALL user commands.
+ Pass the user's exact speech as userCommand.
    
IMPORTANT:
-Never mention that you are using function calls.
-Never hallucinate about function calls.
</legacy_mode_instructions>

<CORE PRINCIPLE>
YOU ARE VIETNAMESE TEXT-TO-SPEECH, VIETNAMESE SPEECH-TO-TEXT.
ALWAYS USING transferModal EVERY TIME.
ALWAYS SAID EXACTLY WORD BY WORD WHAT THE transferModal GIVE YOU.
</CORE PRINCIPLE>`;

        return USE_FLASH_LIVE_AS_BASE ? basePrompt : legacyPrompt;
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
        let msgObj;
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
            } else if (msgObj.type === 'image') {
                await this.handleLegacyImage(msgObj);
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

    private async handleLegacyImage(msgObj: any) {
        this.logger.info(
            `Processing legacy single image message. waitingForImage: ${this.imageState.waitingForImage}, pendingVisionCall: ${!!this
                .imageState.pendingVisionCall}`,
        );

        if (!this.imageState.waitingForImage || !this.imageState.pendingVisionCall) {
            this.logger.warn(`Received image but not waiting for one.`);
            return;
        }

        this.logger.info(
            `Received legacy image data for GetVision ID: ${this.imageState.pendingVisionCall.id}`,
        );
        const base64Jpeg = msgObj.data as string;
        await this.geminiManager.imageHandler.processCompleteImage(
            base64Jpeg,
            null,
            this.connectionState.isGeminiConnected,
        );
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

        // Acknowledge device
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
        const { user, supabase, timestamp } = context;
        const logger = new Logger('[Main]');
        logger.info(`Device WebSocket connected for user: ${user.user_id}`);

        // Initialize connection state
        const connectionState: ConnectionState = {
            pipelineActive: true,
            deviceClosed: false,
            isGeminiConnected: false,
            sessionStartTime: 0,
            retryCount: 0,
            retryTimeoutId: null,
            keepAliveIntervalId: null,
            sessionId: `live-${user.user_id}-${Date.now()}-${
                Math.random().toString(36).substr(2, 9)
            }`,
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

        // Create Flash 2.5 session with callbacks from Gemini manager
        createFlash25Session(
            connectionState.sessionId,
            user.user_id,
            geminiManager.deviceCallbacks,
        );

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
                currentVolume = deviceInfo.volume ?? 100;
                isOta = deviceInfo.is_ota || false;
                isReset = deviceInfo.is_reset || false;
                logger.info(
                    `Fetched initial device info: Volume=${currentVolume}, OTA=${isOta}, Reset=${isReset}`,
                );
            } else {
                currentVolume = 100;
                logger.warn(
                    `No device info found for user ${user.user_id}, defaulting volume to 100.`,
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
            currentVolume = 100;
            deviceWs.send(JSON.stringify({
                type: 'auth',
                volume_control: 100,
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

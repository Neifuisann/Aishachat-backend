import { Buffer } from 'node:buffer';
import { WebSocket as WSWebSocket } from 'npm:ws';
import type { RawData, WebSocketServer as _WSS } from 'npm:ws';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// Import configurations and utilities
import * as config from '../config/config.ts';
import { AudioFilter, boostTtsVolumeInPlace, ttsState } from '../audio/audio.ts';
import { ADPCMStreamProcessor } from '../audio/adpcm.ts';
import { audioDebugManager } from '../audio/audio_debug.ts';
import { SetVolume } from '../audio/volume_handler.ts';
import { isValidJpegBase64 } from '../utils/image_utils.ts';
import { Logger } from '../utils/logger.ts';

// TTS imports
import {
    convertTextToSpeechStreaming as convertAzureTTSStreaming,
    validateAzureTTSConfig,
    DEFAULT_VOICE,
    type AzureTTSRequest,
} from '../audio/azure_tts.ts';

// STT imports
import { AzureSTTManager, validateAzureSTTConfig } from '../audio/azure_stt.ts';

// Flash handler imports
import {
    createFlash25Session,
    destroyFlash25Session,
    type DeviceOperationCallbacks,
    processUserActionWithSession,
} from './flash_handler.ts';

// Supabase imports
import * as supabaseService from '../services/supabase.ts';

// ===== Constants =====
const CONSTANTS = {
    MAX_RETRIES: 10,
    RETRY_DELAYS: [1000, 2000, 4000, 8000, 16000, 30000, 60000, 120000, 180000, 300000],
    KEEP_ALIVE_INTERVAL: 30000,
    TTS_DELAY_MS: 100,
    LEGACY_MODE_PROMPT: `
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
</CORE PRINCIPLE>`
};

// ===== Type Definitions =====
interface ConnectionContext {
    user: any;
    supabase: SupabaseClient;
    timestamp: string;
}

interface SessionData {
    sessionId: string;
    userId: string;
    timestamp: Date;
    errorType: 'device_error' | 'gemini_error' | 'quota_exceeded' | 'connection_failed';
    errorMessage: string;
    sessionContext?: any;
}

interface States {
    connection: {
        pipelineActive: boolean;
        deviceClosed: boolean;
        isGeminiConnected: boolean;
        sessionStartTime: number;
        retryCount: number;
        retryTimeoutId: ReturnType<typeof setTimeout> | null;
        keepAliveIntervalId: ReturnType<typeof setInterval> | null;
        sessionId: string;
    };
    audio: {
        micAccum: Uint8Array;
        lastCompressionRatio: number | undefined;
        micFilter: AudioFilter;
        ttsFilter: AudioFilter;
        adpcmProcessor: ADPCMStreamProcessor;
        azureSTTManager?: AzureSTTManager;
    };
    tts: {
        responseCreatedSent: boolean;
        ttsTextBuffer: string;
        ttsTimeout: number | null;
        toolCallInProgress: boolean;
    };
    image: {
        pendingVisionCall: { prompt: string; id?: string; resolve?: (value: any) => void; } | null;
        waitingForImage: boolean;
        photoCaptureFailed: boolean;
        imageTimeoutId: ReturnType<typeof setTimeout> | null;
        imageChunkAssembly: {
            chunks: Map<number, string>;
            totalChunks: number;
            receivedCount: number;
            timestamp: number;
            mime?: string;
        } | null;
        chunkTimeoutId: ReturnType<typeof setTimeout> | null;
    };
}

// ===== Utility Functions =====
const utils = {
    truncateSessionId: (sessionId: string): string => {
        if (sessionId.startsWith('live-')) {
            const parts = sessionId.split('-');
            if (parts.length >= 3) return `${parts[0]}-${parts[1]}...`;
        }
        return sessionId.length > 20 ? sessionId.substring(0, 20) + '...' : sessionId;
    },
    
    extractUserCommand: (functionCalls: any[]): string => {
        const transferModalCall = functionCalls.find(call => call.name === 'transferModal');
        return transferModalCall?.args?.userCommand || 'N/A';
    },
    
    extractResult: (responsePayload: any): string => {
        const response = responsePayload?.functionResponses?.[0]?.response?.result;
        return response || 'N/A';
    },
    
    generateSessionId: (userId: string): string => {
        return `live-${userId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }
};

// ===== Session Error Tracker Singleton =====
class SessionErrorTracker {
    private static instance: SessionErrorTracker;
    private resumableSessions = new Map<string, SessionData>();
    private logger = new Logger('[SessionErrorTracker]');

    static getInstance(): SessionErrorTracker {
        if (!this.instance) this.instance = new SessionErrorTracker();
        return this.instance;
    }

    saveSessionForResumption(
        userId: string,
        sessionId: string,
        errorType: SessionData['errorType'],
        errorMessage: string,
        sessionContext?: any
    ): void {
        if (!config.SESSION_RESUMPTION_CONFIG.enabled) return;

        const resumableData: SessionData = {
            sessionId,
            userId,
            timestamp: new Date(),
            errorType,
            errorMessage,
            sessionContext,
        };

        this.resumableSessions.set(userId, resumableData);
        this.logger.info(
            `Saved session ${utils.truncateSessionId(sessionId)} for user ${userId} due to ${errorType}: ${errorMessage}`
        );

        setTimeout(() => {
            if (this.resumableSessions.get(userId)?.sessionId === sessionId) {
                this.resumableSessions.delete(userId);
                this.logger.info(`Expired resumable session ${utils.truncateSessionId(sessionId)} for user ${userId}`);
            }
        }, config.SESSION_RESUMPTION_CONFIG.timeoutMs);
    }

    getResumableSession(userId: string): SessionData | null {
        const resumableData = this.resumableSessions.get(userId);
        if (!resumableData) return null;

        const sessionAge = Date.now() - resumableData.timestamp.getTime();
        if (sessionAge > config.SESSION_RESUMPTION_CONFIG.timeoutMs) {
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
                `Cleared resumable session ${utils.truncateSessionId(resumableData.sessionId)} for user ${userId}`
            );
        }
    }

    hasResumableSession(userId: string): boolean {
        return this.getResumableSession(userId) !== null;
    }
}

// ===== TTS Manager =====
class TTSManager {
    private logger = new Logger('[TTS]');

    constructor(
        private deviceWs: WSWebSocket,
        private user: any,
        private ttsState: States['tts'],
        private ttsFilter?: AudioFilter
    ) {}

    isExternalTTSEnabled(): boolean {
        return config.TTS_PROVIDER !== 'GEMINI';
    }

    async processPartialText(text: string): Promise<void> {
        if (!this.isExternalTTSEnabled()) return;
        this.ttsState.ttsTextBuffer += text;
    }

    async processTextWithTTSStreaming(
        text: string,
        onAudioChunk: (chunk: Uint8Array) => Promise<void>
    ): Promise<{ success: boolean; error?: string } | null> {
        switch (config.TTS_PROVIDER) {
            case 'AZURE_TTS':
                if (!validateAzureTTSConfig()) {
                    this.logger.error('Azure TTS not properly configured');
                    return null;
                }
                
                const azureTTSVoice = this.user.personality?.azure_tts_voice || DEFAULT_VOICE;
                this.logger.info(`Azure TTS: Processing text "${text}" with voice "${azureTTSVoice}"`);
                
                try {
                    const result = await convertAzureTTSStreaming(
                        { text, voice: azureTTSVoice },
                        onAudioChunk
                    );
                    
                    if (result.success) {
                        this.logger.info(`Azure TTS: Successfully processed text`);
                        return { success: true };
                    } else {
                        this.logger.error(`Azure TTS: Failed - ${result.error}`);
                        return { success: false, error: result.error };
                    }
                } catch (error) {
                    this.logger.error(`Azure TTS: Error processing text:`, error);
                    return { 
                        success: false, 
                        error: error instanceof Error ? error.message : String(error) 
                    };
                }
                
            case 'GEMINI':
            default:
                return null;
        }
    }

    async processTTSWithDelay(): Promise<void> {
        if (!this.ttsState.ttsTextBuffer.trim()) {
            this.logger.info('TTS delay timeout reached, but no text to process');
            return;
        }

        try {
            this.logger.info(
                `${config.TTS_PROVIDER} TTS: Processing delayed text (${this.ttsState.ttsTextBuffer.length} chars)`
            );

            if (!this.ttsState.responseCreatedSent && this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.ttsState.responseCreatedSent = true;
                this.logger.info('Device => Sent RESPONSE.CREATED (delayed TTS)');
            }

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
                                this.logger.warn('Device WS closed while sending TTS frames');
                                break;
                            }
                        }
                    } catch (error) {
                        this.logger.error('Error processing TTS audio chunk:', error);
                    }
                }
            );

            if (!ttsResult) {
                this.logger.error(`${config.TTS_PROVIDER} TTS: Provider not properly configured`);
            } else if (!ttsResult.success) {
                this.logger.error(`${config.TTS_PROVIDER} TTS failed:`, ttsResult.error);
            } else {
                this.logger.info(`${config.TTS_PROVIDER} TTS streaming completed successfully`);
            }
        } catch (error) {
            this.logger.error(`Error processing ${config.TTS_PROVIDER} TTS:`, error);
        }

        this.ttsState.ttsTextBuffer = '';
        this.ttsState.ttsTimeout = null;
    }
}

// ===== Image Handler =====
class ImageHandler {
    private logger = new Logger('[Image]');

    constructor(
        private supabase: SupabaseClient,
        private user: any,
        private imageState: States['image']
    ) {}

    async processCompleteImage(
        base64Jpeg: string,
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean
    ): Promise<void> {
        if (!base64Jpeg || typeof base64Jpeg !== 'string') {
            this.logger.error('Invalid image data received');
            this.handleImageError(
                geminiWs,
                isGeminiConnected,
                'Failed to receive valid image data from device.'
            );
            return;
        }

        this.imageState.waitingForImage = false;

        if (this.imageState.imageTimeoutId) {
            clearTimeout(this.imageState.imageTimeoutId);
            this.imageState.imageTimeoutId = null;
        }

        if (this.imageState.pendingVisionCall?.resolve) {
            try {
                this.logger.info(
                    `Image captured successfully (${Math.round(base64Jpeg.length * 3 / 4 / 1024)} KB)`
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
                    message: `Error processing captured image: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                });
            }
        } else {
            this.logger.error('No pending vision call found');
        }

        await this.uploadImageToStorage(base64Jpeg);
        this.imageState.pendingVisionCall = null;
    }

    private async uploadImageToStorage(base64Jpeg: string): Promise<void> {
        try {
            this.logger.info(
                `Uploading image (${Math.round(base64Jpeg.length * 3 / 4 / 1024)} KB)`
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
                this.logger.error('Failed to upload image:', uploadError);
                this.imageState.photoCaptureFailed = true;
            } else if (uploadData) {
                this.logger.info(`Image uploaded successfully: ${bucketName}/${uploadData.path}`);
            }
        } catch (error) {
            this.logger.error('Unexpected error during upload:', error);
            this.imageState.photoCaptureFailed = true;
        }
    }

    private handleImageError(
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean,
        errorMessage: string
    ): void {
        this.imageState.waitingForImage = false;
        this.imageState.photoCaptureFailed = true;

        if (
            isGeminiConnected && 
            geminiWs?.readyState === WSWebSocket.OPEN &&
            this.imageState.pendingVisionCall?.id
        ) {
            const functionResponse = {
                toolResponse: {
                    functionResponses: [{
                        id: this.imageState.pendingVisionCall.id,
                        name: 'GetVision',
                        response: { result: errorMessage },
                    }],
                }
            };

            try {
                geminiWs.send(JSON.stringify(functionResponse));
                this.logger.info('Sent error function response to Gemini');
            } catch (err) {
                this.logger.error('Failed to send error response:', err);
            }
        }

        this.imageState.pendingVisionCall = null;
    }

    handleImageChunk(
        msgObj: any,
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean
    ): void {
        this.logger.info(`Received image chunk ${msgObj.chunk_index + 1}/${msgObj.total_chunks}`);

        if (!this.imageState.waitingForImage || !this.imageState.pendingVisionCall) {
            this.logger.warn('Received image chunk but not waiting for image');
            return;
        }

        if (!this.imageState.imageChunkAssembly) {
            this.imageState.imageChunkAssembly = {
                chunks: new Map(),
                totalChunks: msgObj.total_chunks,
                receivedCount: 0,
                timestamp: Date.now(),
            };

            this.imageState.chunkTimeoutId = setTimeout(() => {
                this.logger.error('Image chunk assembly timeout');
                this.handleChunkTimeout(geminiWs, isGeminiConnected);
            }, config.IMAGE_CHUNK_TIMEOUT_MS);
        }

        this.imageState.imageChunkAssembly.chunks.set(msgObj.chunk_index, msgObj.data);
        this.imageState.imageChunkAssembly.receivedCount++;

        if (
            this.imageState.imageChunkAssembly.receivedCount ===
            this.imageState.imageChunkAssembly.totalChunks
        ) {
            this.assembleCompleteImage(geminiWs, isGeminiConnected);
        }
    }

    private async assembleCompleteImage(
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean
    ): Promise<void> {
        this.logger.info('Assembling complete image');

        if (this.imageState.chunkTimeoutId) {
            clearTimeout(this.imageState.chunkTimeoutId);
            this.imageState.chunkTimeoutId = null;
        }

        let completeBase64 = '';
        for (let i = 0; i < this.imageState.imageChunkAssembly!.totalChunks; i++) {
            const chunk = this.imageState.imageChunkAssembly!.chunks.get(i);
            if (!chunk) {
                this.logger.error(`Missing chunk ${i}`);
                this.imageState.imageChunkAssembly = null;
                this.imageState.waitingForImage = false;
                this.imageState.pendingVisionCall = null;
                return;
            }
            completeBase64 += chunk;
        }

        this.logger.info(`Image assembly complete - ${completeBase64.length} characters`);
        this.imageState.imageChunkAssembly = null;
        await this.processCompleteImage(completeBase64, geminiWs, isGeminiConnected);
    }

    private handleChunkTimeout(
        geminiWs: WSWebSocket | null,
        isGeminiConnected: boolean
    ): void {
        this.imageState.imageChunkAssembly = null;
        this.imageState.waitingForImage = false;

        if (
            isGeminiConnected && 
            geminiWs?.readyState === WSWebSocket.OPEN &&
            this.imageState.pendingVisionCall?.id
        ) {
            const functionResponse = {
                toolResponse: {
                    functionResponses: [{
                        id: this.imageState.pendingVisionCall.id,
                        name: 'GetVision',
                        response: { result: 'Image capture failed: Incomplete chunk transmission.' },
                    }],
                }
            };

            try {
                geminiWs.send(JSON.stringify(functionResponse));
                this.logger.info('Sent chunk timeout error response');
            } catch (err) {
                this.logger.error('Failed to send chunk timeout error:', err);
            }
        }

        this.imageState.pendingVisionCall = null;
        this.imageState.chunkTimeoutId = null;
    }
}

// ===== Gemini Connection Manager =====
class GeminiConnectionManager {
    private logger = new Logger('[Gemini]');
    private geminiWs: WSWebSocket | null = null;
    private ttsManager: TTSManager;
    public imageHandler: ImageHandler;
    public deviceCallbacks: DeviceOperationCallbacks;

    constructor(
        private context: ConnectionContext,
        private deviceWs: WSWebSocket,
        private states: States
    ) {
        this.ttsManager = new TTSManager(
            deviceWs,
            context.user,
            states.tts,
            states.audio.ttsFilter
        );
        this.imageHandler = new ImageHandler(context.supabase, context.user, states.image);
        this.deviceCallbacks = {
            requestPhoto: this.requestPhoto.bind(this),
            setVolume: this.setVolume.bind(this),
        };
    }

    private async requestPhoto(callId: string): Promise<any> {
        return new Promise((resolve) => {
            if (this.states.image.waitingForImage) {
                resolve({
                    success: false,
                    message: 'Already waiting for an image. Please try again later.',
                });
                return;
            }

            this.states.image.pendingVisionCall = {
                prompt: 'Flash 2.5 vision request',
                id: callId,
                resolve,
            };
            this.states.image.waitingForImage = true;

            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.logger.info(`Sending photo request for call ${callId}`);
                this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'REQUEST.PHOTO' }));
            } else {
                this.logger.error('Device WS not open for photo request');
                this.states.image.waitingForImage = false;
                this.states.image.pendingVisionCall = null;
                resolve({
                    success: false,
                    message: 'Device connection not available for photo capture.',
                });
            }
        });
    }

    private async setVolume(volumeLevel: number, callId: string): Promise<any> {
        this.logger.info(`SetVolume called: ${volumeLevel} (ID: ${callId})`);

        if (typeof volumeLevel !== 'number' || volumeLevel < 0 || volumeLevel > 100) {
            return {
                success: false,
                message: 'Invalid volume level. Must be a number between 0 and 100.',
            };
        }

        try {
            return await SetVolume(
                this.context.supabase,
                this.context.user.user_id,
                volumeLevel
            );
        } catch (err) {
            this.logger.error(`Error setting volume:`, err);
            return { 
                success: false, 
                message: err instanceof Error ? err.message : String(err) 
            };
        }
    }

    async connect(systemPrompt: string, firstMessage: string | null): Promise<void> {
        const currentKey = config.apiKeyManager.getCurrentKey();
        if (!currentKey) {
            this.logger.error('Missing API Key');
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.close(1011, 'Server Configuration Error: Missing API Key');
            }
            return;
        }

        const voiceName = this.context.user.personality?.oai_voice || 'Leda';
        this.logger.info(`Using TTS voice: ${voiceName}, Provider: ${config.TTS_PROVIDER}`);

        const gemUrl = config.GEMINI_LIVE_URL_TEMPLATE.replace('{api_key}', currentKey);
        this.logger.info('Connecting to Gemini Live');
        
        this.geminiWs = new WSWebSocket(gemUrl);
        this.setupGeminiEventHandlers(systemPrompt, firstMessage, voiceName);
    }

    private setupGeminiEventHandlers(
        systemPrompt: string,
        firstMessage: string | null,
        voiceName: string
    ): void {
        if (!this.geminiWs) return;

        this.geminiWs.on('open', () => this.handleGeminiOpen(systemPrompt, firstMessage, voiceName));
        this.geminiWs.on('message', async (data: RawData) => await this.handleGeminiMessage(data));
        this.geminiWs.on('close', (code, reason) => this.handleGeminiClose(code, reason));
        this.geminiWs.on('error', (err) => this.handleGeminiError(err));
    }

    private handleGeminiOpen(
        systemPrompt: string,
        firstMessage: string | null,
        voiceName: string
    ): void {
        this.states.connection.isGeminiConnected = true;
        this.states.connection.sessionStartTime = Date.now();
        this.logger.info('Gemini Live connection established');

        const sessionErrorTracker = SessionErrorTracker.getInstance();
        if (sessionErrorTracker.hasResumableSession(this.context.user.user_id)) {
            sessionErrorTracker.clearResumableSession(this.context.user.user_id);
            this.logger.info('Cleared resumable session due to successful connection');
        }

        this.states.connection.keepAliveIntervalId = setInterval(
            () => this.sendKeepAliveAudioChunk(),
            CONSTANTS.KEEP_ALIVE_INTERVAL
        );

        const tools = [{
            functionDeclarations: [{
                name: 'transferModal',
                description: 'Transfers user original speech. Use for all user commands.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        userCommand: {
                            type: 'STRING',
                            description: "The user's speech converted to text.",
                        },
                    },
                    required: ['userCommand'],
                },
            }],
        }];

        const responseModalities = this.ttsManager.isExternalTTSEnabled() ? ['TEXT'] : ['AUDIO'];
        
        const setupMsg = {
            setup: {
                model: 'models/gemini-2.0-flash-live-001',
                generationConfig: {
                    responseModalities,
                    speechConfig: this.ttsManager.isExternalTTSEnabled() ? undefined : {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName },
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

        try {
            this.geminiWs?.send(JSON.stringify(setupMsg));
            this.logger.info('Sent Gemini setup message');
            this.sendInitialTurn(firstMessage);
        } catch (err) {
            this.logger.error('Failed to send setup:', err);
            if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                this.deviceWs.close(1011, 'Gemini setup failed');
            }
        }
    }

    private sendInitialTurn(firstMessage: string | null): void {
        const message = firstMessage || 'Xin chào!';
        this.logger.info(`Sending initial turn: "${message}"`);
        
        const userTurn = {
            clientContent: {
                turns: [{ role: 'user', parts: [{ text: message }] }],
                turnComplete: true,
            },
        };
        
        this.geminiWs?.send(JSON.stringify(userTurn));
    }

    private async handleGeminiMessage(data: RawData): Promise<void> {
        if (
            !this.states.connection.pipelineActive || 
            this.states.connection.deviceClosed ||
            !this.geminiWs || 
            this.geminiWs.readyState !== WSWebSocket.OPEN
        ) {
            return;
        }

        try {
            const msg = JSON.parse(data.toString('utf-8'));
            await this.processGeminiMessage(msg);
        } catch (err) {
            this.logger.warn('Failed to parse Gemini message:', err);
        }
    }

    private async processGeminiMessage(msg: any): Promise<void> {
        if (!this.states.connection.pipelineActive || this.states.connection.deviceClosed) return;

        if (msg.setupComplete) {
            this.logger.info('Setup Complete');
            return;
        }

        if (msg.toolCall?.functionCalls && Array.isArray(msg.toolCall.functionCalls)) {
            await this.handleToolCalls(msg.toolCall.functionCalls);
        }

        if (msg.serverContent?.modelTurn?.parts) {
            await this.handleServerContent(msg.serverContent.modelTurn.parts);
        }

        if (msg.serverContent?.generationComplete) {
            await this.handleGenerationComplete();
        }

        await this.handleTranscriptions(msg);

        if (msg.goAway) {
            this.handleGoAway(msg.goAway);
        }
    }

    private async handleToolCalls(functionCalls: any[]): Promise<void> {
        const userCommand = utils.extractUserCommand(functionCalls);
        this.logger.info(`Tool calls: ${functionCalls.map(c => c.name).join(', ')} | Command: "${userCommand}"`);

        if (this.states.tts.toolCallInProgress) {
            this.logger.info('Tool call already in progress');
            return;
        }

        this.states.tts.toolCallInProgress = true;

        for (const call of functionCalls) {
            if (call.name === 'transferModal' && call.id) {
                await this.handleTransferModalCall(call);
            }
        }
    }

    private async handleTransferModalCall(call: any): Promise<void> {
        const callId = call.id;
        const userCommand = call.args?.userCommand;
        const searchResults = call.args?.searchResults;

        this.logger.info(`transferModal (ID: ${callId}) | Command: "${userCommand}"`);

        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
            this.logger.info('Sent SPEAKING state');
        }

        let result = { success: false, message: 'Unknown error in transferModal.' };

        if (typeof userCommand === 'string' && userCommand.trim()) {
            try {
                let fullCommand = userCommand.trim();
                if (searchResults && typeof searchResults === 'string' && searchResults.trim()) {
                    fullCommand = `${userCommand.trim()}\n\nSearch Results: ${searchResults.trim()}`;
                }

                result = await processUserActionWithSession(
                    this.states.connection.sessionId,
                    fullCommand,
                    this.context.supabase,
                    this.context.user.user_id,
                );

                if (result.success && result.message && this.ttsManager.isExternalTTSEnabled()) {
                    this.logger.info('Sending Flash 2.5 response directly to Azure TTS');
                    
                    const ttsResult = await this.ttsManager.processTextWithTTSStreaming(
                        result.message,
                        async (audioChunk: Uint8Array) => {
                            try {
                                const pcmData = Buffer.from(audioChunk);
                                if (this.states.audio.ttsFilter) {
                                    this.states.audio.ttsFilter.processAudioInPlace(pcmData);
                                }
                                boostTtsVolumeInPlace(pcmData, 3.0);
                                
                                const opusFrames = await ttsState.encodePcmChunk(pcmData);
                                for (const frame of opusFrames) {
                                    if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                                        this.deviceWs.send(frame);
                                    } else {
                                        this.logger.warn('Device WS closed');
                                        break;
                                    }
                                }
                            } catch (error) {
                                this.logger.error('Error processing TTS chunk:', error);
                            }
                        }
                    );

                    if (ttsResult?.success) {
                        this.logger.info('Flash 2.5 response processed by Azure TTS');
                    }

                    await this.sendResponseComplete();
                    this.sendFunctionResponse(callId, 'transferModal', 'Response processed successfully');
                    return;
                }
            } catch (err) {
                this.logger.error(`Error in transferModal:`, err);
                result = {
                    success: false,
                    message: err instanceof Error ? err.message : String(err),
                };
            }
        }

        this.sendFunctionResponse(callId, 'transferModal', result.message);
    }

    private sendFunctionResponse(callId: string, functionName: string, result: string): void {
        if (
            this.states.connection.isGeminiConnected && 
            this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            const functionResponse = {
                toolResponse: {
                    functionResponses: [{
                        id: callId,
                        name: functionName,
                        response: { result },
                    }],
                }
            };

            try {
                this.geminiWs.send(JSON.stringify(functionResponse));
                this.logger.info(`Sent ${functionName} response (ID: ${callId})`);
            } catch (err) {
                this.logger.error(`Failed to send ${functionName} response:`, err);
            }
        }
    }

    private async handleServerContent(parts: any[]): Promise<void> {
        for (const part of parts) {
            if (part.text && this.ttsManager.isExternalTTSEnabled()) {
                await this.ttsManager.processPartialText(part.text);
            }

            if (part.inlineData?.data) {
                await this.handleAudioData(part.inlineData.data);
            }
        }
    }

    private async handleAudioData(audioData: string): Promise<void> {
        if (!this.states.tts.responseCreatedSent && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.states.tts.responseCreatedSent = true;
        }

        try {
            const pcmData = Buffer.from(audioData, 'base64');
            this.states.audio.ttsFilter.processAudioInPlace(pcmData);
            boostTtsVolumeInPlace(pcmData, 3.0);
            
            const opusFrames = await ttsState.encodePcmChunk(pcmData);
            for (const frame of opusFrames) {
                if (
                    this.deviceWs.readyState === WSWebSocket.OPEN &&
                    !this.states.connection.deviceClosed
                ) {
                    this.deviceWs.send(frame);
                } else {
                    this.logger.warn('Device WS closed');
                    break;
                }
            }
        } catch (err) {
            this.logger.error('Error processing audio:', err);
        }
    }

    private async handleGenerationComplete(): Promise<void> {
        this.logger.info('Generation Complete');

        if (this.states.tts.toolCallInProgress && !this.states.tts.responseCreatedSent) {
            this.states.tts.toolCallInProgress = false;
        }
    }

    private async sendResponseComplete(): Promise<void> {
        this.logger.info('Sending RESPONSE.COMPLETE');
        ttsState.reset();
        this.states.tts.responseCreatedSent = false;
        this.states.tts.toolCallInProgress = false;
        
        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
        }
    }

    private async handleTranscriptions(msg: any): Promise<void> {
        if (msg.inputTranscription?.text && msg.inputTranscription.finished && msg.inputTranscription.text.trim()) {
            this.logger.info('User transcription:', msg.inputTranscription.text);
            await supabaseService.addConversation(
                this.context.supabase,
                'user',
                msg.inputTranscription.text,
                this.context.user,
            ).catch(err => this.logger.error('DB Error:', err));
        }

        if (msg.outputTranscription?.text && msg.outputTranscription.finished && msg.outputTranscription.text.trim()) {
            this.logger.info('Assistant transcription:', msg.outputTranscription.text);
            await supabaseService.addConversation(
                this.context.supabase,
                'assistant',
                msg.outputTranscription.text,
                this.context.user,
            ).catch(err => this.logger.error('DB Error:', err));
        }
    }

    private handleGoAway(goAway: any): void {
        this.logger.warn('Received goAway:', JSON.stringify(goAway));
        
        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.close(
                1011,
                `Gemini requested disconnect: ${goAway.reason || 'Unknown reason'}`
            );
        }
    }

    private handleGeminiClose(code: number, reason: Buffer): void {
        this.states.connection.isGeminiConnected = false;
        const reasonString = reason.toString();
        this.logger.info(`Gemini WS closed: ${code} ${reasonString}`);

        if (this.states.connection.keepAliveIntervalId) {
            clearInterval(this.states.connection.keepAliveIntervalId);
            this.states.connection.keepAliveIntervalId = null;
        }

        this.geminiWs = null;

        if (
            code === 1011 &&
            reasonString.toLowerCase().includes('quota') &&
            !this.states.connection.deviceClosed &&
            this.deviceWs.readyState === WSWebSocket.OPEN
        ) {
            this.handleQuotaExceeded();
        } else {
            this.handleNonQuotaClose();
        }
    }

    private handleQuotaExceeded(): void {
        const rotatedSuccessfully = config.apiKeyManager.rotateToNextKey();
        
        if (rotatedSuccessfully) {
            this.logger.info('Quota exceeded. Rotating API key and retrying');
            this.reconnect();
        } else {
            this.logger.info('All API keys exhausted');
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'QUOTA.EXCEEDED' }));
            
            SessionErrorTracker.getInstance().saveSessionForResumption(
                this.context.user.user_id,
                this.states.connection.sessionId,
                'quota_exceeded',
                'All API keys exhausted due to quota limits'
            );

            if (this.states.connection.retryCount < CONSTANTS.MAX_RETRIES) {
                this.scheduleRetry();
            } else {
                this.logger.error('Max retries reached');
                if (this.deviceWs.readyState === WSWebSocket.OPEN) {
                    this.deviceWs.close(1011, 'Assistant disconnected - all API keys exhausted');
                }
            }
        }
    }

    private scheduleRetry(): void {
        const delay = CONSTANTS.RETRY_DELAYS[this.states.connection.retryCount];
        this.states.connection.retryCount++;
        
        this.logger.warn(
            `Retrying in ${delay / 1000}s (Attempt ${this.states.connection.retryCount}/${CONSTANTS.MAX_RETRIES})`
        );

        if (this.states.connection.retryTimeoutId) {
            clearTimeout(this.states.connection.retryTimeoutId);
        }

        this.states.connection.retryTimeoutId = setTimeout(() => {
            config.apiKeyManager.resetRotation();
            if (
                !this.states.connection.deviceClosed && 
                this.deviceWs.readyState === WSWebSocket.OPEN
            ) {
                this.logger.info('Attempting reconnect');
                this.reconnect();
            }
        }, delay);
    }

    private handleNonQuotaClose(): void {
        if (this.states.connection.retryCount >= CONSTANTS.MAX_RETRIES) {
            this.logger.error('Max retries reached');
        }

        if (!this.states.connection.deviceClosed && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.logger.info('Closing device WS due to Gemini close');
            this.deviceWs.close(1011, 'Assistant disconnected or unrecoverable error');
        }
    }

    private handleGeminiError(err: Error): void {
        this.states.connection.isGeminiConnected = false;
        this.logger.error('Gemini WS error:', err);

        SessionErrorTracker.getInstance().saveSessionForResumption(
            this.context.user.user_id,
            this.states.connection.sessionId,
            'gemini_error',
            `Gemini WebSocket error: ${err.message}`
        );

        if (this.states.connection.keepAliveIntervalId) {
            clearInterval(this.states.connection.keepAliveIntervalId);
            this.states.connection.keepAliveIntervalId = null;
        }

        if (this.geminiWs && this.geminiWs.readyState !== WSWebSocket.CLOSED) {
            this.geminiWs.close();
        }
        
        this.geminiWs = null;

        if (!this.states.connection.deviceClosed && this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(
                JSON.stringify({ type: 'error', message: 'Assistant connection error' })
            );
            this.deviceWs.close(1011, 'Assistant error');
        }
    }

    private sendKeepAliveAudioChunk(): void {
        if (
            !this.states.connection.isGeminiConnected || 
            !this.geminiWs ||
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
                        { data: b64, mime_type: `audio/pcm;rate=${config.MIC_SAMPLE_RATE}` },
                    ],
                },
            };
            
            this.geminiWs.send(JSON.stringify(gemMsg));
        } catch (err) {
            this.logger.error('Failed to send keep-alive:', err);
        }
    }

    private async reconnect(): Promise<void> {
        const { user, supabase } = this.context;
        const isDoctor = user.user_info?.user_type === 'doctor';
        
        const chatHistory = await supabaseService.getChatHistory(
            supabase,
            user.user_id,
            user.personality?.key ?? null,
            isDoctor,
        ).catch(err => {
            this.logger.error('Failed to get chat history:', err);
            return [];
        });

        const currentVolume = await this.getCurrentVolume();
        const systemPromptText = supabaseService.createSystemPrompt(chatHistory, this.context, currentVolume) ||
            'You are a helpful assistant.';
        const firstMessage = supabaseService.createFirstMessage(chatHistory, this.context);

        await this.connect(this.buildFullSystemPrompt(systemPromptText), firstMessage);
    }

    private async getCurrentVolume(): Promise<number> {
        try {
            const deviceInfo = await supabaseService.getDeviceInfo(
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
        return CONSTANTS.LEGACY_MODE_PROMPT;
    }

    sendAudioChunk(audioChunk: Uint8Array): void {
        const b64 = Buffer.from(audioChunk).toString('base64');
        
        if (
            this.states.connection.isGeminiConnected && 
            this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            const gemMsg = {
                realtime_input: {
                    media_chunks: [
                        { data: b64, mime_type: `audio/pcm;rate=${config.MIC_SAMPLE_RATE}` },
                    ],
                },
            };
            
            try {
                this.geminiWs.send(JSON.stringify(gemMsg));
            } catch (err) {
                this.logger.error('Failed to send audio chunk:', err);
            }
        }
    }

    sendTurnComplete(): void {
        if (
            this.states.connection.isGeminiConnected && 
            this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            this.logger.info('Signaling Turn Complete');
            
            const finalizeTurn = {
                clientContent: { turns: [], turnComplete: true },
            };
            
            try {
                this.geminiWs.send(JSON.stringify(finalizeTurn));
            } catch (err) {
                this.logger.error('Failed to send Turn Complete:', err);
            }
        }
    }

    interruptCurrentTurn(): void {
        this.states.audio.micAccum = new Uint8Array(0);
        ttsState.reset();
        this.states.tts.responseCreatedSent = false;
        this.states.tts.ttsTextBuffer = '';
        
        if (this.states.tts.ttsTimeout) {
            clearTimeout(this.states.tts.ttsTimeout);
            this.states.tts.ttsTimeout = null;
            this.logger.info('Cleared pending TTS timeout');
        }

        if (
            this.states.connection.isGeminiConnected && 
            this.geminiWs?.readyState === WSWebSocket.OPEN
        ) {
            this.logger.info('Signaling Turn Complete (Interrupt)');
            
            const interruptTurn = {
                clientContent: { turns: [], turnComplete: true },
            };
            
            try {
                this.geminiWs.send(JSON.stringify(interruptTurn));
            } catch (err) {
                this.logger.error('Failed to send interrupt:', err);
            }
        }
    }

    close(): void {
        if (this.states.connection.retryTimeoutId) {
            clearTimeout(this.states.connection.retryTimeoutId);
            this.states.connection.retryTimeoutId = null;
        }

        if (this.states.connection.keepAliveIntervalId) {
            clearInterval(this.states.connection.keepAliveIntervalId);
            this.states.connection.keepAliveIntervalId = null;
        }

        if (
            this.geminiWs && 
            this.geminiWs.readyState !== WSWebSocket.CLOSED &&
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

    constructor(
        private deviceWs: WSWebSocket,
        private states: States,
        private geminiManager: GeminiConnectionManager
    ) {}

    async handleMessage(raw: RawData, isBinary: boolean): Promise<void> {
        if (!this.states.connection.pipelineActive || this.states.connection.deviceClosed) return;

        if (isBinary) {
            this.handleBinaryMessage(raw);
        } else {
            await this.handleTextMessage(raw);
        }
    }

    private handleBinaryMessage(raw: RawData): void {
        let audioChunk: Uint8Array | null = null;

        if (raw instanceof ArrayBuffer) {
            audioChunk = new Uint8Array(raw);
        } else if (Buffer.isBuffer(raw)) {
            audioChunk = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        } else {
            this.logger.warn('Unexpected binary data format');
            return;
        }

        let pcmChunk: Uint8Array;
        if (config.ADPCM_ENABLED) {
            pcmChunk = this.states.audio.adpcmProcessor.decodeADPCMChunk(audioChunk);
            this.states.audio.lastCompressionRatio = pcmChunk.length / audioChunk.length;
        } else {
            pcmChunk = audioChunk;
            this.states.audio.lastCompressionRatio = undefined;
        }

        const combined = new Uint8Array(this.states.audio.micAccum.length + pcmChunk.length);
        combined.set(this.states.audio.micAccum, 0);
        combined.set(pcmChunk, this.states.audio.micAccum.length);
        this.states.audio.micAccum = combined;

        this.processAudioChunks();
    }

    private processAudioChunks(): void {
        while (this.states.audio.micAccum.length >= config.MIC_ACCUM_CHUNK_SIZE) {
            const chunkToSend = this.states.audio.micAccum.slice(0, config.MIC_ACCUM_CHUNK_SIZE);
            this.states.audio.micAccum = this.states.audio.micAccum.slice(config.MIC_ACCUM_CHUNK_SIZE);

            const filteredChunk = new Uint8Array(chunkToSend);
            this.states.audio.micFilter.processAudioInPlace(filteredChunk);

            audioDebugManager.addAudioData(
                this.states.connection.sessionId,
                filteredChunk,
                this.states.audio.lastCompressionRatio
            );

            const effectiveSTTProvider = config.getEffectiveSTTProvider();
            if (effectiveSTTProvider === 'AZURE_STT' && this.states.audio.azureSTTManager) {
                this.states.audio.azureSTTManager.addAudioChunk(filteredChunk);
            } else {
                this.geminiManager.sendAudioChunk(filteredChunk);
            }
        }
    }

    private async handleTextMessage(raw: RawData): Promise<void> {
        let msgObj: any;
        
        try {
            const rawString = raw.toString('utf-8');
            if (rawString.length > 1000) {
                this.logger.info(`Received large message (${rawString.length} chars)`);
            } else {
                this.logger.info(`Received: ${rawString.substring(0, 200)}${rawString.length > 200 ? '...' : ''}`);
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
                    this.states.connection.isGeminiConnected
                );
            } else if (msgObj.type === 'image_complete') {
                this.logger.info(`Image complete: ${msgObj.total_chunks} chunks`);
            } else if (msgObj.type === 'instruction' || msgObj.type === 'server') {
                await this.handleInstruction(msgObj);
            }
        } catch (err) {
            this.logger.error('Error processing message:', err);
            if (msgObj.type === 'image' && this.states.image.waitingForImage) {
                this.states.image.waitingForImage = false;
                this.states.image.pendingVisionCall = null;
                this.states.image.photoCaptureFailed = false;
            }
        }
    }

    private async handleInstruction(msgObj: any): Promise<void> {
        if (msgObj.msg === 'end_of_speech') {
            await this.handleEndOfSpeech();
        } else if (msgObj.msg === 'INTERRUPT') {
            this.handleInterrupt();
        }
    }

    private async handleEndOfSpeech(): Promise<void> {
        this.logger.info('End of Speech detected');

        if (this.states.audio.micAccum.length > 0) {
            this.logger.info(`Flushing ${this.states.audio.micAccum.length} bytes`);
            
            const finalChunk = new Uint8Array(this.states.audio.micAccum);
            this.states.audio.micFilter.processAudioInPlace(finalChunk);
            
            audioDebugManager.addAudioData(
                this.states.connection.sessionId,
                finalChunk,
                this.states.audio.lastCompressionRatio
            );

            const effectiveSTTProvider = config.getEffectiveSTTProvider();
            if (effectiveSTTProvider === 'AZURE_STT' && this.states.audio.azureSTTManager) {
                this.states.audio.azureSTTManager.addAudioChunk(finalChunk);
                await this.states.audio.azureSTTManager.finishSpeech();
            } else {
                this.geminiManager.sendAudioChunk(finalChunk);
            }
            
            this.states.audio.micAccum = new Uint8Array(0);
        } else if (config.getEffectiveSTTProvider() === 'AZURE_STT' && this.states.audio.azureSTTManager) {
            await this.states.audio.azureSTTManager.finishSpeech();
        }

        this.geminiManager.sendTurnComplete();

        if (this.deviceWs.readyState === WSWebSocket.OPEN) {
            this.deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
            this.logger.info('Sent RESPONSE.CREATED');
        }
    }

    private handleInterrupt(): void {
        this.logger.info('INTERRUPT received');
        this.geminiManager.interruptCurrentTurn();
    }
}

// ===== Azure STT Mode Functions =====
async function simulateInitialGreeting(
    states: States,
    context: { user: any; supabase: SupabaseClient },
    geminiManager: GeminiConnectionManager,
    deviceWs: WSWebSocket
): Promise<void> {
    const logger = new Logger('[AzureSTT-Sim]');
    
    try {
        logger.info('Simulating initial greeting');

        if (deviceWs.readyState === WSWebSocket.OPEN) {
            deviceWs.send(JSON.stringify({ type: 'server', msg: 'SPEAKING' }));
        }

        const result = await processUserActionWithSession(
            states.connection.sessionId,
            'Xin chào!',
            context.supabase,
            context.user.user_id,
        );

        if (result.success && result.message) {
            logger.info(`Initial greeting response: "${result.message}"`);
            
            if (deviceWs.readyState === WSWebSocket.OPEN) {
                deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
            }

            await processResponseWithTTS(result.message, geminiManager, deviceWs);
        } else {
            logger.error('Failed to generate initial greeting:', result.message);
        }
    } catch (error) {
        logger.error('Error simulating initial greeting:', error);
    }
}

async function processResponseWithTTS(
    text: string,
    geminiManager: any,
    deviceWs: WSWebSocket
): Promise<void> {
    const logger = new Logger('[AzureSTT-TTS]');
    
    try {
        logger.info(`Processing response with TTS: "${text}"`);

        const ttsResult = await geminiManager.ttsManager.processTextWithTTSStreaming(
            text,
            async (audioChunk: Uint8Array) => {
                try {
                    const pcmData = Buffer.from(audioChunk);
                    
                    if (geminiManager.states?.audio?.ttsFilter) {
                        geminiManager.states.audio.ttsFilter.processAudioInPlace(pcmData);
                    }
                    
                    boostTtsVolumeInPlace(pcmData, 3.0);

                    const opusFrames = await ttsState.encodePcmChunk(pcmData);
                    for (const frame of opusFrames) {
                        if (deviceWs.readyState === WSWebSocket.OPEN) {
                            deviceWs.send(frame);
                        } else {
                            logger.warn('Device WS closed');
                            break;
                        }
                    }
                } catch (error) {
                    logger.error('Error processing TTS chunk:', error);
                }
            }
        );

        logger.info('TTS processing completed');
        ttsState.reset();
        
        if (deviceWs.readyState === WSWebSocket.OPEN) {
            deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
        }
    } catch (error) {
        logger.error('Error processing response with TTS:', error);
    }
}

async function handleAzureSTTTranscription(
    text: string,
    states: States,
    context: { user: any; supabase: SupabaseClient },
    geminiManager: any,
    deviceWs: WSWebSocket
): Promise<void> {
    const logger = new Logger('[AzureSTT]');
    
    try {
        logger.info(`Processing transcription: "${text}"`);

        if (!text.trim()) {
            logger.info('Empty transcription - sending RESPONSE.COMPLETE');
            ttsState.reset();
            if (deviceWs.readyState === WSWebSocket.OPEN) {
                deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
            }
            return;
        }

        const result = await processUserActionWithSession(
            states.connection.sessionId,
            text,
            context.supabase,
            context.user.user_id,
        );

        if (result.success && result.message) {
            logger.info(`Flash 2.5 response: "${result.message}"`);
            await processResponseWithTTS(result.message, geminiManager, deviceWs);
            logger.info('Azure STT -> Flash 2.5 -> TTS flow completed');
        } else {
            logger.error('Flash 2.5 processing failed:', result.message);
            ttsState.reset();
            if (deviceWs.readyState === WSWebSocket.OPEN) {
                deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
            }
        }
    } catch (error) {
        logger.error('Error processing transcription:', error);
        ttsState.reset();
        if (deviceWs.readyState === WSWebSocket.OPEN) {
            deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.COMPLETE' }));
        }
    }
}

// ===== Main Connection Handler =====
export function setupWebSocketConnectionHandler(wss: _WSS): void {
    wss.on('connection', async (deviceWs: WSWebSocket, context: ConnectionContext) => {
        const { user, supabase } = context;
        const logger = new Logger('[Main]');
        logger.info(`Device connected for user: ${user.user_id}`);

        // Session setup
        const sessionErrorTracker = SessionErrorTracker.getInstance();
        const resumableSession = sessionErrorTracker.getResumableSession(user.user_id);
        
        let sessionId: string;
        let shouldResumeSession = false;
        
        if (resumableSession && config.SESSION_RESUMPTION_CONFIG.enabled) {
            sessionId = resumableSession.sessionId;
            shouldResumeSession = true;
            logger.info(
                `🔄 RESUMING SESSION: ${utils.truncateSessionId(sessionId)} ` +
                `(error: ${resumableSession.errorType}, age: ${
                    Math.round((Date.now() - resumableSession.timestamp.getTime()) / 1000)
                }s)`
            );
        } else {
            sessionId = utils.generateSessionId(user.user_id);
            logger.info(`🆕 FRESH SESSION: ${utils.truncateSessionId(sessionId)}`);
        }

        // Initialize states
        const states: States = {
            connection: {
                pipelineActive: true,
                deviceClosed: false,
                isGeminiConnected: false,
                sessionStartTime: 0,
                retryCount: 0,
                retryTimeoutId: null,
                keepAliveIntervalId: null,
                sessionId,
            },
            audio: {
                micAccum: new Uint8Array(0),
                lastCompressionRatio: undefined,
                micFilter: new AudioFilter(config.MIC_SAMPLE_RATE, 300, 3500, config.MIC_INPUT_GAIN),
                ttsFilter: new AudioFilter(config.TTS_SAMPLE_RATE, 700, 4000, 6.0),
                adpcmProcessor: new ADPCMStreamProcessor(config.ADPCM_BUFFER_SIZE),
            },
            tts: {
                responseCreatedSent: false,
                ttsTextBuffer: '',
                ttsTimeout: null,
                toolCallInProgress: false,
            },
            image: {
                pendingVisionCall: null,
                waitingForImage: false,
                photoCaptureFailed: false,
                imageTimeoutId: null,
                imageChunkAssembly: null,
                chunkTimeoutId: null,
            },
        };

        // Initialize managers
        audioDebugManager.startSession(states.connection.sessionId);
        
        const geminiManager = new GeminiConnectionManager(context, deviceWs, states);
        
        // Initialize Azure STT if configured
        let effectiveSTTProvider = config.getEffectiveSTTProvider();
        logger.info(`Effective STT Provider: ${effectiveSTTProvider}`);
        
        let azureSTTInitialized = false;
        if (effectiveSTTProvider === 'AZURE_STT' && config.validateSTTProvider('AZURE_STT')) {
            try {
                const azureSTTManager = new AzureSTTManager(
                    async (text: string, isFinal: boolean) => {
                        if (isFinal) {
                            logger.info(`Azure STT Final: "${text}"`);
                            if (deviceWs.readyState === WSWebSocket.OPEN) {
                                deviceWs.send(JSON.stringify({ type: 'server', msg: 'RESPONSE.CREATED' }));
                            }
                            await handleAzureSTTTranscription(
                                text,
                                states,
                                context,
                                geminiManager,
                                deviceWs
                            );
                        } else if (text.trim()) {
                            logger.info(`Azure STT Partial: "${text}"`);
                        }
                    },
                    (error: string) => {
                        logger.error('Azure STT Error:', error);
                    }
                );

                azureSTTInitialized = await azureSTTManager.initialize();
                if (azureSTTInitialized) {
                    states.audio.azureSTTManager = azureSTTManager;
                    logger.info('✅ Azure STT initialized');
                } else {
                    logger.warn('❌ Azure STT initialization failed - falling back to Gemini');
                    effectiveSTTProvider = 'GEMINI_LIVE';
                }
            } catch (error) {
                logger.error('❌ Azure STT exception:', error);
                effectiveSTTProvider = 'GEMINI_LIVE';
            }
        }

        // Flash 2.5 session setup
        if (shouldResumeSession && resumableSession) {
            try {
                createFlash25Session(
                    states.connection.sessionId,
                    user.user_id,
                    geminiManager.deviceCallbacks,
                    user,
                );
                sessionErrorTracker.clearResumableSession(user.user_id);
                logger.info(`✅ Resumed Flash 2.5 session`);
            } catch (error) {
                logger.error(`❌ Failed to resume session:`, error);
                const freshSessionId = utils.generateSessionId(user.user_id);
                states.connection.sessionId = freshSessionId;
                createFlash25Session(
                    states.connection.sessionId,
                    user.user_id,
                    geminiManager.deviceCallbacks,
                    user,
                );
                sessionErrorTracker.clearResumableSession(user.user_id);
                logger.info(`🆕 Created fallback session`);
            }
        } else {
            createFlash25Session(
                states.connection.sessionId,
                user.user_id,
                geminiManager.deviceCallbacks,
                user,
            );
        }

        // Create device message handler
        const deviceMessageHandler = new DeviceMessageHandler(deviceWs, states, geminiManager);

        // Initial device setup
        let currentVolume = 70;
        let isOta = false;
        let isReset = false;
        
        try {
            const deviceInfo = await supabaseService.getDeviceInfo(supabase, user.user_id);
            if (deviceInfo) {
                currentVolume = deviceInfo.volume ?? 70;
                isOta = deviceInfo.is_ota || false;
                isReset = deviceInfo.is_reset || false;
                logger.info(`Device info: Volume=${currentVolume}, OTA=${isOta}, Reset=${isReset}`);
            }
        } catch (err) {
            logger.error('Failed to get device info:', err);
        }

        deviceWs.send(JSON.stringify({
            type: 'auth',
            volume_control: currentVolume,
            pitch_factor: user.personality?.pitch_factor ?? 1,
            is_ota: isOta,
            is_reset: isReset,
        }));

        // Prepare Gemini connection
        const isDoctor = user.user_info?.user_type === 'doctor';
        const chatHistory = await supabaseService.getChatHistory(
            supabase,
            user.user_id,
            user.personality?.key ?? null,
            isDoctor,
        ).catch(err => {
            logger.error('Failed to get chat history:', err);
            return [];
        });

        const systemPromptText = supabaseService.createSystemPrompt(chatHistory, context, currentVolume) ||
            'You are a helpful assistant.';
        const firstMessage = supabaseService.createFirstMessage(chatHistory, context);
        const fullSystemPrompt = CONSTANTS.LEGACY_MODE_PROMPT;

        // Connect based on STT provider
        if (effectiveSTTProvider !== 'AZURE_STT') {
            logger.info('Connecting to Gemini Live');
            await geminiManager.connect(fullSystemPrompt, firstMessage);
        } else {
            logger.info('Using Azure STT mode');
            await simulateInitialGreeting(states, context, geminiManager, deviceWs);
        }

        // Device event handlers
        deviceWs.on('message', async (raw: RawData, isBinary: boolean) => {
            await deviceMessageHandler.handleMessage(raw, isBinary);
        });

        deviceWs.on('error', (err) => {
            logger.error('Device WS error:', err);
            if (!states.connection.deviceClosed) {
                states.connection.deviceClosed = true;
                states.connection.pipelineActive = false;
                
                sessionErrorTracker.saveSessionForResumption(
                    user.user_id,
                    states.connection.sessionId,
                    'device_error',
                    `Device WebSocket error: ${err instanceof Error ? err.message : String(err)}`
                );

                if (states.connection.retryTimeoutId) {
                    clearTimeout(states.connection.retryTimeoutId);
                    states.connection.retryTimeoutId = null;
                }

                audioDebugManager.endSession(states.connection.sessionId, 'device_error')
                    .catch(err => logger.error('Failed to end audio debug session:', err));
                
                geminiManager.close();
            }
        });

        deviceWs.on('close', async (code, reason) => {
            if (states.connection.deviceClosed) return;
            
            logger.info(`Device closed: Code=${code}, Reason=${reason.toString()}`);
            states.connection.deviceClosed = true;
            states.connection.pipelineActive = false;

            const isAbnormalClose = code !== 1000 && code !== 1001;
            if (isAbnormalClose) {
                sessionErrorTracker.saveSessionForResumption(
                    user.user_id,
                    states.connection.sessionId,
                    'connection_failed',
                    `Device connection closed abnormally: Code ${code}, Reason: ${reason.toString()}`
                );
            } else {
                sessionErrorTracker.clearResumableSession(user.user_id);
            }

            if (states.image.chunkTimeoutId) {
                clearTimeout(states.image.chunkTimeoutId);
                states.image.chunkTimeoutId = null;
            }
            states.image.imageChunkAssembly = null;

            if (states.connection.retryTimeoutId) {
                clearTimeout(states.connection.retryTimeoutId);
                states.connection.retryTimeoutId = null;
            }

            if (states.connection.sessionStartTime > 0) {
                const durationSeconds = Math.floor(
                    (Date.now() - states.connection.sessionStartTime) / 1000
                );
                logger.info(`Session duration: ${durationSeconds} seconds`);
                await supabaseService.updateUserSessionTime(supabase, user, durationSeconds)
                    .catch(err => logger.error('DB Error:', err));
            }

            if (effectiveSTTProvider !== 'AZURE_STT') {
                geminiManager.close();
            }

            if (states.audio.azureSTTManager) {
                states.audio.azureSTTManager.disconnect();
                logger.info('Azure STT disconnected');
            }

            await audioDebugManager.endSession(states.connection.sessionId, 'connection_closed');
            
            logger.info(`Destroying Flash 2.5 session`);
            destroyFlash25Session(states.connection.sessionId);
        });
    });
}
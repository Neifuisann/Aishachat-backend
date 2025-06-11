/**
 * ElevenLabs Text-to-Speech Integration
 *
 * This module provides integration with ElevenLabs TTS API as an alternative
 * to Gemini's built-in audio responses. When enabled, text responses from
 * Gemini are sent to ElevenLabs for high-quality speech synthesis.
 */

import { ELEVENLABS_API_KEY, TTS_SAMPLE_RATE } from './config.ts';
import { Logger } from './logger.ts';

const logger = new Logger('[11Labs]');

export interface ElevenLabsVoiceSettings {
    stability: number;
    similarity_boost: number;
    style?: number;
    use_speaker_boost?: boolean;
}

export interface ElevenLabsTTSRequest {
    text: string;
    model_id?: string;
    voice_settings?: ElevenLabsVoiceSettings;
    output_format?: string;
    language_code?: string;
}

export interface ElevenLabsTTSResponse {
    success: boolean;
    audio?: Uint8Array;
    error?: string;
}

/**
 * Default voice settings optimized for conversational AI
 */
const DEFAULT_VOICE_SETTINGS: ElevenLabsVoiceSettings = {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.0,
    use_speaker_boost: true,
};

/**
 * Convert text to speech using ElevenLabs API
 * @param text - The text to convert to speech
 * @param voiceId - ElevenLabs voice ID (default: Rachel)
 * @param options - Additional TTS options
 * @returns Promise<ElevenLabsTTSResponse>
 */
export async function convertTextToSpeech(
    text: string,
    voiceId: string = '21m00Tcm4TlvDq8ikWAM', // Rachel voice
    options: Partial<ElevenLabsTTSRequest> = {},
): Promise<ElevenLabsTTSResponse> {
    if (!ELEVENLABS_API_KEY) {
        return {
            success: false,
            error: 'ElevenLabs API key not configured',
        };
    }

    if (!text.trim()) {
        return {
            success: false,
            error: 'Empty text provided',
        };
    }

    try {
        // Determine output format based on TTS_SAMPLE_RATE
        // ElevenLabs supports: mp3_22050_32, mp3_44100_64, mp3_44100_96, mp3_44100_128, mp3_44100_192
        // pcm_16000, pcm_22050, pcm_24000, pcm_44100, ulaw_8000

        // Try PCM format first (requires Pro tier), fallback to MP3 if needed
        let outputFormat = 'pcm_24000'; // Default to 24kHz PCM to match TTS_SAMPLE_RATE

        // Use type assertion to handle the constant comparison
        const sampleRate = TTS_SAMPLE_RATE as number;
        if (sampleRate === 16000) {
            outputFormat = 'pcm_16000';
        } else if (sampleRate === 22050) {
            outputFormat = 'pcm_22050';
        } else if (sampleRate === 44100) {
            outputFormat = 'pcm_44100';
        }

        const modelId = options.model_id || 'eleven_flash_v2_5';
        const requestBody: ElevenLabsTTSRequest = {
            text: text,
            model_id: modelId,
            voice_settings: options.voice_settings || DEFAULT_VOICE_SETTINGS,
        };

        // Only add language_code for models that support it
        // Flash v2.5 and Turbo v2.5 support language_code parameter
        if (modelId === 'eleven_flash_v2_5' || modelId === 'eleven_turbo_v2_5') {
            requestBody.language_code = options.language_code || 'vi'; // Vietnamese
        }

        logger.info(
            `ElevenLabs TTS: Converting text (${text.length} chars) using voice ${voiceId}, format: ${outputFormat}`,
        );

        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
            {
                method: 'POST',
                headers: {
                    'Accept': 'audio/*',
                    'Content-Type': 'application/json',
                    'xi-api-key': ELEVENLABS_API_KEY,
                },
                body: JSON.stringify(requestBody),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`ElevenLabs TTS API error: ${response.status} - ${errorText}`);
            return {
                success: false,
                error: `ElevenLabs API error: ${response.status} - ${errorText}`,
            };
        }

        // Handle streaming response
        if (!response.body) {
            return {
                success: false,
                error: 'No response body received from ElevenLabs',
            };
        }

        const reader = response.body.getReader();
        const audioChunks: Uint8Array[] = [];
        let totalBytes = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                audioChunks.push(value);
                totalBytes += value.length;
                //console.log(`ElevenLabs TTS: Received chunk ${audioChunks.length}, ${value.length} bytes (total: ${totalBytes})`);
            }
        } finally {
            reader.releaseLock();
        }

        // Combine all chunks
        const audioData = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of audioChunks) {
            audioData.set(chunk, offset);
            offset += chunk.length;
        }

        logger.info(
            `ElevenLabs TTS: Successfully generated ${audioData.length} bytes of audio from ${audioChunks.length} chunks`,
        );
        logger.debug(
            `ElevenLabs TTS: Audio format: ${outputFormat}, first 16 bytes: ${
                Array.from(audioData.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(
                    ' ',
                )
            }`,
        );

        // Check if we received MP3 data instead of PCM (indicates subscription limitation)
        if (
            audioData.length > 3 &&
            audioData[0] === 0x49 && audioData[1] === 0x44 && audioData[2] === 0x33
        ) {
            logger.error('ElevenLabs TTS: Received MP3 data with ID3 tags instead of PCM');
            logger.error(
                "ElevenLabs TTS: This indicates your subscription doesn't support PCM format",
            );
            logger.error('ElevenLabs TTS: PCM format requires Pro tier or above subscription');
            return {
                success: false,
                error:
                    'Received MP3 format instead of PCM. PCM format requires Pro tier subscription or above. Please upgrade your ElevenLabs subscription or implement MP3 decoding.',
            };
        }

        // Check for MP3 frame header (0xFF 0xFB or similar)
        if (audioData.length > 2 && audioData[0] === 0xFF && (audioData[1] & 0xE0) === 0xE0) {
            logger.error('ElevenLabs TTS: Received MP3 frame data instead of PCM');
            return {
                success: false,
                error:
                    'Received MP3 format instead of PCM. Please upgrade your ElevenLabs subscription to Pro tier or above for PCM support.',
            };
        }

        // For PCM formats, we need to ensure the data is in the right format
        let processedAudio = audioData;
        if (outputFormat.startsWith('pcm_')) {
            processedAudio = new Uint8Array(convertAudioFormat(audioData, outputFormat));
        }

        return {
            success: true,
            audio: processedAudio,
        };
    } catch (error) {
        logger.error('ElevenLabs TTS error:', error);
        return {
            success: false,
            error: `Network or processing error: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

/**
 * Get available ElevenLabs voices
 * @returns Promise with list of available voices
 */
export async function getAvailableVoices(): Promise<any> {
    if (!ELEVENLABS_API_KEY) {
        throw new Error('ElevenLabs API key not configured');
    }

    try {
        const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch voices: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        logger.error('Error fetching ElevenLabs voices:', error);
        throw error;
    }
}

/**
 * Convert audio format if needed to match ESP32 requirements
 * This function handles any necessary audio format conversion
 * @param audioData - Raw audio data from ElevenLabs
 * @param sourceFormat - Source audio format
 * @returns Converted audio data as Uint8Array
 */
export function convertAudioFormat(
    audioData: Uint8Array,
    sourceFormat: string = 'pcm_24000',
): Uint8Array {
    // For PCM formats, we need to ensure the data is raw PCM without headers
    if (sourceFormat.startsWith('pcm_')) {
        let pcmData = audioData;

        // ElevenLabs might return PCM with WAV headers, we need to strip them
        // WAV header is typically 44 bytes, starts with "RIFF"
        if (
            audioData.length > 44 &&
            audioData[0] === 0x52 && audioData[1] === 0x49 &&
            audioData[2] === 0x46 && audioData[3] === 0x46
        ) {
            logger.debug('ElevenLabs TTS: Detected WAV header, stripping it');

            // Parse WAV header to get actual audio parameters
            const view = new DataView(audioData.buffer);
            const sampleRate = view.getUint32(24, true);
            const bitsPerSample = view.getUint16(34, true);
            const channels = view.getUint16(22, true);

            logger.debug(
                `ElevenLabs TTS: WAV format - ${sampleRate}Hz, ${bitsPerSample}-bit, ${channels} channel(s)`,
            );

            // Find the data chunk (should start with "data")
            let dataOffset = 44; // Standard WAV header size
            for (let i = 36; i < audioData.length - 4; i++) {
                if (
                    audioData[i] === 0x64 && audioData[i + 1] === 0x61 &&
                    audioData[i + 2] === 0x74 && audioData[i + 3] === 0x61
                ) {
                    dataOffset = i + 8; // Skip "data" + 4-byte size
                    break;
                }
            }

            logger.debug(`ElevenLabs TTS: Data starts at offset ${dataOffset}`);
            pcmData = audioData.slice(dataOffset);
        } else {
            logger.debug('ElevenLabs TTS: No WAV header detected, using raw data');
        }

        // Ensure we have the right format for the audio pipeline
        // The pipeline expects 16-bit little-endian PCM
        logger.debug(`ElevenLabs TTS: Final PCM data size: ${pcmData.length} bytes`);
        return pcmData;
    }

    // For MP3 or other formats, we would need additional processing
    // For now, return as-is and let the existing audio pipeline handle it
    logger.warn(`Audio format conversion not implemented for: ${sourceFormat}`);
    return audioData;
}

/**
 * Convert text to speech using ElevenLabs API with streaming
 * @param text - The text to convert to speech
 * @param voiceId - ElevenLabs voice ID (default: Rachel)
 * @param onAudioChunk - Callback function to handle audio chunks as they arrive
 * @param options - Additional TTS options
 * @returns Promise<ElevenLabsTTSResponse>
 */
export async function convertTextToSpeechStreaming(
    text: string,
    voiceId: string = '21m00Tcm4TlvDq8ikWAM', // Rachel voice
    onAudioChunk: (chunk: Uint8Array) => Promise<void>,
    options: Partial<ElevenLabsTTSRequest> = {},
): Promise<ElevenLabsTTSResponse> {
    if (!ELEVENLABS_API_KEY) {
        return {
            success: false,
            error: 'ElevenLabs API key not configured',
        };
    }

    if (!text.trim()) {
        return {
            success: false,
            error: 'Empty text provided',
        };
    }

    try {
        // Determine output format based on TTS_SAMPLE_RATE
        let outputFormat = 'pcm_24000'; // Default to 24kHz PCM to match TTS_SAMPLE_RATE

        const sampleRate = TTS_SAMPLE_RATE as number;
        if (sampleRate === 16000) {
            outputFormat = 'pcm_16000';
        } else if (sampleRate === 22050) {
            outputFormat = 'pcm_22050';
        } else if (sampleRate === 44100) {
            outputFormat = 'pcm_44100';
        }

        const modelId = options.model_id || 'eleven_flash_v2_5';
        const requestBody: ElevenLabsTTSRequest = {
            text: text,
            model_id: modelId,
            voice_settings: options.voice_settings || DEFAULT_VOICE_SETTINGS,
        };

        // Only add language_code for models that support it
        if (modelId === 'eleven_flash_v2_5' || modelId === 'eleven_turbo_v2_5') {
            requestBody.language_code = options.language_code || 'vi'; // Vietnamese
        }

        logger.info(
            `ElevenLabs TTS Streaming: Converting text (${text.length} chars) using voice ${voiceId}, format: ${outputFormat}`,
        );

        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`,
            {
                method: 'POST',
                headers: {
                    'Accept': 'audio/*',
                    'Content-Type': 'application/json',
                    'xi-api-key': ELEVENLABS_API_KEY,
                },
                body: JSON.stringify(requestBody),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error(`ElevenLabs TTS API error: ${response.status} - ${errorText}`);
            return {
                success: false,
                error: `ElevenLabs API error: ${response.status} - ${errorText}`,
            };
        }

        // Handle streaming response
        if (!response.body) {
            return {
                success: false,
                error: 'No response body received from ElevenLabs',
            };
        }

        const reader = response.body.getReader();
        let totalBytes = 0;
        let chunkCount = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                chunkCount++;
                totalBytes += value.length;

                // // Log progress every 10 chunks to reduce spam
                // if (chunkCount % 10 === 0 || chunkCount <= 3) {
                //     console.log(`ElevenLabs TTS: Streaming chunk ${chunkCount}, ${value.length} bytes (total: ${totalBytes})`);
                // }

                // Send chunk directly to callback for immediate processing
                // No need for format conversion on individual chunks - ElevenLabs streaming already provides correct format
                await onAudioChunk(value);
            }
        } finally {
            reader.releaseLock();
        }

        logger.info(
            `ElevenLabs TTS Streaming: Successfully processed ${chunkCount} chunks, ${totalBytes} total bytes`,
        );

        return {
            success: true,
            audio: new Uint8Array(0), // No need to return audio data since it's streamed
        };
    } catch (error) {
        logger.error('ElevenLabs TTS streaming error:', error);
        return {
            success: false,
            error: `Network or processing error: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

/**
 * Validate ElevenLabs configuration
 * @returns boolean indicating if ElevenLabs is properly configured
 */
export function validateElevenLabsConfig(): boolean {
    if (!ELEVENLABS_API_KEY || ELEVENLABS_API_KEY === 'your_elevenlabs_api_key_here') {
        logger.error('ElevenLabs API key not properly configured');
        return false;
    }
    return true;
}

/**
 * OpenAI Text-to-Speech Integration
 * 
 * This module provides integration with OpenAI TTS API as an alternative
 * to Gemini's built-in audio responses. When enabled, text responses from
 * Gemini are sent to OpenAI for high-quality speech synthesis.
 */

import { OPENAI_API_KEY, TTS_SAMPLE_RATE } from "./config.ts";

export interface OpenAIVoiceSettings {
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
    model: "tts-1" | "tts-1-hd";
    response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
    speed?: number; // 0.25 to 4.0
}

export interface OpenAITTSRequest {
    model: string;
    input: string;
    voice: string;
    response_format?: string;
    speed?: number;
}

export interface OpenAITTSResponse {
    success: boolean;
    audio?: Uint8Array;
    error?: string;
}

// Default voice settings optimized for quality and compatibility
const DEFAULT_VOICE_SETTINGS: OpenAIVoiceSettings = {
    voice: "alloy",
    model: "tts-1",
    response_format: "pcm",
    speed: 1.0
};

/**
 * Convert text to speech using OpenAI API
 * @param text - The text to convert to speech
 * @param options - TTS options including voice, model, etc.
 * @returns Promise<OpenAITTSResponse>
 */
export async function convertTextToSpeech(
    text: string,
    options: Partial<OpenAIVoiceSettings> = {}
): Promise<OpenAITTSResponse> {
    if (!OPENAI_API_KEY) {
        return {
            success: false,
            error: "OpenAI API key not configured"
        };
    }

    if (!text.trim()) {
        return {
            success: false,
            error: "Empty text provided"
        };
    }

    try {
        const settings = { ...DEFAULT_VOICE_SETTINGS, ...options };
        
        // Determine response format based on TTS_SAMPLE_RATE
        let responseFormat = "pcm"; // Default to PCM for compatibility
        
        const sampleRate = TTS_SAMPLE_RATE as number;
        if (sampleRate === 16000 || sampleRate === 22050 || sampleRate === 24000 || sampleRate === 44100) {
            responseFormat = "pcm";
        } else {
            responseFormat = "wav"; // Fallback to WAV for other sample rates
        }

        const requestBody: OpenAITTSRequest = {
            model: settings.model,
            input: text,
            voice: settings.voice,
            response_format: responseFormat,
            speed: settings.speed
        };

        console.log(`OpenAI TTS: Converting text (${text.length} chars) using voice ${settings.voice}, model: ${settings.model}, format: ${responseFormat}`);

        const response = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`OpenAI TTS API error: ${response.status} - ${errorText}`);
            return {
                success: false,
                error: `OpenAI API error: ${response.status} - ${errorText}`
            };
        }

        // Get audio data as array buffer
        const audioBuffer = await response.arrayBuffer();
        const audioData = new Uint8Array(audioBuffer);

        console.log(`OpenAI TTS: Successfully converted text to ${audioData.length} bytes of audio`);

        return {
            success: true,
            audio: audioData
        };

    } catch (error) {
        console.error("OpenAI TTS error:", error);
        return {
            success: false,
            error: `Network or processing error: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Convert text to speech using OpenAI API with streaming
 * @param text - The text to convert to speech
 * @param onAudioChunk - Callback function to handle audio chunks as they arrive
 * @param options - TTS options including voice, model, etc.
 * @returns Promise<OpenAITTSResponse>
 */
export async function convertTextToSpeechStreaming(
    text: string,
    onAudioChunk: (chunk: Uint8Array) => Promise<void>,
    options: Partial<OpenAIVoiceSettings> = {}
): Promise<OpenAITTSResponse> {
    if (!OPENAI_API_KEY) {
        return {
            success: false,
            error: "OpenAI API key not configured"
        };
    }

    if (!text.trim()) {
        return {
            success: false,
            error: "Empty text provided"
        };
    }

    try {
        const settings = { ...DEFAULT_VOICE_SETTINGS, ...options };
        
        // Determine response format based on TTS_SAMPLE_RATE
        let responseFormat = "pcm";
        
        const sampleRate = TTS_SAMPLE_RATE as number;
        if (sampleRate === 16000 || sampleRate === 22050 || sampleRate === 24000 || sampleRate === 44100) {
            responseFormat = "pcm";
        } else {
            responseFormat = "wav";
        }

        const requestBody: OpenAITTSRequest = {
            model: settings.model,
            input: text,
            voice: settings.voice,
            response_format: responseFormat,
            speed: settings.speed
        };

        console.log(`OpenAI TTS Streaming: Converting text (${text.length} chars) using voice ${settings.voice}, format: ${responseFormat}`);

        const response = await fetch("https://nekoapi.com/v1/audio/speech", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`OpenAI TTS API error: ${response.status} - ${errorText}`);
            return {
                success: false,
                error: `OpenAI API error: ${response.status} - ${errorText}`
            };
        }

        // Get the complete audio response first
        const audioBuffer = await response.arrayBuffer();
        const audioData = new Uint8Array(audioBuffer);

        console.log(`OpenAI TTS Streaming: Received ${audioData.length} bytes, chunking for streaming`);

        // Simulate streaming by chunking the audio data
        const CHUNK_SIZE = 4096; // 4KB chunks for smooth streaming
        let chunkCount = 0;
        let totalBytes = 0;

        try {
            for (let offset = 0; offset < audioData.length; offset += CHUNK_SIZE) {
                const chunkEnd = Math.min(offset + CHUNK_SIZE, audioData.length);
                const chunk = audioData.slice(offset, chunkEnd);

                if (chunk.length > 0) {
                    chunkCount++;
                    totalBytes += chunk.length;

                    // Send chunk to callback
                    await onAudioChunk(chunk);

                    // Small delay to simulate streaming and prevent overwhelming the audio pipeline
                    if (offset + CHUNK_SIZE < audioData.length) {
                        await new Promise(resolve => setTimeout(resolve, 10)); // 10ms delay between chunks
                    }
                }
            }
        } catch (error) {
            console.error("Error during OpenAI TTS streaming:", error);
            return {
                success: false,
                error: `Streaming error: ${error instanceof Error ? error.message : String(error)}`
            };
        }

        console.log(`OpenAI TTS Streaming: Successfully processed ${chunkCount} chunks, ${totalBytes} total bytes`);

        return {
            success: true,
            audio: new Uint8Array(0) // No need to return audio data since it's streamed
        };

    } catch (error) {
        console.error("OpenAI TTS streaming error:", error);
        return {
            success: false,
            error: `Network or processing error: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Validate OpenAI configuration
 * @returns boolean indicating if OpenAI is properly configured
 */
export function validateOpenAIConfig(): boolean {
    if (!OPENAI_API_KEY || OPENAI_API_KEY === "your_openai_api_key_here") {
        console.error("OpenAI API key not properly configured");
        return false;
    }
    return true;
}

/**
 * Get available OpenAI voices
 * @returns Array of available voice names
 */
export function getAvailableVoices(): string[] {
    return ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
}

/**
 * Get available OpenAI models
 * @returns Array of available model names
 */
export function getAvailableModels(): string[] {
    return ["tts-1", "tts-1-hd"];
}

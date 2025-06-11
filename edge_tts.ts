/**
 * Edge TTS Integration for Deno
 * 
 * This module provides integration with Microsoft Edge's Text-to-Speech service
 * as a free alternative to paid TTS services. It uses the msedge-tts npm package
 * and provides streaming capabilities for real-time audio processing.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { TTS_SAMPLE_RATE, EDGE_TTS_DEFAULT_VOICE, EDGE_TTS_DEFAULT_FORMAT, EDGE_TTS_DEFAULT_SPEED } from "./config.ts";
import { Buffer } from "node:buffer";

export interface EdgeTTSVoiceSettings {
    voice: string;
    rate?: number; // Speed multiplier (0.5 to 2.0)
    pitch?: string; // Pitch adjustment (e.g., "+200Hz", "-50Hz")
    volume?: string; // Volume adjustment (e.g., "+50%", "-20%")
    outputFormat?: keyof typeof OUTPUT_FORMAT;
}

export interface EdgeTTSRequest {
    text: string;
    voice: string;
    rate?: number;
    pitch?: string;
    volume?: string;
    outputFormat?: keyof typeof OUTPUT_FORMAT;
}

export interface EdgeTTSResponse {
    success: boolean;
    audioData?: Uint8Array;
    error?: string;
    metadata?: any;
}

// OpenAI voice names mapped to Edge TTS equivalents (similar to Python version)
const voiceMapping: Record<string, string> = {
    'alloy': 'vi-VN-HoaiMyNeural',
    'echo': 'vi-VN-NamMinhNeural', 
    'fable': 'vi-VN-HoaiMyNeural',
    'onyx': 'vi-VN-NamMinhNeural',
    'nova': 'vi-VN-NamMinhNeural',
    'shimmer': 'vi-VN-HoaiMyNeural'
};

/**
 * Text preprocessing for TTS (adapted from Python version)
 * Cleans Markdown and adds contextual hints for better speech synthesis
 */
export function prepareTTSInput(text: string): string {
    // Remove emojis (basic implementation)
    text = text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '');

    // Add context for headers
    text = text.replace(/^(#{1,6})\s+(.*)$/gm, (match, hashes, headerText) => {
        const level = hashes.length;
        if (level === 1) {
            return `Title — ${headerText.trim()}\n`;
        } else if (level === 2) {
            return `Section — ${headerText.trim()}\n`;
        } else {
            return `Subsection — ${headerText.trim()}\n`;
        }
    });

    // Remove links while keeping the link text
    text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Describe inline code
    text = text.replace(/`([^`]+)`/g, 'code snippet: $1');

    // Remove bold/italic symbols but keep the content
    text = text.replace(/(\*\*|__|\*|_)/g, '');

    // Remove code blocks with a description
    text = text.replace(/```[\s\S]*?```/g, '(code block omitted)');

    // Remove image syntax but add alt text if available
    text = text.replace(/!\[([^\]]*)\]\([^\)]+\)/g, 'Image: $1');

    // Remove HTML tags
    text = text.replace(/<\/?[^>]+(>|$)/g, '');

    // Normalize line breaks
    text = text.replace(/\n{2,}/g, '\n\n');

    // Replace multiple spaces within lines
    text = text.replace(/ {2,}/g, ' ');

    // Trim leading and trailing whitespace
    text = text.trim();

    return text;
}

/**
 * Convert speed multiplier to Edge TTS rate format
 */
function speedToRate(speed: number): string {
    if (speed < 0 || speed > 2) {
        throw new Error("Speed must be between 0 and 2 (inclusive).");
    }

    // Convert speed to percentage change
    const percentageChange = (speed - 1) * 100;

    // Format with a leading "+" or "-" as required
    return `${percentageChange >= 0 ? '+' : ''}${percentageChange.toFixed(0)}%`;
}

/**
 * Get the appropriate Edge TTS voice name
 */
function getEdgeTTSVoice(voice: string): string {
    return voiceMapping[voice] || voice;
}

/**
 * Convert MP3 audio data to PCM using FFmpeg
 * @param mp3Data - MP3 audio data as Uint8Array
 * @returns PCM audio data as Uint8Array (16-bit signed, 24kHz, mono)
 */
async function convertMp3ToPcm(mp3Data: Uint8Array): Promise<Uint8Array> {
    // Create temporary files for input and output
    const tempDir = await Deno.makeTempDir();
    const inputPath = `${tempDir}/input.mp3`;
    const outputPath = `${tempDir}/output.pcm`;

    try {
        // Write MP3 data to temporary file
        await Deno.writeFile(inputPath, mp3Data);

        // Use FFmpeg to convert MP3 to raw PCM
        const command = new Deno.Command("ffmpeg", {
            args: [
                "-i", inputPath,           // Input MP3 file
                "-f", "s16le",             // Output format: 16-bit signed little-endian
                "-ar", "24000",            // Sample rate: 24kHz to match TTS_SAMPLE_RATE
                "-ac", "1",                // Channels: mono
                "-y",                      // Overwrite output file
                outputPath                 // Output PCM file
            ],
            stdout: "null",
            stderr: "null"
        });

        const { code } = await command.output();

        if (code !== 0) {
            throw new Error(`FFmpeg conversion failed with exit code ${code}`);
        }

        // Read the converted PCM data
        const pcmData = await Deno.readFile(outputPath);
        return pcmData;

    } finally {
        // Clean up temporary files
        try {
            await Deno.remove(tempDir, { recursive: true });
        } catch (error) {
            console.warn("Failed to clean up temporary files:", error);
        }
    }
}

/**
 * Convert text to speech using Edge TTS
 */
export async function convertTextToSpeech(
    text: string,
    voiceName: string = EDGE_TTS_DEFAULT_VOICE,
    options: Partial<EdgeTTSRequest> = {}
): Promise<EdgeTTSResponse> {
    if (!text.trim()) {
        return {
            success: false,
            error: "Empty text provided"
        };
    }

    try {
        // Preprocess text for better TTS
        const processedText = prepareTTSInput(text);
        
        // Get the appropriate Edge TTS voice
        const edgeTTSVoice = getEdgeTTSVoice(voiceName);
        
        // Convert speed to rate format
        const rate = options.rate ? speedToRate(options.rate) : speedToRate(EDGE_TTS_DEFAULT_SPEED);
        
        // Set up TTS instance
        const tts = new MsEdgeTTS();
        
        // Determine output format - use MP3 and convert to PCM for ESP32 compatibility
        const outputFormat = "AUDIO_24KHZ_96KBITRATE_MONO_MP3" as keyof typeof OUTPUT_FORMAT;
        const format = OUTPUT_FORMAT[outputFormat];
        
        await tts.setMetadata(edgeTTSVoice, format);
        
        console.log(`Edge TTS: Converting text (${processedText.length} chars) using voice ${edgeTTSVoice}, format: ${outputFormat}`);
        
        // Generate audio to stream
        const { audioStream } = tts.toStream(processedText, {
            rate: options.rate || EDGE_TTS_DEFAULT_SPEED,
            pitch: options.pitch || "+0Hz",
            volume: options.volume || "+0%"
        });

        // Collect audio data
        const audioChunks: Uint8Array[] = [];
        
        return new Promise((resolve, reject) => {
            audioStream.on("data", (chunk: Buffer) => {
                audioChunks.push(new Uint8Array(chunk));
            });

            audioStream.on("end", async () => {
                // Combine all chunks
                const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const mp3Data = new Uint8Array(totalLength);
                let offset = 0;

                for (const chunk of audioChunks) {
                    mp3Data.set(chunk, offset);
                    offset += chunk.length;
                }

                // Convert MP3 to PCM for ESP32 compatibility
                try {
                    const pcmData = await convertMp3ToPcm(mp3Data);
                    resolve({
                        success: true,
                        audioData: pcmData
                    });
                } catch (conversionError) {
                    console.error("MP3 to PCM conversion failed:", conversionError);
                    resolve({
                        success: false,
                        error: `MP3 to PCM conversion failed: ${conversionError}`
                    });
                }
            });

            audioStream.on("error", (error: Error) => {
                console.error(`Edge TTS error: ${error.message}`);
                reject({
                    success: false,
                    error: `Edge TTS error: ${error.message}`
                });
            });
        });

    } catch (error) {
        console.error(`Edge TTS conversion error: ${error}`);
        return {
            success: false,
            error: `Edge TTS conversion error: ${error}`
        };
    }
}

/**
 * Convert text to speech using Edge TTS with streaming
 */
export async function convertTextToSpeechStreaming(
    text: string,
    voiceName: string = EDGE_TTS_DEFAULT_VOICE,
    onAudioChunk: (chunk: Uint8Array) => Promise<void>,
    options: Partial<EdgeTTSRequest> = {}
): Promise<EdgeTTSResponse> {
    if (!text.trim()) {
        return {
            success: false,
            error: "Empty text provided"
        };
    }

    try {
        // Preprocess text for better TTS
        const processedText = prepareTTSInput(text);
        
        // Get the appropriate Edge TTS voice
        const edgeTTSVoice = getEdgeTTSVoice(voiceName);
        
        // Set up TTS instance
        const tts = new MsEdgeTTS();
        
        // Determine output format - use MP3 and convert to PCM for ESP32 compatibility
        const outputFormat = "AUDIO_24KHZ_96KBITRATE_MONO_MP3" as keyof typeof OUTPUT_FORMAT;
        const format = OUTPUT_FORMAT[outputFormat];
        
        await tts.setMetadata(edgeTTSVoice, format);
        
        console.log(`Edge TTS Streaming: Converting text (${processedText.length} chars) using voice ${edgeTTSVoice}, format: ${outputFormat}`);
        
        // Generate audio to stream
        const { audioStream } = tts.toStream(processedText, {
            rate: options.rate || EDGE_TTS_DEFAULT_SPEED,
            pitch: options.pitch || "+0Hz",
            volume: options.volume || "+0%"
        });

        // For streaming, we need to collect chunks and convert them
        const audioChunks: Uint8Array[] = [];

        return new Promise((resolve, reject) => {
            audioStream.on("data", (chunk: Buffer) => {
                audioChunks.push(new Uint8Array(chunk));
            });

            audioStream.on("end", async () => {
                try {
                    // Combine all MP3 chunks
                    const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                    const mp3Data = new Uint8Array(totalLength);
                    let offset = 0;

                    for (const chunk of audioChunks) {
                        mp3Data.set(chunk, offset);
                        offset += chunk.length;
                    }

                    // Convert MP3 to PCM
                    const pcmData = await convertMp3ToPcm(mp3Data);

                    // Send PCM data in chunks for streaming
                    const chunkSize = 960; // TTS_FRAME_SIZE_BYTES
                    for (let i = 0; i < pcmData.length; i += chunkSize) {
                        const chunk = pcmData.slice(i, i + chunkSize);
                        await onAudioChunk(chunk);
                    }

                    resolve({
                        success: true
                    });
                } catch (conversionError) {
                    console.error("MP3 to PCM conversion failed in streaming:", conversionError);
                    resolve({
                        success: false,
                        error: `MP3 to PCM conversion failed: ${conversionError}`
                    });
                }
            });

            audioStream.on("error", (error: Error) => {
                console.error(`Edge TTS streaming error: ${error.message}`);
                reject({
                    success: false,
                    error: `Edge TTS streaming error: ${error.message}`
                });
            });
        });

    } catch (error) {
        console.error(`Edge TTS streaming conversion error: ${error}`);
        return {
            success: false,
            error: `Edge TTS streaming conversion error: ${error}`
        };
    }
}

/**
 * Validate Edge TTS configuration
 */
export function validateEdgeTTSConfig(): boolean {
    // Edge TTS doesn't require API keys, so it's always valid
    return true;
}

/**
 * Get available Edge TTS voices (basic list)
 */
export function getAvailableVoices(): string[] {
    return [
        'en-US-AvaNeural',
        'en-US-AndrewNeural',
        'en-US-EmmaNeural',
        'en-US-BrianNeural',
        'en-US-JennyNeural',
        'en-US-GuyNeural',
        'en-US-AriaNeural',
        'en-US-DavisNeural',
        'en-US-EricNeural',
        'en-US-SteffanNeural',
        'en-GB-SoniaNeural',
        'en-GB-RyanNeural',
        'en-AU-NatashaNeural',
        'en-AU-WilliamNeural',
        'vi-VN-NamMinhNeural',
        'vi-VN-HoaiMyNeural'
    ];
}

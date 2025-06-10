import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
    AUDIO_DEBUG,
    AUDIO_DEBUG_DIR,
    AUDIO_DEBUG_MAX_FILES,
    MIC_SAMPLE_RATE,
    MIC_SAMPLE_BITS,
    MIC_CHANNELS
} from "./config.ts";

/**
 * Audio Debug System
 * 
 * This module provides functionality to save voice commands as audio files
 * for testing and debugging the audio pipeline. It supports:
 * - Automatic WAV file creation with proper headers
 * - File rotation to maintain maximum file count
 * - Bandwidth and compression logging
 * - Session-based file naming
 */

interface AudioDebugSession {
    sessionId: string;
    startTime: Date;
    audioBuffer: Uint8Array[];
    totalBytes: number;
    compressionRatio?: number;
    lastSaveTime: number;
    chunkCount: number;
}

class AudioDebugManager {
    private sessions: Map<string, AudioDebugSession> = new Map();
    private isEnabled: boolean = AUDIO_DEBUG;
    private debugDir: string = AUDIO_DEBUG_DIR;
    private maxFiles: number = AUDIO_DEBUG_MAX_FILES;

    constructor() {
        if (this.isEnabled) {
            this.initializeDebugDirectory();
            console.log(`Audio Debug System initialized: ${this.debugDir} (max ${this.maxFiles} files)`);
        }
    }

    /**
     * Initialize the debug directory
     */
    private async initializeDebugDirectory(): Promise<void> {
        try {
            await ensureDir(this.debugDir);
        } catch (error) {
            console.error("Failed to create audio debug directory:", error);
            this.isEnabled = false;
        }
    }

    /**
     * Start a new debug session for a connection
     */
    public startSession(sessionId: string): void {
        if (!this.isEnabled) return;

        const session: AudioDebugSession = {
            sessionId,
            startTime: new Date(),
            audioBuffer: [],
            totalBytes: 0,
            lastSaveTime: Date.now(),
            chunkCount: 0
        };

        this.sessions.set(sessionId, session);
        console.log(`Audio debug session started: ${sessionId}`);
    }

    /**
     * Add audio data to the debug session
     */
    public addAudioData(sessionId: string, audioData: Uint8Array, compressionRatio?: number): void {
        if (!this.isEnabled) return;

        const session = this.sessions.get(sessionId);
        if (!session) return;

        // Store audio data
        session.audioBuffer.push(new Uint8Array(audioData));
        session.totalBytes += audioData.length;
        session.chunkCount++;

        if (compressionRatio) {
            session.compressionRatio = compressionRatio;
        }

        // Log bandwidth info periodically (every 10 chunks)
        if (session.chunkCount % 10 === 0) {
            this.logBandwidthInfo(session);
        }

        // Auto-save every 30 seconds or 100 chunks to prevent data loss
        const now = Date.now();
        const timeSinceLastSave = now - session.lastSaveTime;
        const shouldAutoSave = timeSinceLastSave > 30000 || session.chunkCount % 100 === 0;

        if (shouldAutoSave && session.chunkCount > 0) {
            this.autoSaveSession(sessionId).catch(err =>
                console.error(`Auto-save failed for session ${sessionId}:`, err)
            );
        }
    }

    /**
     * Auto-save session data without ending the session
     */
    private async autoSaveSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        try {
            // Create a partial save with current data
            const duration = Date.now() - session.startTime.getTime();
            const timestamp = session.startTime.toISOString().replace(/[:.]/g, '-');
            const filename = `voice_${timestamp}_autosave_${duration}ms_${sessionId.substring(0, 8)}.wav`;
            const filepath = join(this.debugDir, filename);

            // Combine current audio buffers
            const totalLength = session.audioBuffer.reduce((sum, buffer) => sum + buffer.length, 0);
            const combinedAudio = new Uint8Array(totalLength);
            let offset = 0;

            for (const buffer of session.audioBuffer) {
                combinedAudio.set(buffer, offset);
                offset += buffer.length;
            }

            // Create and save WAV file
            const wavData = this.createWavFile(combinedAudio);
            await Deno.writeFile(filepath, wavData);

            // Update last save time
            session.lastSaveTime = Date.now();

            console.log(`Audio Debug: Auto-saved session ${sessionId.substring(0, 8)} (${session.chunkCount} chunks, ${(session.totalBytes / 1024).toFixed(1)} KB)`);

        } catch (error) {
            console.error(`Auto-save failed for session ${sessionId}:`, error);
        }
    }

    /**
     * End a debug session and save the audio file
     */
    public async endSession(sessionId: string, reason: string = "session_ended"): Promise<void> {
        if (!this.isEnabled) return;

        const session = this.sessions.get(sessionId);
        if (!session) return;

        try {
            // Calculate session duration
            const duration = Date.now() - session.startTime.getTime();
            
            // Create filename with timestamp and session info
            const timestamp = session.startTime.toISOString().replace(/[:.]/g, '-');
            const filename = `voice_${timestamp}_${reason}_${duration}ms_${sessionId.substring(0, 8)}.wav`;
            const filepath = join(this.debugDir, filename);

            // Combine all audio buffers
            const totalLength = session.audioBuffer.reduce((sum, buffer) => sum + buffer.length, 0);
            const combinedAudio = new Uint8Array(totalLength);
            let offset = 0;
            
            for (const buffer of session.audioBuffer) {
                combinedAudio.set(buffer, offset);
                offset += buffer.length;
            }

            // Create WAV file with proper header
            const wavData = this.createWavFile(combinedAudio);
            await Deno.writeFile(filepath, wavData);

            // Log session summary
            this.logSessionSummary(session, filename, duration);

            // Clean up old files if necessary
            await this.cleanupOldFiles();

        } catch (error) {
            console.error(`Failed to save audio debug file for session ${sessionId}:`, error);
        } finally {
            // Remove session from memory
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Create a WAV file with proper header
     */
    private createWavFile(pcmData: Uint8Array): Uint8Array {
        const sampleRate = MIC_SAMPLE_RATE;
        const bitsPerSample = MIC_SAMPLE_BITS;
        const channels = MIC_CHANNELS;
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const fileSize = 36 + dataSize;

        const header = new ArrayBuffer(44);
        const view = new DataView(header);

        // RIFF header
        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, fileSize, true);    // File size
        view.setUint32(8, 0x57415645, false); // "WAVE"

        // fmt chunk
        view.setUint32(12, 0x666d7420, false); // "fmt "
        view.setUint32(16, 16, true);          // Chunk size
        view.setUint16(20, 1, true);           // Audio format (PCM)
        view.setUint16(22, channels, true);    // Number of channels
        view.setUint32(24, sampleRate, true);  // Sample rate
        view.setUint32(28, byteRate, true);    // Byte rate
        view.setUint16(32, blockAlign, true);  // Block align
        view.setUint16(34, bitsPerSample, true); // Bits per sample

        // data chunk
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, dataSize, true);    // Data size

        // Combine header and data
        const wavFile = new Uint8Array(44 + dataSize);
        wavFile.set(new Uint8Array(header), 0);
        wavFile.set(pcmData, 44);

        return wavFile;
    }

    /**
     * Log bandwidth and compression information
     */
    private logBandwidthInfo(session: AudioDebugSession): void {
        const durationMs = Date.now() - session.startTime.getTime();
        const durationSec = durationMs / 1000;
        const bytesPerSecond = session.totalBytes / durationSec;
        const kbps = (bytesPerSecond * 8) / 1000;

        let logMessage = `Audio Debug [${session.sessionId.substring(0, 8)}]: ` +
                        `${session.totalBytes} bytes, ${kbps.toFixed(1)} kbps`;

        if (session.compressionRatio) {
            const originalSize = session.totalBytes * session.compressionRatio;
            const savedBytes = originalSize - session.totalBytes;
            const savedPercentage = (savedBytes / originalSize) * 100;
            logMessage += `, compression: ${session.compressionRatio.toFixed(1)}x ` +
                         `(saved ${savedPercentage.toFixed(1)}%)`;
        }

        console.log(logMessage);
    }

    /**
     * Log session summary when ending
     */
    private logSessionSummary(session: AudioDebugSession, filename: string, duration: number): void {
        const sizeKB = (session.totalBytes / 1024).toFixed(1);
        const durationSec = (duration / 1000).toFixed(1);

        console.log(`Audio Debug Session Complete:
  File: ${filename}
  Duration: ${durationSec}s
  Size: ${sizeKB} KB (${session.totalBytes} bytes)
  Chunks: ${session.chunkCount}
  ${session.compressionRatio ? `Compression: ${session.compressionRatio.toFixed(1)}x` : 'No compression'}`);
    }

    /**
     * Clean up old files to maintain max file count
     */
    private async cleanupOldFiles(): Promise<void> {
        try {
            const files: { name: string; mtime: Date }[] = [];
            
            for await (const entry of Deno.readDir(this.debugDir)) {
                if (entry.isFile && entry.name.endsWith('.wav')) {
                    const filepath = join(this.debugDir, entry.name);
                    const stat = await Deno.stat(filepath);
                    files.push({ name: entry.name, mtime: stat.mtime || new Date(0) });
                }
            }

            // Sort by modification time (oldest first)
            files.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

            // Remove excess files
            const filesToRemove = files.length - this.maxFiles;
            if (filesToRemove > 0) {
                for (let i = 0; i < filesToRemove; i++) {
                    const filepath = join(this.debugDir, files[i].name);
                    await Deno.remove(filepath);
                    console.log(`Audio Debug: Removed old file ${files[i].name}`);
                }
            }
        } catch (error) {
            console.error("Failed to cleanup old audio debug files:", error);
        }
    }

    /**
     * Get current debug status
     */
    public getStatus(): { enabled: boolean; activeSessions: number; directory: string; maxFiles: number } {
        return {
            enabled: this.isEnabled,
            activeSessions: this.sessions.size,
            directory: this.debugDir,
            maxFiles: this.maxFiles
        };
    }

    /**
     * Force end all active sessions (for cleanup)
     */
    public async endAllSessions(reason: string = "server_shutdown"): Promise<void> {
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
            await this.endSession(sessionId, reason);
        }
    }
}

// Export singleton instance
export const audioDebugManager = new AudioDebugManager();

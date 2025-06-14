/**
 * ADPCM (Adaptive Differential Pulse Code Modulation) Implementation for Deno
 * 
 * This implementation provides 4:1 compression ratio for 16-bit PCM audio.
 * Optimized for VoIP applications in bandwidth-constrained environments.
 * 
 * Features:
 * - 16-bit PCM ↔ 4-bit ADPCM conversion
 * - Maintains 16kHz sample rate
 * - Low latency encoding/decoding
 * - Compatible with ESP32 ADPCM implementation
 */

// ADPCM step size table
const STEPSIZE_TABLE = new Int16Array([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
]);

// Index adjustment table
const INDEX_TABLE = new Int8Array([
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
]);

export class ADPCMEncoder {
    private valprev: number = 0;
    private index: number = 0;

    constructor() {
        this.reset();
    }

    reset(): void {
        this.valprev = 0;
        this.index = 0;
    }

    private encodeSample(sample: number): number {
        const step = STEPSIZE_TABLE[this.index];
        let diff = sample - this.valprev;
        
        let code = 0;
        
        // Set sign bit
        if (diff < 0) {
            code = 8;
            diff = -diff;
        }
        
        // Quantize the difference
        let tempStep = step;
        if (diff >= tempStep) {
            code |= 4;
            diff -= tempStep;
        }
        tempStep >>= 1;
        
        if (diff >= tempStep) {
            code |= 2;
            diff -= tempStep;
        }
        tempStep >>= 1;
        
        if (diff >= tempStep) {
            code |= 1;
        }
        
        // Reconstruct the signal
        let diffq = step >> 3;
        if (code & 4) diffq += step;
        if (code & 2) diffq += step >> 1;
        if (code & 1) diffq += step >> 2;
        
        if (code & 8) {
            this.valprev -= diffq;
        } else {
            this.valprev += diffq;
        }
        
        // Clamp to 16-bit range
        if (this.valprev > 32767) this.valprev = 32767;
        else if (this.valprev < -32768) this.valprev = -32768;
        
        // Update index
        this.index += INDEX_TABLE[code];
        if (this.index < 0) this.index = 0;
        else if (this.index > 88) this.index = 88;
        
        return code & 0x0F;
    }

    /**
     * Encode PCM buffer to ADPCM
     * @param pcmBuffer - Int16Array containing 16-bit PCM samples
     * @returns Uint8Array containing compressed ADPCM data
     */
    encode(pcmBuffer: Int16Array): Uint8Array {
        const sampleCount = pcmBuffer.length;
        const adpcmBytes = Math.ceil(sampleCount / 2);
        const adpcmBuffer = new Uint8Array(adpcmBytes);
        
        let adpcmIndex = 0;
        
        for (let i = 0; i < sampleCount; i += 2) {
            let byte = 0;
            
            // Encode first sample (lower 4 bits)
            byte = this.encodeSample(pcmBuffer[i]);
            
            // Encode second sample (upper 4 bits) if available
            if (i + 1 < sampleCount) {
                byte |= (this.encodeSample(pcmBuffer[i + 1]) << 4);
            }
            
            adpcmBuffer[adpcmIndex++] = byte;
        }
        
        return adpcmBuffer;
    }

    /**
     * Get compression ratio
     */
    static getCompressionRatio(): number {
        return 4.0;
    }

    /**
     * Get state for debugging
     */
    getState(): { valprev: number; index: number } {
        return { valprev: this.valprev, index: this.index };
    }
}

export class ADPCMDecoder {
    private valprev: number = 0;
    private index: number = 0;

    constructor() {
        this.reset();
    }

    reset(): void {
        this.valprev = 0;
        this.index = 0;
    }

    private decodeSample(adpcmSample: number): number {
        const step = STEPSIZE_TABLE[this.index];
        let diffq = step >> 3;
        
        if (adpcmSample & 4) diffq += step;
        if (adpcmSample & 2) diffq += step >> 1;
        if (adpcmSample & 1) diffq += step >> 2;
        
        if (adpcmSample & 8) {
            this.valprev -= diffq;
        } else {
            this.valprev += diffq;
        }
        
        // Clamp to 16-bit range
        if (this.valprev > 32767) this.valprev = 32767;
        else if (this.valprev < -32768) this.valprev = -32768;
        
        // Update index
        this.index += INDEX_TABLE[adpcmSample];
        if (this.index < 0) this.index = 0;
        else if (this.index > 88) this.index = 88;
        
        return this.valprev;
    }

    /**
     * Decode ADPCM buffer to PCM
     * @param adpcmBuffer - Uint8Array containing compressed ADPCM data
     * @returns Int16Array containing 16-bit PCM samples
     */
    decode(adpcmBuffer: Uint8Array): Int16Array {
        const sampleCount = adpcmBuffer.length * 2;
        const pcmBuffer = new Int16Array(sampleCount);
        
        let sampleIndex = 0;
        
        for (let i = 0; i < adpcmBuffer.length; i++) {
            const byte = adpcmBuffer[i];
            
            // Decode first sample (lower 4 bits)
            pcmBuffer[sampleIndex++] = this.decodeSample(byte & 0x0F);
            
            // Decode second sample (upper 4 bits)
            pcmBuffer[sampleIndex++] = this.decodeSample((byte >> 4) & 0x0F);
        }
        
        return pcmBuffer;
    }

    /**
     * Get expansion ratio
     */
    static getExpansionRatio(): number {
        return 4.0;
    }

    /**
     * Get state for debugging
     */
    getState(): { valprev: number; index: number } {
        return { valprev: this.valprev, index: this.index };
    }
}

// Utility functions for ADPCM processing
export namespace ADPCM {
    /**
     * Calculate compressed size for given PCM sample count
     */
    export function getCompressedSize(pcmSamples: number): number {
        return Math.ceil(pcmSamples / 2);
    }

    /**
     * Calculate decompressed size for given ADPCM byte count
     */
    export function getDecompressedSize(adpcmBytes: number): number {
        return adpcmBytes * 2;
    }

    /**
     * Convert PCM bytes to Int16Array
     */
    export function bytesToInt16Array(buffer: Uint8Array): Int16Array {
        return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    }

    /**
     * Convert Int16Array to PCM bytes
     */
    export function int16ArrayToBytes(samples: Int16Array): Uint8Array {
        return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    }

    /**
     * Create ADPCM encoder with automatic state management
     */
    export function createEncoder(): ADPCMEncoder {
        return new ADPCMEncoder();
    }

    /**
     * Create ADPCM decoder with automatic state management
     */
    export function createDecoder(): ADPCMDecoder {
        return new ADPCMDecoder();
    }
}

// Stream processing class for real-time ADPCM encoding/decoding
export class ADPCMStreamProcessor {
    private encoder: ADPCMEncoder;
    private decoder: ADPCMDecoder;
    private inputBuffer: Int16Array;
    private inputBufferUsed: number = 0;

    constructor(bufferSize: number = 1024) {
        this.encoder = new ADPCMEncoder();
        this.decoder = new ADPCMDecoder();
        this.inputBuffer = new Int16Array(bufferSize);
    }

    /**
     * Process incoming PCM data and return ADPCM compressed data
     */
    encodePCMChunk(pcmData: Uint8Array): Uint8Array[] {
        const samples = ADPCM.bytesToInt16Array(pcmData);
        const chunks: Uint8Array[] = [];
        
        // Add to input buffer
        let sampleIndex = 0;
        while (sampleIndex < samples.length) {
            const canCopy = Math.min(
                samples.length - sampleIndex,
                this.inputBuffer.length - this.inputBufferUsed
            );
            
            this.inputBuffer.set(
                samples.subarray(sampleIndex, sampleIndex + canCopy),
                this.inputBufferUsed
            );
            
            this.inputBufferUsed += canCopy;
            sampleIndex += canCopy;
            
            // Process when buffer is full or we have even number of samples
            if (this.inputBufferUsed >= this.inputBuffer.length || 
                (this.inputBufferUsed >= 2 && sampleIndex >= samples.length)) {
                
                // Ensure even number of samples for ADPCM
                const samplesToProcess = this.inputBufferUsed & ~1;
                
                if (samplesToProcess > 0) {
                    const toEncode = this.inputBuffer.subarray(0, samplesToProcess);
                    const compressed = this.encoder.encode(toEncode);
                    chunks.push(compressed);
                    
                    // Move remaining samples to beginning
                    const remaining = this.inputBufferUsed - samplesToProcess;
                    if (remaining > 0) {
                        this.inputBuffer.copyWithin(0, samplesToProcess, this.inputBufferUsed);
                    }
                    this.inputBufferUsed = remaining;
                }
            }
        }
        
        return chunks;
    }

    /**
     * Process incoming ADPCM data and return PCM data
     */
    decodeADPCMChunk(adpcmData: Uint8Array): Uint8Array {
        const pcmSamples = this.decoder.decode(adpcmData);
        return ADPCM.int16ArrayToBytes(pcmSamples);
    }

    /**
     * Flush any remaining data in the encoder buffer
     */
    flush(): Uint8Array | null {
        if (this.inputBufferUsed > 0) {
            // Pad with zero if odd number of samples
            if (this.inputBufferUsed & 1) {
                this.inputBuffer[this.inputBufferUsed] = 0;
                this.inputBufferUsed++;
            }
            
            const toEncode = this.inputBuffer.subarray(0, this.inputBufferUsed);
            const compressed = this.encoder.encode(toEncode);
            this.inputBufferUsed = 0;
            return compressed;
        }
        return null;
    }

    /**
     * Reset encoder and decoder states
     */
    reset(): void {
        this.encoder.reset();
        this.decoder.reset();
        this.inputBufferUsed = 0;
    }
}

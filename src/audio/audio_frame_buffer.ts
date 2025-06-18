// Circular buffer for audio frames
export class AudioFrameBuffer {
    private frames: Int16Array[];
    private frameSize: number;
    private maxFrames: number;
    private writeIndex: number;
    private frameCount: number;

    constructor(frameSize: number, maxFrames: number) {
        this.frameSize = frameSize;
        this.maxFrames = maxFrames;
        this.writeIndex = 0;
        this.frameCount = 0;

        // Allocate memory for frames
        this.frames = new Array(maxFrames);
        for (let i = 0; i < maxFrames; i++) {
            this.frames[i] = new Int16Array(frameSize);
        }
    }

    addFrame(frame: Int16Array | Uint8Array): boolean {
        if (!frame) return false;

        // Convert Uint8Array to Int16Array if needed
        let frameData: Int16Array;
        if (frame instanceof Uint8Array) {
            // Convert bytes to 16-bit samples (little-endian)
            frameData = new Int16Array(frame.length / 2);
            for (let i = 0; i < frameData.length; i++) {
                frameData[i] = (frame[i * 2 + 1] << 8) | frame[i * 2];
            }
        } else {
            frameData = frame;
        }

        // Ensure we don't exceed frame size
        const copyLength = Math.min(frameData.length, this.frameSize);
        
        // Copy frame data
        this.frames[this.writeIndex].set(frameData.subarray(0, copyLength));
        
        // Fill remaining with zeros if frame is smaller
        if (copyLength < this.frameSize) {
            this.frames[this.writeIndex].fill(0, copyLength);
        }

        // Update indices
        this.writeIndex = (this.writeIndex + 1) % this.maxFrames;
        if (this.frameCount < this.maxFrames) {
            this.frameCount++;
        }

        return true;
    }

    getFrame(index: number, frame: Int16Array): boolean {
        if (!frame || index >= this.frameCount) return false;

        // Calculate actual index (considering circular buffer)
        let actualIndex: number;
        if (this.frameCount < this.maxFrames) {
            actualIndex = index;
        } else {
            actualIndex = (this.writeIndex + index) % this.maxFrames;
        }

        // Copy frame data
        const copyLength = Math.min(frame.length, this.frameSize);
        frame.set(this.frames[actualIndex].subarray(0, copyLength));

        return true;
    }

    getFrameCount(): number {
        return this.frameCount;
    }

    clear(): void {
        this.writeIndex = 0;
        this.frameCount = 0;
    }

    // Get all frames as a single buffer
    getAllFrames(): Int16Array {
        const totalSamples = this.frameCount * this.frameSize;
        const result = new Int16Array(totalSamples);
        
        for (let i = 0; i < this.frameCount; i++) {
            const frame = new Int16Array(this.frameSize);
            if (this.getFrame(i, frame)) {
                result.set(frame, i * this.frameSize);
            }
        }
        
        return result;
    }

    // Convert frames to Uint8Array (PCM bytes)
    getAllFramesAsBytes(): Uint8Array {
        const frames = this.getAllFrames();
        const result = new Uint8Array(frames.length * 2);
        
        for (let i = 0; i < frames.length; i++) {
            const sample = frames[i];
            result[i * 2] = sample & 0xFF;         // Low byte
            result[i * 2 + 1] = (sample >> 8) & 0xFF; // High byte
        }
        
        return result;
    }
}

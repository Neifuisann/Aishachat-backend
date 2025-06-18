import { Logger } from '../utils/logger.ts';
import { VADConfig, VADState } from './vad_config.ts';
import { AudioFrameBuffer } from './audio_frame_buffer.ts';

const log = new Logger('[VAD]');

export interface VADProcessResult {
    shouldTransmit: boolean;
    sendPrefixBuffer: boolean;
    prefixFrames?: Uint8Array;
}

// Main VAD class
export class VoiceActivityDetector {
    private config: VADConfig;
    private currentState: VADState;
    private prefixBuffer: AudioFrameBuffer;
    
    // Energy tracking
    private currentEnergy: number;
    private smoothedEnergy: number;
    
    // Frame counters
    private speechFrameCount: number;
    private silenceFrameCount: number;

    // Calibration variables
    private calibrationActive: boolean;
    private calibrationStartTime: number;
    private calibrationDuration: number;
    private calibrationEnergySum: number;
    private calibrationMaxEnergy: number;
    private calibrationFrameCount: number;

    // Debug timing
    private lastEnergyDebug: number;

    constructor(cfg: VADConfig = new VADConfig()) {
        this.config = cfg;
        this.currentState = VADState.VAD_SILENCE;
        this.currentEnergy = 0.0;
        this.smoothedEnergy = 0.0;
        this.speechFrameCount = 0;
        this.silenceFrameCount = 0;
        
        this.calibrationActive = false;
        this.calibrationStartTime = 0;
        this.calibrationDuration = 0;
        this.calibrationEnergySum = 0.0;
        this.calibrationMaxEnergy = 0.0;
        this.calibrationFrameCount = 0;

        this.lastEnergyDebug = 0;
        
        // Create prefix buffer
        this.prefixBuffer = new AudioFrameBuffer(this.config.frameSize, this.config.prefixFrames);
    }

    private calculateRMSEnergy(frame: Int16Array | Uint8Array): number {
        if (!frame) return 0.0;

        // Convert Uint8Array to Int16Array if needed
        let samples: Int16Array;
        if (frame instanceof Uint8Array) {
            samples = new Int16Array(frame.length / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = (frame[i * 2 + 1] << 8) | frame[i * 2];
            }
        } else {
            samples = frame;
        }

        let sum = 0.0;
        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            sum += sample * sample;
        }

        return Math.sqrt(sum / samples.length);
    }

    private updateEnergySmoothing(newEnergy: number): void {
        this.currentEnergy = newEnergy;
        
        // Apply exponential smoothing
        this.smoothedEnergy = (this.config.energySmoothingFactor * newEnergy) + 
                             ((1.0 - this.config.energySmoothingFactor) * this.smoothedEnergy);
    }

    private isSpeechEnergy(energy: number): boolean {
        return energy > this.config.speechThreshold;
    }

    private isSilenceEnergy(energy: number): boolean {
        return energy < this.config.silenceThreshold;
    }

    processFrame(frame: Int16Array | Uint8Array): VADProcessResult {
        const result: VADProcessResult = {
            shouldTransmit: false,
            sendPrefixBuffer: false
        };

        if (!frame) return result;

        // Calculate energy for current frame
        const frameEnergy = this.calculateRMSEnergy(frame);
        this.updateEnergySmoothing(frameEnergy);

        // Debug: Print energy levels occasionally
        const now = Date.now();
        if (now - this.lastEnergyDebug > 2000) { // Every 2 seconds
            log.info(`Energy Debug: Raw=${frameEnergy.toFixed(1)}, Smoothed=${this.smoothedEnergy.toFixed(1)}, Thresholds=${this.config.speechThreshold}/${this.config.silenceThreshold}`);
            this.lastEnergyDebug = now;
        }

        // Handle calibration mode
        if (this.calibrationActive) {
            this.calibrationEnergySum += frameEnergy;
            if (frameEnergy > this.calibrationMaxEnergy) {
                this.calibrationMaxEnergy = frameEnergy;
            }
            this.calibrationFrameCount++;

            // Check if calibration is complete
            if (now - this.calibrationStartTime >= this.calibrationDuration) {
                this.calibrationActive = false;
                const calibResults = this.getCalibrationResults();
                
                log.info('VAD Calibration complete:');
                log.info(`  Average silence energy: ${calibResults.avgSilence.toFixed(2)}`);
                log.info(`  Maximum silence energy: ${calibResults.maxSilence.toFixed(2)}`);
                log.info(`  Suggested speech threshold: ${calibResults.suggestedSpeechThreshold.toFixed(2)}`);
                log.info(`  Suggested silence threshold: ${(calibResults.suggestedSpeechThreshold * 0.6).toFixed(2)}`);
            }

            // During calibration, don't process speech detection
            this.prefixBuffer.addFrame(frame);
            return result;
        }

        // Always add frame to prefix buffer (for potential future use)
        this.prefixBuffer.addFrame(frame);
        
        // State machine for VAD
        switch (this.currentState) {
            case VADState.VAD_SILENCE:
                if (this.isSpeechEnergy(this.smoothedEnergy)) {
                    this.currentState = VADState.VAD_SPEECH_START;
                    this.speechFrameCount = 1;
                    this.silenceFrameCount = 0;
                    result.sendPrefixBuffer = true;  // Send prefix buffer when speech starts
                    result.prefixFrames = this.prefixBuffer.getAllFramesAsBytes();
                    log.info(`Speech started! Energy=${this.smoothedEnergy.toFixed(1)}`);
                    result.shouldTransmit = true;  // Also send current frame
                }
                break;
                
            case VADState.VAD_SPEECH_START:
                this.speechFrameCount++;
                if (this.speechFrameCount >= this.config.minSpeechFrames) {
                    this.currentState = VADState.VAD_SPEECH_ACTIVE;
                }

                if (this.isSilenceEnergy(this.smoothedEnergy)) {
                    this.silenceFrameCount++;
                    if (this.silenceFrameCount === 1) {
                        log.info(`Silence detection started, energy=${this.smoothedEnergy.toFixed(1)}`);
                    }
                    if (this.silenceFrameCount >= this.config.silenceFrames) {
                        this.currentState = VADState.VAD_SILENCE;
                        this.speechFrameCount = 0;
                        this.silenceFrameCount = 0;
                        log.info(`Speech ended (silence detected) after ${this.config.silenceFrames} frames`);
                        break; // End of speech - stop sending
                    }
                } else {
                    if (this.silenceFrameCount > 0) {
                        log.info(`Silence counter reset (was ${this.silenceFrameCount}), energy=${this.smoothedEnergy.toFixed(1)}`);
                    }
                    this.silenceFrameCount = 0;  // Reset silence counter
                }
                result.shouldTransmit = true;  // Continue sending during speech start
                break;

            case VADState.VAD_SPEECH_ACTIVE:
                if (this.isSilenceEnergy(this.smoothedEnergy)) {
                    this.silenceFrameCount++;
                    if (this.silenceFrameCount === 1) {
                        log.info(`Silence detection started, energy=${this.smoothedEnergy.toFixed(1)}`);
                    }
                    if (this.silenceFrameCount >= this.config.silenceFrames) {
                        this.currentState = VADState.VAD_SILENCE;
                        this.speechFrameCount = 0;
                        this.silenceFrameCount = 0;
                        log.info(`Speech ended (silence detected) after ${this.config.silenceFrames} frames`);
                        break; // End of speech - stop sending
                    }
                } else {
                    if (this.silenceFrameCount > 0) {
                        log.info(`Silence counter reset (was ${this.silenceFrameCount}), energy=${this.smoothedEnergy.toFixed(1)}`);
                    }
                    this.silenceFrameCount = 0;  // Reset silence counter
                }
                result.shouldTransmit = true;  // Continue sending during active speech
                break;
                
            case VADState.VAD_SPEECH_END:
                // This state is not used in current implementation
                // but could be used for more complex state transitions
                this.currentState = VADState.VAD_SILENCE;
                break;
        }
        
        return result;
    }

    // State queries
    getState(): VADState {
        return this.currentState;
    }

    getCurrentEnergy(): number {
        return this.smoothedEnergy;
    }

    isSpeechActive(): boolean {
        return this.currentState === VADState.VAD_SPEECH_ACTIVE || 
               this.currentState === VADState.VAD_SPEECH_START;
    }

    getSpeechFrameCount(): number {
        return this.speechFrameCount;
    }

    getSilenceFrameCount(): number {
        return this.silenceFrameCount;
    }

    // Configuration
    updateConfig(cfg: VADConfig): void {
        this.config = cfg;
        
        // Recreate prefix buffer if frame size or count changed
        this.prefixBuffer = new AudioFrameBuffer(this.config.frameSize, this.config.prefixFrames);
        
        this.reset();
    }

    setThresholds(speechThreshold: number, silenceThreshold: number): void {
        this.config.speechThreshold = speechThreshold;
        this.config.silenceThreshold = silenceThreshold;
    }

    reset(): void {
        this.currentState = VADState.VAD_SILENCE;
        this.currentEnergy = 0.0;
        this.smoothedEnergy = 0.0;
        this.speechFrameCount = 0;
        this.silenceFrameCount = 0;

        // Reset calibration state
        this.calibrationActive = false;
        this.calibrationStartTime = 0;
        this.calibrationEnergySum = 0.0;
        this.calibrationMaxEnergy = 0.0;
        this.calibrationFrameCount = 0;

        this.prefixBuffer.clear();
    }

    printDebugInfo(): void {
        log.info(`State: ${this.currentState}, Energy: ${this.currentEnergy.toFixed(2)}, Smoothed: ${this.smoothedEnergy.toFixed(2)}, Speech: ${this.speechFrameCount}, Silence: ${this.silenceFrameCount}, Thresholds: ${this.config.speechThreshold}/${this.config.silenceThreshold}`);
    }

    startCalibration(durationMs: number = 5000): void {
        this.calibrationActive = true;
        this.calibrationStartTime = Date.now();
        this.calibrationDuration = durationMs;
        this.calibrationEnergySum = 0.0;
        this.calibrationMaxEnergy = 0.0;
        this.calibrationFrameCount = 0;

        log.info(`VAD Calibration started - please remain silent for ${durationMs / 1000} seconds`);
    }

    isCalibrating(): boolean {
        return this.calibrationActive;
    }

    getCalibrationResults(): { avgSilence: number; maxSilence: number; suggestedSpeechThreshold: number } {
        if (this.calibrationFrameCount > 0) {
            const avgSilence = this.calibrationEnergySum / this.calibrationFrameCount;
            const maxSilence = this.calibrationMaxEnergy;
            // Suggest speech threshold as 3x the maximum silence energy
            const suggestedSpeechThreshold = maxSilence * 3.0;
            
            return { avgSilence, maxSilence, suggestedSpeechThreshold };
        } else {
            return {
                avgSilence: 0.0,
                maxSilence: 0.0,
                suggestedSpeechThreshold: this.config.speechThreshold
            };
        }
    }
}

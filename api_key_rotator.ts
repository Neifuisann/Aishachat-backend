/**
 * Enhanced API Key Rotation Manager
 * Implements seamless API key rotation without service interruption using:
 * - Dual-key approach (primary/secondary)
 * - 5-minute rotation buffer before expiration
 * - 30-second grace period for transition
 * - Automatic key validation and testing
 */

import { Logger } from './logger.ts';

const logger = new Logger('[APIKeyRotator]');

export interface APIKeyPair {
    primary: string;
    secondary?: string;
    lastRotated?: Date;
    expiresAt?: Date;
    isValid: boolean;
}

export interface RotationConfig {
    rotationBufferMs: number; // 5 minutes before expiration
    gracePeriodMs: number; // 30 seconds for transition
    validationTimeoutMs: number; // Timeout for key validation
    maxRetries: number; // Max retries for key validation
}

export class APIKeyManager {
    private keyPairs: Map<string, APIKeyPair> = new Map();
    private keyProvider: KeyProvider;
    private config: RotationConfig;
    private rotationTimers: Map<string, number> = new Map();

    constructor(keyProvider: KeyProvider, config?: Partial<RotationConfig>) {
        this.keyProvider = keyProvider;
        this.config = {
            rotationBufferMs: 5 * 60 * 1000, // 5 minutes
            gracePeriodMs: 30 * 1000, // 30 seconds
            validationTimeoutMs: 10 * 1000, // 10 seconds
            maxRetries: 3,
            ...config,
        };
    }

    /**
     * Initialize API key for a service
     */
    async initializeService(service: string, initialKey: string): Promise<void> {
        const isValid = await this.validateKey(service, initialKey);
        
        this.keyPairs.set(service, {
            primary: initialKey,
            isValid,
            lastRotated: new Date(),
        });

        if (isValid) {
            logger.info(`Initialized API key for service: ${service}`);
            this.scheduleRotation(service);
        } else {
            logger.error(`Invalid initial API key for service: ${service}`);
            throw new Error(`Invalid API key for service: ${service}`);
        }
    }

    /**
     * Get the active API key for a service
     * Returns secondary key during rotation, primary otherwise
     */
    getActiveKey(service: string): string {
        const pair = this.keyPairs.get(service);
        if (!pair) {
            throw new Error(`No API key configured for service: ${service}`);
        }

        // Use secondary key during rotation if available
        return pair.secondary || pair.primary;
    }

    /**
     * Get the primary API key for a service
     */
    getPrimaryKey(service: string): string {
        const pair = this.keyPairs.get(service);
        if (!pair) {
            throw new Error(`No API key configured for service: ${service}`);
        }
        return pair.primary;
    }

    /**
     * Manually trigger key rotation for a service
     */
    async rotateKey(service: string): Promise<void> {
        const currentPair = this.keyPairs.get(service);
        if (!currentPair) {
            throw new Error(`No API key configured for service: ${service}`);
        }

        logger.info(`Starting manual key rotation for service: ${service}`);

        try {
            // Generate new key
            const newKey = await this.keyProvider.generateKey(service);
            
            // Validate new key
            const isValid = await this.validateKey(service, newKey);
            if (!isValid) {
                throw new Error('Generated key failed validation');
            }

            // Set as secondary key
            currentPair.secondary = newKey;
            logger.info(`New key generated and set as secondary for service: ${service}`);

            // Grace period for transition
            await this.sleep(this.config.gracePeriodMs);

            // Promote secondary to primary
            currentPair.primary = newKey;
            currentPair.secondary = undefined;
            currentPair.lastRotated = new Date();

            logger.info(`Key rotation completed for service: ${service}`);

            // Schedule next rotation
            this.scheduleRotation(service);

        } catch (error) {
            logger.error(`Key rotation failed for service ${service}:`, error);
            
            // Clean up failed secondary key
            if (currentPair.secondary) {
                currentPair.secondary = undefined;
            }
            
            throw error;
        }
    }

    /**
     * Schedule automatic key rotation
     */
    private scheduleRotation(service: string): void {
        const pair = this.keyPairs.get(service);
        if (!pair || !pair.expiresAt) {
            return; // No expiration time set
        }

        // Clear existing timer
        const existingTimer = this.rotationTimers.get(service);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Calculate rotation time (buffer before expiration)
        const rotationTime = pair.expiresAt.getTime() - this.config.rotationBufferMs;
        const delay = Math.max(0, rotationTime - Date.now());

        const timerId = setTimeout(async () => {
            try {
                await this.rotateKey(service);
            } catch (error) {
                logger.error(`Scheduled rotation failed for service ${service}:`, error);
                
                // Retry rotation with exponential backoff
                this.retryRotation(service, 1);
            }
        }, delay) as unknown as number;

        this.rotationTimers.set(service, timerId);
        
        logger.info(
            `Scheduled key rotation for service ${service} in ${Math.round(delay / 1000)} seconds`
        );
    }

    /**
     * Retry key rotation with exponential backoff
     */
    private async retryRotation(service: string, attempt: number): Promise<void> {
        if (attempt > this.config.maxRetries) {
            logger.error(`Max rotation retries exceeded for service: ${service}`);
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000); // Max 1 minute
        
        logger.info(`Retrying key rotation for service ${service} (attempt ${attempt}) in ${delay}ms`);

        setTimeout(async () => {
            try {
                await this.rotateKey(service);
            } catch (error) {
                logger.error(`Rotation retry ${attempt} failed for service ${service}:`, error);
                this.retryRotation(service, attempt + 1);
            }
        }, delay);
    }

    /**
     * Validate an API key for a service
     */
    private async validateKey(service: string, key: string): Promise<boolean> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.config.validationTimeoutMs);

            const isValid = await this.keyProvider.validateKey(service, key, controller.signal);
            
            clearTimeout(timeoutId);
            return isValid;

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                logger.warn(`Key validation timeout for service: ${service}`);
            } else {
                logger.error(`Key validation error for service ${service}:`, error);
            }
            return false;
        }
    }

    /**
     * Set expiration time for a service key
     */
    setKeyExpiration(service: string, expiresAt: Date): void {
        const pair = this.keyPairs.get(service);
        if (pair) {
            pair.expiresAt = expiresAt;
            this.scheduleRotation(service);
            logger.info(`Set key expiration for service ${service}: ${expiresAt.toISOString()}`);
        }
    }

    /**
     * Get key information for a service
     */
    getKeyInfo(service: string): APIKeyPair | undefined {
        const pair = this.keyPairs.get(service);
        return pair ? { ...pair } : undefined;
    }

    /**
     * Get all configured services
     */
    getServices(): string[] {
        return Array.from(this.keyPairs.keys());
    }

    /**
     * Check if a service has a valid key
     */
    hasValidKey(service: string): boolean {
        const pair = this.keyPairs.get(service);
        return pair?.isValid ?? false;
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        // Clear all rotation timers
        for (const timerId of this.rotationTimers.values()) {
            clearTimeout(timerId);
        }
        this.rotationTimers.clear();
        this.keyPairs.clear();
        
        logger.info('API Key Manager destroyed');
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Interface for key providers (implement for different services)
 */
export interface KeyProvider {
    /**
     * Generate a new API key for a service
     */
    generateKey(service: string): Promise<string>;

    /**
     * Validate an API key for a service
     */
    validateKey(service: string, key: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Example implementation for Gemini API keys
 */
export class GeminiKeyProvider implements KeyProvider {
    private keyPool: string[];
    private currentIndex: number = 0;

    constructor(keys: string[]) {
        this.keyPool = keys.filter(key => key && key.trim().length > 0);
        if (this.keyPool.length === 0) {
            throw new Error('No valid keys provided to GeminiKeyProvider');
        }
    }

    async generateKey(service: string): Promise<string> {
        // For Gemini, we rotate through the pool rather than generating new keys
        this.currentIndex = (this.currentIndex + 1) % this.keyPool.length;
        return this.keyPool[this.currentIndex];
    }

    async validateKey(service: string, key: string, signal?: AbortSignal): Promise<boolean> {
        try {
            // Test the key with a simple API call
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
                { 
                    method: 'GET',
                    signal,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            return response.ok;
        } catch (error) {
            logger.warn(`Key validation failed for service ${service}:`, error);
            return false;
        }
    }
}

/**
 * Robust Connection Manager with Circuit Breaker Pattern
 * Implements production-grade WebSocket connection handling with:
 * - Exponential backoff with jitter
 * - Circuit breaker pattern for failure protection
 * - Message queuing for connection recovery
 * - Connection state management
 */

import { Logger } from '../utils/logger.ts';
import { CONNECTION_RETRY_CONFIG, CIRCUIT_BREAKER_CONFIG, KEEP_ALIVE_CONFIG } from '../config/config.ts';

const logger = new Logger('[ConnectionManager]');

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'failed';
    reconnectAttempts: number;
    lastError?: Error;
    lastConnectedAt?: Date;
    lastDisconnectedAt?: Date;
}

export interface QueuedMessage {
    data: string | ArrayBuffer;
    timestamp: number;
    priority: 'high' | 'normal' | 'low';
}

export interface CircuitBreakerState {
    state: 'closed' | 'open' | 'half-open';
    failureCount: number;
    lastFailureTime?: Date;
    nextAttemptTime?: Date;
}

export class RobustWebSocket {
    private ws: WebSocket | null = null;
    private connectionState: ConnectionState;
    private messageQueue: QueuedMessage[] = [];
    private circuitBreaker: CircuitBreakerState;
    private reconnectTimeoutId: number | null = null;
    private keepAliveIntervalId: number | null = null;
    private url: string;
    private protocols?: string | string[];

    // Event handlers
    public onopen?: (event: Event) => void;
    public onmessage?: (event: MessageEvent) => void;
    public onclose?: (event: CloseEvent) => void;
    public onerror?: (event: Event) => void;
    public onreconnect?: (attempt: number) => void;
    public onreconnectfailed?: () => void;

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        
        this.connectionState = {
            status: 'disconnected',
            reconnectAttempts: 0,
        };

        this.circuitBreaker = {
            state: 'closed',
            failureCount: 0,
        };
    }

    get readyState(): number {
        return this.ws?.readyState ?? WebSocket.CLOSED;
    }

    get binaryType(): BinaryType {
        return this.ws?.binaryType ?? 'blob';
    }

    set binaryType(type: BinaryType) {
        if (this.ws) {
            this.ws.binaryType = type;
        }
    }

    async connect(): Promise<void> {
        if (this.connectionState.status === 'connecting' || this.connectionState.status === 'connected') {
            return;
        }

        // Check circuit breaker
        if (!this.canAttemptConnection()) {
            throw new Error('Circuit breaker is open - connection attempts blocked');
        }

        this.connectionState.status = 'connecting';
        
        try {
            await this.establishConnection();
        } catch (error) {
            this.handleConnectionFailure(error as Error);
            throw error;
        }
    }

    private canAttemptConnection(): boolean {
        if (this.circuitBreaker.state === 'closed') {
            return true;
        }

        if (this.circuitBreaker.state === 'open') {
            const now = new Date();
            if (this.circuitBreaker.nextAttemptTime && now >= this.circuitBreaker.nextAttemptTime) {
                this.circuitBreaker.state = 'half-open';
                logger.info('Circuit breaker transitioning to half-open state');
                return true;
            }
            return false;
        }

        // half-open state - allow one attempt
        return true;
    }

    private async establishConnection(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.url, this.protocols);
                this.ws.binaryType = 'arraybuffer'; // Optimize for binary data

                this.ws.onopen = (event) => {
                    this.handleConnectionSuccess();
                    this.onopen?.(event);
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.onmessage?.(event);
                };

                this.ws.onclose = (event) => {
                    this.handleConnectionClose(event);
                    this.onclose?.(event);
                };

                this.ws.onerror = (event) => {
                    this.handleConnectionError(event);
                    this.onerror?.(event);
                    reject(new Error('WebSocket connection failed'));
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    private handleConnectionSuccess(): void {
        this.connectionState.status = 'connected';
        this.connectionState.reconnectAttempts = 0;
        this.connectionState.lastConnectedAt = new Date();
        
        // Reset circuit breaker on successful connection
        this.circuitBreaker.state = 'closed';
        this.circuitBreaker.failureCount = 0;
        
        logger.info('WebSocket connection established successfully');
        
        // Process queued messages
        this.processMessageQueue();
        
        // Start keep-alive
        this.startKeepAlive();
    }

    private handleConnectionFailure(error: Error): void {
        this.connectionState.status = 'failed';
        this.connectionState.lastError = error;
        this.connectionState.lastDisconnectedAt = new Date();
        
        // Update circuit breaker
        this.circuitBreaker.failureCount++;
        this.circuitBreaker.lastFailureTime = new Date();
        
        if (this.circuitBreaker.failureCount >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
            this.openCircuitBreaker();
        }
        
        logger.error('WebSocket connection failed:', error);
        
        // Schedule reconnection
        this.scheduleReconnect();
    }

    private handleConnectionClose(event: CloseEvent): void {
        this.connectionState.status = 'disconnected';
        this.connectionState.lastDisconnectedAt = new Date();
        
        this.stopKeepAlive();
        
        logger.info(`WebSocket connection closed: ${event.code} ${event.reason}`);
        
        // Schedule reconnection if not a clean close
        if (event.code !== 1000) {
            this.scheduleReconnect();
        }
    }

    private handleConnectionError(event: Event): void {
        logger.error('WebSocket error:', event);
    }

    private openCircuitBreaker(): void {
        this.circuitBreaker.state = 'open';
        this.circuitBreaker.nextAttemptTime = new Date(
            Date.now() + CIRCUIT_BREAKER_CONFIG.recoveryTimeoutMs
        );
        
        logger.warn(
            `Circuit breaker opened after ${this.circuitBreaker.failureCount} failures. ` +
            `Next attempt at ${this.circuitBreaker.nextAttemptTime.toISOString()}`
        );
    }

    private calculateBackoffDelay(): number {
        const exponentialDelay = Math.min(
            CONNECTION_RETRY_CONFIG.initialDelayMs * 
            Math.pow(CONNECTION_RETRY_CONFIG.backoffMultiplier, this.connectionState.reconnectAttempts),
            CONNECTION_RETRY_CONFIG.maxDelayMs
        );
        
        const jitter = Math.random() * CONNECTION_RETRY_CONFIG.jitterRange;
        return exponentialDelay + jitter;
    }

    private scheduleReconnect(): void {
        if (this.connectionState.reconnectAttempts >= CONNECTION_RETRY_CONFIG.maxRetries) {
            this.connectionState.status = 'failed';
            logger.error('Maximum reconnection attempts reached');
            this.onreconnectfailed?.();
            return;
        }

        const delay = this.calculateBackoffDelay();
        this.connectionState.reconnectAttempts++;
        
        logger.info(
            `Scheduling reconnection attempt ${this.connectionState.reconnectAttempts}/${CONNECTION_RETRY_CONFIG.maxRetries} ` +
            `in ${Math.round(delay)}ms`
        );

        this.reconnectTimeoutId = setTimeout(() => {
            this.onreconnect?.(this.connectionState.reconnectAttempts);
            this.connect().catch((error) => {
                logger.error('Reconnection attempt failed:', error);
            });
        }, delay) as unknown as number;
    }

    private processMessageQueue(): void {
        if (this.messageQueue.length === 0) return;
        
        logger.info(`Processing ${this.messageQueue.length} queued messages`);
        
        // Sort by priority and timestamp
        this.messageQueue.sort((a, b) => {
            const priorityOrder = { high: 0, normal: 1, low: 2 };
            const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
            return priorityDiff !== 0 ? priorityDiff : a.timestamp - b.timestamp;
        });

        const messages = [...this.messageQueue];
        this.messageQueue = [];

        for (const message of messages) {
            try {
                this.send(message.data);
            } catch (error) {
                logger.error('Failed to send queued message:', error);
                // Re-queue failed messages with lower priority
                this.queueMessage(message.data, 'low');
            }
        }
    }

    private queueMessage(data: string | ArrayBuffer, priority: 'high' | 'normal' | 'low' = 'normal'): void {
        // Limit queue size to prevent memory issues
        const maxQueueSize = 1000;
        if (this.messageQueue.length >= maxQueueSize) {
            // Remove oldest low-priority messages
            this.messageQueue = this.messageQueue.filter(msg => msg.priority !== 'low').slice(-maxQueueSize + 1);
        }

        this.messageQueue.push({
            data,
            timestamp: Date.now(),
            priority,
        });
    }

    private startKeepAlive(): void {
        this.keepAliveIntervalId = setInterval(() => {
            if (this.readyState === WebSocket.OPEN) {
                // Send a ping frame or small message to keep connection alive
                try {
                    this.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                } catch (error) {
                    logger.warn('Keep-alive ping failed:', error);
                }
            }
        }, KEEP_ALIVE_CONFIG.intervalMs) as unknown as number;
    }

    private stopKeepAlive(): void {
        if (this.keepAliveIntervalId) {
            clearInterval(this.keepAliveIntervalId);
            this.keepAliveIntervalId = null;
        }
    }

    send(data: string | ArrayBuffer | Blob): void {
        if (this.readyState === WebSocket.OPEN && this.ws) {
            this.ws.send(data);
        } else {
            // Queue message for later delivery
            if (typeof data === 'string' || data instanceof ArrayBuffer) {
                this.queueMessage(data);
            } else {
                logger.warn('Cannot queue Blob messages - message dropped');
            }
        }
    }

    close(code?: number, reason?: string): void {
        // Clear reconnection timer
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }

        this.stopKeepAlive();
        
        if (this.ws) {
            this.ws.close(code, reason);
            this.ws = null;
        }
        
        this.connectionState.status = 'disconnected';
    }

    getConnectionState(): ConnectionState {
        return { ...this.connectionState };
    }

    getCircuitBreakerState(): CircuitBreakerState {
        return { ...this.circuitBreaker };
    }

    getQueuedMessageCount(): number {
        return this.messageQueue.length;
    }
}

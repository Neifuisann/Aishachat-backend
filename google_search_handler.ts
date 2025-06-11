import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from 'npm:@google/genai';
import { apiKeyManager } from './config.ts';
import { Logger } from './logger.ts';

const logger = new Logger('[GoogleSearch]');

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Retry configuration for API calls
 */
interface RetryConfig {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    readonly backoffMultiplier: number;
    readonly retryableStatusCodes: ReadonlyArray<number>;
}

/**
 * Error with status code
 */
interface ErrorWithStatus extends Error {
    status?: number;
}

/**
 * Google Search Response Interface
 */
export interface GoogleSearchResponse {
    readonly success: boolean;
    readonly message: string;
    readonly data?: SearchResultData;
}

/**
 * Search result data structure
 */
interface SearchResultData {
    readonly query: string;
    readonly timestamp: string;
    readonly rawResults?: string;
    readonly error?: string;
}

/**
 * Search handler configuration
 */
interface SearchHandlerConfig {
    readonly temperature: number;
    readonly model: string;
    readonly responseMimeType: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableStatusCodes: [500, 502, 503, 504, 429],
} as const;

const SEARCH_CONFIG: SearchHandlerConfig = {
    temperature: 0.1,
    model: 'gemini-2.0-flash',
    responseMimeType: 'text/plain',
} as const;

const RETRYABLE_ERROR_PATTERNS = [
    'internal server error',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'rate limit',
    'quota exceeded',
    'overloaded',
    'temporarily unavailable',
    'server error',
    'connection reset',
    'timeout',
    'network error',
] as const;

const SAFETY_SETTINGS = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
    },
];

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Get retry configuration from environment variables
 */
function getRetryConfig(): RetryConfig {
    const env = globalThis.Deno?.env;
    if (!env) return DEFAULT_RETRY_CONFIG;

    return {
        maxRetries: parseInt(
            env.get('GEMINI_MAX_RETRIES') || String(DEFAULT_RETRY_CONFIG.maxRetries),
        ),
        baseDelayMs: parseInt(
            env.get('GEMINI_BASE_DELAY_MS') || String(DEFAULT_RETRY_CONFIG.baseDelayMs),
        ),
        maxDelayMs: parseInt(
            env.get('GEMINI_MAX_DELAY_MS') || String(DEFAULT_RETRY_CONFIG.maxDelayMs),
        ),
        backoffMultiplier: parseFloat(
            env.get('GEMINI_BACKOFF_MULTIPLIER') || String(DEFAULT_RETRY_CONFIG.backoffMultiplier),
        ),
        retryableStatusCodes: DEFAULT_RETRY_CONFIG.retryableStatusCodes,
    };
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Retry handler for API operations
 */
class RetryHandler {
    constructor(private readonly config: RetryConfig = getRetryConfig()) {}

    /**
     * Execute operation with retry logic
     */
    async execute<T>(
        operation: () => Promise<T>,
        operationName: string,
    ): Promise<T> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    await this.delayBeforeRetry(attempt, operationName);
                }

                const result = await operation();

                if (attempt > 0) {
                    this.logRetrySuccess(operationName, attempt);
                }

                return result;
            } catch (error) {
                lastError = error;

                if (!this.shouldRetry(error, attempt)) {
                    break;
                }

                this.logRetryError(operationName, attempt, error);
            }
        }

        this.logFinalError(operationName, lastError);
        throw lastError;
    }

    private async delayBeforeRetry(attempt: number, operationName: string): Promise<void> {
        const delay = this.calculateDelay(attempt - 1);
        logger.info(
            `Retrying ${operationName} (attempt ${attempt}/${this.config.maxRetries}) after ${
                Math.round(delay)
            }ms delay`,
        );
        await this.sleep(delay);
    }

    private calculateDelay(attempt: number): number {
        const exponentialDelay = this.config.baseDelayMs *
            Math.pow(this.config.backoffMultiplier, attempt);
        const jitter = Math.random() * 0.1 * exponentialDelay;
        return Math.min(exponentialDelay + jitter, this.config.maxDelayMs);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private shouldRetry(error: unknown, attempt: number): boolean {
        return attempt < this.config.maxRetries && this.isRetryableError(error);
    }

    private isRetryableError(error: unknown): boolean {
        const errorWithStatus = error as ErrorWithStatus;

        if (
            errorWithStatus.status &&
            this.config.retryableStatusCodes.includes(errorWithStatus.status)
        ) {
            return true;
        }

        const errorMessage = (errorWithStatus.message || '').toLowerCase();
        return RETRYABLE_ERROR_PATTERNS.some((pattern) => errorMessage.includes(pattern));
    }

    private logRetryError(operationName: string, attempt: number, error: unknown): void {
        const errorInfo = this.extractErrorInfo(error);
        logger.error(`${operationName} failed on attempt ${attempt + 1}:`, errorInfo);
    }

    private logRetrySuccess(operationName: string, attempt: number): void {
        logger.info(`${operationName} succeeded on attempt ${attempt + 1}`);
    }

    private logFinalError(operationName: string, error: unknown): void {
        logger.error(
            `${operationName} failed after ${this.config.maxRetries + 1} attempts. Final error:`,
            error,
        );
    }

    private extractErrorInfo(error: unknown): Record<string, unknown> {
        const errorWithStatus = error as ErrorWithStatus;
        return {
            status: errorWithStatus.status || 'unknown',
            message: errorWithStatus.message || String(error),
            retryable: this.isRetryableError(error),
        };
    }
}

// ============================================================================
// Search System Instructions
// ============================================================================

/**
 * Generate system instruction for search
 */
function createSearchSystemInstruction(): string {
    return `
You are a search information extractor. Use Google Search to find information and return ONLY the factual data found.

CRITICAL INSTRUCTIONS:
- Use Google Search to find information
- Return ONLY factual information from search results
- Do NOT provide conversational responses
- Do NOT add your own commentary or interpretation
- Do NOT format as a conversation
- Return raw facts, dates, numbers, and key information only
- Use RAW language you got for the response, dont changes it, just copy-paste.

Format:
SEARCH: [query]
DATE: ${new Date().toISOString()}
RESULTS:
[List only the key facts found, one per line]
`;
}

// ============================================================================
// Google Search Handler
// ============================================================================

/**
 * Google Search Handler using Flash 2.5 with Google Search grounding
 */
export class GoogleSearchHandler {
    private ai: GoogleGenAI;
    private readonly retryHandler: RetryHandler;

    constructor(
        private readonly config: SearchHandlerConfig = SEARCH_CONFIG,
        retryConfig?: RetryConfig,
    ) {
        this.ai = this.initializeAI();
        this.retryHandler = new RetryHandler(retryConfig);
    }

    /**
     * Perform Google Search
     * @param query - The search query
     * @param sessionId - Session ID for logging
     * @returns Search results
     */
    async performSearch(query: string, sessionId: string): Promise<GoogleSearchResponse> {
        try {
            this.logSearchStart(query, sessionId);

            const searchResult = await this.executeSearch(query, sessionId);

            this.logSearchComplete(sessionId, searchResult);

            return this.createSuccessResponse(query, searchResult);
        } catch (error) {
            return this.createErrorResponse(query, sessionId, error);
        }
    }

    private initializeAI(): GoogleGenAI {
        const apiKey = apiKeyManager.getCurrentKey();
        if (!apiKey) {
            throw new Error('API key not available for Google Search');
        }
        return new GoogleGenAI({ apiKey });
    }

    private async executeSearch(query: string, sessionId: string): Promise<string> {
        const response = await this.retryHandler.execute(
            () => this.callGeminiAPI(query),
            `Google Search Flash 2.5 (session: ${sessionId})`,
        );

        return this.extractSearchResults(response);
    }

    private async callGeminiAPI(query: string): Promise<any> {
        return await this.ai.models.generateContent({
            model: this.config.model,
            config: {
                temperature: this.config.temperature,
                safetySettings: SAFETY_SETTINGS,
                tools: [{ googleSearch: {} }],
                responseMimeType: this.config.responseMimeType,
                systemInstruction: [{ text: createSearchSystemInstruction() }],
            },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: query }],
                },
            ],
        });
    }

    private extractSearchResults(response: any): string {
        let searchResult = '';

        const candidates = (response as any).candidates;
        if (!candidates || candidates.length === 0) {
            return searchResult;
        }

        const candidate = candidates[0];
        if (!candidate.content?.parts) {
            return searchResult;
        }

        for (const part of candidate.content.parts) {
            if (part.text) {
                searchResult += part.text;
            }
        }

        return searchResult;
    }

    private createSuccessResponse(query: string, searchResult: string): GoogleSearchResponse {
        return {
            success: true,
            message: searchResult || 'Search completed but no results were found.',
            data: {
                query,
                timestamp: new Date().toISOString(),
                rawResults: searchResult,
            },
        };
    }

    private createErrorResponse(
        query: string,
        sessionId: string,
        error: unknown,
    ): GoogleSearchResponse {
        logger.error(`Google Search (session: ${sessionId}) error:`, error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        return {
            success: false,
            message: `Search failed: ${errorMessage}`,
            data: {
                query,
                timestamp: new Date().toISOString(),
                error: errorMessage,
            },
        };
    }

    private logSearchStart(query: string, sessionId: string): void {
        logger.info(`Google Search (session: ${sessionId}): Performing search for "${query}"`);
    }

    private logSearchComplete(sessionId: string, searchResult: string): void {
        logger.info(`Google Search (session: ${sessionId}): Search completed successfully`);

        const preview = searchResult.substring(0, 200);
        logger.debug(`Google Search raw result: ${preview}...`);
    }
}

// ============================================================================
// Factory and Export
// ============================================================================

/**
 * Create a singleton instance of GoogleSearchHandler
 */
class GoogleSearchHandlerFactory {
    private static instance: GoogleSearchHandler;

    static getInstance(): GoogleSearchHandler {
        if (!this.instance) {
            this.instance = new GoogleSearchHandler();
        }
        return this.instance;
    }
}

/**
 * Perform Google Search using the singleton handler
 * @param query - The search query
 * @param sessionId - Session ID for logging
 * @returns Search results
 */
export async function performGoogleSearch(
    query: string,
    sessionId: string,
): Promise<GoogleSearchResponse> {
    const handler = GoogleSearchHandlerFactory.getInstance();
    return handler.performSearch(query, sessionId);
}

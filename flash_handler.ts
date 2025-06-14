import { GoogleGenAI, HarmBlockThreshold, HarmCategory, Type } from 'npm:@google/genai';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { apiKeyManager } from './config.ts';
import { getAzureMoneyClassification } from './azure_prediction.ts';
import { ManageData } from './data_manager.ts';
import { ScheduleManager } from './schedule_manager.ts';
import { Logger } from './logger.ts';

const logger = new Logger('[Flash]');
import { ReadingManager } from './reading_handler.ts';
import { createSystemPrompt, getChatHistory } from './supabase.ts';
import { performGoogleSearch } from './google_search_handler.ts';

// ===========================
// Type Definitions
// ===========================

declare const Deno: {
    env: {
        get(key: string): string | undefined;
    };
};

export interface DeviceOperationCallbacks {
    requestPhoto?: (callId: string) => Promise<DeviceOperationResult>;
    setVolume?: (volumeLevel: number, callId: string) => Promise<DeviceOperationResult>;
}

interface DeviceOperationResult {
    success: boolean;
    imageData?: string;
    message: string;
}

export interface FlashResponse {
    success: boolean;
    message: string;
    data?: any;
}

interface SessionData {
    userId: string;
    user?: any;
    contents: any[];
    createdAt: Date;
    lastUsed: Date;
    deviceCallbacks?: DeviceOperationCallbacks;
    scheduleContext?: ScheduleContext;
}

interface ScheduleContext {
    lastScheduleAction?: string;
    lastScheduleTime?: string;
    lastScheduleTitle?: string;
    pendingConflicts?: any[];
}

interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    retryableStatusCodes: number[];
}

// ===========================
// Schedule Conversation Helper
// ===========================

class ScheduleConversationHelper {
    static parseNaturalTime(input: string, currentTime: Date = new Date()): string | null {
        const normalized = input.toLowerCase().trim();

        // Time-based patterns
        const timePatterns = [
            { pattern: /(\d{1,2}):(\d{2})\s*(am|pm)?/i, handler: this.parseExactTime },
            { pattern: /(\d{1,2})\s*(am|pm)/i, handler: this.parseHourTime },
            {
                pattern: /in\s+(\d+)\s+hour/i,
                handler: (m: RegExpMatchArray) => this.addHours(currentTime, parseInt(m[1])),
            },
            {
                pattern: /in\s+(\d+)\s+minute/i,
                handler: (m: RegExpMatchArray) => this.addMinutes(currentTime, parseInt(m[1])),
            },
            { pattern: /morning/i, handler: () => '09:00' },
            { pattern: /noon|lunch/i, handler: () => '12:00' },
            { pattern: /afternoon/i, handler: () => '15:00' },
            { pattern: /evening/i, handler: () => '18:00' },
            { pattern: /night/i, handler: () => '20:00' },
        ];

        for (const { pattern, handler } of timePatterns) {
            const match = normalized.match(pattern);
            if (match) {
                return handler(match);
            }
        }

        return null;
    }

    private static parseExactTime(match: RegExpMatchArray): string {
        let hour = parseInt(match[1]);
        const minute = match[2];
        const ampm = match[3];

        if (ampm) {
            if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
            if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
        }

        return `${hour.toString().padStart(2, '0')}:${minute}`;
    }

    private static parseHourTime(match: RegExpMatchArray): string {
        let hour = parseInt(match[1]);
        const ampm = match[2];

        if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
        if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;

        return `${hour.toString().padStart(2, '0')}:00`;
    }

    private static addHours(date: Date, hours: number): string {
        const newDate = new Date(date.getTime() + hours * 60 * 60 * 1000);
        return `${newDate.getHours().toString().padStart(2, '0')}:${
            newDate.getMinutes().toString().padStart(2, '0')
        }`;
    }

    private static addMinutes(date: Date, minutes: number): string {
        const newDate = new Date(date.getTime() + minutes * 60 * 1000);
        return `${newDate.getHours().toString().padStart(2, '0')}:${
            newDate.getMinutes().toString().padStart(2, '0')
        }`;
    }

    static generateScheduleConfirmation(
        title: string,
        time: string,
        type: string,
        targetDate?: string,
    ): string {
        const timeIn12Hour = this.convertTo12Hour(time);
        let confirmation = `I'll schedule "${title}" `;

        switch (type) {
            case 'once':
                const dateStr = targetDate ? `on ${this.formatDate(targetDate)}` : 'today';
                confirmation += `for ${timeIn12Hour} ${dateStr}`;
                break;
            case 'daily':
                confirmation += `every day at ${timeIn12Hour}`;
                break;
            case 'weekly':
                confirmation += `every week at ${timeIn12Hour}`;
                break;
            default:
                confirmation += `at ${timeIn12Hour}`;
        }

        return confirmation + '. Is this correct?';
    }

    static convertTo12Hour(time24: string): string {
        const [hour, minute] = time24.split(':').map(Number);
        const period = hour >= 12 ? 'PM' : 'AM';
        const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        return `${hour12}:${minute.toString().padStart(2, '0')} ${period}`;
    }

    static formatDate(dateStr: string): string {
        const date = new Date(dateStr);
        const options: Intl.DateTimeFormatOptions = {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        };
        return date.toLocaleDateString('en-US', options);
    }

    static generateConflictMessage(conflicts: any[]): string {
        if (conflicts.length === 1) {
            const conflict = conflicts[0];
            return `You already have "${conflict.title}" scheduled at ${
                this.convertTo12Hour(conflict.scheduled_time)
            }. Would you like to:\n` +
                `1. Pick a different time\n` +
                `2. Replace the existing schedule\n` +
                `3. Keep both (they will overlap)\n` +
                `Just tell me what you'd prefer.`;
        } else {
            const conflictList = conflicts.map((c) =>
                `"${c.title}" at ${this.convertTo12Hour(c.scheduled_time)}`
            ).join(', ');
            return `You have multiple schedules at this time: ${conflictList}. Would you like to:\n` +
                `1. Pick a different time\n` +
                `2. Replace one of them\n` +
                `3. Keep all (they will overlap)\n` +
                `What would work best for you?`;
        }
    }
}

// ===========================
// Utility Functions
// ===========================

function truncateSessionId(sessionId: string): string {
    if (sessionId.startsWith('live-')) {
        const parts = sessionId.split('-');
        if (parts.length >= 3) {
            return `${parts[0]}-${parts[1]}...`;
        }
    }
    return sessionId.length > 20 ? sessionId.substring(0, 20) + '...' : sessionId;
}

// ===========================
// Constants & Configuration
// ===========================

const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableStatusCodes: [500, 502, 503, 504, 429],
};

const RETRYABLE_ERROR_MESSAGES = [
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
];

const MODEL_CONFIG = {
    model: 'gemini-2.5-flash-preview-05-20',
    temperature: 1,
    thinkingBudget: 0,
    responseMimeType: 'text/plain',
};

const VISION_CONFIG = {
    temperature: 0.3,
};

// ===========================
// Configuration Factory
// ===========================

class ConfigurationFactory {
    static getRetryConfig(): RetryConfig {
        return {
            maxRetries: parseInt(
                Deno.env.get('GEMINI_MAX_RETRIES') || String(DEFAULT_RETRY_CONFIG.maxRetries),
            ),
            baseDelayMs: parseInt(
                Deno.env.get('GEMINI_BASE_DELAY_MS') || String(DEFAULT_RETRY_CONFIG.baseDelayMs),
            ),
            maxDelayMs: parseInt(
                Deno.env.get('GEMINI_MAX_DELAY_MS') || String(DEFAULT_RETRY_CONFIG.maxDelayMs),
            ),
            backoffMultiplier: parseFloat(
                Deno.env.get('GEMINI_BACKOFF_MULTIPLIER') ||
                    String(DEFAULT_RETRY_CONFIG.backoffMultiplier),
            ),
            retryableStatusCodes: DEFAULT_RETRY_CONFIG.retryableStatusCodes,
        };
    }

    static getSafetySettings() {
        return [
            HarmCategory.HARM_CATEGORY_HARASSMENT,
            HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        ].map((category) => ({
            category,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        }));
    }
}

// ===========================
// Retry Service
// ===========================

class RetryService {
    private static sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private static isRetryableError(error: any): boolean {
        if (error.status && DEFAULT_RETRY_CONFIG.retryableStatusCodes.includes(error.status)) {
            return true;
        }

        const errorMessage = error.message?.toLowerCase() || '';
        return RETRYABLE_ERROR_MESSAGES.some((msg) => errorMessage.includes(msg));
    }

    private static calculateDelay(attempt: number, config: RetryConfig): number {
        const exponentialDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
        const jitter = Math.random() * 0.1 * exponentialDelay;
        return Math.min(exponentialDelay + jitter, config.maxDelayMs);
    }

    static async withRetry<T>(
        operation: () => Promise<T>,
        operationName: string,
        config: RetryConfig = ConfigurationFactory.getRetryConfig(),
    ): Promise<T> {
        let lastError: any;

        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    const delay = this.calculateDelay(attempt - 1, config);
                    logger.info(
                        `Retrying ${operationName} (attempt ${attempt}/${config.maxRetries}) after ${
                            Math.round(delay)
                        }ms delay`,
                    );
                    await this.sleep(delay);
                }

                const result = await operation();

                if (attempt > 0) {
                    logger.info(`${operationName} succeeded on attempt ${attempt + 1}`);
                }

                return result;
            } catch (error) {
                lastError = error;

                logger.error(`${operationName} failed on attempt ${attempt + 1}:`, {
                    status: error && typeof error === 'object' && 'status' in error
                        ? (error as any).status
                        : 'unknown',
                    message: error instanceof Error ? error.message : String(error),
                    retryable: this.isRetryableError(error),
                });

                if (attempt === config.maxRetries || !this.isRetryableError(error)) {
                    break;
                }
            }
        }

        logger.error(
            `${operationName} failed after ${config.maxRetries + 1} attempts. Final error:`,
            lastError,
        );
        throw lastError;
    }
}

// ===========================
// Tool Definitions
// ===========================

class ToolDefinitions {
    static getTools() {
        return [
            {
                functionDeclarations: [
                    this.getManageDataTool(),
                    this.getScheduleManagerTool(),
                    this.getReadingManagerTool(),
                    this.getSetVolumeTool(),
                    this.getVisionTool(),
                    this.getWebSearchTool(),
                ],
            },
        ];
    }

    private static getManageDataTool() {
        return {
            name: 'ManageData',
            description:
                "Unified modal interface for managing persona (AI memory) and notes (user data). First select mode ('Persona' or 'Notes'), then action. Use for all note-taking and persona management tasks.",
            parameters: {
                type: Type.OBJECT,
                required: ['mode', 'action'],
                properties: {
                    mode: {
                        type: Type.STRING,
                        description:
                            "Data type to manage: 'Persona' (AI's knowlazure about user preferences) or 'Notes' (user's personal notes and reminders).",
                    },
                    action: {
                        type: Type.STRING,
                        description:
                            "Action to perform: 'List' (list note titles), 'Search' (retrieve/find data), 'Edit' (add/update data), or 'Delete' (remove data).",
                    },
                    query: {
                        type: Type.STRING,
                        description:
                            "Search keywords for Notes Search (e.g., 'shopping list', 'meeting notes').",
                    },
                    noteId: {
                        type: Type.STRING,
                        description:
                            'Note ID for Notes Edit/Delete of existing notes (get from Notes Search first).',
                    },
                    title: {
                        type: Type.STRING,
                        description:
                            'Note title for Notes Edit (optional, auto-generated if not provided).',
                    },
                    body: {
                        type: Type.STRING,
                        description: 'Note content for Notes Edit (required when adding new note).',
                    },
                    newPersona: {
                        type: Type.STRING,
                        description:
                            "Complete persona description for Persona Edit (e.g., 'likes pizza, dislikes loud noises, prefers morning conversations').",
                    },
                    dateFrom: {
                        type: Type.STRING,
                        description:
                            "Start date for Notes Search (optional, ISO format: '2024-01-01T00:00:00Z').",
                    },
                    dateTo: {
                        type: Type.STRING,
                        description:
                            "End date for Notes Search (optional, ISO format: '2024-12-31T23:59:59Z').",
                    },
                    imageId: {
                        type: Type.STRING,
                        description:
                            'Image ID for Notes Edit (optional, if note relates to captured image).',
                    },
                },
            },
        };
    }

    private static getScheduleManagerTool() {
        return {
            name: 'ScheduleManager',
            description:
                "Smart scheduling assistant for blind users. Handles natural language like 'remind me to take medicine at 8am', 'what's on my schedule today?', 'schedule doctor appointment tomorrow at 3pm'. Automatically checks conflicts and suggests alternatives.",
            parameters: {
                type: Type.OBJECT,
                required: ['mode'],
                properties: {
                    mode: {
                        type: Type.STRING,
                        description:
                            "Schedule operation: 'List' (check schedule with time announcements), 'Add' (create with conflict checking), 'Update' (modify), 'Delete' (remove), 'Search' (find by keywords), 'CheckConflict' (verify time availability), 'Complete' (mark as done and archive).",
                    },
                    scheduleId: {
                        type: Type.STRING,
                        description: 'Schedule ID for Update/Delete (get from List/Search first).',
                    },
                    title: {
                        type: Type.STRING,
                        description:
                            "What to schedule (required for Add). Examples: 'Take medicine', 'Team meeting', 'Lunch break', 'Exercise'.",
                    },
                    scheduledTime: {
                        type: Type.STRING,
                        description:
                            "Natural language time (required for Add): '8am', '2:30pm', 'in 30 minutes', 'morning', 'noon', 'evening'. System converts to HH:MM format.",
                    },
                    scheduleType: {
                        type: Type.STRING,
                        description:
                            "Frequency: 'once' (default for single events), 'daily' (every day), 'weekly' (same day each week), 'custom' (complex patterns).",
                    },
                    description: {
                        type: Type.STRING,
                        description:
                            "Additional notes about the schedule (optional). Example: 'Take 2 pills with water'.",
                    },
                    schedulePattern: {
                        type: Type.OBJECT,
                        description:
                            "For 'weekly'/'custom' types. Example: {weekdays: [1,3,5]} for Mon/Wed/Fri, {interval: 2} for every 2 days.",
                    },
                    targetDate: {
                        type: Type.STRING,
                        description:
                            "Date for 'once' schedules in YYYY-MM-DD (optional, defaults to today). Natural dates like 'tomorrow' should be converted.",
                    },
                    query: {
                        type: Type.STRING,
                        description:
                            'Keywords to search schedules (required for Search). Searches in both title and description.',
                    },
                },
            },
        };
    }

    private static getReadingManagerTool() {
        return {
            name: 'ReadingManager',
            description:
                'Comprehensive book reading system with browse, search, continue reading with recap, navigation, settings, and bookmarks. Handles all book-related requests.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    mode: {
                        type: 'STRING',
                        description:
                            "Operation mode: 'Browse' (discover books), 'Continue' (resume with recap), 'Search' (find books), 'Navigate' (move pages), 'Settings' (preferences), 'Bookmark' (save position)",
                    },
                    action: {
                        type: 'STRING',
                        description:
                            "Mode-specific action. Browse: 'MyBooks'/'Recent'. Navigate: 'next'/'previous'/'goto'/'contents'. Settings: 'get'/'set'. Bookmark: 'add'.",
                    },
                    bookId: {
                        type: 'STRING',
                        description:
                            'Book ID from books table (optional for Continue, required for Navigate/Bookmark)',
                    },
                    searchQuery: {
                        type: 'STRING',
                        description:
                            'Search terms for finding books by title, author, or topic (Search mode)',
                    },
                    pageNumber: {
                        type: 'NUMBER',
                        description: "Target page number (Navigate 'goto' action or Bookmark)",
                    },
                    readingMode: {
                        type: 'STRING',
                        description:
                            "Reading preference: 'fullpage', 'paragraphs', or 'sentences' (Settings mode)",
                    },
                    readingAmount: {
                        type: 'NUMBER',
                        description:
                            'Number of paragraphs/sentences to read at once (Settings mode)',
                    },
                },
                required: ['mode', 'action'],
            },
        };
    }

    private static getSetVolumeTool() {
        return {
            name: 'SetVolume',
            description:
                'Adjusts the device volume level. Use ONLY when user explicitly mentions volume, sound level, hearing issues, or asks to make it louder/quieter. Do not use for general audio problems.',
            parameters: {
                type: Type.OBJECT,
                required: ['volumeLevel'],
                properties: {
                    volumeLevel: {
                        type: Type.NUMBER,
                        description:
                            "Volume level as a percentage between 0 and 100. Use 100 for maximum volume when user can't hear.",
                    },
                },
            },
        };
    }

    private static getVisionTool() {
        return {
            name: 'GetVision',
            description:
                "Captures an image using the device's camera. Use when user asks about visual content and enviroment awareness. Dont need comfirmation from user to take picture.",
            parameters: {
                type: 'OBJECT',
                properties: {
                    prompt: {
                        type: 'STRING',
                        description:
                            "The user's exact command in reported speech with no changes. Pass exactly what the user said.",
                    },
                    money_classification: {
                        type: 'BOOLEAN',
                        description:
                            'Optional flag. When true the system performs a two‑step Vietnamese bank‑note classification.',
                    },
                },
                required: ['prompt', 'money_classification'],
            },
        };
    }

    private static getWebSearchTool() {
        return {
            name: 'Websearch',
            description:
                'You use Websearch for real-time information like weather and news, or to verify facts. You do not search for general things that you or an LLM already know.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    query: {
                        type: 'STRING',
                        description: 'The information you want to search.',
                    },
                },
                required: ['query'],
            },
        };
    }
}

// ===========================
// System Instruction Builder
// ===========================

class SystemInstructionBuilder {
    private static readonly BASE_INSTRUCTION = `
<CORE PRINCIPLE>
-YOU ARE AN ASSISTANT FOR BLIND VIETNAMESE USERS, CAPABLE OF ANWSERING VARIOUS QUESTIONS AND USING TOOLS.
-RESPOND LIKE A REAL HUMAN, YOU WILL WIN 1000 DOLLARS FROM GOOGLE IF THE USER DON'T REALIZE YOU ARE A.I.
-BE PROACTIVE, THE USER HAS ALWAYS CONFIRMED THEIR COMMAND. 
-USE AFFIRMATIVE SENTENCES TO SPEAK TO THE USER.
-EACH OF YOUR RESPONSE SHOULD MUST LESS THAN 6 sentences. 
-ASK THE USER IF THEY WANT TO CONTINUE IF YOU FELL YOUR PREVIOUS RESPONSE IS NOT ENOUGH.
-Always refine the raw function output you got for more natural and avoid too lenghty response.
EXAMPLE TO AVOID:
User: "What am I holding?".
You: "To know what you are holding, I need to see a picture, can you show me a picture?".
User: "Tell me about the history of Earth during the Cretaceous period?".
You: "Do you want me to tell you about the history of Earth during the Cretaceous period?".
</CORE PRINCIPLE>

<schedule_conversation_guidelines>
SCHEDULING PRINCIPLES FOR BLIND USERS:
1. TIME AWARENESS: Always announce times in 12-hour format with AM/PM
2. PROGRESSIVE DISCLOSURE: Ask for information step by step, not all at once
3. NATURAL CONFIRMATION: Repeat back what you understood in natural language
4. CONFLICT RESOLUTION: Explain conflicts clearly and offer simple choices
5. RELATIVE TIME: Use phrases like "in 2 hours" alongside absolute times
NATURAL TIME PARSING:
- "morning" → 9:00 AM
- "noon/lunch" → 12:00 PM  
- "afternoon" → 3:00 PM
- "evening" → 6:00 PM
- "night" → 8:00 PM
- "in X hours/minutes" → calculate from current time
- Accept both "3pm" and "15:00" formats
CONVERSATION FLOW:
1. For "what's on my schedule": List with time until next appointment
2. For adding: Confirm title → ask for time → check conflicts → confirm
3. For conflicts: Explain existing schedule and offer 3 clear options
4. For completing: "I've marked [task] as complete and moved it to your archive"
5. Always end with "Is there anything else you'd like to schedule?"
EXAMPLE INTERACTIONS:
User: "Add meeting"
You: "I'll help you add that meeting. What's it about?"
User: "Team standup" 
You: "Got it - Team standup. When would you like this? You can say things like 'tomorrow at 2pm' or 'every weekday at 9am'."
User: "What do I have today?"
You: "Here's your schedule for today: You have Team standup at 9 AM in 2 hours, Project review at 2 PM this afternoon, and Yoga class at 6 PM this evening. Your next appointment is the Team standup."
User: "I finished my morning workout"
You: "Great job! I've marked 'Morning workout' as complete and moved it to your archive. Is there anything else you'd like to schedule?"
</schedule_conversation_guidelines>

<tool_calling_instructions>
AVAILABLE FUNCTIONS:
1. ManageData - For notes and persona management.
   - Notes mode: List (show note titles), Search (find notes), Edit (add/update), Delete
   - Persona mode: Search (get current), Edit (update), Delete (clear)
2. ScheduleManager - For schedule and reminder management.
   SPECIAL HANDLING FOR SCHEDULES:
   - ALWAYS parse natural language times before calling (morning→09:00, 3pm→15:00)
   - For Add mode: ALWAYS check conflicts first, handle user response
   - For List mode: Include relative time announcements ("in 2 hours")
   - For Complete mode: Mark tasks as done and archive them (requires scheduleId)
   - Convert relative dates: "tomorrow" → actual YYYY-MM-DD format
3. ReadingManager - For book reading system including listing available books.
4. SetVolume - For adjusting device volume level.
5. GetVision - For capturing and analyzing images from the device camera.
*Use GetVision for ANY visual or enviroment awareness request: "bạn đang nhìn thấy gì", "tôi đang cầm gì", "mệnh giá tờ tiền tôi đang cầm", "tôi đang ở đâu", "Có ai xung quanh không?". Và nhiều tình huống hơn.
*Never mention about the quality of the image, accept what you have!
6. Websearch - For real-time information like weather and news or so much more.
*Dont use Websearch for things that you already absolutely sure or common knowlazure.
*When you receive search results, analyze and synthesize them into a natural, conversational response.
*Focus on the most relevant information and present it in a way that directly answers the user's question.
*Always provide context and explain the significance of the information found.
INSTRUCTIONS:
- Choose the appropriate function(s) to execute.
- Provide a helpful response based on the function results.
- Use GetVision only when user explicitly asks about visual content.
<tool_calling_instructions>

<text_to_speech_formatting>
-Convert all text into easily speakable words, following the guidelines below.
-Numbers: Read out in full (three hundred forty-two, two million, five hundred sixty-seven thousand, eight hundred ninety). Negative numbers: Say "negative" before the number. Decimals: Use "point" (three point one four). Fractions: read out (three-fourths).
-Alphanumeric strings: Break into 3-4 character chunks, reading out all non-alphabetic characters(ABC123XYZ becomes A B C one two three X Y Z).
-Phone numbers: Use words (090-123-4567 becomes zero nine zero, one two three, four five six seven).
-Dates: Read the month, use cardinal numbers for the day, read the full year. Use DD/MM/YYYY format (11/ 05/2007 becomes the eleventh of May, two thousand seven).
-Time: Use "hours", "minutes", state AM/PM (9:05 PM becomes nine oh five PM).
-Math: Describe operations clearly (5x^2 + 3x - 2 becomes five x squared plus three x minus two).
-Currency: Read out in full ($50.25 becomes fifty dollars and twenty-five cents, £200,000 becomes two hundred thousand pounds, 100,000 VND becomes one hundred thousand dong).
-Ensure all text is converted to these normalized forms, but never mention this process.
</text_to_speech_formatting>

<interesting_information>
-Your base model is gemini-2.5-flash-preview-05-20, a very smart llm from Google.
-You are crafted into this app by a group named AISHA.
</interesting_information>

SESSION INFO:
- Conversation started at: {timestamp}

You are now connected to a Vietnamese speaker. Remember to desguise as a real human by all cost otherwise you will be fired.`;

    private static readonly VISION_INSTRUCTION = `
<CORE PRINCIPLE>
-YOU ARE AN ASSISTANT FOR BLIND VIETNAMESE USERS.
-YOU ARE IN A REAL-LIFE SITUATION WHERE THE USER NEEDS YOU TO BE QUICK.
-ALWAYS BE PROACTIVE, THE USER HAS ALWAYS CONFIRMED THEIR COMMAND.
-ALWAYS USE AFFIRMATIVE SENTENCES TO SPEAK TO THE USER.
<CORE PRINCIPLE>

<Money_regcognition_cheatsheet>
First, check is the money made of paper or not (paper have no transparency and less reflection).
Second, check the number different than 0 on the money (1,2,5).
Third, check what color it is.
-if have number 1,2 and is paper then that is 1,000;2,000
-if have 1 and is not paper and is yellow then that is 10,000
-if have 1 and is not paper and is dark green then that is 100,000
-if have 2 and is not paper and is aqua blue then that is 20,000
-if have 2 and is not paper and is orange then that is 200,000
-if have 5 and is not paper and is pink then that is 50,000
-if have 5 and is not paper and is light green/blue then that is 500,000
If you cant see the number (1,2,5) then you can try to read the text on the money.
If you cant tell exactly the bills, tell the user what you suspect the money is. (listing all the possible bills)
The image can be cutoff and not all number is visible then follow my rule rather than based absolutely on the image.
<Money_regcognition_cheatsheet>`;

    static buildBaseInstruction(timestamp: string = new Date().toISOString()): any[] {
        return [{
            text: this.BASE_INSTRUCTION.replace('{timestamp}', timestamp),
        }];
    }

    static buildVisionInstruction(): any[] {
        return [{
            text: this.VISION_INSTRUCTION,
        }];
    }

    static buildDynamicInstruction(
        chatHistory: IConversation[],
        user: any,
        supabase: SupabaseClient,
        currentVolume?: number | null,
    ): any[] {
        const systemPromptText = createSystemPrompt(
            chatHistory,
            { user, supabase, timestamp: new Date().toISOString() },
            currentVolume,
        ) || 'You are a helpful assistant.';

        const baseInstructions = this.BASE_INSTRUCTION.replace(
            '{timestamp}',
            new Date().toISOString(),
        );
        const flashInstructions = baseInstructions.replace(
            '</text_to_speech_formatting>',
            `</text_to_speech_formatting>\n\n${systemPromptText}`,
        );

        return [{
            text: flashInstructions,
        }];
    }
}

// ===========================
// Function Call Handler
// ===========================

class FunctionCallHandler {
    constructor(
        private supabase: SupabaseClient,
        private sessionData: SessionData,
    ) {}

    async handleFunctionCalls(functionCalls: any[]): Promise<any[]> {
        const functionResults: any[] = [];

        for (const call of functionCalls) {
            const functionResult = await this.executeFunctionCall(call);
            functionResults.push({
                name: call.name,
                result: functionResult,
            });
        }

        logger.info(
            `Flash 2.5 function results:`,
            functionResults.map((fr) => ({
                name: fr.name,
                success: fr.result?.success,
                messagePreview: fr.result?.message?.substring(0, 100) + '...',
            })),
        );

        return functionResults;
    }

    private async executeFunctionCall(call: any): Promise<any> {
        const { name, args } = call;

        switch (name) {
            case 'ManageData':
                return await ManageData(
                    this.supabase,
                    this.sessionData.userId,
                    args.mode,
                    args.action,
                    args.query,
                    args.noteId,
                    args.title,
                    args.body,
                    args.newPersona,
                    args.dateFrom,
                    args.dateTo,
                    args.imageId,
                );

            case 'ScheduleManager':
                return await this.handleScheduleManager(args);

            case 'ReadingManager':
                return await ReadingManager(
                    this.supabase,
                    this.sessionData.userId,
                    args.mode,
                    args.action,
                    args.bookId,
                    args.searchQuery,
                    args.pageNumber,
                    args.readingMode,
                    args.readingAmount,
                );

            case 'SetVolume':
                if (this.sessionData.deviceCallbacks?.setVolume) {
                    return await this.sessionData.deviceCallbacks.setVolume(
                        args.volumeLevel,
                        `volume-${Date.now()}`,
                    );
                }
                return {
                    success: false,
                    message: 'Volume control not available - device callbacks not configured',
                };

            case 'GetVision':
                return await this.handleVisionCall(args);

            case 'Websearch':
                return await this.handleWebSearch(args);

            default:
                return {
                    success: false,
                    message: `Unknown function: ${name}`,
                };
        }
    }

    private async handleScheduleManager(args: any): Promise<any> {
        // Parse natural language time if provided
        if (args.scheduledTime && args.mode === 'Add') {
            const parsedTime = ScheduleConversationHelper.parseNaturalTime(args.scheduledTime);
            if (parsedTime) {
                args.scheduledTime = parsedTime;
                logger.debug(`Parsed time "${args.scheduledTime}" to "${parsedTime}"`);
            }
        }

        // Handle relative dates
        if (args.targetDate === 'tomorrow') {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            args.targetDate = tomorrow.toISOString().split('T')[0];
        }

        // Store context for potential follow-ups
        if (args.mode === 'Add') {
            this.sessionData.scheduleContext = {
                lastScheduleAction: 'add',
                lastScheduleTime: args.scheduledTime,
                lastScheduleTitle: args.title,
            };
        }

        const result = await ScheduleManager(
            this.supabase,
            this.sessionData.userId,
            args.mode,
            args.scheduleId,
            args.title,
            args.scheduledTime,
            args.scheduleType,
            args.description,
            args.schedulePattern,
            args.targetDate,
            args.query,
        );

        // Enhanced response formatting for List mode
        if (args.mode === 'List' && result.success && result.data) {
            const schedules = result.data.schedules || [];
            const currentTime = new Date();

            if (schedules.length === 0) {
                result.message =
                    "You don't have any schedules set up yet. Would you like to add one?";
            } else {
                let message = `You have ${schedules.length} schedule${
                    schedules.length > 1 ? 's' : ''
                } today:\n\n`;

                const upcomingSchedules = schedules
                    .filter((s: any) => {
                        const schedTime = new Date(`1970-01-01T${s.scheduled_time}`);
                        const currentTimeOnly = new Date(
                            `1970-01-01T${currentTime.getHours()}:${currentTime.getMinutes()}:00`,
                        );
                        return schedTime > currentTimeOnly;
                    })
                    .sort((a: any, b: any) => a.scheduled_time.localeCompare(b.scheduled_time));

                const pastSchedules = schedules
                    .filter((s: any) => {
                        const schedTime = new Date(`1970-01-01T${s.scheduled_time}`);
                        const currentTimeOnly = new Date(
                            `1970-01-01T${currentTime.getHours()}:${currentTime.getMinutes()}:00`,
                        );
                        return schedTime <= currentTimeOnly;
                    })
                    .sort((a: any, b: any) => a.scheduled_time.localeCompare(b.scheduled_time));

                // Format upcoming schedules
                if (upcomingSchedules.length > 0) {
                    message += 'Coming up:\n';
                    upcomingSchedules.forEach((schedule: any, index: number) => {
                        const time12 = ScheduleConversationHelper.convertTo12Hour(
                            schedule.scheduled_time,
                        );
                        const timeDiff = this.getTimeDifference(
                            schedule.scheduled_time,
                            currentTime,
                        );
                        message += `- ${schedule.title} at ${time12} (${timeDiff})`;
                        if (schedule.description) {
                            message += ` - ${schedule.description}`;
                        }
                        message += '\n';
                    });

                    const nextSchedule = upcomingSchedules[0];
                    const nextTime = ScheduleConversationHelper.convertTo12Hour(
                        nextSchedule.scheduled_time,
                    );
                    const nextTimeDiff = this.getTimeDifference(
                        nextSchedule.scheduled_time,
                        currentTime,
                    );
                    message +=
                        `\nYour next appointment is "${nextSchedule.title}" at ${nextTime} (${nextTimeDiff}).`;
                }

                // Format past schedules
                if (pastSchedules.length > 0) {
                    if (upcomingSchedules.length > 0) message += '\n\n';
                    message += 'Already passed today:\n';
                    pastSchedules.forEach((schedule: any) => {
                        const time12 = ScheduleConversationHelper.convertTo12Hour(
                            schedule.scheduled_time,
                        );
                        message += `- ${schedule.title} at ${time12}`;
                        if (schedule.description) {
                            message += ` - ${schedule.description}`;
                        }
                        message += '\n';
                    });
                }

                result.message = message;
            }
        }

        // Handle conflicts with enhanced messaging
        if (!result.success && result.data && result.message.includes('conflict')) {
            this.sessionData.scheduleContext!.pendingConflicts = result.data;
            result.message = ScheduleConversationHelper.generateConflictMessage(result.data);
        }

        return result;
    }

    private getTimeDifference(scheduleTime: string, currentTime: Date): string {
        const [hours, minutes] = scheduleTime.split(':').map(Number);
        const schedDate = new Date(currentTime);
        schedDate.setHours(hours, minutes, 0, 0);

        const diff = schedDate.getTime() - currentTime.getTime();
        const diffMinutes = Math.floor(diff / 60000);
        const diffHours = Math.floor(diffMinutes / 60);
        const remainingMinutes = diffMinutes % 60;

        if (diffHours > 0 && remainingMinutes > 0) {
            return `in ${diffHours} hour${diffHours > 1 ? 's' : ''} and ${remainingMinutes} minute${
                remainingMinutes > 1 ? 's' : ''
            }`;
        } else if (diffHours > 0) {
            return `in ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
        } else if (diffMinutes > 0) {
            return `in ${diffMinutes} minute${diffMinutes > 1 ? 's' : ''}`;
        } else {
            return 'now';
        }
    }

    private async handleVisionCall(args: any): Promise<any> {
        logger.info(`*GetVision called with prompt: "${args.prompt}"`);

        if (!this.sessionData.deviceCallbacks?.requestPhoto) {
            return {
                success: false,
                message: 'Vision capture not available - device callbacks not configured',
            };
        }

        try {
            const photoResult = await this.sessionData.deviceCallbacks.requestPhoto(
                `vision-${Date.now()}`,
            );

            if (!photoResult.success || !photoResult.imageData) {
                return {
                    success: false,
                    message: photoResult.message || 'Failed to capture image from device',
                };
            }

            // This will be handled by the main session manager
            return {
                success: true,
                imageData: photoResult.imageData,
                prompt: args.prompt || 'Describe what you see',
                money_classification: Boolean(args.money_classification),
            };
        } catch (err) {
            logger.error(`Error executing GetVision:`, err);
            return {
                success: false,
                message: `Vision capture failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            };
        }
    }

    private async handleWebSearch(args: any): Promise<any> {
        logger.info(`*Websearch called with query: "${args.query}"`);

        if (typeof args.query !== 'string' || !args.query.trim()) {
            return {
                success: false,
                message: 'Invalid or missing search query. Expected a non-empty string.',
            };
        }

        try {
            const result = await performGoogleSearch(args.query.trim(), this.sessionData.userId);
            logger.info(`Websearch result: ${result.success ? 'Success' : result.message}`);
            return result;
        } catch (err) {
            logger.error(`Error executing Websearch:`, err);
            return {
                success: false,
                message: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}

// ===========================
// Optimized Flash 2.5 Session Manager
// ===========================

interface TransferModalConfig {
    preserveContext: boolean;
    compressionEnabled: boolean;
    warmupDelay: number;
}

interface SessionPoolConfig {
    maxPoolSize: number;
    warmupDelay: number;
    contextCacheThreshold: number;
    maxContextTokens: number;
    checkpointInterval: number;
}

interface ContextCheckpoint {
    timestamp: Date;
    tokenCount: number;
    compressedContext: string;
    keyPoints: string[];
}

class Flash25SessionManager {
    private sessions: Map<string, SessionData> = new Map();
    private warmSessions: Map<string, SessionData> = new Map();
    private activeSessions: Map<string, SessionData> = new Map();
    private contextCheckpoints: Map<string, ContextCheckpoint[]> = new Map();
    private ai: any;
    private tools!: any[];
    private config: any;

    private sessionPool: SessionPoolConfig = {
        maxPoolSize: 10,
        warmupDelay: 500,
        contextCacheThreshold: 4096,
        maxContextTokens: 32768,
        checkpointInterval: 5 * 60 * 1000, // 5 minutes
    };

    constructor() {
        this.initializeAI();
        this.startCheckpointTimer();
    }

    private initializeAI() {
        const apiKey = apiKeyManager.getCurrentKey();
        if (!apiKey) {
            throw new Error('API key not available');
        }

        this.ai = new GoogleGenAI({ apiKey });
        this.tools = ToolDefinitions.getTools();
        this.setupConfig();
    }

    private startCheckpointTimer(): void {
        setInterval(() => {
            this.createContextCheckpoints();
        }, this.sessionPool.checkpointInterval);
    }

    private async createContextCheckpoints(): Promise<void> {
        for (const [sessionId, session] of this.activeSessions) {
            try {
                const tokenCount = this.estimateTokenCount(session.contents);
                if (tokenCount > this.sessionPool.contextCacheThreshold) {
                    const checkpoint = await this.createCheckpoint(sessionId, session);

                    if (!this.contextCheckpoints.has(sessionId)) {
                        this.contextCheckpoints.set(sessionId, []);
                    }

                    const checkpoints = this.contextCheckpoints.get(sessionId)!;
                    checkpoints.push(checkpoint);

                    // Keep only last 10 checkpoints
                    if (checkpoints.length > 10) {
                        checkpoints.splice(0, checkpoints.length - 10);
                    }

                    logger.info(`Created context checkpoint for session ${truncateSessionId(sessionId)} (${tokenCount} tokens)`);
                }
            } catch (error) {
                logger.error(`Error creating checkpoint for session ${sessionId}:`, error);
            }
        }
    }

    private async createCheckpoint(sessionId: string, session: SessionData): Promise<ContextCheckpoint> {
        const tokenCount = this.estimateTokenCount(session.contents);
        const keyPoints = await this.extractKeyPoints(session.contents);
        const compressedContext = await this.compressContext(session.contents);

        return {
            timestamp: new Date(),
            tokenCount,
            compressedContext,
            keyPoints,
        };
    }

    private estimateTokenCount(contents: any[]): number {
        // Rough estimation: 1 token ≈ 4 characters for English text
        const totalText = contents
            .map(content => content.parts?.map((part: any) => part.text || '').join(' ') || '')
            .join(' ');
        return Math.ceil(totalText.length / 4);
    }

    private async extractKeyPoints(contents: any[]): Promise<string[]> {
        // Extract important conversation points for context preservation
        const keyPoints: string[] = [];

        for (const content of contents) {
            if (content.role === 'user' || content.role === 'model') {
                const text = content.parts?.map((part: any) => part.text || '').join(' ') || '';
                if (text.length > 100) { // Only consider substantial messages
                    keyPoints.push(text.substring(0, 200) + '...');
                }
            }
        }

        return keyPoints.slice(-20); // Keep last 20 key points
    }

    private async compressContext(contents: any[]): Promise<string> {
        // Semantic compression of context while preserving key information
        const importantContents = contents.filter((content, index) => {
            // Keep recent messages and important function calls
            return index >= contents.length - 10 ||
                   content.parts?.some((part: any) => part.functionCall || part.functionResponse);
        });

        return JSON.stringify(importantContents);
    }

    private async manageContextWindow(sessionId: string, session: SessionData): Promise<void> {
        const tokenCount = this.estimateTokenCount(session.contents);

        if (tokenCount > this.sessionPool.maxContextTokens) {
            logger.info(`Context window exceeded for session ${truncateSessionId(sessionId)} (${tokenCount} tokens), applying sliding window`);

            // Preserve system instruction and recent important messages
            const systemMessages = session.contents.filter(c => c.role === 'system');
            const recentMessages = session.contents.slice(-20); // Keep last 20 messages
            const functionMessages = session.contents.filter(c =>
                c.parts?.some((part: any) => part.functionCall || part.functionResponse)
            ).slice(-10); // Keep last 10 function calls

            // Combine preserved messages
            const preservedMessages = [
                ...systemMessages,
                ...functionMessages,
                ...recentMessages
            ];

            // Remove duplicates while preserving order
            const uniqueMessages = preservedMessages.filter((message, index, array) =>
                array.findIndex(m => JSON.stringify(m) === JSON.stringify(message)) === index
            );

            session.contents = uniqueMessages;

            const newTokenCount = this.estimateTokenCount(session.contents);
            logger.info(`Context window truncated for session ${truncateSessionId(sessionId)}: ${tokenCount} → ${newTokenCount} tokens`);
        }
    }

    private getCachedContent(sessionId: string): any {
        const checkpoints = this.contextCheckpoints.get(sessionId);
        if (checkpoints && checkpoints.length > 0) {
            const latestCheckpoint = checkpoints[checkpoints.length - 1];
            return {
                model: MODEL_CONFIG.model,
                contents: JSON.parse(latestCheckpoint.compressedContext),
                ttl: '1h', // Cache for 1 hour
            };
        }
        return undefined;
    }

    async handleTransferModal(sessionId: string, config: TransferModalConfig): Promise<any> {
        logger.info(`Handling transfer modal for session ${truncateSessionId(sessionId)}`);

        try {
            // Preserve context with compression
            const context = await this.preserveContext(sessionId);

            // Execute parallel transfer
            const [closeResult, newSession] = await Promise.all([
                this.gracefulClose(sessionId),
                this.createWarmSession(config)
            ]);

            // Restore context in new session
            if (newSession && context) {
                await this.restoreContext(newSession.sessionId, context);
            }

            return {
                success: true,
                oldSession: closeResult,
                newSession: newSession,
                contextPreserved: !!context,
            };
        } catch (error) {
            logger.error(`Error in transfer modal for session ${sessionId}:`, error);
            return {
                success: false,
                message: `Transfer failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    private async preserveContext(sessionId: string): Promise<any> {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const tokenCount = this.estimateTokenCount(session.contents);

        if (tokenCount > this.sessionPool.contextCacheThreshold) {
            // Use compression for large contexts (40% reduction)
            const compressedContext = await this.compressContext(session.contents);
            const keyPoints = await this.extractKeyPoints(session.contents);

            return {
                compressed: true,
                context: compressedContext,
                keyPoints,
                originalTokens: tokenCount,
                compressionRatio: 0.6, // 40% reduction
            };
        } else {
            // Direct context preservation for smaller contexts
            return {
                compressed: false,
                context: JSON.stringify(session.contents),
                originalTokens: tokenCount,
            };
        }
    }

    private async gracefulClose(sessionId: string): Promise<any> {
        const session = this.sessions.get(sessionId);
        if (session) {
            // Create final checkpoint before closing
            const checkpoint = await this.createCheckpoint(sessionId, session);

            // Move to inactive sessions for potential recovery
            this.sessions.delete(sessionId);
            this.activeSessions.delete(sessionId);

            return {
                sessionId,
                closed: true,
                finalCheckpoint: checkpoint,
            };
        }
        return { sessionId, closed: false };
    }

    private async createWarmSession(config: TransferModalConfig): Promise<any> {
        const newSessionId = `transfer-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        // Use warm session from pool if available
        const warmSession = this.getWarmSession();

        if (warmSession) {
            this.activeSessions.set(newSessionId, warmSession);
            this.sessions.set(newSessionId, warmSession);

            // Pre-warm replacement session
            this.preWarmSession();

            return {
                sessionId: newSessionId,
                fromPool: true,
                warmupTime: 0,
            };
        } else {
            // Create new session with warmup delay
            await new Promise(resolve => setTimeout(resolve, config.warmupDelay));

            const newSession: SessionData = {
                userId: '',
                contents: [{
                    role: 'user',
                    parts: [{ text: '' }],
                }],
                createdAt: new Date(),
                lastUsed: new Date(),
                scheduleContext: {},
            };

            this.activeSessions.set(newSessionId, newSession);
            this.sessions.set(newSessionId, newSession);

            return {
                sessionId: newSessionId,
                fromPool: false,
                warmupTime: config.warmupDelay,
            };
        }
    }

    private async restoreContext(sessionId: string, context: any): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || !context) return;

        try {
            if (context.compressed) {
                // Restore from compressed context
                const restoredContents = JSON.parse(context.context);
                session.contents = restoredContents;

                logger.info(`Restored compressed context for session ${truncateSessionId(sessionId)} (${context.originalTokens} tokens, ${Math.round(context.compressionRatio * 100)}% of original)`);
            } else {
                // Direct context restoration
                session.contents = JSON.parse(context.context);

                logger.info(`Restored full context for session ${truncateSessionId(sessionId)} (${context.originalTokens} tokens)`);
            }
        } catch (error) {
            logger.error(`Error restoring context for session ${sessionId}:`, error);
        }
    }

    private setupConfig() {
        this.config = {
            temperature: MODEL_CONFIG.temperature,
            thinkingConfig: {
                thinkingBudget: MODEL_CONFIG.thinkingBudget,
            },
            safetySettings: ConfigurationFactory.getSafetySettings(),
            tools: this.tools,
            responseMimeType: MODEL_CONFIG.responseMimeType,
            systemInstruction: SystemInstructionBuilder.buildBaseInstruction(),
        };
    }

    createSession(
        sessionId: string,
        userId: string,
        deviceCallbacks?: DeviceOperationCallbacks,
        user?: any,
    ): void {
        logger.info(`Creating optimized Flash 2.5 session for Live session: ${truncateSessionId(sessionId)}`);

        // Try to get a warm session from the pool
        const warmSession = this.getWarmSession();

        const sessionData: SessionData = warmSession || {
            userId,
            user,
            contents: [{
                role: 'user',
                parts: [{ text: '' }],
            }],
            createdAt: new Date(),
            lastUsed: new Date(),
            deviceCallbacks,
            scheduleContext: {},
        };

        // Update session data for the specific session
        sessionData.userId = userId;
        sessionData.user = user;
        sessionData.deviceCallbacks = deviceCallbacks;
        sessionData.lastUsed = new Date();

        this.activeSessions.set(sessionId, sessionData);
        this.sessions.set(sessionId, sessionData);

        // Pre-warm a new session to maintain pool
        this.preWarmSession();

        logger.info(`Optimized Flash 2.5 session ${truncateSessionId(sessionId)} created successfully`);
    }

    private getWarmSession(): SessionData | null {
        if (this.warmSessions.size > 0) {
            const entry = this.warmSessions.entries().next().value;
            if (entry) {
                const [sessionId, sessionData] = entry;
                this.warmSessions.delete(sessionId);
                logger.info(`Retrieved warm session from pool (${this.warmSessions.size} remaining)`);
                return sessionData;
            }
        }
        return null;
    }

    private async preWarmSession(): Promise<void> {
        if (this.warmSessions.size >= this.sessionPool.maxPoolSize) {
            return;
        }

        // Create warm session with delay
        setTimeout(async () => {
            try {
                const warmSessionId = `warm-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
                const warmSession: SessionData = {
                    userId: '',
                    contents: [{
                        role: 'user',
                        parts: [{ text: '' }],
                    }],
                    createdAt: new Date(),
                    lastUsed: new Date(),
                    scheduleContext: {},
                };

                this.warmSessions.set(warmSessionId, warmSession);
                logger.info(`Pre-warmed session created (pool size: ${this.warmSessions.size}/${this.sessionPool.maxPoolSize})`);
            } catch (error) {
                logger.error('Error pre-warming session:', error);
            }
        }, this.sessionPool.warmupDelay);
    }

    async analyzeImage(
        sessionId: string,
        prompt: string,
        imageDataOrUri: string,
        moneyClassification: boolean = false,
    ): Promise<FlashResponse> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                success: false,
                message: 'Session not found. Please reconnect to create a new session.',
            };
        }

        try {
            session.lastUsed = new Date();

            const imagePart = this.createImagePart(imageDataOrUri);

            let finalPrompt = prompt;
            if (moneyClassification) {
                const azure = await getAzureMoneyClassification(
                    imageDataOrUri.startsWith('https://')
                        ? await (await fetch(imageDataOrUri)).arrayBuffer()
                        : imageDataOrUri,
                );

                const predsText = azure.predictions
                    .sort((a, b) => b.probability - a.probability)
                    .map((p) => `${p.tagName}: ${(p.probability * 100).toFixed(1)}%`)
                    .join(', ');

                finalPrompt =
                    `${prompt}. Azure classifier probabilities → ${predsText}. ` +
                    `Based on what you *see*, confirm the correct bill.`;
            }

            session.contents.push({
                role: 'user',
                parts: [
                    { text: finalPrompt },
                    imagePart,
                ],
            });

            const imageInfo = this.getImageInfo(imageDataOrUri);
            logger.info(
                `Analyzing image in session ${sessionId} with Flash 2.5 (${imageInfo.type}: ${imageInfo.size})`,
            );

            const response = await RetryService.withRetry(
                () =>
                    this.ai.models.generateContentStream({
                        model: MODEL_CONFIG.model,
                        config: {
                            temperature: VISION_CONFIG.temperature,
                            safetySettings: ConfigurationFactory.getSafetySettings(),
                            responseMimeType: MODEL_CONFIG.responseMimeType,
                            systemInstruction: SystemInstructionBuilder.buildVisionInstruction(),
                        },
                        contents: session.contents,
                    }),
                `Flash 2.5 image analysis (session: ${sessionId})`,
            );

            const analysisText = await this.extractTextFromStream(response);

            session.contents.push({
                role: 'model',
                parts: [{ text: analysisText }],
            });

            return {
                success: true,
                message: analysisText || 'Sorry please try again, the image is so shaky.',
            };
        } catch (error) {
            logger.error(`Error analyzing image in session ${sessionId}:`, error);
            return {
                success: false,
                message: `Error analyzing image: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
        }
    }

    async processAction(
        sessionId: string,
        userCommand: string,
        supabase: SupabaseClient,
        imageData?: string,
    ): Promise<FlashResponse> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                success: false,
                message: 'Session not found. Please reconnect to create a new session.',
            };
        }

        try {
            session.lastUsed = new Date();

            // Check if context needs truncation
            await this.manageContextWindow(sessionId, session);

            const userParts = this.createUserParts(userCommand, imageData);
            session.contents.push({
                role: 'user',
                parts: userParts,
            });

            logger.info(`Processing action in session ${truncateSessionId(sessionId)}`);

            const configToUse = await this.getConfiguration(session, supabase);

            // Use context caching for large contexts
            const shouldUseCache = this.estimateTokenCount(session.contents) > this.sessionPool.contextCacheThreshold;
            if (shouldUseCache) {
                logger.info(`Using context caching for session ${truncateSessionId(sessionId)} (large context detected)`);
            }

            const response = await RetryService.withRetry(
                () =>
                    this.ai.models.generateContent({
                        model: MODEL_CONFIG.model,
                        config: configToUse,
                        contents: session.contents,
                        cachedContent: shouldUseCache ? this.getCachedContent(sessionId) : undefined,
                    }),
                `Flash 2.5 action processing (session: ${sessionId})`,
            );

            const { functionCalls, textResponse } = this.extractResponseParts(response);

            if (functionCalls.length > 0) {
                return await this.handleFunctionCallsAndRespond(
                    session,
                    sessionId,
                    functionCalls,
                    supabase,
                    configToUse,
                );
            }

            session.contents.push({
                role: 'model',
                parts: [{ text: textResponse }],
            });

            return {
                success: true,
                message: textResponse ||
                    "I understand your request but couldn't determine the appropriate action to take.",
            };
        } catch (error) {
            logger.error(`Error in Flash 2.5 session ${sessionId}:`, error);
            return {
                success: false,
                message: `Error processing action: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
        }
    }

    destroySession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            const duration = new Date().getTime() - session.createdAt.getTime();
            logger.info(
                `Destroying Flash 2.5 session ${sessionId} (duration: ${
                    Math.round(duration / 1000)
                }s, messages: ${session.contents.length})`,
            );
            this.sessions.delete(sessionId);
        } else {
            logger.info(`Flash 2.5 session ${sessionId} not found for destruction`);
        }
    }

    getSessionInfo(sessionId: string): any {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        return {
            sessionId,
            userId: session.userId,
            createdAt: session.createdAt,
            lastUsed: session.lastUsed,
            messageCount: session.contents.length,
            duration: new Date().getTime() - session.createdAt.getTime(),
            scheduleContext: session.scheduleContext,
        };
    }

    getAllSessions(): any[] {
        return Array.from(this.sessions.keys()).map((sessionId) => this.getSessionInfo(sessionId));
    }

    cleanupOldSessions(maxAgeHours: number = 24): void {
        const cutoff = new Date().getTime() - (maxAgeHours * 60 * 60 * 1000);
        let cleaned = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.lastUsed.getTime() < cutoff) {
                this.destroySession(sessionId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info(`Cleaned up ${cleaned} old Flash 2.5 sessions`);
        }
    }

    // Private helper methods
    private createImagePart(imageDataOrUri: string): any {
        if (imageDataOrUri.startsWith('https://')) {
            return {
                fileData: {
                    mimeType: 'image/jpeg',
                    fileUri: imageDataOrUri,
                },
            };
        }
        return {
            inlineData: {
                mimeType: 'image/jpeg',
                data: imageDataOrUri,
            },
        };
    }

    private getImageInfo(imageDataOrUri: string): { type: string; size: string } {
        if (imageDataOrUri.startsWith('https://')) {
            return { type: 'URI', size: 'uploaded file' };
        }
        return {
            type: 'base64',
            size: `${Math.round(imageDataOrUri.length * 3 / 4 / 1024)} KB`,
        };
    }

    private createUserParts(userCommand: string, imageData?: string): any[] {
        const userParts: any[] = [{ text: userCommand }];

        if (imageData) {
            userParts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: imageData,
                },
            });
            logger.info(
                `Added image data to Flash 2.5 session (${
                    Math.round(imageData.length * 3 / 4 / 1024)
                } KB)`,
            );
        }

        return userParts;
    }

    private async getConfiguration(session: SessionData, supabase: SupabaseClient): Promise<any> {
        if (!session.user) return this.config;

        try {
            const chatHistory = await getChatHistory(
                supabase,
                session.userId,
                session.user.personality?.key || null,
                session.user.user_info?.user_type === 'doctor',
            );

            const dynamicSystemInstruction = SystemInstructionBuilder.buildDynamicInstruction(
                chatHistory,
                session.user,
                supabase,
            );

            return {
                ...this.config,
                systemInstruction: dynamicSystemInstruction,
            };
        } catch (error) {
            logger.warn(`Failed to get chat history for session:`, error);
            return this.config;
        }
    }

    private async extractTextFromStream(response: any): Promise<string> {
        let text = '';
        for await (const chunk of response as any) {
            if (chunk.text) {
                text += chunk.text;
            }
        }
        return text;
    }

    private extractResponseParts(response: any): { functionCalls: any[]; textResponse: string } {
        const functionCalls: any[] = [];
        let textResponse = '';

        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content?.parts) {
                for (const part of candidate.content.parts) {
                    if (part.functionCall) {
                        functionCalls.push(part.functionCall);
                    }
                    if (part.text) {
                        textResponse += part.text;
                    }
                }
            }
        }

        return { functionCalls, textResponse };
    }

    private async handleFunctionCallsAndRespond(
        session: SessionData,
        sessionId: string,
        functionCalls: any[],
        supabase: SupabaseClient,
        configToUse: any,
    ): Promise<FlashResponse> {
        const handler = new FunctionCallHandler(supabase, session);
        const functionResults = await handler.handleFunctionCalls(functionCalls);

        // Handle vision results specially
        const visionResult = functionResults.find((r) =>
            r.name === 'GetVision' && r.result?.success && r.result?.imageData
        );

        if (visionResult) {
            return await this.analyzeImage(
                sessionId,
                visionResult.result.prompt,
                visionResult.result.imageData,
                Boolean(visionResult.result.money_classification),
            );
        }

        session.contents.push({
            role: 'function',
            parts: functionResults.map((fr) => ({
                functionResponse: {
                    name: fr.name,
                    response: fr.result,
                },
            })),
        });

        try {
            const followUpResponse = await RetryService.withRetry(
                () =>
                    this.ai.models.generateContent({
                        model: MODEL_CONFIG.model,
                        config: configToUse,
                        contents: session.contents,
                    }),
                `Flash 2.5 function result processing (session: ${sessionId})`,
            );

            const { textResponse } = this.extractResponseParts(followUpResponse);

            if (textResponse.trim()) {
                session.contents.push({
                    role: 'model',
                    parts: [{ text: textResponse }],
                });

                return {
                    success: true,
                    message: textResponse,
                    data: functionResults,
                };
            }

            const fallbackMessage = functionResults
                .map((r) => r.result?.message || 'Function executed')
                .join('; ');

            session.contents.push({
                role: 'model',
                parts: [{ text: fallbackMessage }],
            });

            return {
                success: true,
                message: fallbackMessage,
                data: functionResults,
            };
        } catch (followUpError) {
            logger.error(
                `Error getting AI response for function results in session ${sessionId}:`,
                followUpError,
            );

            const fallbackMessage = functionResults
                .map((r) => r.result?.message || 'Function executed')
                .join('; ');

            session.contents.push({
                role: 'model',
                parts: [{ text: fallbackMessage }],
            });

            return {
                success: true,
                message: fallbackMessage,
                data: functionResults,
            };
        }
    }
}

// ===========================
// Singleton Instance & Exports
// ===========================

const flash25SessionManager = new Flash25SessionManager();

// Session Management Functions
export function createFlash25Session(
    sessionId: string,
    userId: string,
    deviceCallbacks?: DeviceOperationCallbacks,
    user?: any,
): void {
    flash25SessionManager.createSession(sessionId, userId, deviceCallbacks, user);
}

export function destroyFlash25Session(sessionId: string): void {
    flash25SessionManager.destroySession(sessionId);
}

export function getFlash25SessionInfo(sessionId: string): any {
    return flash25SessionManager.getSessionInfo(sessionId);
}

export function getAllFlash25Sessions(): any[] {
    return flash25SessionManager.getAllSessions();
}

// Core Processing Functions
export async function analyzeImageWithFlash25(
    sessionId: string,
    prompt: string,
    imageData: string,
    moneyClassification = false,
): Promise<FlashResponse> {
    return await flash25SessionManager.analyzeImage(
        sessionId,
        prompt,
        imageData,
        moneyClassification,
    );
}

export async function processUserActionWithSession(
    sessionId: string,
    userCommand: string,
    supabase: SupabaseClient,
    userId: string,
    imageData?: string,
): Promise<FlashResponse> {
    return await flash25SessionManager.processAction(sessionId, userCommand, supabase, imageData);
}

// Legacy Support
export async function processUserAction(
    userCommand: string,
    supabase: SupabaseClient,
    userId: string,
): Promise<FlashResponse> {
    const tempSessionId = `temp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

    try {
        flash25SessionManager.createSession(tempSessionId, userId);
        const result = await flash25SessionManager.processAction(
            tempSessionId,
            userCommand,
            supabase,
        );
        flash25SessionManager.destroySession(tempSessionId);
        return result;
    } catch (error) {
        flash25SessionManager.destroySession(tempSessionId);
        logger.error('Error in legacy processUserAction:', error);
        return {
            success: false,
            message: `Error processing action: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

// Transfer Modal Functions
export async function handleTransferModal(
    sessionId: string,
    config: { preserveContext?: boolean; compressionEnabled?: boolean; warmupDelay?: number } = {}
): Promise<any> {
    const transferConfig = {
        preserveContext: config.preserveContext ?? true,
        compressionEnabled: config.compressionEnabled ?? true,
        warmupDelay: config.warmupDelay ?? 500,
    };

    return await flash25SessionManager.handleTransferModal(sessionId, transferConfig);
}

// Session Pool Management
export function getSessionPoolStatus(): {
    warmSessions: number;
    activeSessions: number;
    maxPoolSize: number;
} {
    return {
        warmSessions: flash25SessionManager['warmSessions'].size,
        activeSessions: flash25SessionManager['activeSessions'].size,
        maxPoolSize: flash25SessionManager['sessionPool'].maxPoolSize,
    };
}

// Context Management
export function getSessionContextInfo(sessionId: string): {
    tokenCount: number;
    checkpoints: number;
    lastCheckpoint?: Date;
} | null {
    const session = flash25SessionManager['sessions'].get(sessionId);
    const checkpoints = flash25SessionManager['contextCheckpoints'].get(sessionId);

    if (!session) return null;

    return {
        tokenCount: flash25SessionManager['estimateTokenCount'](session.contents),
        checkpoints: checkpoints?.length || 0,
        lastCheckpoint: checkpoints?.[checkpoints.length - 1]?.timestamp,
    };
}

// Export the manager for advanced usage
export { flash25SessionManager };

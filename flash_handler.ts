import { GoogleGenAI, Type } from "npm:@google/genai";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { apiKeyManager } from "./config.ts";
import { ManageData } from "./data_manager.ts";
import { ScheduleManager } from "./schedule_manager.ts";
import { ReadingManager } from "./reading_handler.ts";

/**
 * Device operation callbacks interface
 */
export interface DeviceOperationCallbacks {
    requestVision: (prompt: string, callId: string) => Promise<{ success: boolean; message: string }>;
    setVolume: (volumeLevel: number, callId: string) => Promise<{ success: boolean; message: string }>;
}

/**
 * Flash 2.5 Session Manager
 * Maintains persistent chat sessions with full history for each Live Gemini connection
 */
class Flash25SessionManager {
    private sessions: Map<string, any> = new Map();
    private ai: any;
    private tools: any[];
    private config: any;

    constructor() {
        this.initializeAI();
    }

    private initializeAI() {
        const apiKey = apiKeyManager.getCurrentKey();
        if (!apiKey) {
            throw new Error("API key not available");
        }

        this.ai = new GoogleGenAI({ apiKey });
        this.setupTools();
        this.setupConfig();
    }

    private setupTools() {
        this.tools = [
            {
                functionDeclarations: [
                    {
                        name: "ManageData",
                        description: "Unified modal interface for managing persona (AI memory) and notes (user data). First select mode ('Persona' or 'Notes'), then action. Use for all note-taking and persona management tasks.",
                        parameters: {
                            type: Type.OBJECT,
                            required: ["mode", "action"],
                            properties: {
                                mode: {
                                    type: Type.STRING,
                                    description: "Data type to manage: 'Persona' (AI's knowledge about user preferences) or 'Notes' (user's personal notes and reminders)."
                                },
                                action: {
                                    type: Type.STRING,
                                    description: "Action to perform: 'Search' (retrieve/find data), 'Edit' (add/update data), or 'Delete' (remove data)."
                                },
                                query: {
                                    type: Type.STRING,
                                    description: "Search keywords for Notes Search (e.g., 'shopping list', 'meeting notes')."
                                },
                                noteId: {
                                    type: Type.STRING,
                                    description: "Note ID for Notes Edit/Delete of existing notes (get from Notes Search first)."
                                },
                                title: {
                                    type: Type.STRING,
                                    description: "Note title for Notes Edit (optional, auto-generated if not provided)."
                                },
                                body: {
                                    type: Type.STRING,
                                    description: "Note content for Notes Edit (required when adding new note)."
                                },
                                newPersona: {
                                    type: Type.STRING,
                                    description: "Complete persona description for Persona Edit (e.g., 'likes pizza, dislikes loud noises, prefers morning conversations')."
                                },
                                dateFrom: {
                                    type: Type.STRING,
                                    description: "Start date for Notes Search (optional, ISO format: '2024-01-01T00:00:00Z')."
                                },
                                dateTo: {
                                    type: Type.STRING,
                                    description: "End date for Notes Search (optional, ISO format: '2024-12-31T23:59:59Z')."
                                },
                                imageId: {
                                    type: Type.STRING,
                                    description: "Image ID for Notes Edit (optional, if note relates to captured image)."
                                }
                            },
                        },
                    },
                    {
                        name: "ScheduleManager",
                        description: "Unified modal interface for schedule and reminder management. First select mode ('List', 'Add', 'Update', 'Delete', 'Search', 'CheckConflict'), then provide required parameters. Use for all scheduling tasks.",
                        parameters: {
                            type: Type.OBJECT,
                            required: ["mode"],
                            properties: {
                                mode: {
                                    type: Type.STRING,
                                    description: "Schedule operation mode: 'List' (get all schedules with current time then read all the schedules aloud), 'Add' (create new schedule), 'Update' (modify existing), 'Delete' (remove schedule), 'Search' (find by title/description), 'CheckConflict' (check time conflicts)."
                                },
                                scheduleId: {
                                    type: Type.STRING,
                                    description: "Schedule ID for Update/Delete operations (get from List/Search first)."
                                },
                                title: {
                                    type: Type.STRING,
                                    description: "Schedule title (required for Add, optional for Update). Examples: 'Take a drink', 'Take a walk', 'Doctor appointment'."
                                },
                                scheduledTime: {
                                    type: Type.STRING,
                                    description: "Time for schedule in natural language or HH:MM format (required for Add, optional for Update/CheckConflict). Examples: '6am', '18:30', '7pm'."
                                },
                                scheduleType: {
                                    type: Type.STRING,
                                    description: "Type of schedule: 'once' (default), 'daily', 'weekly', or 'custom'. Optional for Add/Update."
                                },
                                description: {
                                    type: Type.STRING,
                                    description: "Additional description for the schedule (optional for Add/Update)."
                                },
                                schedulePattern: {
                                    type: Type.OBJECT,
                                    description: "Complex schedule pattern for 'weekly' or 'custom' types (optional). Example: {weekdays: [1,3,5]} for Mon/Wed/Fri."
                                },
                                targetDate: {
                                    type: Type.STRING,
                                    description: "Target date for 'once' schedules in YYYY-MM-DD format (optional, defaults to today for Add/CheckConflict)."
                                },
                                query: {
                                    type: Type.STRING,
                                    description: "Search query for Search mode (required for Search). Search in title and description."
                                }
                            },
                        },
                    },
                    {
                        name: "ReadingManager",
                        description: "Unified modal interface for book reading system. Supports reading history, book content, search within books, and reading settings management. Use for all book-related tasks.",
                        parameters: {
                            type: Type.OBJECT,
                            required: ["mode", "action"],
                            properties: {
                                mode: {
                                    type: Type.STRING,
                                    description: "Reading operation mode: 'History' (check reading progress), 'Read' (read book content), 'Search' (find keywords in book), or 'Settings' (manage reading preferences)."
                                },
                                action: {
                                    type: Type.STRING,
                                    description: "Action to perform within the selected mode. History: 'Check'. Read: 'Continue', 'Start', 'GoTo'. Search: 'Find'. Settings: 'Get', 'Set'."
                                },
                                bookName: {
                                    type: Type.STRING,
                                    description: "Name of the book (without .txt extension). Required for History, Read, and Search modes."
                                },
                                pageNumber: {
                                    type: Type.NUMBER,
                                    description: "Page number for Read mode with 'GoTo' action (1-based indexing)."
                                },
                                keyword: {
                                    type: Type.STRING,
                                    description: "Search keyword for Search mode 'Find' action."
                                },
                                readingMode: {
                                    type: Type.STRING,
                                    description: "Reading mode for Settings 'Set' action: 'paragraphs', 'sentences', or 'fullpage'."
                                },
                                readingAmount: {
                                    type: Type.NUMBER,
                                    description: "Number of paragraphs or sentences to read at once (for Settings 'Set' action, not needed for 'fullpage' mode)."
                                }
                            },
                        },
                    },
                    {
                        name: "SetVolume",
                        description: "Adjusts the device volume level. Use ONLY when user explicitly mentions volume, sound level, hearing issues, or asks to make it louder/quieter. Do not use for general audio problems.",
                        parameters: {
                            type: Type.OBJECT,
                            required: ["volumeLevel"],
                            properties: {
                                volumeLevel: {
                                    type: Type.NUMBER,
                                    description: "Volume level as a percentage between 0 and 100. Use 100 for maximum volume when user can't hear."
                                }
                            }
                        }
                    }
                ]
            }
        ];
    }

    private setupConfig() {
        this.config = {
            thinkingConfig: {
                thinkingBudget: 500,
            },
            tools: this.tools,
            responseMimeType: 'text/plain',
        };
    }

    /**
     * Create a new Flash 2.5 session for a Live Gemini connection
     */
    createSession(sessionId: string, userId: string, deviceCallbacks?: DeviceOperationCallbacks): void {
        console.log(`Creating Flash 2.5 session for Live session: ${sessionId}`);

        const initialContents = [
            {
                role: 'user',
                parts: [
                    {
                        text: `You are an AI assistant that processes user commands and executes appropriate functions.

AVAILABLE FUNCTIONS:
1. ManageData - For notes and persona management
2. ScheduleManager - For schedule and reminder management
3. ReadingManager - For book reading system
4. GetVision - For capturing and analyzing images from the device camera
5. SetVolume - For adjusting device volume level

INSTRUCTIONS:
- Analyze the user command carefully
- Choose the appropriate function(s) to execute
- Call functions with correct parameters
- Provide a helpful response based on the function results
- If multiple functions are needed, call them in sequence
- Always confirm before deleting anything
- Respond in Vietnamese if the user speaks Vietnamese
- Maintain context and remember previous conversations in this session
- Use GetVision only when user explicitly asks about visual content
- Use SetVolume only when user mentions volume, hearing, or sound issues

SESSION INFO:
- Session ID: ${sessionId}
- User ID: ${userId}
- Session started at: ${new Date().toISOString()}

You are now ready to process user commands. Remember all interactions in this session.`,
                    },
                ],
            },
        ];

        this.sessions.set(sessionId, {
            userId,
            contents: initialContents,
            createdAt: new Date(),
            lastUsed: new Date(),
            deviceCallbacks
        });

        console.log(`Flash 2.5 session ${sessionId} created successfully`);
    }

    /**
     * Analyze image directly without function calling (for vision requests)
     */
    async analyzeImage(
        sessionId: string,
        prompt: string,
        imageDataOrUri: string
    ): Promise<FlashResponse> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                success: false,
                message: "Session not found. Please reconnect to create a new session."
            };
        }

        try {
            // Update last used timestamp
            session.lastUsed = new Date();

            // Add image and prompt to session history
            const imagePart = imageDataOrUri.startsWith('https://') ?
                // Google AI file URI
                {
                    fileData: {
                        mimeType: "image/jpeg",
                        fileUri: imageDataOrUri
                    }
                } :
                // Base64 data
                {
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: imageDataOrUri
                    }
                };

            session.contents.push({
                role: 'user',
                parts: [
                    {
                        text: prompt,
                    },
                    imagePart
                ],
            });

            const imageType = imageDataOrUri.startsWith('https://') ? 'URI' : 'base64';
            const imageSize = imageDataOrUri.startsWith('https://') ?
                'uploaded file' :
                `${Math.round(imageDataOrUri.length * 3 / 4 / 1024)} KB`;

            console.log(`Analyzing image in session ${sessionId} with Flash 2.5 (${imageType}: ${imageSize})`);

            // Use Flash 2.5 for direct image analysis (no function calling)
            const response = await this.ai.models.generateContentStream({
                model: 'gemini-2.5-flash-preview-05-20',
                config: {
                    thinkingConfig: {
                        thinkingBudget: 500,
                    },
                    responseMimeType: 'text/plain',
                    // No tools for direct image analysis
                },
                contents: session.contents,
            });

            let analysisText = "";
            // Properly handle all response parts to avoid warnings
            for await (const chunk of response) {
                // Handle text content directly from chunk
                if (chunk.text) {
                    analysisText += chunk.text;
                }
            }

            // Add Flash 2.5's analysis to session history
            session.contents.push({
                role: 'model',
                parts: [
                    {
                        text: analysisText,
                    },
                ],
            });

            return {
                success: true,
                message: analysisText || "I can see the image and have analyzed it."
            };

        } catch (error) {
            console.error(`Error analyzing image in session ${sessionId}:`, error);
            return {
                success: false,
                message: `Error analyzing image: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Process a user action within an existing session
     */
    async processAction(
        sessionId: string,
        userCommand: string,
        supabase: SupabaseClient,
        imageData?: string
    ): Promise<FlashResponse> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                success: false,
                message: "Session not found. Please reconnect to create a new session."
            };
        }

        try {
            // Update last used timestamp
            session.lastUsed = new Date();

            // Add user command to session history (with optional image)
            const userParts: any[] = [
                {
                    text: userCommand,
                }
            ];

            // Add image if provided
            if (imageData) {
                userParts.push({
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: imageData
                    }
                });
                console.log(`Added image data to Flash 2.5 session ${sessionId} (${Math.round(imageData.length * 3 / 4 / 1024)} KB)`);
            }

            session.contents.push({
                role: 'user',
                parts: userParts,
            });

            console.log(`Processing action in session ${sessionId}: "${userCommand}"`);

            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash-preview-05-20',
                config: this.config,
                contents: session.contents,
            });

            let functionCalls: any[] = [];
            let textResponse = "";

            // Handle the complete response to avoid warnings
            if (response.candidates && response.candidates.length > 0) {
                const candidate = response.candidates[0];
                if (candidate.content?.parts) {
                    for (const part of candidate.content.parts) {
                        // Handle function calls
                        if (part.functionCall) {
                            functionCalls.push(part.functionCall);
                        }
                        // Handle text content
                        if (part.text) {
                            textResponse += part.text;
                        }
                    }
                }
            }

            // Handle function calls
            if (functionCalls.length > 0) {
                const functionResults: any[] = [];

                for (const call of functionCalls) {
                    let functionResult: any;

                    if (call.name === "ManageData") {
                        const args = call.args;
                        functionResult = await ManageData(
                            supabase,
                            session.userId,
                            args.mode,
                            args.action,
                            args.query,
                            args.noteId,
                            args.title,
                            args.body,
                            args.newPersona,
                            args.dateFrom,
                            args.dateTo,
                            args.imageId
                        );
                    } else if (call.name === "ScheduleManager") {
                        const args = call.args;
                        functionResult = await ScheduleManager(
                            supabase,
                            session.userId,
                            args.mode,
                            args.scheduleId,
                            args.title,
                            args.scheduledTime,
                            args.scheduleType,
                            args.description,
                            args.schedulePattern,
                            args.targetDate,
                            args.query
                        );
                    } else if (call.name === "ReadingManager") {
                        const args = call.args;
                        functionResult = await ReadingManager(
                            supabase,
                            session.userId,
                            args.mode,
                            args.action,
                            args.bookName,
                            args.pageNumber,
                            args.keyword,
                            args.readingMode,
                            args.readingAmount
                        );
                    } else if (call.name === "SetVolume") {
                        const args = call.args;
                        if (session.deviceCallbacks?.setVolume) {
                            functionResult = await session.deviceCallbacks.setVolume(
                                args.volumeLevel,
                                `volume-${Date.now()}`
                            );
                        } else {
                            functionResult = {
                                success: false,
                                message: "Volume control not available - device callbacks not configured"
                            };
                        }
                    }

                    functionResults.push({
                        name: call.name,
                        result: functionResult
                    });
                }

                // Add function results to session history for context
                session.contents.push({
                    role: 'model',
                    parts: [
                        {
                            text: `Function calls executed: ${functionResults.map(r => `${r.name}: ${r.result?.message || 'completed'}`).join('; ')}`,
                        },
                    ],
                });

                return {
                    success: true,
                    message: functionResults.map(r => r.result?.message || "Function executed").join("; "),
                    data: functionResults
                };
            } else {
                // Add text response to session history
                session.contents.push({
                    role: 'model',
                    parts: [
                        {
                            text: textResponse,
                        },
                    ],
                });

                return {
                    success: true,
                    message: textResponse || "I understand your request but couldn't determine the appropriate action to take."
                };
            }

        } catch (error) {
            console.error(`Error in Flash 2.5 session ${sessionId}:`, error);
            return {
                success: false,
                message: `Error processing action: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Destroy a Flash 2.5 session when Live Gemini disconnects
     */
    destroySession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            const duration = new Date().getTime() - session.createdAt.getTime();
            console.log(`Destroying Flash 2.5 session ${sessionId} (duration: ${Math.round(duration / 1000)}s, messages: ${session.contents.length})`);
            this.sessions.delete(sessionId);
        } else {
            console.log(`Flash 2.5 session ${sessionId} not found for destruction`);
        }
    }

    /**
     * Get session info for debugging
     */
    getSessionInfo(sessionId: string): any {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        return {
            sessionId,
            userId: session.userId,
            createdAt: session.createdAt,
            lastUsed: session.lastUsed,
            messageCount: session.contents.length,
            duration: new Date().getTime() - session.createdAt.getTime()
        };
    }

    /**
     * Get all active sessions (for debugging)
     */
    getAllSessions(): any[] {
        return Array.from(this.sessions.keys()).map(sessionId => this.getSessionInfo(sessionId));
    }

    /**
     * Clean up old sessions (optional maintenance)
     */
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
            console.log(`Cleaned up ${cleaned} old Flash 2.5 sessions`);
        }
    }
}

// Create global session manager instance
const flash25SessionManager = new Flash25SessionManager();

export { flash25SessionManager };

/**
 * Flash 2.5 API handler for processing user commands and executing appropriate tools
 * This handler receives user commands from Live Gemini and processes them using Flash 2.5
 * with thinking budget to choose and execute the correct tools.
 */

interface FlashResponse {
    success: boolean;
    message: string;
    data?: any;
}

/**
 * Analyze image using Flash 2.5 intelligence (for vision requests)
 * @param sessionId - Live Gemini session ID
 * @param prompt - Vision prompt/question about the image
 * @param imageData - Base64 image data
 * @returns Flash 2.5 image analysis
 */
export async function analyzeImageWithFlash25(
    sessionId: string,
    prompt: string,
    imageData: string
): Promise<FlashResponse> {
    return await flash25SessionManager.analyzeImage(sessionId, prompt, imageData);
}

/**
 * Process user action using persistent Flash 2.5 session
 * @param sessionId - Live Gemini session ID
 * @param userCommand - The user command in reported speech
 * @param supabase - Supabase client
 * @param userId - User ID
 * @param imageData - Optional base64 image data for vision analysis
 * @returns Response from Flash 2.5 processing
 */
export async function processUserActionWithSession(
    sessionId: string,
    userCommand: string,
    supabase: SupabaseClient,
    userId: string,
    imageData?: string
): Promise<FlashResponse> {
    return await flash25SessionManager.processAction(sessionId, userCommand, supabase, imageData);
}

/**
 * Create a new Flash 2.5 session for a Live Gemini connection
 * @param sessionId - Live Gemini session ID
 * @param userId - User ID
 * @param deviceCallbacks - Optional device operation callbacks for vision and volume
 */
export function createFlash25Session(sessionId: string, userId: string, deviceCallbacks?: DeviceOperationCallbacks): void {
    flash25SessionManager.createSession(sessionId, userId, deviceCallbacks);
}

/**
 * Destroy a Flash 2.5 session when Live Gemini disconnects
 * @param sessionId - Live Gemini session ID
 */
export function destroyFlash25Session(sessionId: string): void {
    flash25SessionManager.destroySession(sessionId);
}

/**
 * Get Flash 2.5 session info for debugging
 * @param sessionId - Live Gemini session ID
 */
export function getFlash25SessionInfo(sessionId: string): any {
    return flash25SessionManager.getSessionInfo(sessionId);
}

/**
 * Get all active Flash 2.5 sessions for debugging
 */
export function getAllFlash25Sessions(): any[] {
    return flash25SessionManager.getAllSessions();
}

/**
 * Legacy function for backward compatibility - creates temporary session
 * @deprecated Use processUserActionWithSession instead
 */
export async function processUserAction(
    userCommand: string,
    supabase: SupabaseClient,
    userId: string
): Promise<FlashResponse> {
    // Create temporary session for legacy compatibility
    const tempSessionId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
        flash25SessionManager.createSession(tempSessionId, userId);
        const result = await flash25SessionManager.processAction(tempSessionId, userCommand, supabase);
        flash25SessionManager.destroySession(tempSessionId);
        return result;
    } catch (error) {
        flash25SessionManager.destroySession(tempSessionId);
        console.error("Error in legacy processUserAction:", error);
        return {
            success: false,
            message: `Error processing action: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

import { GoogleGenAI, Type } from "npm:@google/genai";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { apiKeyManager } from "./config.ts";
import { ManageData } from "./data_manager.ts";
import { ScheduleManager } from "./schedule_manager.ts";
import { ReadingManager } from "./reading_handler.ts";

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
 * Process user action using Gemini Flash 2.5 with function calling
 * @param userCommand - The user command in reported speech
 * @param supabase - Supabase client
 * @param userId - User ID
 * @returns Response from Flash 2.5 processing
 */
export async function processUserAction(
    userCommand: string,
    supabase: SupabaseClient,
    userId: string
): Promise<FlashResponse> {
    try {
        const apiKey = apiKeyManager.getCurrentKey();
        if (!apiKey) {
            return {
                success: false,
                message: "API key not available"
            };
        }

        const ai = new GoogleGenAI({
            apiKey: apiKey,
        });

        const tools = [
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
                    }
                ]
            }
        ];

        const config = {
            thinkingConfig: {
                thinkingBudget: 500,
            },
            tools,
            responseMimeType: 'text/plain',
        };

        const model = 'gemini-2.5-flash-preview-05-20';
        const contents = [
            {
                role: 'user',
                parts: [
                    {
                        text: `You are an AI assistant that processes user commands and executes appropriate functions.

AVAILABLE FUNCTIONS:
1. ManageData - For notes and persona management
2. ScheduleManager - For schedule and reminder management
3. ReadingManager - For book reading system

INSTRUCTIONS:
- Analyze the user command carefully
- Choose the appropriate function(s) to execute
- Call functions with correct parameters
- Provide a helpful response based on the function results
- If multiple functions are needed, call them in sequence
- Always confirm before deleting anything
- Respond in Vietnamese if the user speaks Vietnamese

USER COMMAND: "${userCommand}"

Process this command and execute the appropriate function(s).`,
                    },
                ],
            },
        ];

        const response = await ai.models.generateContentStream({
            model,
            config,
            contents,
        });

        let functionCalls: any[] = [];
        let textResponse = "";

        for await (const chunk of response) {
            if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                functionCalls.push(...chunk.functionCalls);
            }
            if (chunk.text) {
                textResponse += chunk.text;
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
                        userId,
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
                        userId,
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
                        userId,
                        args.mode,
                        args.action,
                        args.bookName,
                        args.pageNumber,
                        args.keyword,
                        args.readingMode,
                        args.readingAmount
                    );
                }

                functionResults.push({
                    name: call.name,
                    result: functionResult
                });
            }

            return {
                success: true,
                message: functionResults.map(r => r.result?.message || "Function executed").join("; "),
                data: functionResults
            };
        } else {
            // No function calls, just return the text response
            return {
                success: true,
                message: textResponse || "I understand your request but couldn't determine the appropriate action to take."
            };
        }

    } catch (error) {
        console.error("Error in processUserAction:", error);
        return {
            success: false,
            message: `Error processing action: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

import { GoogleGenerativeAI } from "npm:@google/generative-ai";
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

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash-preview-05-20",
            generationConfig: {
                temperature: 0.7,
                thinkingConfig: {
                    thinkingBudget: 500,
                },
            },
            systemInstruction: `You are an AI assistant that processes user commands and executes appropriate functions.

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

Process this command and execute the appropriate function(s).`
        });

        // Define the tools for Flash 2.5
        const tools = [
            {
                functionDeclarations: [
                    {
                        name: "ManageData",
                        description: "Unified modal interface for managing persona (AI memory) and notes (user data). First select mode ('Persona' or 'Notes'), then action. Use for all note-taking and persona management tasks.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                mode: {
                                    type: "STRING",
                                    description: "Data type to manage: 'Persona' (AI's knowledge about user preferences) or 'Notes' (user's personal notes and reminders)."
                                },
                                action: {
                                    type: "STRING",
                                    description: "Action to perform: 'Search' (retrieve/find data), 'Edit' (add/update data), or 'Delete' (remove data)."
                                },
                                query: {
                                    type: "STRING",
                                    description: "Search keywords for Notes Search (e.g., 'shopping list', 'meeting notes')."
                                },
                                noteId: {
                                    type: "STRING",
                                    description: "Note ID for Notes Edit/Delete of existing notes (get from Notes Search first)."
                                },
                                title: {
                                    type: "STRING",
                                    description: "Note title for Notes Edit (optional, auto-generated if not provided)."
                                },
                                body: {
                                    type: "STRING",
                                    description: "Note content for Notes Edit (required when adding new note)."
                                },
                                newPersona: {
                                    type: "STRING",
                                    description: "Complete persona description for Persona Edit (e.g., 'likes pizza, dislikes loud noises, prefers morning conversations')."
                                },
                                dateFrom: {
                                    type: "STRING",
                                    description: "Start date for Notes Search (optional, ISO format: '2024-01-01T00:00:00Z')."
                                },
                                dateTo: {
                                    type: "STRING",
                                    description: "End date for Notes Search (optional, ISO format: '2024-12-31T23:59:59Z')."
                                },
                                imageId: {
                                    type: "STRING",
                                    description: "Image ID for Notes Edit (optional, if note relates to captured image)."
                                }
                            },
                            required: ["mode", "action"]
                        },
                    },
                    {
                        name: "ScheduleManager",
                        description: "Unified modal interface for schedule and reminder management. First select mode ('List', 'Add', 'Update', 'Delete', 'Search', 'CheckConflict'), then provide required parameters. Use for all scheduling tasks.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                mode: {
                                    type: "STRING",
                                    description: "Schedule operation mode: 'List' (get all schedules with current time then read all the schedules aloud), 'Add' (create new schedule), 'Update' (modify existing), 'Delete' (remove schedule), 'Search' (find by title/description), 'CheckConflict' (check time conflicts)."
                                },
                                scheduleId: {
                                    type: "STRING",
                                    description: "Schedule ID for Update/Delete operations (get from List/Search first)."
                                },
                                title: {
                                    type: "STRING",
                                    description: "Schedule title (required for Add, optional for Update). Examples: 'Take a drink', 'Take a walk', 'Doctor appointment'."
                                },
                                scheduledTime: {
                                    type: "STRING",
                                    description: "Time for schedule in natural language or HH:MM format (required for Add, optional for Update/CheckConflict). Examples: '6am', '18:30', '7pm'."
                                },
                                scheduleType: {
                                    type: "STRING",
                                    description: "Type of schedule: 'once' (default), 'daily', 'weekly', or 'custom'. Optional for Add/Update."
                                },
                                description: {
                                    type: "STRING",
                                    description: "Additional description for the schedule (optional for Add/Update)."
                                },
                                schedulePattern: {
                                    type: "OBJECT",
                                    description: "Complex schedule pattern for 'weekly' or 'custom' types (optional). Example: {weekdays: [1,3,5]} for Mon/Wed/Fri."
                                },
                                targetDate: {
                                    type: "STRING",
                                    description: "Target date for 'once' schedules in YYYY-MM-DD format (optional, defaults to today for Add/CheckConflict)."
                                },
                                query: {
                                    type: "STRING",
                                    description: "Search query for Search mode (required for Search). Search in title and description."
                                }
                            },
                            required: ["mode"]
                        },
                    },
                    {
                        name: "ReadingManager",
                        description: "Unified modal interface for book reading system. Supports reading history, book content, search within books, and reading settings management. Use for all book-related tasks.",
                        parameters: {
                            type: "OBJECT",
                            properties: {
                                mode: {
                                    type: "STRING",
                                    description: "Reading operation mode: 'History' (check reading progress), 'Read' (read book content), 'Search' (find keywords in book), or 'Settings' (manage reading preferences)."
                                },
                                action: {
                                    type: "STRING",
                                    description: "Action to perform within the selected mode. History: 'Check'. Read: 'Continue', 'Start', 'GoTo'. Search: 'Find'. Settings: 'Get', 'Set'."
                                },
                                bookName: {
                                    type: "STRING",
                                    description: "Name of the book (without .txt extension). Required for History, Read, and Search modes."
                                },
                                pageNumber: {
                                    type: "NUMBER",
                                    description: "Page number for Read mode with 'GoTo' action (1-based indexing)."
                                },
                                keyword: {
                                    type: "STRING",
                                    description: "Search keyword for Search mode 'Find' action."
                                },
                                readingMode: {
                                    type: "STRING",
                                    description: "Reading mode for Settings 'Set' action: 'paragraphs', 'sentences', or 'fullpage'."
                                },
                                readingAmount: {
                                    type: "NUMBER",
                                    description: "Number of paragraphs or sentences to read at once (for Settings 'Set' action, not needed for 'fullpage' mode)."
                                }
                            },
                            required: ["mode", "action"]
                        },
                    }
                ]
            }
        ];

        // Start chat with Flash 2.5
        const chat = model.startChat({
            tools: tools,
            toolConfig: {
                functionCallingConfig: {
                    mode: "AUTO"
                }
            }
        });

        const result = await chat.sendMessage(userCommand);
        const response = result.response;

        // Handle function calls
        if (response.functionCalls && response.functionCalls.length > 0) {
            const functionResults = [];
            
            for (const call of response.functionCalls) {
                let functionResult;
                
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
                    functionResponse: {
                        name: call.name,
                        response: functionResult
                    }
                });
            }

            // Send function results back to get final response
            const finalResult = await chat.sendMessage(functionResults);
            const finalResponse = finalResult.response;

            return {
                success: true,
                message: finalResponse.text() || "Action completed successfully",
                data: functionResults
            };
        } else {
            // No function calls, just return the text response
            return {
                success: true,
                message: response.text() || "I understand your request but couldn't determine the appropriate action to take."
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

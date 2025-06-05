import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { GetMemory, UpdateMemory } from "./memory_handler.ts";
import { AddNote, SearchNotes, UpdateNote, DeleteNote } from "./note_handler.ts";
import { ListSchedules, AddSchedule, UpdateSchedule, DeleteSchedule, SearchSchedules, FindScheduleConflicts } from "./schedule_handler.ts";
import "./types.d.ts";

/**
 * Unified data management function that handles persona, notes, and schedule management
 * through a modal interface.
 *
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param mode - The data type to manage: "Persona", "Notes", or "Schedule"
 * @param action - The action to perform: "Search", "Edit", "Delete", or "List" (Schedule only)
 * @param query - Search query (required for Notes/Schedule Search)
 * @param noteId - Note ID (required for Notes Edit/Delete of existing notes)
 * @param title - Note/Schedule title (optional for Notes Edit, required for Schedule Add)
 * @param body - Note body (required for Notes Edit when adding new note)
 * @param newPersona - New persona text (required for Persona Edit)
 * @param dateFrom - Start date for Notes Search (optional, ISO format)
 * @param dateTo - End date for Notes Search (optional, ISO format)
 * @param imageId - Image ID for Notes Edit (optional)
 * @param scheduleId - Schedule ID (required for Schedule Edit/Delete of existing schedules)
 * @param scheduledTime - Time for schedule (required for Schedule Add/Edit)
 * @param scheduleType - Type of schedule: 'once', 'daily', 'weekly', 'custom' (optional, defaults to 'once')
 * @param description - Schedule description (optional)
 * @param schedulePattern - Schedule pattern for complex schedules (optional)
 * @param targetDate - Target date for one-time schedules (optional, defaults to today)
 * @returns An object containing success status and relevant data or error message
 */
export async function ManageData(
    supabase: SupabaseClient,
    userId: string,
    mode: "Persona" | "Notes" | "Schedule",
    action: "Search" | "Edit" | "Delete" | "List",
    query?: string | null,
    noteId?: string | null,
    title?: string | null,
    body?: string | null,
    newPersona?: string | null,
    dateFrom?: string | null,
    dateTo?: string | null,
    imageId?: string | null,
    scheduleId?: string | null,
    scheduledTime?: string | null,
    scheduleType?: 'once' | 'daily' | 'weekly' | 'custom' | null,
    description?: string | null,
    schedulePattern?: ISchedulePattern | null,
    targetDate?: string | null
): Promise<{ success: boolean; data?: any; message: string }> {
    console.log(`ManageData called: mode=${mode}, action=${action}, userId=${userId}`);

    // Validate mode and action
    if (!["Persona", "Notes", "Schedule"].includes(mode)) {
        return { success: false, message: "Invalid mode. Must be 'Persona', 'Notes', or 'Schedule'." };
    }
    if (!["Search", "Edit", "Delete", "List"].includes(action)) {
        return { success: false, message: "Invalid action. Must be 'Search', 'Edit', 'Delete', or 'List'." };
    }

    // Validate Schedule-specific actions
    if (mode === "Schedule" && action === "List") {
        // List is only valid for Schedule mode
    } else if (mode !== "Schedule" && action === "List") {
        return { success: false, message: "Action 'List' is only valid for Schedule mode." };
    }

    try {
        // Handle Persona mode
        if (mode === "Persona") {
            if (action === "Search") {
                // Get current persona (like GetMemory)
                const result = await GetMemory(supabase, userId);
                return {
                    success: result.success,
                    data: result.persona,
                    message: result.success
                        ? `Current persona: ${result.persona || "(No persona set)"}`
                        : result.message
                };
            } else if (action === "Edit") {
                // Update persona (like UpdateMemory)
                if (!newPersona || typeof newPersona !== 'string') {
                    return { success: false, message: "newPersona is required for Persona Edit." };
                }
                const result = await UpdateMemory(supabase, userId, newPersona);
                return {
                    success: result.success,
                    message: result.message
                };
            } else if (action === "Delete") {
                // Clear persona (set to empty string)
                const result = await UpdateMemory(supabase, userId, "");
                return {
                    success: result.success,
                    message: result.success ? "Persona cleared successfully." : result.message
                };
            }
        }

        // Handle Notes mode
        else if (mode === "Notes") {
            if (action === "Search") {
                // Search notes (like SearchNotes)
                if (!query || typeof query !== 'string' || !query.trim()) {
                    return { success: false, message: "query is required for Notes Search." };
                }
                const result = await SearchNotes(supabase, userId, query, dateFrom, dateTo);
                return {
                    success: result.success,
                    data: result.notes,
                    message: result.message
                };
            } else if (action === "Edit") {
                if (noteId && typeof noteId === 'string' && noteId.trim()) {
                    // Update existing note (like UpdateNote)
                    const result = await UpdateNote(supabase, userId, noteId, title, body);
                    return {
                        success: result.success,
                        data: result.note,
                        message: result.message
                    };
                } else {
                    // Add new note (like AddNote)
                    if (!body || typeof body !== 'string' || !body.trim()) {
                        return { success: false, message: "body is required for adding a new note." };
                    }
                    const result = await AddNote(supabase, userId, title || null, body, imageId || null);
                    return {
                        success: result.success,
                        data: result.note,
                        message: result.message
                    };
                }
            } else if (action === "Delete") {
                // Delete note (like DeleteNote)
                if (!noteId || typeof noteId !== 'string' || !noteId.trim()) {
                    return { success: false, message: "noteId is required for Notes Delete." };
                }
                const result = await DeleteNote(supabase, userId, noteId);
                return {
                    success: result.success,
                    message: result.message
                };
            }
        }

        // Handle Schedule mode
        else if (mode === "Schedule") {
            if (action === "List") {
                // List all schedules with current time (like ListSchedules)
                const result = await ListSchedules(supabase, userId);
                return {
                    success: result.success,
                    data: result.data,
                    message: result.message
                };
            } else if (action === "Search") {
                // Search schedules (like SearchSchedules)
                if (!query || typeof query !== 'string' || !query.trim()) {
                    return { success: false, message: "query is required for Schedule Search." };
                }
                const result = await SearchSchedules(supabase, userId, query);
                return {
                    success: result.success,
                    data: result.schedules,
                    message: result.message
                };
            } else if (action === "Edit") {
                if (scheduleId && typeof scheduleId === 'string' && scheduleId.trim()) {
                    // Update existing schedule (like UpdateSchedule)
                    const result = await UpdateSchedule(
                        supabase, userId, scheduleId, title, scheduledTime,
                        scheduleType, description, schedulePattern, targetDate
                    );
                    return {
                        success: result.success,
                        data: result.schedule,
                        message: result.message
                    };
                } else {
                    // Add new schedule (like AddSchedule)
                    if (!title || typeof title !== 'string' || !title.trim()) {
                        return { success: false, message: "title is required for adding a new schedule." };
                    }
                    if (!scheduledTime || typeof scheduledTime !== 'string' || !scheduledTime.trim()) {
                        return { success: false, message: "scheduledTime is required for adding a new schedule." };
                    }

                    // Check for conflicts before adding
                    const conflictResult = await FindScheduleConflicts(
                        supabase, userId, scheduledTime, targetDate
                    );

                    if (conflictResult.success && conflictResult.conflicts && conflictResult.conflicts.length > 0) {
                        const conflictTitles = conflictResult.conflicts.map(s => s.title).join(', ');
                        return {
                            success: false,
                            data: conflictResult.conflicts,
                            message: `Schedule conflict detected! You already have these schedules at ${scheduledTime}: ${conflictTitles}. Please choose a different time or update the existing schedule.`
                        };
                    }

                    const result = await AddSchedule(
                        supabase, userId, title, scheduledTime,
                        scheduleType || 'once', description, schedulePattern, targetDate
                    );
                    return {
                        success: result.success,
                        data: result.schedule,
                        message: result.message
                    };
                }
            } else if (action === "Delete") {
                // Delete schedule (like DeleteSchedule)
                if (!scheduleId || typeof scheduleId !== 'string' || !scheduleId.trim()) {
                    return { success: false, message: "scheduleId is required for Schedule Delete." };
                }
                const result = await DeleteSchedule(supabase, userId, scheduleId);
                return {
                    success: result.success,
                    message: result.message
                };
            }
        }

        // This should never be reached due to validation above
        return { success: false, message: "Invalid mode/action combination." };

    } catch (err) {
        console.error(`Unexpected error in ManageData for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

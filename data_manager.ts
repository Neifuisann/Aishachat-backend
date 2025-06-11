import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { GetMemory, UpdateMemory } from "./memory_handler.ts";
import { AddNote, SearchNotes, UpdateNote, DeleteNote, ListNoteTitles } from "./note_handler.ts";
import "./types.d.ts";

/**
 * Unified data management function that handles both persona and notes management
 * through a modal interface.
 *
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param mode - The data type to manage: "Persona" or "Notes"
 * @param action - The action to perform: "List", "Search", "Edit", or "Delete"
 * @param query - Search query (required for Notes Search)
 * @param noteId - Note ID (required for Notes Edit/Delete of existing notes)
 * @param title - Note title (optional for Notes Edit)
 * @param body - Note body (required for Notes Edit when adding new note)
 * @param newPersona - New persona text (required for Persona Edit)
 * @param dateFrom - Start date for Notes Search (optional, ISO format)
 * @param dateTo - End date for Notes Search (optional, ISO format)
 * @param imageId - Image ID for Notes Edit (optional)
 * @returns An object containing success status and relevant data or error message
 */
export async function ManageData(
    supabase: SupabaseClient,
    userId: string,
    mode: "Persona" | "Notes",
    action: "List" | "Search" | "Edit" | "Delete",
    query?: string | null,
    noteId?: string | null,
    title?: string | null,
    body?: string | null,
    newPersona?: string | null,
    dateFrom?: string | null,
    dateTo?: string | null,
    imageId?: string | null
): Promise<{ success: boolean; data?: any; message: string }> {
    console.log(`ManageData called: mode=${mode}, action=${action}, userId=${userId}`);

    // Validate mode and action
    if (!["Persona", "Notes"].includes(mode)) {
        return { success: false, message: "Invalid mode. Must be 'Persona' or 'Notes'." };
    }
    if (!["List", "Search", "Edit", "Delete"].includes(action)) {
        return { success: false, message: "Invalid action. Must be 'List', 'Search', 'Edit', or 'Delete'." };
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
            if (action === "List") {
                // List note titles (like ListNoteTitles)
                const result = await ListNoteTitles(supabase, userId);
                return {
                    success: result.success,
                    data: result.data,
                    message: result.message
                };
            } else if (action === "Search") {
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

        // This should never be reached due to validation above
        return { success: false, message: "Invalid mode/action combination." };

    } catch (err) {
        console.error(`Unexpected error in ManageData for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

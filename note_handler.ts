import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "./types.d.ts";

/**
 * Generates a smart title from the note body content
 * @param body - The full note content
 * @returns A concise title (max 50 characters)
 */
function generateNoteTitle(body: string): string {
    // Remove common phrases and extract key content
    const cleanBody = body
        .replace(/please take note that?/gi, '')
        .replace(/remember that?/gi, '')
        .replace(/note:/gi, '')
        .trim();

    // Take first meaningful sentence or phrase
    const sentences = cleanBody.split(/[.!?]/);
    let title = sentences[0]?.trim() || cleanBody;

    // Limit to 50 characters and add ellipsis if needed
    if (title.length > 50) {
        title = title.substring(0, 47) + '...';
    }

    return title || 'Note';
}

/**
 * Adds a new note for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user creating the note
 * @param title - The note title (optional, will be auto-generated if not provided)
 * @param body - The note content
 * @param imageId - Optional image ID if note includes an image
 * @returns An object containing success status and note data or error message
 */
export async function AddNote(
    supabase: SupabaseClient,
    userId: string,
    title: string | null,
    body: string,
    imageId?: string | null
): Promise<{ success: boolean; note?: INote; message: string }> {
    console.log(`Attempting to add note for user ${userId}`);

    if (!body || body.trim().length === 0) {
        const errorMsg = "Note body cannot be empty";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        // Generate title if not provided
        const noteTitle = title && title.trim() ? title.trim() : generateNoteTitle(body);

        const noteData = {
            user_id: userId,
            title: noteTitle,
            body: body.trim(),
            image_id: imageId || null
        };

        const { data, error } = await supabase
            .from('notes')
            .insert(noteData)
            .select('*')
            .single();

        if (error) {
            console.error(`Supabase error adding note for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const successMsg = `Successfully added note "${noteTitle}"`;
        console.log(successMsg);
        return { success: true, note: data as INote, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in AddNote for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Searches notes for a user based on query and optional date range
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user searching notes
 * @param query - Search query for title and body content
 * @param dateFrom - Optional start date for search (ISO string)
 * @param dateTo - Optional end date for search (ISO string)
 * @returns An object containing success status and notes array or error message
 */
export async function SearchNotes(
    supabase: SupabaseClient,
    userId: string,
    query: string,
    dateFrom?: string | null,
    dateTo?: string | null
): Promise<{ success: boolean; notes?: INote[]; message: string }> {
    console.log(`Attempting to search notes for user ${userId} with query: "${query}"`);

    if (!query || query.trim().length === 0) {
        const errorMsg = "Search query cannot be empty";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        let queryBuilder = supabase
            .from('notes')
            .select('*')
            .eq('user_id', userId);

        // Add text search using PostgreSQL full-text search
        const searchTerms = query.trim().split(/\s+/).join(' | ');
        queryBuilder = queryBuilder.or(
            `title.ilike.%${query}%,body.ilike.%${query}%`
        );

        // Add date filters if provided
        if (dateFrom) {
            queryBuilder = queryBuilder.gte('created_at', dateFrom);
        }
        if (dateTo) {
            queryBuilder = queryBuilder.lte('created_at', dateTo);
        }

        // Order by most recent first
        queryBuilder = queryBuilder.order('created_at', { ascending: false });

        const { data, error } = await queryBuilder;

        if (error) {
            console.error(`Supabase error searching notes for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const notes = data as INote[];
        const successMsg = `Found ${notes.length} note(s) for user ${userId}`;
        console.log(successMsg);
        return { success: true, notes, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in SearchNotes for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Updates an existing note for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user updating the note
 * @param noteId - The ID of the note to update
 * @param title - Optional new title
 * @param body - Optional new body content
 * @returns An object containing success status and updated note or error message
 */
export async function UpdateNote(
    supabase: SupabaseClient,
    userId: string,
    noteId: string,
    title?: string | null,
    body?: string | null
): Promise<{ success: boolean; note?: INote; message: string }> {
    console.log(`Attempting to update note ${noteId} for user ${userId}`);

    if (!title && !body) {
        const errorMsg = "At least title or body must be provided for update";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        // Build update object
        const updateData: any = {
            updated_at: new Date().toISOString()
        };

        if (title !== undefined && title !== null) {
            updateData.title = title.trim();
        }
        if (body !== undefined && body !== null) {
            updateData.body = body.trim();
        }

        const { data, error } = await supabase
            .from('notes')
            .update(updateData)
            .eq('note_id', noteId)
            .eq('user_id', userId) // Ensure user can only update their own notes
            .select('*')
            .single();

        if (error) {
            console.error(`Supabase error updating note ${noteId} for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            const errorMsg = `Note ${noteId} not found or not owned by user ${userId}`;
            console.warn(errorMsg);
            return { success: false, message: errorMsg };
        }

        const successMsg = `Successfully updated note ${noteId} for user ${userId}`;
        console.log(successMsg);
        return { success: true, note: data as INote, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in UpdateNote for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Deletes a note for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user deleting the note
 * @param noteId - The ID of the note to delete
 * @returns An object containing success status and message
 */
export async function DeleteNote(
    supabase: SupabaseClient,
    userId: string,
    noteId: string
): Promise<{ success: boolean; message: string }> {
    console.log(`Attempting to delete note ${noteId} for user ${userId}`);

    try {
        const { data, error } = await supabase
            .from('notes')
            .delete()
            .eq('note_id', noteId)
            .eq('user_id', userId) // Ensure user can only delete their own notes
            .select('title')
            .single();

        if (error) {
            console.error(`Supabase error deleting note ${noteId} for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            const errorMsg = `Note ${noteId} not found or not owned by user ${userId}`;
            console.warn(errorMsg);
            return { success: false, message: errorMsg };
        }

        const successMsg = `Successfully deleted note "${data.title}" for user ${userId}`;
        console.log(successMsg);
        return { success: true, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in DeleteNote for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Lists note titles for a user (lightweight overview)
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param limit - Optional limit for number of notes to return
 * @returns An object containing success status and detailed message with note titles
 */
export async function ListNoteTitles(
    supabase: SupabaseClient,
    userId: string,
    limit: number = 50
): Promise<{ success: boolean; data?: { note_id: string; title: string; created_at: string }[]; message: string }> {
    console.log(`Attempting to list note titles for user ${userId}`);

    try {
        const { data, error } = await supabase
            .from('notes')
            .select('note_id, title, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error(`Supabase error listing note titles for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const noteTitles = data as { note_id: string; title: string; created_at: string }[];

        // Create detailed message with all note titles
        let successMsg = `Found ${noteTitles.length} note(s) for user ${userId}`;

        if (noteTitles.length > 0) {
            successMsg += "\n\nYour Notes:";
            noteTitles.forEach((note, index) => {
                const createdDate = new Date(note.created_at).toLocaleDateString();
                successMsg += `\n${index + 1}. "${note.title}"`;
            });
        } else {
            successMsg += "\n\nNo notes found. You can create your first note by saying something like 'Take note that...'";
        }

        console.log(successMsg);
        return { success: true, data: noteTitles, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in ListNoteTitles for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Gets all notes for a user (for listing/overview)
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param limit - Optional limit for number of notes to return
 * @returns An object containing success status and notes array or error message
 */
export async function GetAllNotes(
    supabase: SupabaseClient,
    userId: string,
    limit: number = 50
): Promise<{ success: boolean; notes?: INote[]; message: string }> {
    console.log(`Attempting to get all notes for user ${userId}`);

    try {
        const { data, error } = await supabase
            .from('notes')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error(`Supabase error getting notes for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const notes = data as INote[];
        const successMsg = `Retrieved ${notes.length} note(s) for user ${userId}`;
        console.log(successMsg);
        return { success: true, notes, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in GetAllNotes for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

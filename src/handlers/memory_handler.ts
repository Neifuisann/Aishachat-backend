import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { Logger } from '../utils/logger.ts';

const logger = new Logger('[Memory]');

/**
 * Retrieves the current supervisee persona (memory) for a user from Supabase.
 * @param supabase - The Supabase client instance scoped to the user.
 * @param userId - The ID of the user whose persona is needed.
 * @returns An object containing success status and the persona string or an error message.
 */
export async function GetMemory(
    supabase: SupabaseClient,
    userId: string,
): Promise<{ success: boolean; persona?: string; message: string }> {
    logger.info(`Attempting to get memory (persona) for user ${userId}`);

    try {
        const { data, error } = await supabase
            .from('users') // Ensure 'users' is your correct table name
            .select('supervisee_persona') // Select only the persona field
            .eq('user_id', userId) // Ensure 'user_id' is the correct column name
            .maybeSingle(); // Expect zero or one row

        if (error) {
            logger.error(`Supabase error getting persona for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            logger.warn(`No user found for user ${userId} to get persona.`);
            return { success: false, message: `User ${userId} not found.` };
        }

        const persona = data.supervisee_persona || ''; // Default to empty string if null
        const successMsg = `Successfully retrieved persona for user ${userId}.`;
        logger.info(successMsg, 'Persona:', persona);
        return { success: true, persona: persona, message: successMsg };
    } catch (err) {
        logger.error(`Unexpected error in GetMemory for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Updates the supervisee persona (memory) for a user in Supabase.
 * @param supabase - The Supabase client instance scoped to the user.
 * @param userId - The ID of the user whose persona needs updating.
 * @param newPersona - The new persona string to set.
 * @returns An object indicating success or failure and a message.
 */
export async function UpdateMemory(
    supabase: SupabaseClient,
    userId: string,
    newPersona: string,
): Promise<{ success: boolean; message: string }> {
    logger.info(`Attempting to update memory (persona) for user ${userId} to: "${newPersona}"`);

    // Basic validation for the new persona string
    if (typeof newPersona !== 'string') {
        const errorMsg = 'Invalid persona provided. Must be a string.';
        logger.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        const { data, error } = await supabase
            .from('users') // Ensure 'users' is your correct table name
            .update({ supervisee_persona: newPersona })
            .eq('user_id', userId) // Ensure 'user_id' is the correct column name
            .select('user_id') // Select something small to confirm update
            .maybeSingle();

        if (error) {
            logger.error(`Supabase error updating persona for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            logger.warn(`No user found for user ${userId} to update persona.`);
            return { success: false, message: `User ${userId} not found.` };
        }

        const successMsg = `Successfully updated persona for user ${userId}.`;
        logger.info(successMsg);
        return { success: true, message: successMsg };
    } catch (err) {
        logger.error(`Unexpected error in UpdateMemory for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

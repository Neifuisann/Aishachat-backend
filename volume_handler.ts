import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Updates the volume setting for a user's device in Supabase.
 * @param supabase - The Supabase client instance scoped to the user.
 * @param userId - The ID of the user whose device volume needs updating.
 * @param volumeLevel - The new volume level (0-100).
 * @returns An object indicating success or failure and a message.
 */
export async function SetVolume(
    supabase: SupabaseClient,
    userId: string,
    volumeLevel: number
): Promise<{ success: boolean; message: string }> {
    console.log(`Attempting to set volume for user ${userId} to ${volumeLevel}`);

    // Validate volume level
    if (typeof volumeLevel !== 'number' || volumeLevel < 0 || volumeLevel > 100) {
        const errorMsg = `Invalid volume level: ${volumeLevel}. Must be a number between 0 and 100.`;
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    // Ensure volume is an integer
    const validatedVolume = Math.round(volumeLevel);

    try {
        const { data, error } = await supabase
            .from('devices') // Make sure 'devices' is your correct table name
            .update({ volume: validatedVolume })
            .eq('user_id', userId) // Ensure 'user_id' is the correct column name
            .select() // Optionally select to confirm the update
            .maybeSingle(); // Use maybeSingle if you expect zero or one row

        if (error) {
            console.error(`Supabase error updating volume for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
             console.warn(`No device found for user ${userId} to update volume.`);
             // Depending on requirements, this might be treated as success or failure.
             // Let's consider it a soft failure for now.
             return { success: false, message: `No device found for user ${userId}.` };
        }

        const successMsg = `Volume for user ${userId} successfully set to ${validatedVolume}.`;
        console.log(successMsg);
        return { success: true, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in SetVolume for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
} 
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import "./types.d.ts";
import { 
    getCurrentTimeUTC7, 
    isValidTimeFormat, 
    isValidDateFormat, 
    parseTimeInput,
    getTodayUTC7,
    shouldScheduleTriggerToday 
} from "./time_utils.ts";

/**
 * Lists all schedules for a user along with current UTC+7 time
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @returns An object containing success status, schedules, current time, and message
 */
export async function ListSchedules(
    supabase: SupabaseClient,
    userId: string
): Promise<{ success: boolean; data?: IScheduleWithCurrentTime; message: string }> {
    console.log(`Attempting to list schedules for user ${userId}`);

    try {
        const { data, error } = await supabase
            .from('schedules')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('scheduled_time', { ascending: true });

        if (error) {
            console.error(`Supabase error listing schedules for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const schedules = data as ISchedule[];
        const timeInfo = getCurrentTimeUTC7();
        
        const result: IScheduleWithCurrentTime = {
            schedules,
            current_time_utc7: timeInfo.current_time_utc7,
            current_date_utc7: timeInfo.current_date_utc7
        };

        const successMsg = `Retrieved ${schedules.length} active schedule(s) for user ${userId}. Current time (UTC+7): ${timeInfo.current_time_utc7}`;
        console.log(successMsg);
        return { success: true, data: result, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in ListSchedules for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Adds a new schedule for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user creating the schedule
 * @param title - The schedule title (e.g., "Take a drink", "Take a walk")
 * @param scheduledTime - Time in HH:MM format or natural language (e.g., "6am", "18:30")
 * @param scheduleType - Type of schedule: 'once', 'daily', 'weekly', 'custom'
 * @param description - Optional description
 * @param schedulePattern - Optional pattern for complex schedules
 * @param targetDate - Optional target date for one-time schedules (YYYY-MM-DD)
 * @returns An object containing success status and schedule data or error message
 */
export async function AddSchedule(
    supabase: SupabaseClient,
    userId: string,
    title: string,
    scheduledTime: string,
    scheduleType: 'once' | 'daily' | 'weekly' | 'custom' = 'once',
    description?: string | null,
    schedulePattern?: ISchedulePattern | null,
    targetDate?: string | null
): Promise<{ success: boolean; schedule?: ISchedule; message: string }> {
    console.log(`Attempting to add schedule for user ${userId}: "${title}" at ${scheduledTime}`);

    if (!title || title.trim().length === 0) {
        const errorMsg = "Schedule title cannot be empty";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    // Parse and validate time
    const parsedTime = parseTimeInput(scheduledTime);
    if (!parsedTime) {
        const errorMsg = `Invalid time format: "${scheduledTime}". Please use formats like "6am", "18:30", or "HH:MM"`;
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    // Validate target date if provided
    if (targetDate && !isValidDateFormat(targetDate)) {
        const errorMsg = `Invalid date format: "${targetDate}". Please use YYYY-MM-DD format`;
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    // Set default target date for 'once' type if not provided
    if (scheduleType === 'once' && !targetDate) {
        targetDate = getTodayUTC7();
    }

    try {
        const scheduleData = {
            user_id: userId,
            title: title.trim(),
            description: description?.trim() || null,
            scheduled_time: parsedTime,
            schedule_type: scheduleType,
            schedule_pattern: schedulePattern || null,
            target_date: targetDate,
            is_active: true
        };

        const { data, error } = await supabase
            .from('schedules')
            .insert(scheduleData)
            .select('*')
            .single();

        if (error) {
            console.error(`Supabase error adding schedule for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const successMsg = `Successfully added schedule "${title}" at ${parsedTime} for user ${userId}`;
        console.log(successMsg);
        return { success: true, schedule: data as ISchedule, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in AddSchedule for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Updates an existing schedule for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user updating the schedule
 * @param scheduleId - The ID of the schedule to update
 * @param title - Optional new title
 * @param scheduledTime - Optional new time
 * @param scheduleType - Optional new schedule type
 * @param description - Optional new description
 * @param schedulePattern - Optional new pattern
 * @param targetDate - Optional new target date
 * @param isActive - Optional new active status
 * @returns An object containing success status and updated schedule or error message
 */
export async function UpdateSchedule(
    supabase: SupabaseClient,
    userId: string,
    scheduleId: string,
    title?: string | null,
    scheduledTime?: string | null,
    scheduleType?: 'once' | 'daily' | 'weekly' | 'custom' | null,
    description?: string | null,
    schedulePattern?: ISchedulePattern | null,
    targetDate?: string | null,
    isActive?: boolean | null
): Promise<{ success: boolean; schedule?: ISchedule; message: string }> {
    console.log(`Attempting to update schedule ${scheduleId} for user ${userId}`);

    if (!scheduleId || scheduleId.trim().length === 0) {
        const errorMsg = "Schedule ID is required for updating";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        // Build update object
        const updateData: any = {
            updated_at: new Date().toISOString()
        };

        if (title !== undefined && title !== null) {
            if (title.trim().length === 0) {
                return { success: false, message: "Schedule title cannot be empty" };
            }
            updateData.title = title.trim();
        }

        if (scheduledTime !== undefined && scheduledTime !== null) {
            const parsedTime = parseTimeInput(scheduledTime);
            if (!parsedTime) {
                return { success: false, message: `Invalid time format: "${scheduledTime}"` };
            }
            updateData.scheduled_time = parsedTime;
        }

        if (scheduleType !== undefined && scheduleType !== null) {
            updateData.schedule_type = scheduleType;
        }

        if (description !== undefined) {
            updateData.description = description?.trim() || null;
        }

        if (schedulePattern !== undefined) {
            updateData.schedule_pattern = schedulePattern;
        }

        if (targetDate !== undefined) {
            if (targetDate && !isValidDateFormat(targetDate)) {
                return { success: false, message: `Invalid date format: "${targetDate}"` };
            }
            updateData.target_date = targetDate;
        }

        if (isActive !== undefined && isActive !== null) {
            updateData.is_active = isActive;
        }

        const { data, error } = await supabase
            .from('schedules')
            .update(updateData)
            .eq('schedule_id', scheduleId)
            .eq('user_id', userId) // Ensure user can only update their own schedules
            .select('*')
            .single();

        if (error) {
            console.error(`Supabase error updating schedule ${scheduleId} for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            const errorMsg = `Schedule ${scheduleId} not found or not owned by user ${userId}`;
            console.warn(errorMsg);
            return { success: false, message: errorMsg };
        }

        const successMsg = `Successfully updated schedule "${data.title}" for user ${userId}`;
        console.log(successMsg);
        return { success: true, schedule: data as ISchedule, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in UpdateSchedule for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Deletes a schedule for a user
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user deleting the schedule
 * @param scheduleId - The ID of the schedule to delete
 * @returns An object containing success status and message
 */
export async function DeleteSchedule(
    supabase: SupabaseClient,
    userId: string,
    scheduleId: string
): Promise<{ success: boolean; message: string }> {
    console.log(`Attempting to delete schedule ${scheduleId} for user ${userId}`);

    if (!scheduleId || scheduleId.trim().length === 0) {
        const errorMsg = "Schedule ID is required for deletion";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        const { data, error } = await supabase
            .from('schedules')
            .delete()
            .eq('schedule_id', scheduleId)
            .eq('user_id', userId) // Ensure user can only delete their own schedules
            .select('title')
            .single();

        if (error) {
            console.error(`Supabase error deleting schedule ${scheduleId} for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        if (!data) {
            const errorMsg = `Schedule ${scheduleId} not found or not owned by user ${userId}`;
            console.warn(errorMsg);
            return { success: false, message: errorMsg };
        }

        const successMsg = `Successfully deleted schedule "${data.title}" for user ${userId}`;
        console.log(successMsg);
        return { success: true, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in DeleteSchedule for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Searches schedules for a user based on query
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user searching schedules
 * @param query - Search query for title and description content
 * @returns An object containing success status and schedules array or error message
 */
export async function SearchSchedules(
    supabase: SupabaseClient,
    userId: string,
    query: string
): Promise<{ success: boolean; schedules?: ISchedule[]; message: string }> {
    console.log(`Attempting to search schedules for user ${userId} with query: "${query}"`);

    if (!query || query.trim().length === 0) {
        const errorMsg = "Search query cannot be empty";
        console.error(errorMsg);
        return { success: false, message: errorMsg };
    }

    try {
        const { data, error } = await supabase
            .from('schedules')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
            .order('scheduled_time', { ascending: true });

        if (error) {
            console.error(`Supabase error searching schedules for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const schedules = data as ISchedule[];
        const successMsg = `Found ${schedules.length} schedule(s) matching "${query}" for user ${userId}`;
        console.log(successMsg);
        return { success: true, schedules, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in SearchSchedules for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Finds schedules that conflict with a given time and date
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param scheduledTime - Time in HH:MM format
 * @param targetDate - Date in YYYY-MM-DD format (optional, defaults to today)
 * @param excludeScheduleId - Optional schedule ID to exclude from conflict check
 * @returns An object containing success status and conflicting schedules
 */
export async function FindScheduleConflicts(
    supabase: SupabaseClient,
    userId: string,
    scheduledTime: string,
    targetDate?: string | null,
    excludeScheduleId?: string | null
): Promise<{ success: boolean; conflicts?: ISchedule[]; message: string }> {
    console.log(`Checking for schedule conflicts for user ${userId} at ${scheduledTime} on ${targetDate || 'today'}`);

    try {
        const checkDate = targetDate || getTodayUTC7();

        let query = supabase
            .from('schedules')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .eq('scheduled_time', scheduledTime);

        if (excludeScheduleId) {
            query = query.neq('schedule_id', excludeScheduleId);
        }

        const { data, error } = await query;

        if (error) {
            console.error(`Supabase error checking conflicts for user ${userId}:`, error);
            return { success: false, message: `Database error: ${error.message}` };
        }

        const allSchedules = data as ISchedule[];

        // Filter schedules that would trigger on the target date
        const conflicts = allSchedules.filter(schedule =>
            shouldScheduleTriggerToday(schedule, checkDate)
        );

        const successMsg = conflicts.length > 0
            ? `Found ${conflicts.length} conflicting schedule(s) at ${scheduledTime} on ${checkDate}`
            : `No conflicts found for ${scheduledTime} on ${checkDate}`;

        console.log(successMsg);
        return { success: true, conflicts, message: successMsg };

    } catch (err) {
        console.error(`Unexpected error in FindScheduleConflicts for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

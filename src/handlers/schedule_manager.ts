import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
    AddSchedule,
    CompleteSchedule,
    DeleteSchedule,
    FindScheduleConflicts,
    ListSchedules,
    SearchSchedules,
    UpdateSchedule,
} from './schedule_handler.ts';
import '../config/types.d.ts';
import { Logger } from '../utils/logger.ts';

const logger = new Logger('[ScheduleMgr]');

/**
 * Unified schedule management function that handles all schedule operations
 * through a modal interface.
 *
 * @param supabase - The Supabase client instance scoped to the user
 * @param userId - The ID of the user
 * @param mode - The schedule operation mode: "List", "Add", "Update", "Delete", "Search", "CheckConflict", or "Complete"
 * @param scheduleId - Schedule ID (required for Update/Delete operations)
 * @param title - Schedule title (required for Add, optional for Update)
 * @param scheduledTime - Time for schedule in natural language or HH:MM format (required for Add, optional for Update)
 * @param scheduleType - Type of schedule: 'once', 'daily', 'weekly', 'custom' (optional, defaults to 'once')
 * @param description - Additional description (optional)
 * @param schedulePattern - Complex schedule pattern for weekly/custom types (optional)
 * @param targetDate - Target date for one-time schedules in YYYY-MM-DD format (optional, defaults to today)
 * @param query - Search query for Search mode (required for Search)
 * @returns An object containing success status and relevant data or error message
 */
export async function ScheduleManager(
    supabase: SupabaseClient,
    userId: string,
    mode: 'List' | 'Add' | 'Update' | 'Delete' | 'Search' | 'CheckConflict' | 'Complete',
    scheduleId?: string | null,
    title?: string | null,
    scheduledTime?: string | null,
    scheduleType?: 'once' | 'daily' | 'weekly' | 'custom' | null,
    description?: string | null,
    schedulePattern?: ISchedulePattern | null,
    targetDate?: string | null,
    query?: string | null,
): Promise<{ success: boolean; data?: any; message: string }> {
    logger.info(`ScheduleManager called: mode=${mode}, userId=${userId}`);

    // Validate mode
    if (
        !['List', 'Add', 'Update', 'Delete', 'Search', 'CheckConflict', 'Complete'].includes(mode)
    ) {
        return {
            success: false,
            message:
                "Invalid mode. Must be 'List', 'Add', 'Update', 'Delete', 'Search', 'CheckConflict', or 'Complete'.",
        };
    }

    try {
        switch (mode) {
            case 'List':
                // List all schedules with current time
                const listResult = await ListSchedules(supabase, userId);
                return {
                    success: listResult.success,
                    data: listResult.data,
                    message: listResult.message,
                };

            case 'Add':
                // Add new schedule
                if (!title || typeof title !== 'string' || !title.trim()) {
                    return {
                        success: false,
                        message: 'title is required for adding a new schedule.',
                    };
                }
                if (!scheduledTime || typeof scheduledTime !== 'string' || !scheduledTime.trim()) {
                    return {
                        success: false,
                        message: 'scheduledTime is required for adding a new schedule.',
                    };
                }

                // Check for conflicts before adding
                const conflictResult = await FindScheduleConflicts(
                    supabase,
                    userId,
                    scheduledTime,
                    targetDate,
                );

                if (
                    conflictResult.success && conflictResult.conflicts &&
                    conflictResult.conflicts.length > 0
                ) {
                    const conflictTitles = conflictResult.conflicts.map((s) => s.title).join(', ');
                    return {
                        success: false,
                        data: conflictResult.conflicts,
                        message:
                            `Schedule conflict detected! You already have these schedules at ${scheduledTime}: ${conflictTitles}. Please choose a different time or update the existing schedule.`,
                    };
                }

                const addResult = await AddSchedule(
                    supabase,
                    userId,
                    title,
                    scheduledTime,
                    scheduleType || 'once',
                    description,
                    schedulePattern,
                    targetDate,
                );
                return {
                    success: addResult.success,
                    data: addResult.schedule,
                    message: addResult.message,
                };

            case 'Update':
                // Update existing schedule
                if (!scheduleId || typeof scheduleId !== 'string' || !scheduleId.trim()) {
                    return {
                        success: false,
                        message: 'scheduleId is required for updating a schedule.',
                    };
                }

                const updateResult = await UpdateSchedule(
                    supabase,
                    userId,
                    scheduleId,
                    title,
                    scheduledTime,
                    scheduleType,
                    description,
                    schedulePattern,
                    targetDate,
                );
                return {
                    success: updateResult.success,
                    data: updateResult.schedule,
                    message: updateResult.message,
                };

            case 'Delete':
                // Delete schedule
                if (!scheduleId || typeof scheduleId !== 'string' || !scheduleId.trim()) {
                    return {
                        success: false,
                        message: 'scheduleId is required for deleting a schedule.',
                    };
                }

                const deleteResult = await DeleteSchedule(supabase, userId, scheduleId);
                return {
                    success: deleteResult.success,
                    message: deleteResult.message,
                };

            case 'Search':
                // Search schedules
                if (!query || typeof query !== 'string' || !query.trim()) {
                    return {
                        success: false,
                        message: 'query is required for searching schedules.',
                    };
                }

                const searchResult = await SearchSchedules(supabase, userId, query);
                return {
                    success: searchResult.success,
                    data: searchResult.schedules,
                    message: searchResult.message,
                };

            case 'CheckConflict':
                // Check for schedule conflicts
                if (!scheduledTime || typeof scheduledTime !== 'string' || !scheduledTime.trim()) {
                    return {
                        success: false,
                        message: 'scheduledTime is required for checking conflicts.',
                    };
                }

                const checkResult = await FindScheduleConflicts(
                    supabase,
                    userId,
                    scheduledTime,
                    targetDate,
                    scheduleId,
                );
                return {
                    success: checkResult.success,
                    data: checkResult.conflicts,
                    message: checkResult.message,
                };

            case 'Complete':
                // Complete and archive schedule
                if (!scheduleId || typeof scheduleId !== 'string' || !scheduleId.trim()) {
                    return {
                        success: false,
                        message: 'scheduleId is required for completing a schedule.',
                    };
                }

                const completeResult = await CompleteSchedule(supabase, userId, scheduleId);
                return {
                    success: completeResult.success,
                    data: completeResult.schedule,
                    message: completeResult.message,
                };

            default:
                return { success: false, message: 'Invalid mode/action combination.' };
        }
    } catch (err) {
        logger.error(`Unexpected error in ScheduleManager for user ${userId}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { success: false, message: `An unexpected error occurred: ${errorMessage}` };
    }
}

/**
 * Time utilities for handling UTC+7 timezone and schedule operations
 */

/**
 * Gets the current time in UTC+7 timezone
 * @returns Object with current time and date in UTC+7
 */
export function getCurrentTimeUTC7(): { current_time_utc7: string; current_date_utc7: string } {
    const now = new Date();
    // Convert to UTC+7 (7 hours ahead of UTC)
    const utc7Time = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    
    return {
        current_time_utc7: utc7Time.toISOString(),
        current_date_utc7: utc7Time.toISOString().split('T')[0] // YYYY-MM-DD format
    };
}

/**
 * Converts a time string (HH:MM) to minutes since midnight
 * @param timeStr - Time in HH:MM format
 * @returns Minutes since midnight
 */
export function timeToMinutes(timeStr: string): number {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Converts minutes since midnight to time string (HH:MM)
 * @param minutes - Minutes since midnight
 * @returns Time in HH:MM format
 */
export function minutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

/**
 * Validates time format (HH:MM or HH:MM:SS)
 * @param timeStr - Time string to validate
 * @returns True if valid, false otherwise
 */
export function isValidTimeFormat(timeStr: string): boolean {
    // Accept both HH:MM and HH:MM:SS formats
    const timeRegexHHMM = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    const timeRegexHHMMSS = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
    return timeRegexHHMM.test(timeStr) || timeRegexHHMMSS.test(timeStr);
}

/**
 * Validates date format (YYYY-MM-DD)
 * @param dateStr - Date string to validate
 * @returns True if valid, false otherwise
 */
export function isValidDateFormat(dateStr: string): boolean {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) return false;
    
    const date = new Date(dateStr);
    return date.toISOString().split('T')[0] === dateStr;
}

/**
 * Parses natural language time input to HH:MM:SS format for Supabase TIME type
 * @param input - Natural language time (e.g., "6am", "7pm", "18:30")
 * @returns Time in HH:MM:SS format or null if invalid
 */
export function parseTimeInput(input: string): string | null {
    const cleanInput = input.toLowerCase().trim();

    // Handle formats like "6am", "7pm"
    const amPmMatch = cleanInput.match(/^(\d{1,2})\s*(am|pm)$/);
    if (amPmMatch) {
        let hours = parseInt(amPmMatch[1]);
        const period = amPmMatch[2];

        if (hours < 1 || hours > 12) return null;

        if (period === 'pm' && hours !== 12) hours += 12;
        if (period === 'am' && hours === 12) hours = 0;

        return `${hours.toString().padStart(2, '0')}:00:00`;
    }

    // Handle formats like "18:30", "6:30"
    const timeMatch = cleanInput.match(/^(\d{1,2}):(\d{2})$/);
    if (timeMatch) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);

        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`;
    }

    // Handle formats like "18:30:45" (full time with seconds)
    const fullTimeMatch = cleanInput.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (fullTimeMatch) {
        const hours = parseInt(fullTimeMatch[1]);
        const minutes = parseInt(fullTimeMatch[2]);
        const seconds = parseInt(fullTimeMatch[3]);

        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) return null;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    // Handle formats like "6", "18" (assume :00:00)
    const hourMatch = cleanInput.match(/^(\d{1,2})$/);
    if (hourMatch) {
        const hours = parseInt(hourMatch[1]);

        if (hours < 0 || hours > 23) return null;

        return `${hours.toString().padStart(2, '0')}:00:00`;
    }

    return null;
}

/**
 * Formats time for display (e.g., "06:00:00" -> "6:00 AM", "06:00" -> "6:00 AM")
 * @param timeStr - Time in HH:MM or HH:MM:SS format
 * @returns Formatted time string
 */
export function formatTimeForDisplay(timeStr: string): string {
    // Handle both HH:MM and HH:MM:SS formats
    const timeParts = timeStr.split(':');
    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);

    if (hours === 0) {
        return `12:${minutes.toString().padStart(2, '0')} AM`;
    } else if (hours < 12) {
        return `${hours}:${minutes.toString().padStart(2, '0')} AM`;
    } else if (hours === 12) {
        return `12:${minutes.toString().padStart(2, '0')} PM`;
    } else {
        return `${hours - 12}:${minutes.toString().padStart(2, '0')} PM`;
    }
}

/**
 * Gets today's date in YYYY-MM-DD format (UTC+7)
 * @returns Today's date string
 */
export function getTodayUTC7(): string {
    return getCurrentTimeUTC7().current_date_utc7;
}

/**
 * Checks if a schedule should trigger today based on its pattern
 * @param schedule - The schedule to check
 * @param currentDate - Current date in YYYY-MM-DD format (UTC+7)
 * @returns True if schedule should trigger today
 */
export function shouldScheduleTriggerToday(schedule: ISchedule, currentDate: string): boolean {
    if (!schedule.is_active) return false;
    
    const today = new Date(currentDate);
    const dayOfWeek = today.getDay(); // 0=Sunday, 1=Monday, etc.
    
    switch (schedule.schedule_type) {
        case 'once':
            return schedule.target_date === currentDate;
            
        case 'daily':
            return true;
            
        case 'weekly':
            if (schedule.schedule_pattern?.weekdays) {
                return schedule.schedule_pattern.weekdays.includes(dayOfWeek);
            }
            return false;
            
        case 'custom':
            if (schedule.schedule_pattern?.specific_dates) {
                return schedule.schedule_pattern.specific_dates.includes(currentDate);
            }
            // Handle skip_days pattern
            if (schedule.schedule_pattern?.skip_days) {
                const createdDate = new Date(schedule.created_at.split('T')[0]);
                const daysDiff = Math.floor((today.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));
                return daysDiff % (schedule.schedule_pattern.skip_days + 1) === 0;
            }
            return false;
            
        default:
            return false;
    }
}

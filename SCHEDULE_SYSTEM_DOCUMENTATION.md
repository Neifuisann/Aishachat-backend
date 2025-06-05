# Schedule Management System

## Overview

The Schedule Management System extends the existing note-taking functionality to include time-based reminders and tasks. It follows the same modal tool calling pattern as the Notes and Persona systems, providing a unified interface through the `ManageData` function.

## Features

### Core Functionality
- **List Schedules**: Get all active schedules with current UTC+7 time
- **Add Schedules**: Create new time-based reminders
- **Update Schedules**: Modify existing schedules
- **Delete Schedules**: Remove schedules with confirmation
- **Search Schedules**: Find schedules by title or description
- **Conflict Detection**: Automatically detect scheduling conflicts

### Schedule Types
1. **Once**: Single occurrence on a specific date (defaults to today)
2. **Daily**: Repeats every day
3. **Weekly**: Repeats on specific days of the week
4. **Custom**: Complex patterns (skip days, specific dates)

### Time Handling
- **UTC+7 Timezone**: All times are handled in UTC+7 timezone
- **Natural Language**: Supports "6am", "7pm", "18:30" formats
- **Flexible Input**: Accepts various time formats and converts automatically

## Database Schema

### schedules table
- `schedule_id` (UUID, Primary Key)
- `user_id` (UUID, Foreign Key to users)
- `title` (TEXT, NOT NULL) - e.g., "Take a drink", "Take a walk"
- `description` (TEXT, NULLABLE) - Additional details
- `scheduled_time` (TIME, NOT NULL) - Time of day (HH:MM:SS format for Supabase)
- `schedule_type` (TEXT, NOT NULL) - 'once', 'daily', 'weekly', 'custom'
- `schedule_pattern` (JSONB, NULLABLE) - Complex patterns
- `target_date` (DATE, NULLABLE) - For one-time schedules
- `is_active` (BOOLEAN, NOT NULL, DEFAULT true)
- `created_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW())
- `updated_at` (TIMESTAMPTZ, NOT NULL, DEFAULT NOW())

### Schedule Pattern Examples
```json
// Weekly schedule (Monday, Wednesday, Friday)
{
  "weekdays": [1, 3, 5]
}

// Custom skip pattern (every 3 days)
{
  "skip_days": 2
}

// Specific dates
{
  "specific_dates": ["2024-12-25", "2024-12-31"]
}

// With end date
{
  "weekdays": [1, 2, 3, 4, 5],
  "end_date": "2024-12-31"
}
```

## API Interface

### ScheduleManager Function
The schedule system has its own dedicated `ScheduleManager` function, separate from `ManageData`:

```typescript
ScheduleManager(
    supabase: SupabaseClient,
    userId: string,
    mode: "List" | "Add" | "Update" | "Delete" | "Search" | "CheckConflict",
    scheduleId?: string,
    title?: string,
    scheduledTime?: string,
    scheduleType?: 'once' | 'daily' | 'weekly' | 'custom',
    description?: string,
    schedulePattern?: ISchedulePattern,
    targetDate?: string,
    query?: string
)
```

### Actions

#### List Schedules
```typescript
// Get all active schedules with current time
ScheduleManager(supabase, userId, "List")
```

#### Add Schedule
```typescript
// Add a simple daily reminder
ScheduleManager(supabase, userId, "Add", null, "Take a walk", "7am", "daily")

// Add a one-time reminder for today
ScheduleManager(supabase, userId, "Add", null, "Doctor appointment", "2pm", "once")

// Add a weekly reminder
ScheduleManager(supabase, userId, "Add", null, "Team meeting", "9am", "weekly", "Weekly standup", {weekdays: [1, 3, 5]})
```

#### Update Schedule
```typescript
// Update existing schedule time
ScheduleManager(supabase, userId, "Update", scheduleId, null, "8am")

// Update schedule type and pattern
ScheduleManager(supabase, userId, "Update", scheduleId, null, null, "weekly", null, {weekdays: [1, 2, 3, 4, 5]})
```

#### Delete Schedule
```typescript
ScheduleManager(supabase, userId, "Delete", scheduleId)
```

#### Search Schedules
```typescript
ScheduleManager(supabase, userId, "Search", null, null, null, null, null, null, null, "walk")
```

#### Check Conflicts
```typescript
ScheduleManager(supabase, userId, "CheckConflict", null, null, "6am", null, null, null, "2024-12-25")
```

## Conversational Flow Examples

### 1. Adding a New Schedule
**User**: "Hey remind me to take a drink at 6am"
**AI**:
1. Calls `ScheduleManager(supabase, userId, "List")` to check existing schedules
2. If no conflict: Calls `ScheduleManager(supabase, userId, "Add", null, "take a drink", "6am", "once")`
3. Responds: "I've set a reminder for you to take a drink at 6:00 AM today."

### 2. Schedule Conflict Detection
**User**: "Hey remind me to take a walk at 6am"
**AI**:
1. Calls `ScheduleManager(supabase, userId, "CheckConflict", null, null, "6am")`
2. Detects existing "take a drink" at 6am
3. Responds: "You already have a reminder to 'take a drink' at 6:00 AM. Would you like me to add this as a separate reminder or update the existing one?"

### 3. Updating Schedule
**User**: "Change my walk reminder to 8pm instead"
**AI**:
1. Calls `ScheduleManager(supabase, userId, "Search", null, null, null, null, null, null, null, "walk")` to find the schedule
2. Asks: "I found your walk reminder currently set for 7:00 AM. Do you want to change it to 8:00 PM?"
3. User confirms: "yes please"
4. Calls `ScheduleManager(supabase, userId, "Update", scheduleId, null, "8pm")`
5. Responds: "Your walk reminder has been updated to 8:00 PM."

### 4. Checking Current Schedules
**User**: "Hey check my current schedule"
**AI**:
1. Calls `ScheduleManager(supabase, userId, "List")`
2. Responds with current time and active schedules: "It's currently 7:30 AM (UTC+7). You have these reminders: Take a drink at 6:00 AM (already passed), Take a walk at 8:00 PM (in 12.5 hours)."

## Time Utilities

### Key Functions
- `getCurrentTimeUTC7()`: Gets current time and date in UTC+7
- `parseTimeInput(input)`: Converts natural language to HH:MM format
- `formatTimeForDisplay(time)`: Formats time for user-friendly display
- `shouldScheduleTriggerToday(schedule, date)`: Determines if schedule should trigger

### Time Format Handling

**AI Input (Natural Language):**
- **12-hour**: "6am", "7pm", "12pm"
- **24-hour**: "18:30", "09:00", "23:45"
- **Hour only**: "6", "18" (assumes :00 minutes)
- **Natural**: Flexible parsing with validation

**Internal Storage (Supabase TIME type):**
- **Format**: HH:MM:SS (e.g., "06:00:00", "19:00:00", "18:30:00")
- **Automatic Conversion**: AI input is automatically converted to proper format
- **Database Compatible**: Fully compatible with PostgreSQL TIME type

**Display Format (User-Friendly):**
- **Format**: "6:00 AM", "7:00 PM", "6:30 PM"
- **Automatic Formatting**: Database format is converted for display

## Integration Points

### Files Modified/Created
- `types.d.ts`: Added ISchedule, ISchedulePattern, IScheduleWithCurrentTime interfaces
- `schedule_handler.ts`: Core CRUD operations for schedules
- `schedule_manager.ts`: Unified modal interface for schedule management
- `time_utils.ts`: Time handling and timezone utilities
- `websocket_handler.ts`: Added ScheduleManager tool and function call handling

### Database
- Created `schedules` table with proper indexes and triggers
- Automatic `updated_at` timestamp management
- Foreign key constraints to users table

## Security & Performance

### Security
- Row Level Security (RLS) through user_id filtering
- All operations scoped to authenticated user
- Input validation for time formats and schedule types

### Performance
- Indexed on user_id, scheduled_time, is_active, target_date
- Efficient conflict detection queries
- Minimal data transfer with selective field updates

## Future Enhancements

### Potential Features
- **Notifications**: Push notifications for upcoming schedules
- **Snooze**: Ability to postpone schedules
- **Categories**: Group schedules by type (health, work, personal)
- **Recurring Patterns**: More complex patterns (every 2nd Tuesday, etc.)
- **Time Zones**: Support for multiple time zones
- **Calendar Integration**: Export to external calendar systems

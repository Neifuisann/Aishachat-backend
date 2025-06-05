/**
 * AI Function Calling Help System
 *
 * This module provides detailed documentation and step-by-step guidance
 * for all available AI functions. The AI must call Help(functionName)
 * before using any main function to understand parameters, flows, and examples.
 */

/**
 * Unified Help function - Get detailed documentation for any function
 *
 * @param functionName - Name of the function to get help for
 * @returns Detailed documentation for the specified function
 */
export function Help(functionName: string): { success: boolean; documentation: string } {
    switch (functionName) {
        case "GetVision":
            return getVisionHelp();
        case "SetVolume":
            return setVolumeHelp();
        case "ManageData":
            return manageDataHelp();
        case "ScheduleManager":
            return scheduleManagerHelp();
        case "ReadingManager":
            return readingManagerHelp();
        default:
            return {
                success: false,
                documentation: `Unknown function: ${functionName}. Available functions: GetVision, SetVolume, ManageData, ScheduleManager, ReadingManager`
            };
    }
}

/**
 * Help for GetVision function - Image capture and analysis
 */
function getVisionHelp(): { success: boolean; documentation: string } {
    const documentation = `
# GetVision Function Help

## Purpose
Captures an image using the device's camera and analyzes it using AI vision.

## When to Use
- User asks about visual content: "What do you see?", "Look at this", "Describe what's in front of me"
- User wants image analysis: "Read the text in this image", "What color is this object?"
- User mentions seeing something: "Can you see the document I'm holding?"

## Parameters
- **prompt** (required): Specific question about the image
  - Good examples: "What color is the object on the table?", "Read the text in this image", "Is there a person in the image?"
  - Bad examples: "Analyze", "Look", "See" (too vague)

## Example Usage Scenarios
- "What's written on this paper?" → prompt: "Read all the text visible in this image"
- "What color is my shirt?" → prompt: "What color is the person's shirt in the image?"
- "Is anyone in the room?" → prompt: "Are there any people visible in this image?"

## Important Notes
- Very resource intensive - only use when explicitly needed
- Always provide specific, clear prompts
- Don't use speculatively or for general conversation
`;

    return { success: true, documentation };
}

/**
 * Help for SetVolume function - Device volume control
 */
function setVolumeHelp(): { success: boolean; documentation: string } {
    const documentation = `
# SetVolume Function Help

## Purpose
Updates the volume setting for the user's device in the database.

## When to Use
- User mentions volume: "Turn up the volume", "Make it louder", "I can't hear"
- User mentions sound level: "The sound is too low", "Increase volume to 80"
- User has hearing issues: "Speak louder", "I need higher volume"

## Parameters
- **volumeLevel** (required): Number between 0-100
  - 0 = Mute/Silent
  - 50 = Medium volume
  - 100 = Maximum volume

## Example Usage Scenarios
- "Turn up the volume" → volumeLevel: 80
- "Make it quieter" → volumeLevel: 30
- "Set volume to maximum" → volumeLevel: 100
- "Mute the sound" → volumeLevel: 0

## Validation Rules
- Must be a number
- Must be between 0 and 100 (inclusive)
- Automatically rounded to integer
`;

    return { success: true, documentation };
}

/**
 * Help for ManageData function - Unified persona and notes management
 */
function manageDataHelp(): { success: boolean; documentation: string } {
    const documentation = `
# ManageData Function Help

## Purpose
Unified modal interface for managing persona (AI memory) and notes (user data).

## When to Use
- Note-taking: "Remember this", "Add a note", "Save this information"
- Persona management: "Update my preferences", "Remember I like coffee"
- Searching: "Find my notes about", "What do you know about me?"

## Modal Interface Structure
1. **First select mode**: "Persona" (AI memory) or "Notes" (user data)
2. **Then select action**: "Search", "Edit", or "Delete"
3. **Provide required parameters** based on mode/action combination

## PERSONA MODE
### Search
- **Purpose**: Get current AI knowledge about user preferences
- **Parameters**: mode="Persona", action="Search"
- **Returns**: Current persona text or "(No persona set)"

### Edit
- **Purpose**: Update AI's stored knowledge
- **Parameters**: mode="Persona", action="Edit", newPersona="text"
- **Example**: "Remember I prefer tea over coffee and work from home"

### Delete
- **Purpose**: Clear AI's stored knowledge
- **Parameters**: mode="Persona", action="Delete"
- **Result**: Clears all persona data

## NOTES MODE
### Search
- **Purpose**: Find user's notes
- **Required**: mode="Notes", action="Search", query="search terms"
- **Optional**: dateFrom="YYYY-MM-DD", dateTo="YYYY-MM-DD"
- **Example**: query="shopping list", dateFrom="2024-01-01"

### Edit (Add New Note)
- **Purpose**: Add new note
- **Required**: mode="Notes", action="Edit", body="note content"
- **Optional**: title="note title", imageId="image_id"
- **Example**: title="Shopping List", body="Milk, bread, eggs"

### Edit (Update Existing)
- **Purpose**: Update existing note
- **Required**: mode="Notes", action="Edit", noteId="note_id"
- **Optional**: title="new title", body="new content"
- **Requires**: User confirmation before updating

### Delete
- **Purpose**: Remove note
- **Required**: mode="Notes", action="Delete", noteId="note_id"
- **Important**: ALWAYS confirm with user before deleting

## Example Voice Lines & Usage
- "Remember I like spicy food" → Persona Edit
- "Add a note about the meeting" → Notes Edit (new)
- "Find my notes about recipes" → Notes Search
- "Update my shopping list" → Notes Edit (existing)
- "Delete that old note" → Notes Delete (with confirmation)
`;

    return { success: true, documentation };
}

/**
 * Help for ScheduleManager function - Schedule and reminder management
 */
function scheduleManagerHelp(): { success: boolean; documentation: string } {
    const documentation = `
# ScheduleManager Function Help

## Purpose
Dedicated schedule management system for all schedule and reminder operations.

## When to Use
- Scheduling: "Schedule a meeting", "Set a reminder", "Add to my calendar"
- Time management: "What's on my schedule?", "Cancel my 3pm meeting"
- Reminders: "Remind me to call mom", "Set an alarm for 6am"

## Available Modes
1. **List** - View all schedules
2. **Add** - Create new schedule
3. **Update** - Modify existing schedule
4. **Delete** - Remove schedule
5. **Search** - Find specific schedules
6. **CheckConflict** - Check for time conflicts

## MODE: List
- **Purpose**: View all user schedules with current time context
- **Parameters**: mode="List"
- **Returns**: All schedules with status (upcoming, current, past)

## MODE: Add
- **Purpose**: Create new schedule with conflict checking
- **Required**: mode="Add", title="schedule title", scheduledTime="time"
- **Optional**: scheduleType="once|daily|weekly|custom", description="details",
              schedulePattern={pattern object}, targetDate="YYYY-MM-DD"
- **Auto-conflict check**: Automatically checks for conflicts before adding

## MODE: Update
- **Purpose**: Modify existing schedule
- **Required**: mode="Update", scheduleId="schedule_id"
- **Optional**: title, scheduledTime, scheduleType, description, schedulePattern, targetDate
- **Note**: Only provided parameters are updated

## MODE: Delete
- **Purpose**: Remove schedule
- **Required**: mode="Delete", scheduleId="schedule_id"
- **Returns**: Confirmation of deletion

## MODE: Search
- **Purpose**: Find schedules by keywords
- **Required**: mode="Search", query="search terms"
- **Searches**: Title, description, and schedule details

## MODE: CheckConflict
- **Purpose**: Check for time conflicts
- **Required**: mode="CheckConflict", scheduledTime="time", targetDate="YYYY-MM-DD"
- **Returns**: List of conflicting schedules if any

## Schedule Types
- **once**: Single occurrence (default)
- **daily**: Every day
- **weekly**: Every week
- **custom**: Complex patterns using schedulePattern

## Time Format
- **Natural language**: "6am", "2:30pm", "noon", "midnight"
- **24-hour format**: "06:00", "14:30", "12:00", "00:00"
- **System converts**: Natural language → proper TIME format for database

## Example Usage Scenarios
- "What's my schedule today?" → mode="List"
- "Schedule a meeting at 2pm tomorrow" → mode="Add", title="Meeting", scheduledTime="2pm"
- "Cancel my 3pm appointment" → mode="Search" first, then mode="Delete"
- "Move my morning meeting to 10am" → mode="Update" with new scheduledTime
- "Do I have anything at 2pm?" → mode="CheckConflict"

## Important Notes
- Natural language time input is converted automatically
- Conflict checking is automatic for Add operations
- Always search first when user refers to "my meeting" or similar
- Confirm deletions and major updates with user
`;

    return { success: true, documentation };
}

/**
 * Help for ReadingManager function - Book reading system
 */
function readingManagerHelp(): { success: boolean; documentation: string } {
    const documentation = `
# ReadingManager Function Help

## Purpose
Comprehensive book reading system with history tracking, content delivery, search, and settings.

## When to Use
- Reading requests: "Read me a book", "Continue reading", "Start reading Harry Potter"
- Reading history: "Where did I stop reading?", "What books have I read?"
- Book search: "Find the word 'magic' in the book", "Search for 'chapter 5'"
- Reading settings: "Read by paragraphs", "Change reading mode to sentences"

## Modal Interface Structure
1. **First select mode**: "History", "Read", "Search", or "Settings"
2. **Then select action** based on the mode
3. **Provide required parameters** for the mode/action combination

## MODE: History
### Action: Check
- **Purpose**: Get reading progress for a specific book
- **Required**: mode="History", action="Check", bookName="book title"
- **Returns**: Current page, total pages, reading progress percentage

## MODE: Read
### Action: Continue
- **Purpose**: Resume reading from last saved position
- **Required**: mode="Read", action="Continue", bookName="book title"
- **Returns**: Content from current page with reading settings applied

### Action: Start
- **Purpose**: Begin reading from the beginning (page 1)
- **Required**: mode="Read", action="Start", bookName="book title"
- **Returns**: Content from page 1 with reading settings applied

### Action: GoTo
- **Purpose**: Jump to a specific page number
- **Required**: mode="Read", action="GoTo", bookName="book title", pageNumber=number
- **Returns**: Content from specified page

## MODE: Search
### Action: Find
- **Purpose**: Search for keywords within a book
- **Required**: mode="Search", action="Find", bookName="book title", keyword="search term"
- **Returns**: All occurrences with page numbers and context

## MODE: Settings
### Action: Get
- **Purpose**: Retrieve current reading preferences
- **Required**: mode="Settings", action="Get"
- **Returns**: Current readingMode and readingAmount

### Action: Set
- **Purpose**: Update reading preferences
- **Required**: mode="Settings", action="Set", readingMode="mode", readingAmount=number
- **Reading Modes**: "paragraphs", "sentences", "fullpage"
- **Reading Amount**: Number of units to read (1-10 for paragraphs/sentences)

## Reading Modes Explained
- **fullpage**: Reads entire page content (readingAmount ignored)
- **paragraphs**: Reads specified number of paragraphs (1-10)
- **sentences**: Reads specified number of sentences (1-10)

## Example Usage Scenarios
- "Continue reading The Hobbit" → mode="Read", action="Continue", bookName="The Hobbit"
- "Start reading from the beginning" → mode="Read", action="Start", bookName="book title"
- "Go to page 50" → mode="Read", action="GoTo", bookName="book title", pageNumber=50
- "Where did I stop in Harry Potter?" → mode="History", action="Check", bookName="Harry Potter"
- "Find the word 'dragon' in the book" → mode="Search", action="Find", keyword="dragon"
- "Read by sentences instead" → mode="Settings", action="Set", readingMode="sentences", readingAmount=3
- "What are my reading settings?" → mode="Settings", action="Get"
`;

    return { success: true, documentation };
}

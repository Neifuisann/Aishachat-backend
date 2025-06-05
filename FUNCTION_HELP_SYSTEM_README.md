# AI Function Calling Help System

## Overview
This system provides comprehensive documentation and step-by-step guidance for AI function calling to reduce confusion and improve accuracy when the AI needs to use various functions.

## System Components

### 1. Unified Help Function (`function_help_system.ts`)
- **Help(functionName)**: Single unified function that provides detailed guidance for any function
- Supports: GetVision, SetVolume, ManageData, ScheduleManager, ReadingManager
- Returns comprehensive documentation based on the requested function name

### 2. Integration (`websocket_handler.ts`)
- Unified Help function added to tool declarations
- Single help function handler processes calls and returns documentation
- System instructions updated to require help function usage

### 3. System Instructions Updates
- **Mandatory Rule**: AI must call Help(functionName) before using any main function
- **Voice Trigger Examples**: Real-life voice lines that should trigger each function
- **Function Priorities**: Clear guidelines on when to use each function

## How It Works

### Step 1: AI Receives User Request
User says something like: "Remember I like spicy food"

### Step 2: AI Calls Help Function First
AI calls `Help(functionName="ManageData")` to understand:
- Modal interface structure (Persona vs Notes)
- Required parameters for each mode/action
- Step-by-step examples
- Voice line triggers

### Step 3: AI Uses Main Function Correctly
Based on help documentation, AI calls:
```
ManageData(
  mode: "Persona",
  action: "Edit",
  newPersona: "likes spicy food"
)
```

## Function Documentation Structure

Each help function returns comprehensive documentation including:

### Purpose
Clear explanation of what the function does

### When to Use
- Specific voice triggers and user scenarios
- Real-life examples of when to call the function

### Parameters
- Required vs optional parameters
- Parameter types and validation rules
- Examples of good vs bad parameter values

### Modal Interface (where applicable)
- Step-by-step flow for complex functions
- Mode selection guidance
- Action-specific requirements

### Example Usage Scenarios
- Common user requests mapped to function calls
- Voice line examples with corresponding parameters
- Error handling and edge cases

### Important Notes
- Resource usage considerations
- Confirmation requirements
- Special handling instructions

## Voice Trigger Examples

### GetVision
- "What do you see?"
- "Look at this"
- "Describe what's in front of me"
- "Read the text in this image"
- "What color is this object?"

### SetVolume
- "Turn up the volume"
- "Make it louder"
- "I can't hear you"
- "Speak louder"
- "Set volume to 80"

### ManageData
- "Remember this information"
- "Add a note about the meeting"
- "Find my notes about recipes"
- "What do you know about my preferences?"
- "Update my shopping list"

### ScheduleManager
- "Schedule a meeting at 2pm"
- "Set a reminder for tomorrow"
- "What's on my schedule today?"
- "Cancel my 3pm appointment"
- "Remind me to call mom"

### ReadingManager
- "Read me a book"
- "Continue reading The Hobbit"
- "Where did I stop reading?"
- "Find the word 'dragon' in the book"
- "Read by paragraphs instead"

## Benefits

### For AI
- **Reduced Confusion**: Clear guidance on function usage
- **Better Parameter Selection**: Examples and validation rules
- **Improved Accuracy**: Step-by-step documentation prevents errors
- **Context Understanding**: Voice trigger examples help identify when to use functions

### For Users
- **More Reliable Function Calls**: AI makes fewer mistakes
- **Consistent Behavior**: Standardized function usage patterns
- **Better Error Handling**: AI understands edge cases and requirements
- **Natural Interaction**: Voice triggers feel more conversational

### For Developers
- **Centralized Documentation**: All function guidance in one place
- **Easy Updates**: Modify help functions to update AI behavior
- **Debugging**: Clear logs show when help functions are called
- **Scalability**: Easy to add new functions with help documentation

## System Instructions Integration

The system instructions now include:

```
MANDATORY: ALWAYS call Help(functionName) before using any main function to understand parameters and usage

FUNCTION HELP SYSTEM:
- Help(functionName="GetVision"): Get detailed guidance before using GetVision
- Help(functionName="SetVolume"): Get detailed guidance before using SetVolume
- Help(functionName="ManageData"): Get detailed guidance before using ManageData
- Help(functionName="ScheduleManager"): Get detailed guidance before using ScheduleManager
- Help(functionName="ReadingManager"): Get detailed guidance before using ReadingManager
```

## Implementation Details

### Function Declaration
The unified Help function is declared in the tools array with:
- Clear description emphasizing mandatory usage
- Required functionName parameter to specify which function needs help
- Simple response structure

### Handler Implementation
The unified help function handler:
- Calls Help(functionName) from `function_help_system.ts`
- Returns appropriate documentation based on functionName parameter
- Logs help function usage for debugging

### Error Prevention
The system prevents common errors by:
- Providing clear parameter examples
- Explaining modal interface flows
- Including validation rules
- Showing voice trigger patterns

This comprehensive help system ensures the AI has detailed guidance for every function call, significantly reducing confusion and improving the accuracy of function usage.

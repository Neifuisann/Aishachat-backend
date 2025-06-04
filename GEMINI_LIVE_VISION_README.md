# Gemini Live Vision Integration

## Overview

This implementation provides two methods for handling ESP32 image analysis:

1. **External API Method** (Default): Uses external Gemini Vision API via REST calls
2. **Direct Gemini Live Method** (New): Sends images directly through Gemini Live WebSocket

## Configuration

Add the following environment variable to your `.env` file:

```env
# Vision Processing Method
# Set to "true" to use direct Gemini Live WebSocket for image analysis
# Set to "false" or omit to use external Gemini Vision API (default)
USE_GEMINI_LIVE_VISION=false
```

## How It Works

### External API Method (Default)
- ESP32 captures image → Rotates 180° → Uploads to Supabase → Calls external Gemini Vision API → Returns result via function response

### Direct Gemini Live Method (New)
- ESP32 captures image → Rotates 180° → Uploads to Supabase → Sends image directly through Gemini Live WebSocket → Gemini Live analyzes and responds directly

## Key Differences

| Feature | External API | Direct Gemini Live |
|---------|-------------|-------------------|
| **Latency** | Higher (REST API call) | Lower (direct WebSocket) |
| **Function Response** | Required | Not needed |
| **API Usage** | Uses Vision API quota | Uses Live API quota |
| **Integration** | Function calling pattern | Direct multimodal input |
| **Error Handling** | Separate error handling | Integrated with Live session |

## Implementation Details

### Configuration Import
```typescript
import { USE_GEMINI_LIVE_VISION } from "./config.ts";
```

### Image Processing Logic
```typescript
if (USE_GEMINI_LIVE_VISION) {
    // Direct method: Send image through Gemini Live WebSocket
    const imageMessage = {
        realtime_input: {
            media_chunks: [{
                data: processedBase64Jpeg,
                mime_type: "image/jpeg"
            }]
        }
    };
    geminiWs.send(JSON.stringify(imageMessage));
    
    // Send prompt as text message
    const promptMessage = {
        clientContent: {
            turns: [{
                role: "user",
                parts: [{ text: pendingVisionCall.prompt }]
            }],
            turnComplete: true
        }
    };
    geminiWs.send(JSON.stringify(promptMessage));
} else {
    // External method: Use external Gemini Vision API
    visionResult = await callGeminiVision(processedBase64Jpeg, pendingVisionCall.prompt);
}
```

### Function Response Handling
```typescript
// Only send function response for external API method
if (!USE_GEMINI_LIVE_VISION && isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
    // Send function response...
} else if (USE_GEMINI_LIVE_VISION) {
    console.log("Using direct vision method, no function response needed");
}
```

## Benefits of Direct Method

1. **Lower Latency**: No additional REST API call
2. **Better Integration**: Seamless with Gemini Live conversation flow
3. **Unified Context**: Image analysis happens within the same session context
4. **Natural Responses**: Gemini can respond more naturally to visual content

## Usage

1. Set `USE_GEMINI_LIVE_VISION=true` in your environment
2. Restart the server
3. Ask for image analysis as usual: "What do you see?" or "Describe this image"
4. The system will automatically use the direct method

## Backward Compatibility

- Default behavior remains unchanged (external API method)
- Existing function calling interface is preserved
- No breaking changes to client code

## Testing

To test the new feature:

1. Set `USE_GEMINI_LIVE_VISION=true`
2. Connect ESP32 device
3. Request image analysis
4. Check logs for "Using Gemini Live direct vision" messages
5. Verify image analysis works correctly

## Troubleshooting

### Common Issues

1. **Image not analyzed**: Check Gemini Live WebSocket connection status
2. **Function response errors**: Ensure `USE_GEMINI_LIVE_VISION=true` is set correctly
3. **Latency issues**: Direct method should be faster; check WebSocket connection

### Debug Logs

Look for these log messages:
- `"Using Gemini Live direct vision with prompt: ..."`
- `"Gemini Live => Sent image directly through WebSocket"`
- `"Using direct vision method, no function response needed"`

## Future Enhancements

- Support for multiple images in single request
- Enhanced error handling for direct method
- Performance metrics comparison
- Automatic fallback between methods

# API Key Rotation System Implementation

## Overview
Implemented a comprehensive API key rotation system for handling Google Gemini API quota exceeded errors. The system automatically rotates through multiple API keys before falling back to retry delays.

## Key Features

### 1. **ApiKeyManager Class** (config.ts)
- Manages a pool of 7 API keys (1 primary + 6 additional)
- Tracks current active key index
- Provides rotation and reset functionality
- Detects when all keys are exhausted

### 2. **Immediate Key Rotation** (websocket_handler.ts)
- On quota exceeded error, immediately rotates to next available key
- Only uses retry delays when ALL keys are exhausted
- Resets key rotation when starting a new retry cycle
- Maintains existing retry logic as fallback

### 3. **Vision API Integration** (vision.ts)
- Updated to use dynamic API key from rotation system
- Implements quota handling with automatic key rotation
- Tries all available keys before failing

### 4. **Backward Compatibility**
- Existing code continues to work
- Gradual migration to new system
- Maintains all existing functionality

## API Keys Pool
```
Primary Key: From GEMINI_API_KEY environment variable
Additional Keys:
1. AIzaSyAwwEL1GPN-bdH0wJFlJG_EugrG5do8cxM
2. AIzaSyApMQGrsx0y3_GVJw13MgrFCLa7LBwQCOs
3. AIzaSyBPcFqnv3ZWHt-pRkGl9V_o_Sd79VNnSug
4. AIzaSyBYxmLg3eomM-2jCOjyuM68w21QkSTfRkQ
5. AIzaSyBE9yOQvzS93FZckeqzrdrazvec21CdKb8
6. AIzaSyBE9yOQvzS93FZckeqzrdrazvec21CdKb8 (duplicate removed)
```

## How It Works

### Normal Operation
1. System starts with first API key
2. Makes requests using current active key
3. On success, continues with same key

### Quota Exceeded Handling
1. **WebSocket Connection**: Immediately rotates to next key and reconnects
2. **Vision API**: Tries all keys in sequence before failing
3. **All Keys Exhausted**: Falls back to retry delays (15s, 30s, 60s, 180s)
4. **Retry Cycle**: Resets rotation and tries all keys again

### Key Rotation Flow
```
Key 1 → Quota → Key 2 → Quota → Key 3 → ... → Key 6 → Quota → Retry Delays
                                                                      ↓
Key 1 ← Reset ← Wait 15s ← All Keys Exhausted ← Key 6 ← Quota ← Key 5
```

## Benefits

1. **Maximized API Usage**: Uses all available keys before waiting
2. **Reduced Downtime**: Immediate rotation instead of delays
3. **Automatic Recovery**: Self-healing system with retry logic
4. **Scalable**: Easy to add more keys to the pool
5. **Monitoring**: Comprehensive logging of rotation events

## Files Modified

- **config.ts**: Added ApiKeyManager class and key pool
- **websocket_handler.ts**: Updated quota handling with key rotation
- **vision.ts**: Added key rotation for vision API calls
- **main.ts**: Cleaned up duplicate code and imports

## Testing

Created `test_api_rotation.ts` to verify:
- ✅ Key pool initialization
- ✅ Rotation through all keys
- ✅ Exhaustion detection
- ✅ Reset functionality

## Usage

The system works automatically - no code changes needed for existing functionality. The rotation happens transparently when quota errors occur.

### Manual Control (if needed)
```typescript
import { apiKeyManager } from "./config.ts";

// Get current key
const currentKey = apiKeyManager.getCurrentKey();

// Rotate to next key
const success = apiKeyManager.rotateToNextKey();

// Check if exhausted
const exhausted = apiKeyManager.areAllKeysExhausted();

// Reset rotation
apiKeyManager.resetRotation();
```

## Monitoring

Watch for these log messages:
- `"Initialized API key pool with X keys"`
- `"Rotated to API key X/Y"`
- `"All API keys have been exhausted. Will retry with delays."`
- `"Reset API key rotation to start from first key"`
- `"Quota exceeded. Rotating to next API key and retrying immediately..."`

## Future Enhancements

1. **Dynamic Key Management**: Load keys from database/config
2. **Key Health Monitoring**: Track success rates per key
3. **Load Balancing**: Distribute requests across healthy keys
4. **Rate Limiting**: Prevent rapid exhaustion of keys

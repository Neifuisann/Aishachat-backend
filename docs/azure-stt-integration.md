# Azure Speech-to-Text Integration

## Overview

The AISHA server now supports Azure Speech-to-Text (STT) as an alternative to Gemini Live for speech recognition. This integration provides improved accuracy for Vietnamese language processing and allows for a more modular architecture.

## Architecture

### Traditional Flow (Gemini Live)
```
Audio Input → Gemini Live (STT + LLM) → Gemini/Azure TTS → Audio Output
```

### New Azure STT Flow
```
Audio Input → Azure STT → Flash 2.5 (LLM) → Azure TTS → Audio Output
```

## Key Benefits

1. **Improved Vietnamese Recognition**: Azure STT provides better accuracy for Vietnamese language
2. **Modular Architecture**: Separate STT, LLM, and TTS components for better flexibility
3. **Fallback Support**: Automatic fallback to Gemini Live if Azure STT fails
4. **Cost Optimization**: Use different providers for different components based on cost/quality needs

## Configuration

### Environment Variables

Add these variables to your `.env` file:

```bash
# STT Provider Selection
STT_PROVIDER=AZURE_STT  # Options: GEMINI_LIVE, AZURE_STT

# Azure STT Configuration
AZURE_STT_KEY=your_azure_speech_key
AZURE_STT_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com
AZURE_STT_LANGUAGE=vi-VN

# Azure TTS Configuration (optional, if using Azure TTS)
TTS_PROVIDER=AZURE_TTS  # Options: GEMINI, AZURE_TTS
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com
```

### Azure Speech Service Setup

1. Create an Azure Speech Service resource in the Azure Portal
2. Copy the API key and endpoint URL
3. Set the appropriate region (e.g., Southeast Asia for better latency)
4. Configure the environment variables as shown above

## Implementation Details

### Core Components

#### 1. Azure STT Module (`src/audio/azure_stt.ts`)
- **AzureSTTManager**: Main class for managing STT operations
- **AzureSTTStreaming**: Handles streaming audio processing
- **convertSpeechToText**: Batch speech recognition function
- **validateAzureSTTConfig**: Configuration validation

#### 2. Configuration System (`src/config/config.ts`)
- **STT_PROVIDER**: Environment variable for provider selection
- **getEffectiveSTTProvider()**: Returns active STT provider with fallback
- **validateSTTProvider()**: Validates provider configuration

#### 3. WebSocket Handler Integration (`src/handlers/websocket_handler.ts`)
- Modified audio processing pipeline
- Azure STT manager initialization
- Transcription callback handling
- Proper cleanup procedures

### Audio Processing Flow

1. **Audio Input**: Microphone audio received via WebSocket
2. **Audio Filtering**: Applied gain and filtering (same as before)
3. **STT Routing**: Audio routed to Azure STT or Gemini Live based on configuration
4. **Transcription**: Azure STT processes audio and returns text
5. **LLM Processing**: Flash 2.5 processes transcribed text
6. **TTS Generation**: Response converted to speech via Azure TTS or Gemini
7. **Audio Output**: Generated audio sent to device

### Error Handling

- **Configuration Validation**: Checks Azure credentials on startup
- **Fallback Mechanism**: Automatically falls back to Gemini Live if Azure STT fails
- **Retry Logic**: Implements retry for transient Azure service errors
- **Graceful Degradation**: System continues to function even if Azure services are unavailable

## API Reference

### AzureSTTManager

```typescript
class AzureSTTManager {
    constructor(
        onTranscription: (text: string, isFinal: boolean) => void,
        onError: (error: string) => void,
        config?: AzureSTTConfig
    )
    
    async initialize(): Promise<boolean>
    addAudioChunk(audioChunk: Uint8Array): void
    async finishSpeech(): Promise<void>
    disconnect(): void
    isReady(): boolean
}
```

### Configuration Types

```typescript
interface AzureSTTConfig {
    language?: string;                    // Default: 'vi-VN'
    profanityOption?: 'masked' | 'removed' | 'raw';
    outputFormat?: 'simple' | 'detailed';
    enableWordLevelTimestamps?: boolean;
    enableDiarization?: boolean;
}
```

## Testing

### Running Tests

```bash
# Run all Azure STT integration tests
deno test --allow-all --no-check tests/azure_stt_integration_test.ts

# Run specific test categories
deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Configuration"
deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Integration Flow"

# Run test runner with environment check
deno run --allow-all tests/run_tests.ts
```

### Test Coverage

- ✅ Configuration validation
- ✅ Audio file loading and processing
- ✅ Azure STT speech recognition
- ✅ Flash 2.5 text processing
- ✅ Azure TTS text-to-speech
- ✅ Complete integration flow
- ✅ Streaming functionality
- ✅ Error handling and fallbacks

### Test Audio

Tests use `debug/noisy_env.wav` as sample audio. The file should be:
- Format: WAV (16-bit PCM)
- Sample Rate: 16kHz
- Channels: Mono
- Language: Vietnamese

## Monitoring and Debugging

### Logging

Enable detailed logging for debugging:

```bash
AUDIO_DEBUG=true
AUDIO_DEBUG_DIR=./debug_audio
```

### Log Messages

- `[AzureSTT]` - Azure STT processing messages
- `[Flash]` - Flash 2.5 processing messages
- `[Config]` - Configuration and validation messages

### Common Issues

1. **"Azure STT configuration is invalid"**
   - Check `AZURE_STT_KEY` is set correctly
   - Verify endpoint URL matches your Azure region
   - Ensure Speech service is active in Azure

2. **404 Resource not found**
   - Verify the endpoint URL is correct
   - Check the API key has proper permissions
   - Ensure the Speech service is deployed in the specified region

3. **No transcription results**
   - Check audio format (16kHz, 16-bit, mono)
   - Verify language setting matches audio content
   - Check audio quality and volume levels

## Performance Considerations

### Latency
- Azure STT: ~200-500ms additional latency compared to Gemini Live
- Network latency depends on Azure region selection
- Batch processing may have higher latency than streaming

### Accuracy
- Azure STT generally provides better accuracy for Vietnamese
- Supports various Vietnamese dialects and accents
- Better handling of technical terms and proper nouns

### Cost
- Azure STT: Pay-per-use model
- Free tier: 5 hours per month
- Standard tier: $1 per hour (as of 2025)
- Monitor usage in Azure portal

## Migration Guide

### From Gemini Live to Azure STT

1. **Set up Azure Speech Service**
2. **Configure environment variables**
3. **Test with sample audio**
4. **Monitor performance and accuracy**
5. **Adjust configuration as needed**

### Rollback Procedure

To rollback to Gemini Live:

```bash
# Set STT provider back to Gemini Live
STT_PROVIDER=GEMINI_LIVE
```

Restart the server. The system will automatically use Gemini Live for speech recognition.

## Troubleshooting

### Debug Steps

1. **Check Configuration**
   ```bash
   deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Configuration"
   ```

2. **Test Audio Loading**
   ```bash
   deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Load Test Audio"
   ```

3. **Verify Azure Connectivity**
   ```bash
   deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Azure STT Speech"
   ```

4. **Test Complete Flow**
   ```bash
   deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Complete Integration"
   ```

### Support

For issues related to:
- **Azure STT Integration**: Check this documentation and test suite
- **Azure Speech Service**: Refer to Azure documentation
- **Flash 2.5 Processing**: Check Flash handler logs
- **Audio Processing**: Enable audio debugging

## Future Enhancements

### Planned Features
- Real-time streaming WebSocket support for Azure STT
- Multiple language detection and switching
- Custom vocabulary and pronunciation models
- Advanced audio preprocessing

### Optimization Opportunities
- Audio chunk size optimization
- Parallel processing for multiple audio streams
- Caching for frequently used phrases
- Regional endpoint selection based on user location

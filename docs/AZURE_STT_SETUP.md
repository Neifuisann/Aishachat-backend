# Azure Speech-to-Text Integration Setup

This guide explains how to set up and use the Azure Speech-to-Text (STT) integration with AISHA server.

## Overview

The Azure STT integration provides an alternative to Gemini Live for speech recognition, allowing the following flow:
- **Audio Input** → **Azure STT** → **Flash 2.5** → **Azure TTS** → **Audio Output**

## Environment Variables

Add the following environment variables to your `.env` file:

### STT Provider Configuration
```bash
# Set STT provider to Azure (default: GEMINI_LIVE)
STT_PROVIDER=AZURE_STT

# Azure STT Configuration
AZURE_STT_KEY=your_azure_speech_key_here
AZURE_STT_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com
AZURE_STT_LANGUAGE=vi-VN
```

### TTS Provider Configuration (if using Azure TTS)
```bash
# Set TTS provider to Azure (default: GEMINI)
TTS_PROVIDER=AZURE_TTS

# Azure TTS Configuration
AZURE_SPEECH_KEY=your_azure_speech_key_here
AZURE_SPEECH_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com
AZURE_TTS_DEFAULT_VOICE=vi-VN-HoaiMyNeural
```

## Azure Speech Service Setup

1. **Create Azure Speech Service Resource**
   - Go to [Azure Portal](https://portal.azure.com)
   - Create a new "Speech" resource
   - Choose your preferred region (e.g., Southeast Asia)
   - Get the API key and endpoint

2. **Configure API Keys**
   - Copy the primary or secondary key from your Speech resource
   - Set it as `AZURE_STT_KEY` and `AZURE_SPEECH_KEY` in your environment
   - Update the endpoint URL if using a different region

## Supported Languages

The Azure STT integration supports multiple languages. Common options:
- `vi-VN` - Vietnamese
- `en-US` - English (US)
- `zh-CN` - Chinese (Simplified)
- `ja-JP` - Japanese

## Testing the Integration

1. **Run the test suite:**
   ```bash
   deno run --allow-all tests/run_tests.ts
   ```

2. **Test individual components:**
   ```bash
   # Test Azure STT configuration
   deno test --allow-all tests/azure_stt_integration_test.ts --filter "Azure STT Configuration"
   
   # Test complete flow
   deno test --allow-all tests/azure_stt_integration_test.ts --filter "Complete Integration Flow"
   ```

3. **Test with audio file:**
   The tests use `debug/noisy_env.wav` as test audio. Make sure this file exists.

## How It Works

### Normal Gemini Live Flow
```
Audio Input → Gemini Live (STT + LLM) → Gemini/Azure TTS → Audio Output
```

### Azure STT Flow
```
Audio Input → Azure STT → Flash 2.5 (LLM) → Azure TTS → Audio Output
```

### Key Components

1. **AzureSTTManager** (`src/audio/azure_stt.ts`)
   - Handles real-time audio streaming to Azure STT
   - Manages WebSocket connections for continuous recognition
   - Buffers audio chunks for optimal processing

2. **Configuration** (`src/config/config.ts`)
   - `STT_PROVIDER` environment variable controls which STT to use
   - Validation functions ensure proper configuration
   - Fallback to Gemini Live if Azure STT fails

3. **WebSocket Handler** (`src/handlers/websocket_handler.ts`)
   - Routes audio chunks based on STT provider
   - Integrates Azure STT transcription with Flash 2.5
   - Maintains existing TTS processing pipeline

## Troubleshooting

### Common Issues

1. **"Azure STT configuration is invalid"**
   - Check that `AZURE_STT_KEY` is set correctly
   - Verify the endpoint URL is correct for your region
   - Ensure the Speech service is active in Azure

2. **"Failed to initialize Azure STT Manager"**
   - Check network connectivity to Azure
   - Verify API key permissions
   - Check Azure service quotas and limits

3. **No transcription results**
   - Ensure audio format is correct (16kHz, 16-bit, mono PCM)
   - Check the language setting matches your audio
   - Verify audio quality and volume levels

### Debug Mode

Enable debug logging by setting:
```bash
AUDIO_DEBUG=true
AUDIO_DEBUG_DIR=./debug_audio
```

This will save audio files for analysis.

## Performance Considerations

- **Latency**: Azure STT may have slightly higher latency than Gemini Live
- **Accuracy**: Azure STT often provides better accuracy for Vietnamese
- **Cost**: Monitor Azure Speech service usage and costs
- **Fallback**: System automatically falls back to Gemini Live if Azure STT fails

## Switching Between Modes

You can switch between STT providers by changing the environment variable:

```bash
# Use Azure STT
STT_PROVIDER=AZURE_STT

# Use Gemini Live (default)
STT_PROVIDER=GEMINI_LIVE
```

Restart the server after changing the configuration.

## API Limits

Azure Speech Service has the following limits:
- **Free tier**: 5 hours per month
- **Standard tier**: Pay per use
- **Concurrent connections**: Varies by tier
- **Request rate**: Up to 20 requests per second

Monitor your usage in the Azure portal to avoid service interruptions.

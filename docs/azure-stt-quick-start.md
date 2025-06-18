# Azure STT Quick Start Guide

## 🚀 Quick Setup (5 minutes)

### 1. Azure Setup
1. Go to [Azure Portal](https://portal.azure.com)
2. Create "Speech" resource
3. Copy API key and endpoint

### 2. Environment Configuration
Add to your `.env` file:
```bash
STT_PROVIDER=AZURE_STT
AZURE_STT_KEY=your_key_here
AZURE_STT_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com
AZURE_STT_LANGUAGE=vi-VN
```

### 3. Test Setup
```bash
deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Configuration"
```

### 4. Start Server
```bash
deno run --allow-all main.ts
```

## 🔄 Switching Between Modes

### Use Azure STT
```bash
STT_PROVIDER=AZURE_STT
```

### Use Gemini Live (Default)
```bash
STT_PROVIDER=GEMINI_LIVE
```

## 🧪 Testing

### Quick Test
```bash
deno run --allow-all tests/run_tests.ts
```

### Full Integration Test
```bash
deno test --allow-all --no-check tests/azure_stt_integration_test.ts --filter "Complete Integration Flow"
```

## 📊 Audio Flow

### Gemini Live Mode
```
Audio → Gemini Live → Audio Output
```

### Azure STT Mode
```
Audio → Azure STT → Flash 2.5 → Azure TTS → Audio Output
```

## ⚠️ Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| 404 Resource not found | Check endpoint URL and region |
| Invalid configuration | Verify AZURE_STT_KEY is set |
| No transcription | Check audio format (16kHz, mono) |
| High latency | Choose closer Azure region |

### Debug Commands
```bash
# Check configuration
deno test --filter "Configuration"

# Test audio loading
deno test --filter "Load Test Audio"

# Test Azure connectivity
deno test --filter "Azure STT Speech"
```

## 📋 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STT_PROVIDER` | No | `GEMINI_LIVE` | STT provider selection |
| `AZURE_STT_KEY` | Yes* | - | Azure Speech API key |
| `AZURE_STT_ENDPOINT` | No | Southeast Asia | Azure endpoint URL |
| `AZURE_STT_LANGUAGE` | No | `vi-VN` | Recognition language |

*Required when `STT_PROVIDER=AZURE_STT`

## 🌍 Supported Languages

| Code | Language |
|------|----------|
| `vi-VN` | Vietnamese |
| `en-US` | English (US) |
| `zh-CN` | Chinese (Simplified) |
| `ja-JP` | Japanese |
| `ko-KR` | Korean |

## 💰 Azure Pricing (2025)

| Tier | Price | Limit |
|------|-------|-------|
| Free | $0 | 5 hours/month |
| Standard | ~$1/hour | Pay-per-use |

## 📁 Key Files

| File | Purpose |
|------|---------|
| `src/audio/azure_stt.ts` | Azure STT implementation |
| `src/config/config.ts` | Configuration management |
| `tests/azure_stt_integration_test.ts` | Test suite |
| `docs/azure-stt-integration.md` | Full documentation |

## 🔧 Advanced Configuration

### Custom Voice Settings
```bash
# For Azure TTS (optional)
TTS_PROVIDER=AZURE_TTS
AZURE_TTS_DEFAULT_VOICE=vi-VN-HoaiMyNeural
```

### Debug Mode
```bash
AUDIO_DEBUG=true
AUDIO_DEBUG_DIR=./debug_audio
```

## 📞 Support

- **Integration Issues**: Check test suite and logs
- **Azure Service Issues**: Azure Support Portal
- **Performance Issues**: Monitor Azure metrics

## ✅ Verification Checklist

- [ ] Azure Speech service created
- [ ] API key configured in `.env`
- [ ] Configuration test passes
- [ ] Audio test file loads
- [ ] Integration test completes
- [ ] Server starts without errors
- [ ] Audio processing works in real-time

## 🎯 Next Steps

1. **Production Setup**: Configure production Azure resources
2. **Monitoring**: Set up Azure monitoring and alerts
3. **Optimization**: Tune audio chunk sizes and processing
4. **Scaling**: Configure multiple regions for global deployment

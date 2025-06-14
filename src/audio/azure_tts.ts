// ---------------------------------------------------------------------------
//  Azure Text‑to‑Speech helper for AISHA            ©2025 elatoai / MIT‐0
// ---------------------------------------------------------------------------
//  Environment variables required
//   • AZURE_SPEECH_KEY      – Primary or secondary key of your Speech resource
//   • AZURE_SPEECH_ENDPOINT – https://southeastasia.api.cognitive.microsoft.com
//
//  This module replaces azure_tts.ts in one line of your TTS router:
//
//     import * as TTS from './azure_tts.ts';
//
// ---------------------------------------------------------------------------

import { Logger } from '../utils/logger.ts';
import { TTS_FRAME_SIZE_BYTES } from '../config/config.ts';

const log = new Logger('[AzureTTS]');

// ---- constants ------------------------------------------------------------
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoMultilingualNeural';
const DEFAULT_OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm'; // raw PCM
const ENDPOINT =
  (Deno.env.get('AZURE_SPEECH_ENDPOINT') ??
   'https://southeastasia.api.cognitive.microsoft.com').replace(/\/$/, '');

const KEY = Deno.env.get('AZURE_SPEECH_KEY') ?? '';

// ---- types ----------------------------------------------------------------
export interface AzureTTSRequest {
  text: string;
  voice?: string;
  rate?: number;   // 0.5 – 2.0
  pitch?: string;  // "+0Hz" / "-50Hz"
  style?: string;  // "casual" / "chat" / …
}

export interface AzureTTSResponse {
  success: boolean;
  audioData?: Uint8Array;
  error?: string;
}

// ---- helpers --------------------------------------------------------------
function buildSSML(
  { text, voice = DEFAULT_VOICE, rate, pitch, style}: AzureTTSRequest,
): string {
  // Escape XML characters
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Determine language from voice name
  const lang = voice.startsWith('vi-') ? 'vi-VN' :
               voice.startsWith('zh-') ? 'zh-CN' :
               voice.startsWith('de-') ? 'de-DE' :
               voice.startsWith('en-') ? 'en-US' : 'vi-VN';

  const prosody = (rate && rate !== 1) || pitch
    ? `<prosody${rate && rate !== 1 ? ` rate="${rate * 100}%"` : ''}${
        pitch ? ` pitch="${pitch}"` : ''
      }>${escaped}</prosody>`
    : escaped;

  const styled = style
    ? `<mstts:express-as style="${style}">${prosody}</mstts:express-as>`
    : prosody;

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
  <voice name="${voice}">${styled}</voice>
</speak>`.trim();
}

/** Low‑level fetch that returns a Uint8Array with raw PCM audio. */
async function fetchPcm(ssml: string): Promise<Uint8Array> {
  if (!KEY) throw new Error('AZURE_SPEECH_KEY is not set');

  const res = await fetch(`${ENDPOINT}/tts/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': DEFAULT_OUTPUT_FORMAT,
      'User-Agent': 'AISHA/azure-tts',
    },
    body: ssml,
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Azure TTS HTTP ${res.status}: ${msg}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ---- public API -----------------------------------------------------------
export async function convertTextToSpeech(
  req: AzureTTSRequest,
): Promise<AzureTTSResponse> {
  try {
    const pcm = await fetchPcm(buildSSML(req));
    return { success: true, audioData: pcm };
  } catch (e) {
    log.error(String(e));
    return { success: false, error: String(e) };
  }
}

/** Streaming variant – yields 960‑byte frames to the callback. */
export async function convertTextToSpeechStreaming(
  req: AzureTTSRequest,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<AzureTTSResponse> {
  try {
    if (!KEY) throw new Error('AZURE_SPEECH_KEY is not set');

    const ssml = buildSSML(req);
    const res = await fetch(`${ENDPOINT}/tts/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': DEFAULT_OUTPUT_FORMAT,
        'User-Agent': 'AISHA/azure-tts',
      },
      body: ssml,
    });

    if (!res.ok || !res.body) {
      const msg = await res.text();
      throw new Error(`Azure TTS HTTP ${res.status}: ${msg}`);
    }

    const reader = res.body.getReader();
    let leftover: Uint8Array | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      // if previous loop ended with an incomplete frame, prepend it
      const data: Uint8Array = leftover
        ? new Uint8Array([...leftover, ...value])
        : value;

      let offset = 0;
      while (offset + TTS_FRAME_SIZE_BYTES <= data.length) {
        await onChunk(data.subarray(offset, offset + TTS_FRAME_SIZE_BYTES));
        offset += TTS_FRAME_SIZE_BYTES;
      }
      leftover = data.subarray(offset); // save tail for next iteration
    }
    if (leftover && leftover.length) {
      // flush tail – pad with zeros to a full frame
      const pad = new Uint8Array(TTS_FRAME_SIZE_BYTES);
      pad.set(leftover);
      await onChunk(pad);
    }
    return { success: true };
  } catch (e) {
    log.error(String(e));
    return { success: false, error: String(e) };
  }
}

export function validateAzureTTSConfig(): boolean {
  return Boolean(KEY);
}

import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// Load environment variables from .env file
await load({ export: true, examplePath: null });

// Environment variables
export const isDev = Deno.env.get("DEV_MODE") === "true";
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY! Please set it in env.");
  Deno.exit(1);
}

export const GEMINI_LIVE_URL_TEMPLATE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}";

export const GEMINI_VISION_MODEL = Deno.env.get("GEMINI_VISION_MODEL") || "gemini-2.5-flash-preview-04-17"; // Use latest flash or a specific preview
export const GEMINI_VISION_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Microphone Processing
export const MIC_SAMPLE_RATE = 16000;
export const MIC_SAMPLE_BITS = 16; // 16-bit
export const MIC_CHANNELS = 1;
export const MIC_ACCUM_CHUNK_SIZE = 1024; // Process audio in 1k blocks

// TTS Output
export const TTS_SAMPLE_RATE = 24000;
export const TTS_FRAME_SIZE_SAMPLES = 480; // 20ms at 24k
export const TTS_FRAME_SIZE_BYTES = TTS_FRAME_SIZE_SAMPLES * 2; // 960 bytes (16-bit)

// Server Configuration
export const HOST = Deno.env.get("HOST") || "0.0.0.0";
// Default to 8080 unless DEV_MODE is true, then default to 8000
export const PORT = Number(Deno.env.get("PORT") || (isDev ? 8000 : 8080)); 
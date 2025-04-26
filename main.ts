////////////////////////////////////////////////////////////////////////////////
// main.ts - Merged approach to do chunk-based PCM capturing, processAudio(),
//           then push to Gemini. Returns TTS => device as Opus frames,
//           with an added TTS volume boost before Opus-encoding.
////////////////////////////////////////////////////////////////////////////////

import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket as WSWebSocket } from "npm:ws";
import type { RawData, WebSocketServer as _WebSocketServer } from "npm:ws";

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Encoder } from "@evan/opus";

import {
  authenticateUser,
} from "./utils.ts";
import {
  getSupabaseClient,
  getChatHistory,
  createFirstMessage,
  createSystemPrompt,
  addConversation,
  getDeviceInfo,
  updateUserSessionTime,
} from "./supabase.ts";

/******************************************************************************
 * ENV and Setup
 ******************************************************************************/
const isDev = Deno.env.get("DEV_MODE") === "true";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_URL_TEMPLATE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={api_key}";

// We assume mic is capturing 16-bit, 16k samples => chunk ~64 bytes each
// We'll accumulate until we get a "big block" (e.g., 1024 bytes) then we do "processAudio" + base64 => gemini.

const SAMPLE_RATE = 16000;
const SAMPLE_BITS = 16; // 16-bit
const CHANNELS = 1;
const ACCUM_CHUNK_SIZE = 1024; // 1k block to process

/******************************************************************************
 * "processAudio" from your code - for mic => Gemini
 ******************************************************************************/
class AudioFilter {
  // We'll store your filter variables as fields
  private highpassAlpha: number;
  private lowpassAlpha: number;

  private prevInputHighpass = 0;
  private prevOutputHighpass = 0;
  private prevOutputLowpass = 0;

  constructor() {
    // These are the same defaults/cutoffs from your code
    const highpass_cutoff = 300.0;
    const lowpass_cutoff = 3500.0;
    // compute alpha
    this.highpassAlpha = 1.0 / (1.0 + Math.tan(Math.PI * highpass_cutoff / SAMPLE_RATE));
    this.lowpassAlpha  = Math.tan(Math.PI * lowpass_cutoff / SAMPLE_RATE)
                       / (1 + Math.tan(Math.PI * lowpass_cutoff / SAMPLE_RATE));
  }

  /**
   * processAudioInPlace - modifies 16-bit samples with highpass, lowpass, gain <<3
   *    buffer is a Uint8Array of PCM data, length multiple of 2 (16-bit).
   */
  public processAudioInPlace(buffer: Uint8Array) {
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
      // read sample
      let sample = samples[i];

      // highpass
      const inHigh = sample;
      const outHigh = this.highpassAlpha * (
        this.prevOutputHighpass + inHigh - this.prevInputHighpass
      );
      this.prevInputHighpass = inHigh;
      this.prevOutputHighpass = outHigh;

      // lowpass
      const inLow = outHigh;
      const outLow = this.lowpassAlpha * inLow
        + (1 - this.lowpassAlpha) * this.prevOutputLowpass;
      this.prevOutputLowpass = outLow;

      // gain => shift <<3
      let finalOut = (outLow) * (1 << 3); // multiply by 8
      // clip
      if (finalOut > 32767) finalOut = 32767;
      else if (finalOut < -32768) finalOut = -32768;

      samples[i] = finalOut;
    }
  }
}

/******************************************************************************
 * We'll add a TTS volume boost for the Gemini PCM => device (Opus).
 * We'll do a simple factor of 2 (~+6 dB). You can tweak as needed.
 ******************************************************************************/
function boostTtsVolumeInPlace(buffer: Uint8Array, factor = 2.0) {
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) {
    let val = samples[i] * factor;
    // clip
    if (val > 32767) val = 32767;
    else if (val < -32768) val = -32768;
    samples[i] = val;
  }
}

/******************************************************************************
 * TTS (24k) with @evan/opus
 ******************************************************************************/
const TTS_RATE = 24000; // not same as above
const FRAME_SIZE_SAMPLES = 480; // 20ms @24k
const FRAME_SIZE_BYTES = FRAME_SIZE_SAMPLES * 2; // 960 bytes

const ttsEncoder = new Encoder({
  application: "audio",
  sample_rate: TTS_RATE,
  channels: 1,
});

function createTtsBuffer() {
  let leftover = new Uint8Array(0);

  async function encodePcmChunk(rawPcm: Uint8Array): Promise<Uint8Array[]> {
    const combined = new Uint8Array(leftover.length + rawPcm.length);
    combined.set(leftover, 0);
    combined.set(rawPcm, leftover.length);

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset + FRAME_SIZE_BYTES <= combined.length) {
      const slice = combined.subarray(offset, offset + FRAME_SIZE_BYTES);
      offset += FRAME_SIZE_BYTES;
      try {
        // feed slice to opus
        const opusPacket = ttsEncoder.encode(slice);
        frames.push(opusPacket);
      } catch (err) {
        console.error("Opus encode error:", err);
      }
    }
    leftover = combined.subarray(offset);
    return frames;
  }

  function reset() {
    leftover = new Uint8Array(0);
  }

  return { encodePcmChunk, reset };
}
const ttsState = createTtsBuffer();

/******************************************************************************
 * WebSocket server - gemini pipeline
 ******************************************************************************/
const server = createServer();
const wss: _WebSocketServer = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws: WSWebSocket, payload: { user: any; supabase: SupabaseClient; timestamp: string }) => {
  const { user, supabase } = payload;
  let geminiWs: WSWebSocket | null = null;
  let pipelineActive = true;
  let deviceClosed = false;
  let isGeminiConnected = false;
  let sessionStartTime = 0;

  // We'll manage a big buffer to accumulate mic data
  let micAccum = new Uint8Array(0);

  // We'll track if we have told the device "RESPONSE.CREATED"
  let responseCreatedSent = false;

  // Our filter for the mic
  const micFilter = new AudioFilter();

  // If dev, store raw mic
  let micDebugFile: Deno.FsFile | null = null;
  if (isDev) {
    const fn = `debug_mic_pcm_${Date.now()}.pcm`;
    micDebugFile = await Deno.open(fn, { create: true, write: true, append: true });
    console.log("(DEV) Storing raw mic PCM to:", fn);
  }

  // Immediately tell device about volume, etc.
  ws.send(JSON.stringify({
    type: "auth",
    volume_control: user.device?.volume || 70,
    is_ota: user.device?.is_ota || false,
    is_reset: user.device?.is_reset || false,
  }));

  // Chat History => system prompt
  const isDoctor = (user.user_info?.user_type === "doctor");
  const chatHistory = await getChatHistory(
    supabase,
    user.user_id,
    user.personality?.key ?? null,
    isDoctor,
  );
  const firstMessage = createFirstMessage(chatHistory, { user, supabase, timestamp: payload.timestamp });
  const systemPrompt = createSystemPrompt(chatHistory, { user, supabase, timestamp: payload.timestamp });

  // Connect to Gemini
  function connectToGemini() {
    if (!GEMINI_API_KEY) {
      console.error("Missing GEMINI_API_KEY!");
      ws.close(1011, "No Gemini Key");
      return;
    }
    if (!user.personality?.oai_voice) {
      console.error("No user.personality.oai_voice set!");
      ws.close(1011, "No voiceName");
      return;
    }
    const gemUrl = GEMINI_URL_TEMPLATE.replace("{api_key}", GEMINI_API_KEY);
    console.log("Connecting to Gemini at:", gemUrl);

    geminiWs = new WSWebSocket(gemUrl);

    geminiWs.on("open", () => {
      console.log("Gemini connected");
      isGeminiConnected = true;
      sessionStartTime = Date.now();

      // send setup
      const setup = {
        setup: {
          model: "models/gemini-2.0-flash-live-001",
          generationConfig: {
            responseModalities: ["AUDIO"],
            // media_resolution: "MEDIA_RESOLUTION_LOW",
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: user.personality?.oai_voice || "Leda" },
              },
              language_code: "vi-VN",
            },
          },
          systemInstruction: {
            role: "system",
            parts: [{ text: "YOU MUST RESPONSE IN VIETNAMESE ONLY! " + systemPrompt || "You are a helpful assistant." }],
          },
          tools: {
            google_search:{},
            code_execution:{},
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              silenceDurationMs: 2000,
            },
            turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
          },
          outputAudioTranscription: {},
          contextWindowCompression: {
            slidingWindow: {},
          },
        },
      };
      geminiWs?.send(JSON.stringify(setup));

      // If no chat, force "Hello"
      if (!chatHistory?.length) {
        console.log("No prior chat => forced user turn: Hello");
        const userTurn = {
          clientContent: {
            turns: [{ role: "user", parts: [{ text: "Xin chào" }] }],
            turnComplete: true,
          },
        };
        geminiWs?.send(JSON.stringify(userTurn));
      } else if (firstMessage) {
        console.log("Sending first user turn =>", firstMessage);
        const userTurn = {
          clientContent: {
            turns: [{ role: "user", parts: [{ text: firstMessage }] }],
            turnComplete: true,
          },
        };
        geminiWs?.send(JSON.stringify(userTurn));
      }
    });

    geminiWs.on("message", async (raw: RawData) => {
      if (!pipelineActive || deviceClosed) return;
      try {
        const msg = JSON.parse(raw.toString("utf-8"));
        await handleGeminiJson(msg);
      } catch {
        console.log("Gemini => non-JSON => ignoring");
      }
    });

    geminiWs.on("error", (err) => {
      console.error("Gemini error:", err);
      isGeminiConnected = false;
      if (!deviceClosed && ws.readyState === WSWebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: "Gemini error" }));
        ws.close(1011, "Gemini error");
      }
    });

    geminiWs.on("close", (code, reason) => {
      console.log("Gemini closed:", code, reason.toString());
      isGeminiConnected = false;
      geminiWs = null;
      if (!deviceClosed && ws.readyState === WSWebSocket.OPEN) {
        ws.close(1011, "Gemini disconnected");
      }
    });
  }

  async function handleGeminiJson(msgObj: any) {
    if (msgObj.setupComplete) {
      console.log("Gemini => setupComplete");
      return;
    }

    const sc = msgObj.serverContent;
    if (sc?.modelTurn?.parts?.length) {
      // TTS partial
      for (const part of sc.modelTurn.parts) {
        if (part.text) {
          console.log("Gemini partial text:", part.text);
        }
        if (part.inlineData?.data) {
          // first TTS => "RESPONSE.CREATED"
          if (!responseCreatedSent) {
            responseCreatedSent = true;
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
          }
          // decode base64 => chunk => do volume boost => encode => device
          const rawPcm = Buffer.from(part.inlineData.data, "base64");

          // boost volume 3x
          boostTtsVolumeInPlace(rawPcm, 3.0);

          const frames = await ttsState.encodePcmChunk(rawPcm);
          for (const pkt of frames) {
            if (ws.readyState === WSWebSocket.OPEN && !deviceClosed) {
              ws.send(pkt); // device calls opusDecoder.write()
            }
          }
        }
      }
    }

    if (sc?.generationComplete) {
      console.log("Gemini => generationComplete => device listens");
      ttsState.reset();
      responseCreatedSent = false;

      try {
        const dev = await getDeviceInfo(supabase, user.user_id);
        ws.send(JSON.stringify({
          type: "server",
          msg: "RESPONSE.COMPLETE",
          volume_control: dev?.volume ?? 70,
        }));
      } catch {
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
      }
    }

    // inputTranscription => user
    if (msgObj.inputTranscription?.text) {
      console.log("Gemini => user said:", msgObj.inputTranscription.text);
      if (msgObj.inputTranscription.finished) {
        await addConversation(supabase, "user", msgObj.inputTranscription.text, user);
      }
    }
    // outputTranscription => assistant
    if (msgObj.outputTranscription?.text) {
      console.log("Gemini => assistant partial:", msgObj.outputTranscription.text);
      if (msgObj.outputTranscription.finished) {
        await addConversation(supabase, "assistant", msgObj.outputTranscription.text, user);
      }
    }
    if (msgObj.goAway) {
      console.warn("Gemini => goAway:", msgObj.goAway);
    }
  }

  ws.on("message", async (data: RawData, isBinary: boolean) => {
    if (!pipelineActive || deviceClosed) return;

    if (isBinary) {
      // mic 16-bit PCM chunk from device (64 bytes typical)
      // store in micDebugFile
      if (micDebugFile) {
        await micDebugFile.write(new Uint8Array(data));
      }
      // accumulate in micAccum
      let oldLen = micAccum.length;
      let newBuf = new Uint8Array(oldLen + data.length);
      newBuf.set(micAccum, 0);
      newBuf.set(new Uint8Array(data), oldLen);
      micAccum = newBuf;

      // if we have enough => e.g. 1024
      while (micAccum.length >= ACCUM_CHUNK_SIZE) {
        let chunkToProcess = micAccum.slice(0, ACCUM_CHUNK_SIZE);
        micAccum = micAccum.slice(ACCUM_CHUNK_SIZE);

        // apply filter
        micFilter.processAudioInPlace(chunkToProcess);

        // base64
        let b64 = Buffer.from(chunkToProcess).toString("base64");
        // send to gemini
        if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
          // We'll use the "realtime_input" approach from the python example
          const gemMsg = {
            "realtime_input": {
              "media_chunks": [
                {
                  "data": b64,
                  "mime_type": "audio/pcm;rate=16000",
                }
              ]
            }
          };
          geminiWs.send(JSON.stringify(gemMsg));
        }
      }

    } else {
      // JSON instructions
      try {
        const msgObj = JSON.parse(data.toString("utf-8"));
        if (msgObj.type === "instruction") {
          if (msgObj.msg === "end_of_speech") {
            console.log("Device => end_of_speech => finalize user turn");
            // flush leftover
            if (micAccum.length > 0) {
              micFilter.processAudioInPlace(micAccum);
              let b64 = Buffer.from(micAccum).toString("base64");
              micAccum = new Uint8Array(0);

              if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                const gemMsg = {
                  "realtime_input": {
                    "media_chunks": [
                      {
                        "data": b64,
                        "mime_type": "audio/pcm;rate=16000",
                      }
                    ]
                  }
                };
                geminiWs.send(JSON.stringify(gemMsg));
              }
            }

            // now turnComplete
            if (geminiWs && geminiWs.readyState === WSWebSocket.OPEN) {
              const finalize = {
                clientContent: {
                  turns: [],
                  turnComplete: true,
                },
              };
              geminiWs.send(JSON.stringify(finalize));
            }
            // device expects "AUDIO.COMMITTED"
            ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));

          } else if (msgObj.msg === "INTERRUPT") {
            console.log("Device => INTERRUPT => finalize turn");
            // flush leftover if any
            micAccum = new Uint8Array(0);
            if (geminiWs && geminiWs.readyState === WSWebSocket.OPEN) {
              const interrupt = {
                clientContent: { turns: [], turnComplete: true },
              };
              geminiWs.send(JSON.stringify(interrupt));
            }
          }
        }

      } catch (err) {
        console.error("Device JSON parse error:", err);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("Device WS error:", err);
    if (!deviceClosed) {
      deviceClosed = true;
      geminiWs?.close();
    }
    pipelineActive = false;
  });

  ws.on("close", async (code, reason) => {
    console.log("Device WS closed => code:", code, "reason:", reason.toString());
    deviceClosed = true;
    pipelineActive = false;
    if (sessionStartTime > 0) {
      const dur = Math.floor((Date.now() - sessionStartTime) / 1000);
      await updateUserSessionTime(supabase, user, dur).catch(console.error);
    }
    geminiWs?.close();
    if (micDebugFile) {
      await micDebugFile.close();
    }
  });

  connectToGemini();
});

/******************************************************************************
 * Upgrade Handler
 ******************************************************************************/
server.on("upgrade", async (req, socket, head) => {
  console.log("upgrade request received");
  try {
    const { authorization } = req.headers;
    const token = authorization?.replace("Bearer ", "") ?? "";
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const supabase = getSupabaseClient(token);
    const user = await authenticateUser(supabase, token);
    console.log("User authenticated:", user.email);

    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("Authentication success => WS established");
      wss.emit("connection", ws, {
        user,
        supabase,
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    console.error("Auth failed:", err);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

/******************************************************************************
 * Run the server
 ******************************************************************************/
if (isDev) {
  const HOST = Deno.env.get("HOST") || "0.0.0.0";
  const PORT = Number(Deno.env.get("PORT") || 8000);
  server.listen(PORT, HOST, () => {
    console.log(`Server running on ws://${HOST}:${PORT}`);
  });
} else {
  server.listen(8080);
  console.log("Server listening on port 8080");
}

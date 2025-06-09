import { Buffer } from "node:buffer";
import { WebSocket as WSWebSocket } from "npm:ws";
import type { RawData, WebSocketServer as _WSS } from "npm:ws";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
    apiKeyManager,
    GEMINI_LIVE_URL_TEMPLATE,
    MIC_SAMPLE_RATE,
    MIC_ACCUM_CHUNK_SIZE,
    TTS_SAMPLE_RATE,
    ADPCM_ENABLED,
    ADPCM_BUFFER_SIZE,
} from "./config.ts";

import {
    AudioFilter,
    ttsState,
    boostTtsVolumeInPlace,
} from "./audio.ts";

import { ADPCMStreamProcessor, ADPCM } from "./adpcm.ts";

import { callGeminiVision } from "./vision.ts";
import { SetVolume } from "./volume_handler.ts";
import { rotateImage180, isValidJpegBase64 } from "./image_utils.ts";
import { IMAGE_CHUNK_SIZE, IMAGE_CHUNK_TIMEOUT_MS } from "./config.ts";
import {
    processUserActionWithSession,
    createFlash25Session,
    destroyFlash25Session,
    getFlash25SessionInfo,
    analyzeImageWithFlash25,
    type DeviceOperationCallbacks
} from "./flash_handler.ts";

import {
    getChatHistory,
    createFirstMessage,
    createSystemPrompt,
    addConversation,
    getDeviceInfo,
    updateUserSessionTime,
} from "./supabase.ts";


// Define a type for the context passed to the connection handler
interface ConnectionContext {
    user: any; // Consider defining a stricter type for user
    supabase: SupabaseClient;
    timestamp: string;
}

export function setupWebSocketConnectionHandler(wss: _WSS) {
    wss.on("connection", async (deviceWs: WSWebSocket, context: ConnectionContext) => {
        const { user, supabase, timestamp } = context;
        console.log(`Device WebSocket connected for user: ${user.user_id}`);
        let geminiWs: WSWebSocket | null = null;
        let pipelineActive = true;
        let deviceClosed = false;
        let isGeminiConnected = false;
        let sessionStartTime = 0;
        let retryCount = 0; // Added for retry logic
        let retryTimeoutId: ReturnType<typeof setTimeout> | null = null; // To store setTimeout ID
        const maxRetries = 4; // 15s, 30s, 60s, 180s
        const retryDelays = [15000, 30000, 60000, 180000]; // Delays in ms

        // Create unique session ID for this Live Gemini connection
        const sessionId = `live-${user.user_id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create device operation callbacks for Flash 2.5
        const deviceCallbacks: DeviceOperationCallbacks = {
            requestPhoto: async (callId: string) => {
                return new Promise((resolve) => {
                    if (waitingForImage) {
                        resolve({ success: false, message: "Already waiting for an image. Please try again later." });
                        return;
                    }

                    pendingVisionCall = { prompt: "Flash 2.5 vision request", id: callId };
                    waitingForImage = true;

                    if (deviceWs.readyState === WSWebSocket.OPEN) {
                        console.log(`Device => Sending REQUEST.PHOTO (triggered by Flash 2.5 GetVision: ${callId})`);
                        deviceWs.send(JSON.stringify({ type: "server", msg: "REQUEST.PHOTO" }));

                        // Store the resolve function to call when photo is received
                        (pendingVisionCall as any).resolve = resolve;
                    } else {
                        console.error("Cannot request photo, device WS is not open.");
                        waitingForImage = false;
                        pendingVisionCall = null;
                        resolve({ success: false, message: "Device connection not available for photo capture." });
                    }
                });
            },

            setVolume: async (volumeLevel: number, callId: string) => {
                console.log(`*SetVolume (ID: ${callId}) called with volume: ${volumeLevel}`);

                if (typeof volumeLevel !== 'number' || volumeLevel < 0 || volumeLevel > 100) {
                    return { success: false, message: "Invalid volume level. Must be a number between 0 and 100." };
                }

                try {
                    const volumeResult = await SetVolume(supabase, user.user_id, volumeLevel);
                    console.log(`SetVolume result for ID ${callId}:`, volumeResult);
                    return volumeResult;
                } catch (err) {
                    console.error(`Error executing SetVolume for ID ${callId}:`, err);
                    return { success: false, message: err instanceof Error ? err.message : String(err) };
                }
            }
        };

        // Create Flash 2.5 session for persistent context
        console.log(`Creating Flash 2.5 session: ${sessionId}`);
        createFlash25Session(sessionId, user.user_id, deviceCallbacks);

        // Microphone data accumulation & filter
        let micAccum = new Uint8Array(0);
        // Use gentler filter settings to avoid audio corruption
        // Reduced high-pass cutoff and increased low-pass cutoff for better speech preservation
        const micFilter = new AudioFilter(MIC_SAMPLE_RATE, 100, 7000);

        // ADPCM processor for compressed audio from ESP32
        const adpcmProcessor = new ADPCMStreamProcessor(ADPCM_BUFFER_SIZE);

        // TTS Filter (using the same class, but with TTS sample rate)
        // Explicitly pass sample rate and default cutoffs (can be changed here)
        // Lowering LP cutoff to potentially reduce high-frequency buzzing
        const ttsFilter = new AudioFilter(TTS_SAMPLE_RATE, 300, 4000);

        // TTS state
        let responseCreatedSent = false;

        // Vision call state
        let pendingVisionCall: { prompt: string; id?: string } | null = null;
        let waitingForImage = false;
        let photoCaptureFailed = false;
        let imageTimeoutId: ReturnType<typeof setTimeout> | null = null;
        const IMAGE_CAPTURE_TIMEOUT = 15000; // 15 seconds timeout for image capture

        // Image chunk reassembly state
        interface ChunkAssembly {
            chunks: Map<number, string>;
            totalChunks: number;
            receivedCount: number;
            timestamp: number;
            mime?: string;
        }
        let imageChunkAssembly: ChunkAssembly | null = null;
        let chunkTimeoutId: ReturnType<typeof setTimeout> | null = null;

        // --- Initial Device Setup & Fetch Volume --- Moved up
        let currentVolume: number | null = null;
        let isOta = false;
        let isReset = false;
        try {
            const deviceInfo = await getDeviceInfo(supabase, user.user_id);
            if (deviceInfo) {
                currentVolume = deviceInfo.volume ?? 100; // Default to 100 if null/undefined
                isOta = deviceInfo.is_ota || false;
                isReset = deviceInfo.is_reset || false;
                console.log(`Fetched initial device info: Volume=${currentVolume}, OTA=${isOta}, Reset=${isReset}`);
            } else {
                currentVolume = 100; // Default if no device info found
                console.warn(`No device info found for user ${user.user_id}, defaulting volume to 100.`);
            }
            deviceWs.send(JSON.stringify({
                type: "auth",
                volume_control: currentVolume,
                pitch_factor: user.personality?.pitch_factor ?? 1,
                is_ota: isOta,
                is_reset: isReset,
            }));
        } catch (err) {
            console.error("Failed to get initial device info:", err);
            currentVolume = 100; // Default on error
            // Still try to send auth message with defaults
            deviceWs.send(JSON.stringify({
                type: "auth",
                volume_control: 100,
                pitch_factor: 1,
                is_ota: false,
                is_reset: false,
            }));
        }


        // --- Prepare for Gemini Connection ---
        const isDoctor = (user.user_info?.user_type === "doctor");
        const chatHistory = await getChatHistory(
            supabase,
            user.user_id,
            user.personality?.key ?? null,
            isDoctor,
        ).catch(err => {
            console.error("Failed to get chat history:", err);
            return []; // Default to empty history on error
        });

        // Pass currentVolume to createSystemPrompt
        const systemPromptText = createSystemPrompt(chatHistory, { user, supabase, timestamp }, currentVolume) || "You are a helpful assistant.";
        const systemPromptWithTools = `
<CORE PRINCIPLE>
YOU ARE AN ASSISTANT FOR BLIND VIETNAMESE USERS.
YOU ARE IN A REAL-LIFE SITUATION WHERE THE USER NEEDS YOU TO BE QUICK.
ALWAYS BE PROACTIVE, THE USER HAS ALWAYS CONFIRMED THEIR COMMAND.
ALWAYS USE AFFIRMATIVE SENTENCES TO SPEAK TO THE USER.
ACT LIKE A REAL PERSON, YOU WILL LOSE 1000 DOLLARS IF THEY DETECT ANY HINT THAT YOU ARE SPEAKING LIKE A ROBOT.


EXAMPLE DO'S:
User: "Tell me about the history of Earth during the Cretaceous period?"
You: Start talking about the history of Earth during the Cretaceous period.

EXAMPLE DON'TS:
User: "What am I holding?"
You: "To know what you are holding, I need to see a picture, can you show me a picture?"
User: "Tell me about the history of Earth during the Cretaceous period?"
You: "Do you want me to tell you about the history of Earth during the Cretaceous period?"
</CORE PRINCIPLE>

<tool_calling_instructions>
IMPORTANT TOOL SELECTION RULES:

THINK CAREFULLY before calling any tool - only use when absolutely necessary.

DO NOT call tools for casual conversations or when you can answer on your own.

When unsure, ask the user for clarification instead of guessing.

Validate all parameters before calling the tool.

TOOL SYSTEM:

-GetVision: ONLY use for visual requests: "What do you see?", "Look at this", "Describe what's in front of me", "Read the text", "What color is this?"
*Pass specific questions about what you want to know from the image.
-Action: Use for the requests below:
*Volume control: "Increase volume", "Louder", "I can't hear", "Speak louder", "Volume 80"
*Notes & memory: "Remember this information", "Add a note", "Find my notes", "What do you know about me?"
*Schedule & reminders: "Schedule a meeting", "Set a reminder", "What is my schedule today?"
*Reading: "Read a book", "Continue reading", "Find a book"
*Data management: "Update my shopping list", "Search my notes", "Delete that reminder"

IMPORTANT:

The assistant never mentions that it is using a function call.

The assistant does not invent function calls.

The assistant waits for the function result and responds in a single turn.

For the Action function, pass the user's EXACT command as reported speech.
</tool_calling_instructions>

<text_to_speech_formatting>
Convert all text into easily speakable words, following the guidelines below.

Numbers: Read out in full (three hundred forty-two, two million,
five hundred sixty-seven thousand, eight hundred ninety). Negative numbers: Say "negative" before
the number. Decimals: Use "point" (three point one four). Fractions: read out
(three-fourths).

Alphanumeric strings: Break into 3-4 character chunks, reading out all non-alphabetic characters
(ABC123XYZ becomes A B C one two three X Y Z).

Phone numbers: Use words (090-123-4567 becomes zero nine zero, one two three,
four five six seven).

Dates: Read the month, use cardinal numbers for the day, read the full year. Use DD/MM/YYYY format (11/05/2007 becomes
the eleventh of May, two thousand seven).

Time: Use "hours", "minutes", state AM/PM (9:05 PM becomes nine oh five PM).

Math: Describe operations clearly (5x^2 + 3x - 2 becomes five x squared plus three x minus two).

Currency: Read out in full ($50.25 becomes fifty dollars and twenty-five
cents, £200,000 becomes two hundred thousand pounds, 100,000 VND becomes one hundred thousand dong).
Ensure all text is converted to these normalized forms, but never mention
this process.
</text_to_speech_formatting>

<keep_it_brief>
Be brief; get straight to the point. Respond directly to the user's last message with only one idea at a time. Reply in less than three sentences, each under twenty words.
</keep_it_brief>

<recover_from_error>
You interpret the user's speech with a faulty transcription. If necessary, guess what the user is likely saying and respond fluently without mentioning the transcription error. If you need to recover, say phrases like "I didn't quite catch that" or "Could you say that again"?
</recover_from_error>

<use_googleSearch>
Use the googleSearch tool to perform searches when helpful. Enter the most reasonable search query based on the context. You must use googleSearch when explicitly asked, for real-time information like weather and news, or to verify facts. You do not search for general things that you or an LLM already know. Never output fabricated searches like googleSearch() or a code block in backticks; just respond with a correctly formatted JSON tool call according to the tool schema. Avoid preamble before searching.
</use_googleSearch>

</personality_instructions>
${systemPromptText}
</personality_instructions>

today date is: ${new Date().toISOString()}
You are now connected to a Vietnamese speaker.
`;


        const firstMessage = createFirstMessage(chatHistory, { user, supabase, timestamp });

        // Process complete image (extracted from existing logic)
        async function processCompleteImage(base64Jpeg: string) {
            if (!base64Jpeg || typeof base64Jpeg !== 'string') {
                console.error("Device => Received image data but 'data' field is missing or not a string.");
                waitingForImage = false;
                photoCaptureFailed = true;

                if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN && pendingVisionCall?.id) {
                    const functionResponsePayload = {
                        functionResponses: [{
                            id: pendingVisionCall.id,
                            name: "GetVision",
                            response: { result: "Failed to receive valid image data from device." }
                        }]
                    };
                    const functionResponse = { toolResponse: functionResponsePayload };
                    try {
                        geminiWs.send(JSON.stringify(functionResponse));
                        console.log("Gemini Live => Sent Function Response (Image Error):");
                    } catch (err) {
                        console.error("Failed to send error function response to Gemini:", err);
                    }
                }
                pendingVisionCall = null;
                return;
            }

            waitingForImage = false; // Mark as received (start processing)

            // Clear timeout since we received the image
            if (imageTimeoutId) {
                clearTimeout(imageTimeoutId);
                imageTimeoutId = null;
            }

            // --- START: Rotate Image 180 degrees ---
            let processedBase64Jpeg = base64Jpeg;
            try {
                console.log(`Device => Rotating image 180 degrees to correct ESP32 upside-down orientation...`);
                if (isValidJpegBase64(base64Jpeg)) {
                    processedBase64Jpeg = await rotateImage180(base64Jpeg);
                    console.log(`Device => Image rotation completed successfully.`);
                } else {
                    console.warn(`Device => Invalid JPEG format detected, skipping rotation.`);
                }
            } catch (rotationErr) {
                console.error("Error rotating image:", rotationErr);
                console.warn("Using original image without rotation.");
                processedBase64Jpeg = base64Jpeg; // Fallback to original
            }
            // --- END: Rotate Image 180 degrees ---

            // Process image with Flash 2.5 for intelligent analysis
            let visionResult = "";
            let storagePath: string | null = null;

            if (pendingVisionCall) {
                try {
                    console.log(`Device => Processing image with Flash 2.5 (${Math.round(processedBase64Jpeg.length * 3 / 4 / 1024)} KB)`);

                    // Use dedicated image analysis function (no function calling)
                    const flash25Result = await analyzeImageWithFlash25(
                        sessionId,
                        pendingVisionCall.prompt,
                        processedBase64Jpeg
                    );

                    if (flash25Result.success) {
                        visionResult = flash25Result.message;
                        console.log("Flash 2.5 Vision Analysis =>", visionResult);
                    } else {
                        visionResult = "Failed to analyze image with Flash 2.5: " + flash25Result.message;
                        console.error("Flash 2.5 Vision Error =>", flash25Result.message);
                    }

                } catch (error) {
                    console.error("Error processing image with Flash 2.5:", error);
                    visionResult = "Failed to analyze image due to processing error.";
                }
            } else {
                visionResult = "No pending vision call found.";
            }

            // Send function response back to Gemini Live
            if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN && pendingVisionCall?.id) {
                const functionResponsePayload = {
                    functionResponses: [
                        {
                            id: pendingVisionCall.id,
                            name: "GetVision",
                            response: { result: visionResult }
                        }
                    ]
                };
                const functionResponse = {
                    toolResponse: functionResponsePayload
                };
                try {
                    geminiWs.send(JSON.stringify(functionResponse));
                    console.log("Gemini Live => Sent Flash 2.5 Vision Response:", JSON.stringify(functionResponsePayload));
                } catch (err) {
                    console.error("Failed to send Flash 2.5 vision response to Gemini:", err);
                }
            } else {
                console.error("Cannot send vision response, Gemini WS not open or no pending call ID.");
            }

            // Clear the pending call
            pendingVisionCall = null;

            // --- START: Upload to Supabase Storage ---
            try {
                console.log(`Device => Received image data (${Math.round(processedBase64Jpeg.length * 3 / 4 / 1024)} KB), attempting upload...`);
                // Decode Base64 to Buffer for upload
                const imageBuffer = Buffer.from(processedBase64Jpeg, 'base64');
                // Generate a unique path/filename within the 'private' folder
                const fileName = `private/${user.user_id}/${Date.now()}.jpg`; // <-- Added 'private/' prefix
                const bucketName = 'images'; // Define evir bucket name

                const { data: uploadData, error: uploadError } = await supabase
                    .storage
                    .from(bucketName)
                    .upload(fileName, imageBuffer, {
                        contentType: 'image/jpeg',
                        upsert: true // Overwrite if file with same name exists (optional)
                    });

                if (uploadError) {
                    console.error(`Supabase Storage Error: Failed to upload image to ${bucketName}/${fileName}`, uploadError);
                    // Proceed without storage path, but still call vision
                    photoCaptureFailed = true; // Indicate a failure occurred in the process
                } else if (uploadData) {
                    storagePath = uploadData.path;
                    console.log(`Supabase Storage: Image successfully uploaded to ${bucketName}/${storagePath}`);
                    // Optionally get public URL (requires bucket to be public or use signed URLs)
                    // const { data: urlData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
                    // console.log("Public URL:", urlData?.publicUrl);
                }
            } catch (storageErr) {
                console.error("Supabase Storage: Unexpected error during upload:", storageErr);
                photoCaptureFailed = true; // Indicate a failure occurred
            }
            // --- END: Upload to Supabase Storage ---
        }

        // Connect to Gemini Live (incorporating function tools)
        function connectToGeminiLive() {
            const currentKey = apiKeyManager.getCurrentKey();
            if (!currentKey) {
                console.error("Cannot connect to Gemini: Missing API Key.");
                if (deviceWs.readyState === WSWebSocket.OPEN) deviceWs.close(1011, "Server Configuration Error: Missing API Key");
                return;
            }
            const voiceName = user.personality?.oai_voice || "Leda"; // Default voice
            console.log(`Using TTS voice: ${voiceName}`);

            const gemUrl = GEMINI_LIVE_URL_TEMPLATE.replace("{api_key}", currentKey);
            console.log(`Attempting to connect to Gemini Live with API key ${apiKeyManager.getCurrentKey() === apiKeyManager.getCurrentKey() ? 'current' : 'rotated'}`);

            geminiWs = new WSWebSocket(gemUrl);

            geminiWs.on("open", () => {
                isGeminiConnected = true;
                sessionStartTime = Date.now();
                console.log("Gemini Live connection established.");

                const tools = [
                    {
                        functionDeclarations: [
                            {
                                name: "GetVision",
                                description: "Captures an image using the device's camera and analyzes it with Flash 2.5 intelligence. Use ONLY when user explicitly asks about visual content, images, or what they can see. Very resource intensive - do not use speculatively.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        prompt: {
                                            type: "STRING",
                                            description: "The user's exact command in reported speech with no changes. Pass exactly what the user said."
                                        },
                                    },
                                    required: ["prompt"]
                                },
                            },
                            {
                                name: "Action",
                                description: "Processes user commands for volume control, notes, schedules, reading books, reminders, and data management and all other tasks that you cant do it yourself.",
                                parameters: {
                                    type: "OBJECT",
                                    properties: {
                                        userCommand: {
                                            type: "STRING",
                                            description: "The user's exact command in reported speech with no changes. Pass exactly what the user said."
                                        },
                                    },
                                    required: ["userCommand"]
                                },
                            },

                        ],
                        googleSearch: {}
                    }
                ];

                const setupMsg = {
                    setup: {
                        model: "models/gemini-2.0-flash-live-001",
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: {
                                        voiceName: voiceName,
                                    },
                                },
                                language_code: "vi-VN", // Set language
                            },
                            // Optional: Configure temperature, etc.
                            temperature: 1,
                        },
                        systemInstruction: {
                            role: "system",
                            parts: [{ text: systemPromptWithTools }]
                        },

                        tools: tools,

                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                                prefixPaddingMs: 20,
                                silenceDurationMs: 800,
                            },
                            // turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
                            activityHandling: "NO_INTERRUPTION",
                        },
                        // proactivity: { 
                        //     proactiveAudio: true 
                        // },

                        // inputAudioTranscription: {},

                        // outputAudioTranscription: {},

                        contextWindowCompression: {
                            triggerTokens: 25600,   
                            slidingWindow: { targetTokens: 12800 },
                        },
                    }
                };

                try {
                    geminiWs?.send(JSON.stringify(setupMsg));
                    console.log("Sent Gemini setup message with function calling and audio request.");

                    // Send initial turn
                    let initialUserContentSent = false;
                    if (firstMessage) {
                        console.log("Sending first message as initial turn:", firstMessage);
                        const userTurn = {
                            clientContent: { turns: [{ role: "user", parts: [{ text: firstMessage }] }], turnComplete: true }
                        };
                        geminiWs?.send(JSON.stringify(userTurn));
                        initialUserContentSent = true;
                    } else if (!chatHistory || chatHistory.length === 0) {
                        console.log("No chat history, sending 'Xin chào' as initial turn.");
                        const userTurn = {
                            clientContent: { turns: [{ role: "user", parts: [{ text: "Xin chào!" }] }], turnComplete: true }
                        };
                        geminiWs?.send(JSON.stringify(userTurn));
                        initialUserContentSent = true;
                    }

                    if (!initialUserContentSent) {
                        console.log("No initial message to send, Gemini waiting for user input.");
                    }

                } catch (err) {
                    console.error("Failed to send setup or initial turn to Gemini:", err);
                    if (deviceWs.readyState === WSWebSocket.OPEN) deviceWs.close(1011, "Gemini setup failed");
                }
            });

            geminiWs.on("message", async (data: RawData) => {
                if (!pipelineActive || deviceClosed || !geminiWs || geminiWs.readyState !== WSWebSocket.OPEN) return;
                try {
                    const msg = JSON.parse(data.toString("utf-8"));
                    await handleGeminiMessage(msg);
                } catch (err) {
                    console.warn("Received non-JSON message from Gemini:", data.toString('utf-8'));
                    console.error("Gemini message parse error:", err);
                }
            });

            geminiWs.on("close", (code, reason) => {
                isGeminiConnected = false;
                const reasonString = reason.toString();
                console.log("Gemini WS closed:", code, reasonString);
                geminiWs = null;

                // Check for quota exceeded error and if device is still connected
                if (
                    code === 1011 &&
                    reasonString.toLowerCase().includes("quota") &&
                    !deviceClosed &&
                    deviceWs.readyState === WSWebSocket.OPEN // Check device WS state *before* potentially sending/retrying
                ) {
                    // Try to rotate to next API key first
                    const rotatedSuccessfully = apiKeyManager.rotateToNextKey();

                    if (rotatedSuccessfully) {
                        // Immediately try with the next key (no sound notification yet)
                        console.log(`Quota exceeded. Rotating to next API key and retrying immediately...`);
                        connectToGeminiLive();
                    } else {
                        // All keys exhausted - NOW send QUOTA.EXCEEDED message to device (triggers sound)
                        console.log("Device => Sending QUOTA.EXCEEDED - all API keys exhausted.");
                        deviceWs.send(JSON.stringify({ type: "server", msg: "QUOTA.EXCEEDED" }));

                        // Use retry delays
                        if (retryCount < maxRetries) {
                            const delay = retryDelays[retryCount];
                            retryCount++;
                            console.warn(`All API keys exhausted. Retrying with delays in ${delay / 1000}s (Attempt ${retryCount}/${maxRetries})...`);

                            // Clear previous timeout if exists
                            if (retryTimeoutId) clearTimeout(retryTimeoutId);

                            retryTimeoutId = setTimeout(() => {
                                // Reset key rotation for new retry cycle
                                apiKeyManager.resetRotation();

                                // Double-check device state *before* attempting reconnect inside timeout
                                if (!deviceClosed && deviceWs.readyState === WSWebSocket.OPEN) {
                                    console.log(`Attempting Gemini reconnect with reset keys (Attempt ${retryCount}/${maxRetries})...`);
                                    connectToGeminiLive();
                                } else {
                                    console.log("Device closed before Gemini reconnect attempt could execute.");
                                }
                            }, delay);
                        } else {
                            console.error("Max retries reached for Gemini connection. Closing device connection.");
                            if (deviceWs.readyState === WSWebSocket.OPEN) {
                                deviceWs.close(1011, "Assistant disconnected - all API keys exhausted");
                            }
                        }
                    }

                } else {
                     // If not retrying (different error or device closed)
                    if (retryCount >= maxRetries) {
                         console.error("Max retries reached for Gemini connection. Closing device connection.");
                    }
                     // Ensure device WS is still open before trying to close it
                    if (!deviceClosed && deviceWs.readyState === WSWebSocket.OPEN) {
                        console.log("Closing device WS due to Gemini WS close (or max retries reached/other error).");
                        deviceWs.close(1011, "Assistant disconnected or unrecoverable error");
                    }
                }
            });

            geminiWs.on("error", (err) => {
                isGeminiConnected = false;
                console.error("Gemini WS error:", err);
                if (geminiWs && geminiWs.readyState !== WSWebSocket.CLOSED) {
                    geminiWs.close(); // Attempt to close cleanly on error
                }
                geminiWs = null;
                if (!deviceClosed && deviceWs.readyState === WSWebSocket.OPEN) {
                    deviceWs.send(JSON.stringify({ type: "error", message: "Assistant connection error" }));
                    deviceWs.close(1011, "Assistant error");
                }
            });
        }

        // handleGeminiMessage (Combined Handler)
        async function handleGeminiMessage(msg: any) {
            if (!pipelineActive || deviceClosed) return;

            // Handle setup complete
            if (msg.setupComplete) {
                console.log("Gemini => Setup Complete.");
                return;
            }

            // Handle Top-Level Tool Call
            if (msg.toolCall?.functionCalls && Array.isArray(msg.toolCall.functionCalls)) {
                console.log("Gemini => Received Top-Level toolCall:", JSON.stringify(msg.toolCall.functionCalls, null, 2));
                for (const call of msg.toolCall.functionCalls) {
                    // Handle GetVision function (fast capture + Flash 2.5 analysis)
                    if (call.name === "GetVision" && call.id) {
                        let userPrompt = "Describe the image in maximum 3 sentences. With nothing else!";
                        if (call.args?.prompt && typeof call.args.prompt === 'string' && call.args.prompt.trim() !== "") {
                            userPrompt = call.args.prompt.trim() + "Response in maximum 3 sentences. With nothing else!";
                            console.log(`*GetVision (ID: ${call.id}) prompt: "${userPrompt}"`);
                        } else {
                            console.log(`*GetVision (ID: ${call.id}) called with no specific prompt, using default.`);
                        }

                        if (waitingForImage) {
                            console.warn("Received GetVision call while already waiting for an image. Ignoring new request.");
                        } else {
                            pendingVisionCall = { prompt: userPrompt, id: call.id }; // Store prompt and ID
                            waitingForImage = true;

                            // Set timeout for image capture
                            imageTimeoutId = setTimeout(() => {
                                if (waitingForImage && pendingVisionCall) {
                                    console.error(`Image capture timeout after ${IMAGE_CAPTURE_TIMEOUT}ms. Device may not be responding to photo requests.`);
                                    waitingForImage = false;

                                    // Send error response back to Gemini
                                    if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN && pendingVisionCall.id) {
                                        const functionResponsePayload = {
                                            functionResponses: [{
                                                id: pendingVisionCall.id,
                                                name: "GetVision",
                                                response: { result: "Image capture failed: Device did not respond to photo request within timeout period. Please check device camera functionality." }
                                            }]
                                        };
                                        const functionResponse = { toolResponse: functionResponsePayload };
                                        try {
                                            geminiWs.send(JSON.stringify(functionResponse));
                                            console.log("Gemini Live => Sent timeout error response for GetVision");
                                        } catch (err) {
                                            console.error("Failed to send timeout error response to Gemini:", err);
                                        }
                                    }

                                    pendingVisionCall = null;
                                    imageTimeoutId = null;
                                }
                            }, IMAGE_CAPTURE_TIMEOUT);

                            if (deviceWs.readyState === WSWebSocket.OPEN) {
                                console.log(`Device => Sending REQUEST.PHOTO (triggered by GetVision ID: ${call.id})`);
                                console.log(`Device => Waiting for image capture with ${IMAGE_CAPTURE_TIMEOUT}ms timeout...`);
                                deviceWs.send(JSON.stringify({ type: "server", msg: "REQUEST.PHOTO" }));
                            } else {
                                console.error("Cannot request photo, device WS is not open.");
                                waitingForImage = false;
                                pendingVisionCall = null;
                                if (imageTimeoutId) {
                                    clearTimeout(imageTimeoutId);
                                    imageTimeoutId = null;
                                }
                            }
                        }
                    } else if (call.name === "Action" && call.id) {
                        const callId = call.id;
                        const userCommand = call.args?.userCommand;
                        console.log(`*Action (ID: ${callId}) called with command: "${userCommand}"`);

                        let result = { success: false, message: "Unknown error in Action." };

                        if (typeof userCommand === 'string' && userCommand.trim()) {
                            try {
                                result = await processUserActionWithSession(sessionId, userCommand.trim(), supabase, user.user_id);
                                console.log(`Action result for ID ${callId} (session: ${sessionId}):`, result);
                            } catch (err) {
                                console.error(`Error executing Action for ID ${callId}:`, err);
                                result = { success: false, message: err instanceof Error ? err.message : String(err) };
                            }
                        } else {
                            const errorMsg = `Invalid or missing 'userCommand' argument for Action (ID: ${callId}). Expected a non-empty string.`;
                            console.error(errorMsg);
                            result = { success: false, message: errorMsg };
                        }

                        // Send function response back to Gemini Live
                        if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                            const functionResponsePayload = {
                                functionResponses: [
                                    {
                                        id: callId,
                                        name: "Action",
                                        response: { result: result.message }
                                    }
                                ]
                            };
                            const functionResponse = { toolResponse: functionResponsePayload };
                            try {
                                geminiWs.send(JSON.stringify(functionResponse));
                                console.log(`Gemini Live => Sent Function Response for Action (ID: ${callId}):`, JSON.stringify(functionResponsePayload));
                            } catch (err) {
                                console.error(`Failed to send Action function response (ID: ${callId}) to Gemini:`, err);
                            }
                        } else {
                            console.error(`Cannot send Action function response (ID: ${callId}), Gemini WS not open.`);
                        }



                    } else {
                        console.warn(`Received unhandled top-level function call: ${call.name} or missing ID.`);
                        // TODO: Send an error response back for this call ID?
                    }
                }
                return;
            }

            // Handle Server Content (TTS, Function Calls within parts, Text)
            if (msg.serverContent?.modelTurn?.parts) {
                let functionCallDetectedInParts = false;
                // Filter out specific audio mimeType before logging
                const partsToLog = msg.serverContent.modelTurn.parts.filter((part: any) =>
                    !(part.inlineData && part.inlineData.mimeType === 'audio/pcm;rate=24000')
                );
                if (partsToLog.length > 0) { // Only log if there are non-audio parts
                    console.log("Gemini => Received serverContent parts (excluding audio):", JSON.stringify(partsToLog, null, 2));
                }

                for (const part of msg.serverContent.modelTurn.parts) {
                    // Check for Function Call within parts
                    if (part.functionCall) {
                        const fCall = part.functionCall;
                        console.warn("Gemini => Detected functionCall within parts (Ignoring in favor of top-level toolCall):", JSON.stringify(fCall));
                        if (fCall.name === "GetVision") {
                            functionCallDetectedInParts = true; // Still note detection if needed elsewhere
                        }
                    }

                    // Check for Executable Code
                    else if (part.executableCode && part.executableCode.language === "PYTHON") {
                        const code = part.executableCode.code;
                        console.warn("Gemini => Detected executableCode within parts (Ignoring in favor of top-level toolCall):");

                        // Basic parsing to detect GetVision call for logging purposes only
                        const visionMatch = code.match(/GetVision\(prompt=(?:'|")(.*?)(?:'|")\)/);
                        if (visionMatch) {
                            functionCallDetectedInParts = true;
                            console.warn("*(Detected as potential GetVision call via executableCode, but ignoring trigger)");
                        }
                    }

                    // Check for Text part (Log intermediate text)
                    if (part.text) {
                        console.log("Gemini partial text:", part.text);
                    }


                    // Check for TTS Audio Data
                    if (part.inlineData?.data) {
                        // Send RESPONSE.CREATED on the *first* audio chunk
                        if (!responseCreatedSent && deviceWs.readyState === WSWebSocket.OPEN) {
                            responseCreatedSent = true;
                            deviceWs.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
                            console.log("Device => Sent RESPONSE.CREATED");
                        }

                        // Decode base64 -> Filter -> Boost Volume -> Encode to Opus -> Send to device
                        try {
                            const pcmData = Buffer.from(part.inlineData.data, "base64");
                            ttsFilter.processAudioInPlace(pcmData); // Apply the filter
                            // Reducing boost factor to potentially reduce clipping/artifacts
                            boostTtsVolumeInPlace(pcmData, 3.0);
                            const opusFrames = await ttsState.encodePcmChunk(pcmData);

                            for (const frame of opusFrames) {
                                if (deviceWs.readyState === WSWebSocket.OPEN && !deviceClosed) {
                                    deviceWs.send(frame); // Send binary Opus frame
                                } else {
                                    // Stop sending if device closed during processing
                                    console.warn("Device WS closed while sending TTS frames. Aborting send.");
                                    break; // Exit inner loop
                                }
                            }
                        } catch (err) {
                            console.error("Error processing/sending TTS audio chunk:", err);
                        }

                    } // --- End TTS Audio Check ---
                } // --- End loop through parts ---

                // If a function call was detected and handled, Gemini might not expect further audio processing *for this turn*
                // until it receives the function response. The logic above handles parts independently.

            } // --- End Server Content Check ---


            // --- Handle Generation Complete (End of Assistant's Turn/Speech) ---
            if (msg.serverContent?.generationComplete) {
                console.log("Gemini => Generation Complete.");
                // Only send RESPONSE.COMPLETE if we actually sent audio and weren't just handling a function call
                if (responseCreatedSent) {
                    console.log("Device => Sending RESPONSE.COMPLETE");
                    ttsState.reset(); // Reset Opus buffer
                    responseCreatedSent = false; // Reset flag for next response

                    try {
                        // Fetch latest device info (like volume) before signaling completion
                        const devInfo = await getDeviceInfo(supabase, user.user_id).catch(() => null); // Handle potential fetch error
                        if (deviceWs.readyState === WSWebSocket.OPEN) {
                            deviceWs.send(JSON.stringify({
                                type: "server",
                                msg: "RESPONSE.COMPLETE",
                                volume_control: devInfo?.volume ?? 100, // Send last known or default volume
                                pitch_factor: user.personality?.pitch_factor ?? 1,
                            }));
                        }
                    } catch (err) {
                        console.error("Error sending RESPONSE.COMPLETE:", err);
                        // Still try to send basic complete message if fetching device info failed
                        if (deviceWs.readyState === WSWebSocket.OPEN) {
                            deviceWs.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                        }
                    }
                } else {
                    console.log("Generation complete, but no audio was sent (likely function call only or text response). Not sending RESPONSE.COMPLETE.");
                }
            } // --- End Generation Complete Check ---


            // --- Handle Transcriptions (User & Assistant) ---
            if (msg.inputTranscription?.text) {
                // Log partial transcription
                // console.log("Gemini => User partial transcription:", msg.inputTranscription.text); // Can be verbose
                if (msg.inputTranscription.finished && msg.inputTranscription.text.trim()) {
                    console.log("Gemini => User final transcription:", msg.inputTranscription.text);
                    // Store final user utterance in DB
                    await addConversation(supabase, "user", msg.inputTranscription.text, user)
                        .catch(err => console.error("DB Error (User Conv):", err));
                }
            }

            if (msg.outputTranscription?.text) {
                // Log partial assistant transcription
                // console.log("Gemini => Assistant partial transcription:", msg.outputTranscription.text); // Can be verbose
                if (msg.outputTranscription.finished && msg.outputTranscription.text.trim()) {
                    console.log("Gemini => Assistant final transcription:", msg.outputTranscription.text);
                    // Store final assistant utterance in DB
                    await addConversation(supabase, "assistant", msg.outputTranscription.text, user)
                        .catch(err => console.error("DB Error (Asst Conv):", err));
                }
            } // --- End Transcription Handling ---

            // Handle potential GoAway message
            if (msg.goAway) {
                console.warn("Gemini => Received goAway:", JSON.stringify(msg.goAway));
                // Consider closing the connection based on the reason
                if (deviceWs.readyState === WSWebSocket.OPEN) {
                    deviceWs.close(1011, `Gemini requested disconnect: ${msg.goAway.reason || 'Unknown reason'}`);
                }
            }

        } // --- End handleGeminiMessage ---


        // deviceWs => messages from device (Merged Handler)
        deviceWs.on("message", async (raw: RawData, isBinary: boolean) => {
            if (!pipelineActive || deviceClosed) return;

            // Debug: Log all incoming messages
            if (isBinary) {
                const rawSize = raw instanceof ArrayBuffer ? raw.byteLength :
                               Buffer.isBuffer(raw) ? raw.length :
                               Array.isArray(raw) ? raw.reduce((sum, buf) => sum + buf.length, 0) : 0;
                console.log(`Device => Received binary message: ${rawSize} bytes`);
            } else {
                const rawString = raw.toString("utf-8");
                if (rawString.length > 1000) {
                    console.log(`Device => Received large text message: ${rawString.length} chars`);
                } else {
                    console.log(`Device => Received text message: ${rawString.substring(0, 200)}${rawString.length > 200 ? '...' : ''}`);
                }
            }

            if (isBinary) {
                // --- Handle Mic Audio Chunk (ADPCM Compressed or Raw PCM) ---
                let audioChunk: Uint8Array | null = null;

                if (raw instanceof ArrayBuffer) {
                    audioChunk = new Uint8Array(raw);
                } else if (Buffer.isBuffer(raw)) { // Check if it's a Node.js Buffer
                    // Create a Uint8Array view over the Buffer's underlying ArrayBuffer
                    audioChunk = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
                } else {
                    console.warn("Received unexpected binary data format (not ArrayBuffer or Buffer). Ignoring.", typeof raw);
                    // Optionally handle Buffer[] case if needed, though less common here
                    // For now, we ignore other formats
                }

                if (!audioChunk) {
                    return; // Don't process if we couldn't interpret the data
                }

                // Decompress ADPCM to PCM if ADPCM is enabled
                let pcmChunk: Uint8Array;
                if (ADPCM_ENABLED) {
                    // Decompress ADPCM data to PCM
                    pcmChunk = adpcmProcessor.decodeADPCMChunk(audioChunk);
                    // Debug: Log compression ratio (only occasionally to avoid spam)
                    if (audioChunk.length > 0 && Math.random() < 0.01) { // Log ~1% of chunks
                        const compressionRatio = pcmChunk.length / audioChunk.length;
                        console.log(`ADPCM: Decompressed ${audioChunk.length} bytes to ${pcmChunk.length} bytes (${compressionRatio.toFixed(1)}x expansion)`);
                    }
                } else {
                    // Use raw PCM data
                    pcmChunk = audioChunk;
                }

                // Accumulate buffer
                const combined = new Uint8Array(micAccum.length + pcmChunk.length);
                combined.set(micAccum, 0);
                combined.set(pcmChunk, micAccum.length);
                micAccum = combined;

                // Process and send chunks of sufficient size
                while (micAccum.length >= MIC_ACCUM_CHUNK_SIZE) {
                    const chunkToSend = micAccum.slice(0, MIC_ACCUM_CHUNK_SIZE);
                    micAccum = micAccum.slice(MIC_ACCUM_CHUNK_SIZE); // Keep the remainder

                    // Debug: Log audio chunk info periodically
                    //console.log(`Audio chunk: ${chunkToSend.length} bytes, first few samples: ${Array.from(chunkToSend.slice(0, 8)).join(',')}`);

                    // TEMPORARY: Skip filtering to test if filter is causing issues
                    // TODO: Re-enable filtering after testing
                    const filteredChunk = new Uint8Array(chunkToSend);
                    micFilter.processAudioInPlace(filteredChunk);

                    // Use original unfiltered audio for now
                    const audioToSend = chunkToSend;

                    // Base64 encode the audio
                    const b64 = Buffer.from(audioToSend).toString("base64");

                    // Send to Gemini if connected
                    if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                        const gemMsg = {
                            realtime_input: {
                                media_chunks: [
                                    { data: b64, mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}` }
                                ]
                            }
                        };
                        try {
                            geminiWs.send(JSON.stringify(gemMsg));
                            // Debug: Log successful sends periodically
                            //console.log(`Successfully sent audio chunk to Gemini: ${b64.length} chars base64`);

                        } catch (err) {
                            console.error("Failed to send audio chunk to Gemini:", err);
                        }
                    } else {
                        // Stop processing if Gemini disconnects
                        console.warn("Cannot send audio chunk, Gemini WS not open.");
                        micAccum = new Uint8Array(0); // Clear buffer if connection lost
                        break;
                    }
                } // --- End while loop for chunk processing ---

            } else {
                // --- Handle Text Messages from Device (JSON commands, image data) ---
                let msgObj;
                try {
                    const rawString = raw.toString("utf-8");
                    // Log incoming message type and size for debugging
                    if (rawString.length > 1000) {
                        console.log(`Device => Received large message (${rawString.length} chars), likely image data`);
                        // Check if it starts with image data pattern
                        if (rawString.includes('"type":"image"')) {
                            console.log("Device => Confirmed image message detected");
                        }
                    } else {
                        console.log(`Device => Received message: ${rawString.substring(0, 200)}${rawString.length > 200 ? '...' : ''}`);
                    }

                    msgObj = JSON.parse(rawString);
                } catch (err) {
                    console.error("Device JSON parse error:", err, "Raw length:", raw.toString("utf-8").length);
                    console.error("Raw preview:", raw.toString("utf-8").substring(0, 500));
                    return; // Ignore malformed messages
                }

                // Wrap the actual message processing logic in a try/catch
                try {
                    // --- Handle Image Chunk Data ---
                    if (msgObj.type === "image_chunk") {
                        console.log(`Device => Received image chunk ${msgObj.chunk_index + 1}/${msgObj.total_chunks}`);

                        if (!waitingForImage || !pendingVisionCall) {
                            console.warn(`Device => Received image chunk but not waiting for image. Ignoring.`);
                            return;
                        }

                        // Initialize chunk assembly if this is the first chunk
                        if (!imageChunkAssembly) {
                            imageChunkAssembly = {
                                chunks: new Map(),
                                totalChunks: msgObj.total_chunks,
                                receivedCount: 0,
                                timestamp: Date.now()
                            };

                            // Set timeout for chunk assembly
                            chunkTimeoutId = setTimeout(() => {
                                console.error(`Image chunk assembly timeout after ${IMAGE_CHUNK_TIMEOUT_MS}ms. Received ${imageChunkAssembly?.receivedCount}/${imageChunkAssembly?.totalChunks} chunks.`);

                                // Clean up and send error response
                                imageChunkAssembly = null;
                                waitingForImage = false;

                                if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN && pendingVisionCall?.id) {
                                    const functionResponsePayload = {
                                        functionResponses: [{
                                            id: pendingVisionCall.id,
                                            name: "GetVision",
                                            response: { result: "Image capture failed: Incomplete chunk transmission." }
                                        }]
                                    };
                                    const functionResponse = { toolResponse: functionResponsePayload };
                                    try {
                                        geminiWs.send(JSON.stringify(functionResponse));
                                        console.log("Gemini Live => Sent chunk timeout error response");
                                    } catch (err) {
                                        console.error("Failed to send chunk timeout error response to Gemini:", err);
                                    }
                                }

                                pendingVisionCall = null;
                                chunkTimeoutId = null;
                            }, IMAGE_CHUNK_TIMEOUT_MS);
                        }

                        // Store the chunk
                        imageChunkAssembly.chunks.set(msgObj.chunk_index, msgObj.data);
                        imageChunkAssembly.receivedCount++;

                        console.log(`Device => Stored chunk ${msgObj.chunk_index}, total received: ${imageChunkAssembly.receivedCount}/${imageChunkAssembly.totalChunks}`);

                        // Check if we have all chunks
                        if (imageChunkAssembly.receivedCount === imageChunkAssembly.totalChunks) {
                            console.log(`Device => All chunks received, assembling image...`);

                            // Clear timeout
                            if (chunkTimeoutId) {
                                clearTimeout(chunkTimeoutId);
                                chunkTimeoutId = null;
                            }

                            // Assemble the complete base64 image
                            let completeBase64 = "";
                            for (let i = 0; i < imageChunkAssembly.totalChunks; i++) {
                                const chunk = imageChunkAssembly.chunks.get(i);
                                if (!chunk) {
                                    console.error(`Missing chunk ${i} during assembly!`);
                                    imageChunkAssembly = null;
                                    waitingForImage = false;
                                    pendingVisionCall = null;
                                    return;
                                }
                                completeBase64 += chunk;
                            }

                            console.log(`Device => Image assembly complete - ${completeBase64.length} characters`);

                            // Clean up chunk assembly
                            imageChunkAssembly = null;

                            // Process the complete image (reuse existing logic)
                            await processCompleteImage(completeBase64);
                        }

                        return; // Don't process further for chunk messages
                    }

                    // --- Handle Image Complete Message ---
                    else if (msgObj.type === "image_complete") {
                        console.log(`Device => Received image_complete message for ${msgObj.total_chunks} chunks`);
                        // This is just a confirmation message, actual processing happens when all chunks are received
                        return;
                    }

                    // --- Handle Legacy Single Image Data ---
                    else if (msgObj.type === "image") {
                        console.log(`Device => Processing legacy single image message. waitingForImage: ${waitingForImage}, pendingVisionCall: ${!!pendingVisionCall}`);

                        if (!waitingForImage || !pendingVisionCall) {
                            console.warn(`Device => Received image but not waiting for one. waitingForImage: ${waitingForImage}, pendingVisionCall: ${!!pendingVisionCall}`);
                            return; // Don't process unexpected images
                        }

                        console.log(`Device => Received legacy image data for GetVision ID: ${pendingVisionCall.id}`);
                        console.log(`Device => Image capture successful, processing with Flash 2.5...`);

                        const base64Jpeg = msgObj.data as string;
                        await processCompleteImage(base64Jpeg);

                    } // --- End Handle Image Data ---

                    // --- Handle Control Messages (e.g., end_of_speech, interrupt - from Script 2) ---
                    else if (msgObj.type === "instruction" || msgObj.type === "server") { // Accept both types for flexibility
                        if (msgObj.msg === "end_of_speech") {
                            console.log("Device => End of Speech detected.");
                            // Flush any remaining audio in the buffer
                            if (micAccum.length > 0 && isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                                console.log(`Flushing remaining ${micAccum.length} bytes of audio.`);

                                // TEMPORARY: Skip filtering on final chunk too
                                // micFilter.processAudioInPlace(micAccum);
                                const b64 = Buffer.from(micAccum).toString("base64");
                                micAccum = new Uint8Array(0); // Clear after processing

                                const gemMsg = {
                                    realtime_input: { media_chunks: [{ data: b64, mime_type: `audio/pcm;rate=${MIC_SAMPLE_RATE}` }] }
                                };
                                try {
                                    geminiWs.send(JSON.stringify(gemMsg));
                                    console.log("Successfully sent final audio chunk to Gemini");
                                } catch (err) {
                                    console.error("Failed to send final audio chunk to Gemini:", err);
                                }
                            } else {
                                console.log("No remaining audio to flush or Gemini not connected");
                                micAccum = new Uint8Array(0); // Clear buffer even if not sent
                            }

                            // Signal Turn Complete to Gemini
                            if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                                console.log("Gemini Live => Signaling Turn Complete (End of Speech).");
                                const finalizeTurn = {
                                    clientContent: { turns: [], turnComplete: true } // Empty turns, just signal completion
                                };
                                try {
                                    geminiWs.send(JSON.stringify(finalizeTurn));
                                } catch (err) {
                                    console.error("Failed to send Turn Complete message to Gemini:", err);
                                }
                            }
                            // Acknowledge device (optional but good practice)
                            if (deviceWs.readyState === WSWebSocket.OPEN) {
                                deviceWs.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
                            }

                        } else if (msgObj.msg === "INTERRUPT") {
                            console.log("Device => INTERRUPT received.");
                            micAccum = new Uint8Array(0); // Discard any buffered audio on interrupt
                            ttsState.reset(); // Stop any ongoing TTS buffering
                            responseCreatedSent = false; // Reset TTS flag


                            // Signal interruption/turn completion to Gemini (might be optional depending on desired interrupt behavior)
                            if (isGeminiConnected && geminiWs?.readyState === WSWebSocket.OPEN) {
                                console.log("Gemini Live => Signaling Turn Complete (Interrupt).");
                                // Sending turnComplete might make Gemini stop its current output and listen again.
                                const interruptTurn = {
                                    clientContent: { turns: [], turnComplete: true }
                                };
                                try {
                                    geminiWs.send(JSON.stringify(interruptTurn));
                                } catch (err) {
                                    console.error("Failed to send Turn Complete (Interrupt) to Gemini:", err);
                                }
                            }
                            // Acknowledge device (optional)
                            // if (deviceWs.readyState === WSWebSocket.OPEN) {
                            //     deviceWs.send(JSON.stringify({ type: "server", msg: "INTERRUPT.ACK" }));
                            // }
                        }
                        // Handle other instructions if needed
                        // else if (msgObj.msg === "some_other_command") { ... }

                    } // --- End Handle Control Messages ---

                    // --- Handle other message types if necessary ---
                    // else if (msgObj.type === "status") { ... }

                } catch (err) {
                    // Catch errors within the non-binary message handling
                    console.error("Error processing text message from device:", err);
                    // If an error happens during image processing *after* upload started,
                    // ensure we clear the pending state.
                    if (msgObj.type === "image" && waitingForImage) {
                        waitingForImage = false;
                        pendingVisionCall = null;
                         photoCaptureFailed = false; // Reset flag
                    }
                }
            } // --- End Text Message Handling ---
        }); // --- End deviceWs.on("message") ---

        // ---------------------------------------------------------------------------
        // deviceWs => Error and Close Handlers
        // ---------------------------------------------------------------------------
        deviceWs.on("error", (err) => {
            console.error("Device WS error:", err);
            if (!deviceClosed) {
                deviceClosed = true; // Prevent further actions
                pipelineActive = false;
                console.log("Closing Gemini WS due to device error.");
                // If waiting for a retry, cancel it
                if (retryTimeoutId) {
                    console.log("Device error, cancelling pending Gemini reconnect.");
                    clearTimeout(retryTimeoutId);
                    retryTimeoutId = null;
                }
                geminiWs?.close(1011, "Device error");
            }
        });

        deviceWs.on("close", async (code, reason) => {
            if (deviceClosed) return; // Avoid duplicate logging/actions
            console.log(`Device WS closed => Code: ${code}, Reason: ${reason.toString()}`);
            deviceClosed = true;
            pipelineActive = false;

            // Clean up image chunk assembly
            if (chunkTimeoutId) {
                clearTimeout(chunkTimeoutId);
                chunkTimeoutId = null;
            }
            imageChunkAssembly = null;

            // If waiting for a retry, cancel it
            if (retryTimeoutId) {
                console.log("Device closed, cancelling pending Gemini reconnect.");
                clearTimeout(retryTimeoutId);
                retryTimeoutId = null;
            }

            // Log session duration
            if (sessionStartTime > 0) {
                const durationSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
                console.log(`Session duration: ${durationSeconds} seconds.`);
                await updateUserSessionTime(supabase, user, durationSeconds)
                    .catch(err => console.error("DB Error (Session Time):", err));
            }

            // Close Gemini connection if it's still open
            if (geminiWs && geminiWs.readyState !== WSWebSocket.CLOSED && geminiWs.readyState !== WSWebSocket.CLOSING) {
                console.log("Closing Gemini WS because device disconnected.");
                geminiWs.close(1000, "Device disconnected");
            }
            geminiWs = null; // Ensure reference is cleared

            // Destroy Flash 2.5 session
            console.log(`Destroying Flash 2.5 session: ${sessionId}`);
            destroyFlash25Session(sessionId);
        });

        // ---------------------------------------------------------------------------
        // Finally, Initiate the connection to Gemini Live
        // ---------------------------------------------------------------------------
        connectToGeminiLive();

    }); // --- End wss.on("connection") ---
}
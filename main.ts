import "./config.ts";

import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket as WSWebSocket } from "npm:ws";
import type { RawData, WebSocketServer as _WSS } from "npm:ws"; // Use _WSS alias

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

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
import { setupWebSocketConnectionHandler } from "./websocket_handler.ts";
import { audioDebugManager } from "./audio_debug.ts";

import {
  isDev,
  HOST,
  PORT,
  TTS_SAMPLE_RATE,
  TTS_FRAME_SIZE_BYTES,
  MIC_SAMPLE_RATE
} from "./config.ts";


console.log("Initializing server...");

// Create HTTP + WebSocket server
const server = createServer();
const wss: _WSS = new WebSocketServer({ noServer: true });

// Setup the main WebSocket connection listener
setupWebSocketConnectionHandler(wss);

// -----------------------------------------------------------------------------
// HTTP Server Upgrade Handler (Authentication)
// -----------------------------------------------------------------------------
server.on("upgrade", async (req, socket, head) => {
  console.log(`Incoming upgrade request from: ${req.socket.remoteAddress}`);
  try {
    const url = new URL(req.url || "/", `ws://${req.headers.host}`); // Need base for URL parsing
    const token = url.searchParams.get("token") || req.headers.authorization?.replace("Bearer ", "") || ""; // Allow token via query param or header

    if (!token) {
      console.log("Upgrade failed: No token provided.");
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"Access to WebSocket\"\r\n\r\n");
      socket.destroy();
      return;
    }

    // Create a Supabase client scoped to the token for authentication
    const supabase = getSupabaseClient(token);

    // Authenticate using the token
    const user = await authenticateUser(supabase, token);
    console.log(`User authenticated via token: ${user.email}`); // Assuming user object has email

    // Proceed with WebSocket upgrade, passing context to the connection handler
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("WebSocket upgrade successful, emitting connection event.");
      wss.emit("connection", ws, {
        user,
        supabase, // Pass the scoped Supabase client
        timestamp: new Date().toISOString(),
      });
    });
  } catch (err) {
    // Log specific auth errors vs other errors
    if (err instanceof Error && err.message.includes("Authentication failed")) {
        console.error("Authentication failed:", err.message);
    } else {
        console.error("Upgrade handler error:", err);
    }
    // Send 401 on any failure during upgrade/auth
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
  }
});

// -----------------------------------------------------------------------------
// Launch server
// -----------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`WebSocket server listening on ws://${HOST}:${PORT}/`);
  console.log(`Development mode: ${isDev}`);
});

// -----------------------------------------------------------------------------
// Graceful Shutdown Handler
// -----------------------------------------------------------------------------
Deno.addSignalListener("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down...");

  // First, end all active audio debug sessions
  console.log("Ending all audio debug sessions...");
  try {
    await audioDebugManager.endAllSessions("server_shutdown");
    console.log("Audio debug sessions ended.");
  } catch (err) {
    console.error("Error ending audio debug sessions:", err);
  }

  let serversClosed = 0;
  const totalServers = 2; // HTTP and WebSocket

  const checkExit = () => {
    serversClosed++;
    if (serversClosed >= totalServers) {
      console.log("All servers closed. Exiting.");
      Deno.exit(0);
    }
  };

  console.log("Closing HTTP server...");
  server.close((err) => {
    if (err) {
        console.error("Error closing HTTP server:", err);
    } else {
        console.log("HTTP server closed.");
    }
    checkExit();
  });

  console.log("Closing WebSocket server...");
  wss.close((err) => {
    if (err) {
        console.error("Error closing WebSocket server:", err);
    } else {
        console.log("WebSocket server closed.");
    }
    checkExit();
  });

  // Add a timeout as a safety measure (increased to allow audio debug file saving)
  setTimeout(async () => {
    console.warn("Shutdown timeout reached. Forcing audio debug cleanup and exit.");
    try {
      await audioDebugManager.endAllSessions("forced_shutdown");
    } catch (err) {
      console.error("Error in forced audio debug cleanup:", err);
    }
    Deno.exit(1);
  }, 10000); // 10 seconds timeout (increased from 5)

});

console.log("Server setup complete.");
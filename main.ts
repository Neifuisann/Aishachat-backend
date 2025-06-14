import './config.ts';

import { createServer } from 'node:http';
import { WebSocketServer } from 'npm:ws';
import type { WebSocketServer as _WSS } from 'npm:ws'; // Use _WSS alias

import { Logger } from './logger.ts';

const logger = new Logger('[Main]');

import { authenticateUser } from './utils.ts';
import { getSupabaseClient } from './supabase.ts';
import { setupWebSocketConnectionHandler } from './websocket_handler.ts';
import { audioDebugManager } from './audio_debug.ts';

import { HOST, isDev, PORT } from './config.ts';

logger.info('Initializing server...');

// Create HTTP + WebSocket server
const server = createServer();
const wss: _WSS = new WebSocketServer({ noServer: true });

// Setup the main WebSocket connection listener
setupWebSocketConnectionHandler(wss);

// -----------------------------------------------------------------------------
// HTTP Server Upgrade Handler (Authentication)
// -----------------------------------------------------------------------------
server.on('upgrade', async (req, socket, head) => {
    logger.info(`Incoming upgrade request from: ${req.socket.remoteAddress}`);
    try {
        const url = new URL(req.url || '/', `ws://${req.headers.host}`); // Need base for URL parsing
        const token = url.searchParams.get('token') ||
            req.headers.authorization?.replace('Bearer ', '') || ''; // Allow token via query param or header

        if (!token) {
            logger.warn('Upgrade failed: No token provided.');
            socket.write(
                'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="Access to WebSocket"\r\n\r\n',
            );
            socket.destroy();
            return;
        }

        // Create a Supabase client scoped to the token for authentication
        const supabase = getSupabaseClient(token);

        // Authenticate using the token
        const user = await authenticateUser(supabase, token);
        logger.info(`User authenticated via token: ${user.email}`); // Assuming user object has email

        // Proceed with WebSocket upgrade, passing context to the connection handler
        wss.handleUpgrade(req, socket, head, (ws) => {
            logger.info('WebSocket upgrade successful, emitting connection event.');
            wss.emit('connection', ws, {
                user,
                supabase, // Pass the scoped Supabase client
                timestamp: new Date().toISOString(),
            });
        });
    } catch (err) {
        // Log specific auth errors vs other errors
        if (err instanceof Error && err.message.includes('Authentication failed')) {
            logger.error('Authentication failed:', err.message);
        } else {
            logger.error('Upgrade handler error:', err);
        }
        // Send 401 on any failure during upgrade/auth
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
    }
});

// -----------------------------------------------------------------------------
// Launch server
// -----------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
    logger.info(`WebSocket server listening on ws://${HOST}:${PORT}/`);
    logger.info(`Development mode: ${isDev}`);
});

// -----------------------------------------------------------------------------
// Graceful Shutdown Handler
// -----------------------------------------------------------------------------
Deno.addSignalListener('SIGINT', async () => {
    logger.info('\nReceived SIGINT, shutting down...');

    // First, end all active audio debug sessions
    logger.info('Ending all audio debug sessions...');
    try {
        await audioDebugManager.endAllSessions('server_shutdown');
        logger.info('Audio debug sessions ended.');
    } catch (err) {
        logger.error('Error ending audio debug sessions:', err);
    }

    let serversClosed = 0;
    const totalServers = 2; // HTTP and WebSocket

    const checkExit = () => {
        serversClosed++;
        if (serversClosed >= totalServers) {
            logger.info('All servers closed. Exiting.');
            Deno.exit(0);
        }
    };

    logger.info('Closing HTTP server...');
    server.close((err) => {
        if (err) {
            logger.error('Error closing HTTP server:', err);
        } else {
            logger.info('HTTP server closed.');
        }
        checkExit();
    });

    logger.info('Closing WebSocket server...');
    wss.close((err) => {
        if (err) {
            logger.error('Error closing WebSocket server:', err);
        } else {
            logger.info('WebSocket server closed.');
        }
        checkExit();
    });

    // Add a timeout as a safety measure (increased to allow audio debug file saving)
    setTimeout(async () => {
        logger.warn('Shutdown timeout reached. Forcing audio debug cleanup and exit.');
        try {
            await audioDebugManager.endAllSessions('forced_shutdown');
        } catch (err) {
            logger.error('Error in forced audio debug cleanup:', err);
        }
        Deno.exit(1);
    }, 5);
});

logger.info('Server setup complete.');

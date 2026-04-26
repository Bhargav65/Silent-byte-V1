const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
require('dotenv').config();

const { connectDB } = require('./server/db');
const RoomManager = require('./server/roomManager');
const { registerHandlers } = require('./server/socketHandlers');
const { registerIceEndpoint } = require('./server/iceConfig');

// ─── Express & Socket.io Setup ─────────────────────────────────

const app = express();
const server = http.createServer(app);

// CORS: Use CLIENT_URL env var in production, default to '*' for local dev
const allowedOrigin = process.env.CLIENT_URL || '*';

const io = new Server(server, {
    cors: {
        origin: allowedOrigin,
        methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingInterval: 10000,   // Server pings client every 10s
    pingTimeout: 20000,    // Client has 20s to respond
    upgradeTimeout: 10000, // Time to upgrade from polling to ws
});

// ─── Static Files ──────────────────────────────────────────────

app.use(express.static(__dirname));

app.get('/chat.html', (_, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/waiting.html', (_, res) => res.sendFile(path.join(__dirname, 'waiting.html')));
app.get('/create_room', (_, res) => res.sendFile(path.join(__dirname, 'createroom.html')));
app.get('/join_room', (_, res) => res.sendFile(path.join(__dirname, 'join_room.html')));

// ─── Health Check (for Railway / Render / Sevalla) ─────────────

app.get('/health', (_, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

// ─── ICE Config REST Endpoint ──────────────────────────────────

registerIceEndpoint(app);

// ─── Start Server ──────────────────────────────────────────────

async function start() {
    try {
        const { roomsColl } = await connectDB();
        const roomManager = new RoomManager(roomsColl);
        await roomManager.loadFromDB();

        registerHandlers(io, roomManager);

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`[Server] Running on port ${PORT}`);
        });
    } catch (err) {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    }
}

start();

// ─── Graceful Shutdown ─────────────────────────────────────────

process.on('SIGTERM', async () => {
    console.log('[Server] SIGTERM received, shutting down...');
    const { closeDB } = require('./server/db');
    await closeDB();
    server.close(() => process.exit(0));
});

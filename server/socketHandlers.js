/**
 * Socket.io event handlers.
 * Handles room management, WebRTC signaling, and heartbeat.
 */

function registerHandlers(io, roomManager) {
    io.on('connection', (socket) => {
        console.log(`[Socket] Connected: ${socket.id}`);

        // ─── Room Management ───────────────────────────────────────────

        socket.on('create-room', async (roomCode, cb) => {
            try {
                const result = await roomManager.createRoom(roomCode, socket.id);
                if (result.success) {
                    socket.join(roomCode);
                }
                cb(result);
            } catch (err) {
                console.error('[Socket] create-room error:', err);
                cb({ success: false, msg: 'Server error' });
            }
        });

        socket.on('join-room', async (roomCode, cb) => {
            try {
                const result = await roomManager.joinRoom(roomCode, socket.id);
                if (result.success) {
                    socket.join(roomCode);
                    // Notify user1 that user2 has joined
                    if (result.user1SocketId) {
                        io.to(result.user1SocketId).emit('start-chat', { roomCode });
                    }
                }
                cb(result);
            } catch (err) {
                console.error('[Socket] join-room error:', err);
                cb({ success: false, msg: 'Server error' });
            }
        });

        socket.on('rejoin-room', async ({ roomCode, role }) => {
            try {
                const result = await roomManager.rejoinRoom(roomCode, role, socket.id);
                if (!result.success) return;

                socket.join(roomCode);

                // If both users are present, coordinate WebRTC renegotiation
                if (result.user1 && result.user2) {
                    // Tell user2 to prepare (setup peer connection, wait for offer)
                    io.to(result.user2.socketId).emit('start-chat', { roomCode });
                    // Tell user1 to restart WebRTC (create new offer) — slight delay
                    // so user2 has time to set up before the offer arrives
                    setTimeout(() => {
                        io.to(result.user1.socketId).emit('restart-webrtc');
                    }, 500);
                } else {
                    // Only one user in room — just notify them
                    io.to(roomCode).emit('start-chat', { roomCode });
                }
            } catch (err) {
                console.error('[Socket] rejoin-room error:', err);
            }
        });

        socket.on('leave-room', async (roomCode) => {
            try {
                socket.leave(roomCode);
                await roomManager.leaveRoom(roomCode, socket.id);
                io.in(roomCode).emit('peer-left');
            } catch (err) {
                console.error('[Socket] leave-room error:', err);
            }
        });

        // ─── WebRTC Signaling ──────────────────────────────────────────

        socket.on('offer', (data) => {
            socket.to(data.roomCode).emit('offer', { sdp: data.sdp });
        });

        socket.on('answer', (data) => {
            socket.to(data.roomCode).emit('answer', { sdp: data.sdp });
        });

        socket.on('ice-candidate', (data) => {
            socket.to(data.roomCode).emit('ice-candidate', { candidate: data.candidate });
        });

        // ─── Heartbeat ─────────────────────────────────────────────────

        socket.on('heartbeat', () => {
            socket.emit('heartbeat-ack');
        });

        // ─── Disconnect ────────────────────────────────────────────────

        socket.on('disconnect', (reason) => {
            console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);

            roomManager.handleDisconnect(socket.id, (roomCode, role) => {
                // Called after grace period if user didn't reconnect
                console.log(`[Socket] User ${role} permanently removed from ${roomCode}`);
                io.in(roomCode).emit('peer-left');
            });
        });
    });
}

module.exports = { registerHandlers };

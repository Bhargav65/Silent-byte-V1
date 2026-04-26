/**
 * RoomManager — In-memory room state with MongoDB persistence.
 * 
 * Rooms live in a Map for sub-millisecond access.
 * MongoDB is synced on key events for persistence across restarts.
 * 
 * Graceful disconnect: when a socket disconnects, we wait DISCONNECT_GRACE_MS
 * before removing the user, allowing seamless reconnection.
 */

const DISCONNECT_GRACE_MS = 15000; // 15 seconds grace period

class RoomManager {
    constructor(roomsColl) {
        this.roomsColl = roomsColl;
        /** @type {Map<string, { roomCode: string, users: Array<{socketId: string, role: string}> }>} */
        this.rooms = new Map();
        /** @type {Map<string, NodeJS.Timeout>} key = `${roomCode}:${role}` */
        this.disconnectTimers = new Map();
    }

    /**
     * Load existing rooms from MongoDB into memory on startup.
     */
    async loadFromDB() {
        const cursor = this.roomsColl.find({});
        const docs = await cursor.toArray();
        for (const doc of docs) {
            this.rooms.set(doc.roomCode, {
                roomCode: doc.roomCode,
                users: doc.users || [],
            });
        }
        console.log(`[RoomManager] Loaded ${this.rooms.size} rooms from DB`);
    }

    /**
     * Persist a room to MongoDB.
     */
    async _syncToDB(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) {
            await this.roomsColl.deleteOne({ roomCode }).catch(() => { });
            return;
        }
        await this.roomsColl.updateOne(
            { roomCode },
            { $set: { users: room.users } },
            { upsert: true }
        ).catch(err => console.error('[RoomManager] DB sync error:', err.message));
    }

    /**
     * Cancel any pending disconnect timer for a role in a room.
     */
    _cancelDisconnectTimer(roomCode, role) {
        const key = `${roomCode}:${role}`;
        const timer = this.disconnectTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.disconnectTimers.delete(key);
        }
    }

    /**
     * Create a room or update user1's socket ID if room already exists.
     * @returns {{ success: boolean, msg?: string }}
     */
    async createRoom(roomCode, socketId) {
        if (!/^[A-Za-z0-9]{6}$/.test(roomCode)) {
            return { success: false, msg: 'Invalid code' };
        }

        this._cancelDisconnectTimer(roomCode, 'user1');

        const existing = this.rooms.get(roomCode);
        if (!existing) {
            this.rooms.set(roomCode, {
                roomCode,
                users: [{ socketId, role: 'user1' }],
            });
        } else {
            const user1 = existing.users.find(u => u.role === 'user1');
            if (user1) {
                user1.socketId = socketId;
            } else {
                existing.users.push({ socketId, role: 'user1' });
            }
        }

        await this._syncToDB(roomCode);
        return { success: true, role: 'user1' };
    }

    /**
     * Join an existing room as user2.
     * @returns {{ success: boolean, msg?: string, user1SocketId?: string }}
     */
    async joinRoom(roomCode, socketId) {
        if (!/^[A-Za-z0-9]{6}$/.test(roomCode)) {
            return { success: false, msg: 'Invalid code' };
        }

        const room = this.rooms.get(roomCode);
        if (!room || room.users.length === 0) {
            return { success: false, msg: 'Room not found or user1 missing' };
        }

        this._cancelDisconnectTimer(roomCode, 'user2');

        const user2 = room.users.find(u => u.role === 'user2');
        if (user2) {
            user2.socketId = socketId;
        } else {
            room.users.push({ socketId, role: 'user2' });
        }

        await this._syncToDB(roomCode);

        const user1 = room.users.find(u => u.role === 'user1');
        return {
            success: true,
            role: 'user2',
            user1SocketId: user1 ? user1.socketId : null,
        };
    }

    /**
     * Rejoin a room after reconnection. Creates room if it was cleaned up.
     * @returns {{ success: boolean, user1?: object, user2?: object }}
     */
    async rejoinRoom(roomCode, role, socketId) {
        this._cancelDisconnectTimer(roomCode, role);

        let room = this.rooms.get(roomCode);
        if (!room) {
            // Room was cleaned up — recreate it
            room = { roomCode, users: [{ socketId, role }] };
            this.rooms.set(roomCode, room);
        } else {
            const existing = room.users.find(u => u.role === role);
            if (existing) {
                existing.socketId = socketId;
            } else {
                room.users.push({ socketId, role });
            }
        }

        await this._syncToDB(roomCode);

        const user1 = room.users.find(u => u.role === 'user1');
        const user2 = room.users.find(u => u.role === 'user2');
        return { success: true, user1: user1 || null, user2: user2 || null };
    }

    /**
     * Remove a socket from its room immediately (used for intentional leave).
     */
    async leaveRoom(roomCode, socketId) {
        const room = this.rooms.get(roomCode);
        if (!room) return;

        room.users = room.users.filter(u => u.socketId !== socketId);
        if (room.users.length === 0) {
            this.rooms.delete(roomCode);
        }
        await this._syncToDB(roomCode);
    }

    /**
     * Handle socket disconnect with grace period.
     * Returns the roomCode + role so the caller can notify others.
     */
    handleDisconnect(socketId, onRemoved) {
        // Find which room this socket belongs to
        let foundRoom = null;
        let foundRole = null;

        for (const [, room] of this.rooms) {
            const user = room.users.find(u => u.socketId === socketId);
            if (user) {
                foundRoom = room;
                foundRole = user.role;
                break;
            }
        }

        if (!foundRoom || !foundRole) return null;

        const roomCode = foundRoom.roomCode;
        const key = `${roomCode}:${foundRole}`;

        // Start grace period timer
        const timer = setTimeout(async () => {
            this.disconnectTimers.delete(key);

            // Re-check: if the user reconnected with a new socketId, don't remove
            const room = this.rooms.get(roomCode);
            if (!room) return;

            const user = room.users.find(u => u.role === foundRole);
            if (user && user.socketId === socketId) {
                // Socket ID hasn't changed — user truly left
                room.users = room.users.filter(u => u.role !== foundRole);
                if (room.users.length === 0) {
                    this.rooms.delete(roomCode);
                }
                await this._syncToDB(roomCode);
                if (onRemoved) onRemoved(roomCode, foundRole);
            }
        }, DISCONNECT_GRACE_MS);

        this.disconnectTimers.set(key, timer);
        return { roomCode, role: foundRole };
    }

    /**
     * Find room by socket ID.
     */
    findBySocket(socketId) {
        for (const [, room] of this.rooms) {
            const user = room.users.find(u => u.socketId === socketId);
            if (user) return { room, user };
        }
        return null;
    }

    /**
     * Get a room by code.
     */
    getRoom(roomCode) {
        return this.rooms.get(roomCode) || null;
    }
}

module.exports = RoomManager;

/**
 * chat-client.js — Connection, signaling, and WebRTC logic for Silent-Byte.
 *
 * Provides:
 *   - SignalingClient: Socket.io connection lifecycle
 *   - PeerManager:     WebRTC peer connection + data channel
 *
 * Usage (from chat.html):
 *   const signaling = new SignalingClient(roomCode, role);
 *   const peer = new PeerManager(signaling, roomCode, role);
 *   signaling.connect();
 */

// ═══════════════════════════════════════════════════════════════
//  CONNECTION STATES
// ═══════════════════════════════════════════════════════════════

const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    ROOM_JOINED: 'room_joined',
    PEER_CONNECTED: 'peer_connected',
    RECONNECTING: 'reconnecting',
};

// ═══════════════════════════════════════════════════════════════
//  SIGNALING CLIENT (Socket.io wrapper)
// ═══════════════════════════════════════════════════════════════

class SignalingClient {
    constructor(roomCode, role) {
        this.roomCode = roomCode;
        this.role = role;
        this.socket = null;
        this.state = ConnectionState.DISCONNECTED;
        this._listeners = {};
        this._heartbeatInterval = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this.maxReconnectAttempts = 20;
        this.reconnectIntervalMs = 2000;
    }

    /**
     * Register an event callback.
     */
    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    /**
     * Emit an event to registered callbacks.
     */
    _emit(event, ...args) {
        (this._listeners[event] || []).forEach(fn => fn(...args));
    }

    /**
     * Connect to the Socket.io server and join/create the room.
     */
    connect() {
        this.state = ConnectionState.CONNECTING;
        this._emit('state-change', this.state);

        this.socket = io({
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: this.reconnectIntervalMs,
            reconnectionDelayMax: 10000,
            transports: ['websocket', 'polling'],
        });

        this._bindSocketEvents();
        this._startHeartbeat();

        // Handle page reload — rejoin the room (using modern API)
        const navEntries = performance.getEntriesByType && performance.getEntriesByType('navigation');
        const isReload = navEntries && navEntries.length > 0 && navEntries[0].type === 'reload';
        if (isReload) {
            this.socket.once('connect', () => {
                this.socket.emit('rejoin-room', { roomCode: this.roomCode, role: this.role });
            });
        }
    }

    _bindSocketEvents() {
        const s = this.socket;

        // ─── Connection Lifecycle ────────────────────────────

        s.on('connect', () => {
            console.log('[Signaling] Connected:', s.id);

            if (this.state === ConnectionState.RECONNECTING) {
                // Re-register with the server using new socket ID
                console.log('[Signaling] Reconnected, rejoining room...');
                this._clearReconnectTimer();
                this.state = ConnectionState.ROOM_JOINED;
                s.emit('rejoin-room', { roomCode: this.roomCode, role: this.role });
                this._emit('reconnected');
                return;
            }

            // First connection — join or create the room
            if (this.role === 'user1') {
                s.emit('create-room', this.roomCode, (resp) => {
                    if (!resp.success) {
                        this._emit('error', resp.msg || 'Could not create room.');
                        return;
                    }
                    this.state = ConnectionState.ROOM_JOINED;
                    this._emit('state-change', this.state);
                    this._emit('room-ready');
                });
            } else if (this.role === 'user2') {
                s.emit('join-room', this.roomCode, (resp) => {
                    if (!resp.success) {
                        this._emit('error', resp.msg || 'Could not join room.');
                        return;
                    }
                    this.state = ConnectionState.ROOM_JOINED;
                    this._emit('state-change', this.state);
                    this._emit('room-ready');
                    this._emit('peer-joined'); // user2 knows peer is already here
                });
            }
        });

        s.on('disconnect', (reason) => {
            console.log('[Signaling] Disconnected:', reason);
            this.state = ConnectionState.RECONNECTING;
            this._emit('state-change', this.state);
            this._emit('disconnected', reason);
            this._startReconnectTimer();
        });

        // ─── Room Events ─────────────────────────────────────

        s.on('start-chat', (data) => {
            this.state = ConnectionState.ROOM_JOINED;
            this._emit('state-change', this.state);
            this._emit('peer-joined', data);
        });

        s.on('peer-left', () => {
            this._emit('peer-left');
        });

        s.on('restart-webrtc', () => {
            this._emit('restart-webrtc');
        });

        // ─── WebRTC Signaling Relay ──────────────────────────

        s.on('offer', (data) => this._emit('offer', data));
        s.on('answer', (data) => this._emit('answer', data));
        s.on('ice-candidate', (data) => this._emit('ice-candidate', data));

        // ─── Heartbeat ───────────────────────────────────────

        s.on('heartbeat-ack', () => {
            this._lastHeartbeatAck = Date.now();
        });
    }

    // ─── Signaling Emitters ────────────────────────────────

    sendOffer(sdp) {
        this.socket.emit('offer', { roomCode: this.roomCode, sdp });
    }

    sendAnswer(sdp) {
        this.socket.emit('answer', { roomCode: this.roomCode, sdp });
    }

    sendIceCandidate(candidate) {
        this.socket.emit('ice-candidate', { roomCode: this.roomCode, candidate });
    }

    leave() {
        this.socket.emit('leave-room', this.roomCode);
        this._stopHeartbeat();
        this.socket.disconnect();
        this.state = ConnectionState.DISCONNECTED;
        this._emit('state-change', this.state);
    }

    rejoin() {
        this.socket.emit('rejoin-room', { roomCode: this.roomCode, role: this.role });
    }

    // ─── Heartbeat ─────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        this._lastHeartbeatAck = Date.now();
        this._heartbeatInterval = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.socket.emit('heartbeat');
            }
        }, 10000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    // ─── Reconnect Timer (UI feedback) ────────────────────

    _startReconnectTimer() {
        this._reconnectAttempts = 0;
        this._clearReconnectTimer();

        const tick = () => {
            this._reconnectAttempts++;
            this._emit('reconnect-attempt', this._reconnectAttempts, this.maxReconnectAttempts);

            if (this._reconnectAttempts >= this.maxReconnectAttempts) {
                this._clearReconnectTimer();
                this._emit('reconnect-failed');
                return;
            }
            // Exponential backoff: 2s, 4s, 8s... capped at 10s
            const delay = Math.min(this.reconnectIntervalMs * Math.pow(1.5, this._reconnectAttempts), 10000);
            this._reconnectTimer = setTimeout(tick, delay);
        };
        this._reconnectTimer = setTimeout(tick, this.reconnectIntervalMs);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        this._reconnectAttempts = 0;
    }

    /**
     * Check if the signaling socket is connected.
     */
    isConnected() {
        return this.socket && this.socket.connected;
    }
}


// ═══════════════════════════════════════════════════════════════
//  PEER MANAGER (WebRTC wrapper)
// ═══════════════════════════════════════════════════════════════

class PeerManager {
    constructor(signaling, roomCode, role) {
        this.signaling = signaling;
        this.roomCode = roomCode;
        this.role = role;

        this.peerConnection = null;
        this.dataChannel = null;
        this.localStream = null;
        this.remoteStream = null;
        this.iceConfig = null;

        this._listeners = {};
        this.retryQueue = [];
        this._retryInterval = null;
        this.hasEverConnected = false;

        this._bindSignalingEvents();
    }

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    _emit(event, ...args) {
        (this._listeners[event] || []).forEach(fn => fn(...args));
    }

    // ─── Fetch ICE Config from Server ──────────────────────

    async _fetchIceConfig() {
        if (this.iceConfig) return this.iceConfig;

        try {
            const resp = await fetch('/api/ice-config');
            this.iceConfig = await resp.json();
        } catch (err) {
            console.warn('[Peer] Failed to fetch ICE config, using defaults:', err);
            this.iceConfig = {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                ],
                iceCandidatePoolSize: 10,
            };
        }
        return this.iceConfig;
    }

    // ─── Setup WebRTC ──────────────────────────────────────

    async setup() {
        // If there's a stale peer connection, clean it up first
        if (this.peerConnection) {
            console.log('[Peer] Cleaning up stale connection before setup');
            this.cleanup();
        }

        console.log('[Peer] Setting up new WebRTC connection...');
        const config = await this._fetchIceConfig();
        this.peerConnection = new RTCPeerConnection(config);

        // ICE connection state monitoring
        this.peerConnection.oniceconnectionstatechange = () => {
            if (!this.peerConnection) return; // Guard against stale callbacks
            const state = this.peerConnection.iceConnectionState;
            console.log('[Peer] ICE state:', state);

            if (state === 'connected' || state === 'completed') {
                this._emit('connected', !this.hasEverConnected);
                this.hasEverConnected = true;
            } else if (state === 'disconnected') {
                this._emit('ice-disconnected');
                // Try ICE restart first before full restart
                this._attemptIceRestart();
            } else if (state === 'failed') {
                this._emit('ice-failed');
                this.restart();
            }
        };

        // ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.sendIceCandidate(event.candidate);
            }
        };

        // Remote tracks (video/audio)
        this.peerConnection.ontrack = (event) => {
            this._emit('remote-track', event);
        };

        // Data channel setup
        if (this.role === 'user1') {
            this.dataChannel = this.peerConnection.createDataChannel('chat');
            this._bindDataChannel();

            try {
                const offer = await this.peerConnection.createOffer();
                await this.peerConnection.setLocalDescription(offer);
                this.signaling.sendOffer(this.peerConnection.localDescription);
            } catch (err) {
                console.error('[Peer] Error creating offer:', err);
            }
        } else {
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this._bindDataChannel();
            };
        }
    }

    // ─── Data Channel ──────────────────────────────────────

    _bindDataChannel() {
        if (!this.dataChannel) return;

        this.dataChannel.onopen = () => {
            console.log('[Peer] Data channel open');
            this._emit('datachannel-open');

            // Flush retry queue
            while (this.retryQueue.length > 0 && this.dataChannel && this.dataChannel.readyState === 'open') {
                this.dataChannel.send(this.retryQueue.shift());
            }
            if (this.retryQueue.length === 0 && this._retryInterval) {
                clearInterval(this._retryInterval);
                this._retryInterval = null;
            }
        };

        this.dataChannel.onmessage = (e) => {
            this._emit('datachannel-message', e.data);
        };

        this.dataChannel.onerror = (e) => {
            console.error('[Peer] Data channel error:', e);
            this._emit('datachannel-error', e);
        };

        this.dataChannel.onclose = () => {
            console.log('[Peer] Data channel closed');
            this._emit('datachannel-close');
        };
    }

    /**
     * Send data through the data channel with retry support.
     */
    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(data);
            return true;
        }

        // Queue for retry
        this.retryQueue.push(data);
        if (!this._retryInterval) {
            this._retryInterval = setInterval(() => {
                while (this.retryQueue.length > 0 && this.dataChannel && this.dataChannel.readyState === 'open') {
                    this.dataChannel.send(this.retryQueue.shift());
                }
                if (this.retryQueue.length === 0) {
                    clearInterval(this._retryInterval);
                    this._retryInterval = null;
                }
            }, 2000);
        }
        return false;
    }

    /**
     * Check if data channel is open.
     */
    isDataChannelOpen() {
        return this.dataChannel && this.dataChannel.readyState === 'open';
    }

    // ─── Signaling Event Handlers ──────────────────────────

    _bindSignalingEvents() {
        this.signaling.on('offer', async ({ sdp }) => {
            try {
                // If no peer connection yet, set one up (user2 receiving offer)
                if (!this.peerConnection) await this.setup();
                // If the peer connection is in a bad state, recreate it
                if (this.peerConnection.signalingState === 'closed') {
                    console.log('[Peer] Peer connection closed, recreating for offer');
                    this.cleanup();
                    await this.setup();
                }
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
                const answer = await this.peerConnection.createAnswer();
                await this.peerConnection.setLocalDescription(answer);
                this.signaling.sendAnswer(this.peerConnection.localDescription);
            } catch (err) {
                console.error('[Peer] Error handling offer:', err);
            }
        });

        this.signaling.on('answer', async ({ sdp }) => {
            try {
                if (!this.peerConnection) return;
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            } catch (err) {
                console.error('[Peer] Error handling answer:', err);
            }
        });

        this.signaling.on('ice-candidate', ({ candidate }) => {
            if (this.peerConnection && candidate) {
                this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
                    console.error('[Peer] Error adding ICE candidate:', err);
                });
            }
        });

        // NOTE: 'restart-webrtc' is handled by chat.html (the UI layer).
        // PeerManager only handles the signaling relay (offer/answer/ice).
    }

    // ─── ICE Restart ───────────────────────────────────────

    async _attemptIceRestart() {
        if (!this.peerConnection) return;
        // Only attempt ICE restart if signaling is connected (to relay the offer)
        if (!this.signaling.isConnected()) {
            console.log('[Peer] Signaling not connected, skipping ICE restart');
            return;
        }
        try {
            console.log('[Peer] Attempting ICE restart...');
            const offer = await this.peerConnection.createOffer({ iceRestart: true });
            await this.peerConnection.setLocalDescription(offer);
            this.signaling.sendOffer(this.peerConnection.localDescription);
        } catch (err) {
            console.error('[Peer] ICE restart failed, doing full restart:', err);
            this.restart();
        }
    }

    // ─── Full Restart ──────────────────────────────────────

    restart() {
        console.log('[Peer] Full WebRTC restart');
        this.cleanup();
        // Only rejoin if signaling is connected
        if (this.signaling.isConnected()) {
            this.signaling.rejoin();
        }
        // setup() will be called when 'start-chat' / 'restart-webrtc' arrives from server
    }

    // ─── Cleanup ───────────────────────────────────────────

    cleanup() {
        console.log('[Peer] Cleanup called');
        if (this._retryInterval) {
            clearInterval(this._retryInterval);
            this._retryInterval = null;
        }
        if (this.dataChannel) {
            try { this.dataChannel.close(); } catch (e) {}
            this.dataChannel = null;
        }
        if (this.peerConnection) {
            try { this.peerConnection.close(); } catch (e) {}
            this.peerConnection = null;
        }
        this.retryQueue = [];
        this.iceConfig = null; // Force fresh ICE config fetch on next setup
    }

    // ─── Media (Video/Audio) ───────────────────────────────

    async startMedia(isVideo = true) {
        if (!this.peerConnection) await this.setup();

        if (!this.localStream) {
            const constraints = isVideo
                ? { video: true, audio: true }
                : { video: false, audio: true };
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        }

        // Add tracks (avoid duplicates)
        const existingTrackIds = this.peerConnection.getSenders().map(s => s.track && s.track.id);
        this.localStream.getTracks().forEach((track) => {
            if (!existingTrackIds.includes(track.id)) {
                this.peerConnection.addTrack(track, this.localStream);
            }
        });

        // Create & send offer
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        this.signaling.sendOffer(this.peerConnection.localDescription);

        return this.localStream;
    }

    stopMedia() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }
        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach(t => t.stop());
            this.remoteStream = null;
        }
        if (this.peerConnection) {
            this.peerConnection.getSenders().forEach((sender) => {
                if (sender.track) {
                    try { this.peerConnection.removeTrack(sender); } catch (e) { }
                }
            });
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS (global for inline script usage)
// ═══════════════════════════════════════════════════════════════

window.SignalingClient = SignalingClient;
window.PeerManager = PeerManager;
window.ConnectionState = ConnectionState;

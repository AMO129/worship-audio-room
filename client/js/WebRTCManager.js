/**
 * WebRTCManager.js
 * Production WebRTC mesh manager for Worship Audio Room.
 * Handles signalling over WebSocket and peer-to-peer audio via RTCPeerConnection.
 */

const RTC_CONFIG = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]};

const PING_INTERVAL_MS = 25_000;

export class WebRTCManager {
  constructor() {
    /** @type {Map<string, RTCPeerConnection>} peer_id → RTCPeerConnection */
    this.peers = new Map();
    this._pendingCandidates = new Map();

    this._ws            = null;
    this._clientId      = null;
    this._roomId        = null;
    this._audioManager  = null;
    this._pingInterval  = null;
    this._audioContainer = null;
    this._userName      = 'Host';

    // Public callbacks — set by the caller before joining
    this.onPeerJoined   = null;   // (peerId, stream) => void
    this.onPeerLeft     = null;   // (peerId) => void
    this.onStatusChange = null;   // (status, message) => void
    this.onChatMessage  = null;   // (msg) => void
  }

  // ─────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────

  /**
   * Connect to the signalling server and join a room.
   * @param {string} roomId
   * @param {object} audioManager  - must expose destinationNode.stream
   * @param {string} [userName]
   * @returns {Promise<void>}
   */
  join(roomId, audioManager, userName = 'Host') {
    this._roomId       = roomId;
    this._audioManager = audioManager;
    this._userName     = userName;
    this._clientId     = crypto.randomUUID();
    this._ensureAudioContainer();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(roomId)}/${this._clientId}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.addEventListener('open', () => {
        this._emitStatus('connected', 'Connected to room');
        this._startPing();
        resolve();
      });

      ws.addEventListener('error', (err) => {
        this._emitStatus('error', 'WebSocket error');
        reject(err);
      });

      ws.addEventListener('message', (event) => {
        try {
          this._onMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('[WebRTCManager] Failed to parse message:', e);
        }
      });

      ws.addEventListener('close', () => {
        this._stopPing();
        this._emitStatus('disconnected', 'Disconnected');
      });
    });
  }

  /** Gracefully leave: close all peer connections and the WebSocket. */
  leave() {
    this._stopPing();

    for (const [peerId, pc] of this.peers) {
      this._closePeerConnection(peerId, pc);
    }
    this.peers.clear();
    this._pendingCandidates.clear();

    if (this._ws) {
      try { this._ws.close(1000, 'User left'); } catch (_) { /* ignore */ }
      this._ws = null;
    }

    if (this._audioContainer) {
      this._audioContainer.remove();
      this._audioContainer = null;
    }

    this._clientId      = null;
    this._roomId        = null;
    this._audioManager  = null;
    this._pingInterval  = null;
    this._userName      = 'Host';
  }

  /**
   * Broadcast a chat message to the room.
   * @param {string} text
   */
  sendChat(text) {
    this._send({ type: 'chat-message', sender_name: this._userName, text });
  }

  /**
   * Hot-swap the local audio track across all active peer connections.
   * Call this whenever AudioManager changes its output stream.
   */
  refreshLocalTrack() {
    const track = this._getLocalTrack();
    if (!track) return;

    for (const pc of this.peers.values()) {
      const sender = pc.getSenders().find((item) => item.track?.kind === 'audio' || item.track === null);
      sender?.replaceTrack(track).catch(console.warn);
    }
  }

  // ─────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────

  get clientId()      { return this._clientId; }
  get peerCount()     { return this.peers.size; }
  get isConnected()   { return this._ws?.readyState === WebSocket.OPEN; }
  get remotePeerIds() { return [...this.peers.keys()]; }

  // ─────────────────────────────────────────────
  // Signalling message dispatch
  // ─────────────────────────────────────────────

  /** @param {object} msg */
  _onMessage(msg) {
    switch (msg.type) {
      case 'room-users':    this._onRoomUsers(msg);        break;
      case 'peer-joined':   this._onPeerJoined(msg);       break;
      case 'peer-left':     this._onPeerLeft(msg);         break;
      case 'offer':         this._handleOffer(msg);        break;
      case 'answer':        this._handleAnswer(msg);       break;
      case 'ice-candidate': this._handleCandidate(msg);    break;
      case 'chat-message':  this.onChatMessage?.(msg);     break;
      case 'pong':          /* intentionally ignored */    break;
      default:
        console.debug('[WebRTCManager] Unknown message type:', msg.type);
    }
  }

  // ─────────────────────────────────────────────
  // Room event handlers
  // ─────────────────────────────────────────────

  /**
   * We just joined. Send offers to every already-present peer.
   * @param {{ peers: string[] }} msg
   */
  _onRoomUsers(msg) {
    for (const peerId of msg.peers ?? []) {
      this._preparePeer(peerId);
    }
  }

  /**
   * A new peer has joined — they will offer us, so just prepare the PC.
   * @param {{ peer_id: string }} msg
   */
  _onPeerJoined(msg) {
    this._preparePeer(msg.peer_id);
  }

  _preparePeer(remotePeerId) {
    if (!remotePeerId || remotePeerId === this._clientId) return;
    const isNewPeer = !this.peers.has(remotePeerId);
    const pc = this._createPeerConnection(remotePeerId);
    if (isNewPeer) this.onPeerJoined?.(remotePeerId, null);

    if (this._clientId.localeCompare(remotePeerId) < 0) {
      if (isNewPeer) this._initiateOffer(remotePeerId, pc);
    }
  }

  /**
   * A peer disconnected.
   * @param {{ peer_id: string }} msg
   */
  _onPeerLeft(msg) {
    const pc = this.peers.get(msg.peer_id);
    if (pc) {
      this._closePeerConnection(msg.peer_id, pc);
      this.peers.delete(msg.peer_id);
    }
    // Remove any audio element for this peer
    this._audioContainer
      ?.querySelector(`[data-peer-id="${msg.peer_id}"]`)
      ?.remove();

    this.onPeerLeft?.(msg.peer_id);
  }

  // ─────────────────────────────────────────────
  // Offer / Answer / ICE
  // ─────────────────────────────────────────────

  /**
   * We are the newcomer — send an offer to an existing peer.
   * @param {string} remotePeerId
   */
  async _initiateOffer(remotePeerId, peerConnection = this.peers.get(remotePeerId)) {
    try {
      const pc    = peerConnection ?? this._createPeerConnection(remotePeerId);
      let audioTransceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'audio');
      if (!audioTransceiver) {
        audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      }
      audioTransceiver.direction = 'sendrecv';
      const track = this._getLocalTrack();
      if (track) await audioTransceiver.sender.replaceTrack(track);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', target_id: remotePeerId, sdp: offer.sdp });
    } catch (e) {
      console.error(`[WebRTCManager] _initiateOffer to ${remotePeerId} failed:`, e);
    }
  }

  /**
   * An existing peer sent us an offer — answer it.
   * @param {{ sender_id: string, sdp: string }} msg
   */
  async _handleOffer(msg) {
    try {
      const pc = this.peers.get(msg.sender_id) ?? this._createPeerConnection(msg.sender_id);

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
      await this._applyPendingCandidates(msg.sender_id, pc);

      const audioTransceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'audio');
      if (audioTransceiver) {
        audioTransceiver.direction = 'sendrecv';
        const track = this._getLocalTrack();
        if (track) await audioTransceiver.sender.replaceTrack(track);
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._send({ type: 'answer', target_id: msg.sender_id, sdp: answer.sdp });
    } catch (e) {
      console.error(`[WebRTCManager] _handleOffer from ${msg.sender_id} failed:`, e);
    }
  }

  /**
   * Remote peer accepted our offer.
   * @param {{ sender_id: string, sdp: string }} msg
   */
  async _handleAnswer(msg) {
    try {
      const pc = this.peers.get(msg.sender_id);
      if (!pc) { console.warn('[WebRTCManager] No PC for answer from', msg.sender_id); return; }
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      await this._applyPendingCandidates(msg.sender_id, pc);
    } catch (e) {
      console.error(`[WebRTCManager] _handleAnswer from ${msg.sender_id} failed:`, e);
    }
  }

  /**
   * Trickle ICE candidate from remote.
   * @param {{ sender_id: string, candidate: RTCIceCandidateInit }} msg
   */
  async _handleCandidate(msg) {
    try {
      const pc = this.peers.get(msg.sender_id);
      if (!pc || !pc.remoteDescription) {
        const pending = this._pendingCandidates.get(msg.sender_id) ?? [];
        pending.push(msg.candidate);
        this._pendingCandidates.set(msg.sender_id, pending);
        return;
      }
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (e) {
      console.error(`[WebRTCManager] _handleCandidate from ${msg.sender_id} failed:`, e);
    }
  }

  // ─────────────────────────────────────────────
  // RTCPeerConnection factory
  // ─────────────────────────────────────────────

  /**
   * Create, wire-up and register a new RTCPeerConnection for a remote peer.
   * @param {string} remotePeerId
   * @returns {RTCPeerConnection}
   */
  _createPeerConnection(remotePeerId) {
    const existing = this.peers.get(remotePeerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.peers.set(remotePeerId, pc);

    // Trickle ICE
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._send({
          type:        'ice-candidate',
          target_id:   remotePeerId,
          candidate:   candidate.toJSON(),
        });
      }
    };

    // ICE connection state monitoring
    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTCManager] ICE state (${remotePeerId}):`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn(`[WebRTCManager] ICE failed for ${remotePeerId}, restarting…`);
        pc.restartIce();
      }
    };

    // Remote track arrived
    pc.ontrack = (event) => {
      const stream = event.streams?.[0] ?? new MediaStream([event.track]);
      this._attachRemoteStream(remotePeerId, stream);
      this.onPeerJoined?.(remotePeerId, stream);
    };

    return pc;
  }

  // ─────────────────────────────────────────────
  // Audio element helpers
  // ─────────────────────────────────────────────

  /**
   * Create (or reuse) a hidden <audio> element for a remote peer's stream.
   * @param {string} peerId
   * @param {MediaStream} stream
   */
  _attachRemoteStream(peerId, stream) {
    // Reuse existing element if present
    let el = this._audioContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    if (!el) {
      el = document.createElement('audio');
      el.setAttribute('data-peer-id', peerId);
      el.autoplay   = true;
      el.playsInline = true;
      el.style.display = 'none';
      this._audioContainer.appendChild(el);
    }
    el.srcObject = stream;
    el.play().catch((err) => {
      console.warn(`[WebRTCManager] Autoplay blocked for peer ${peerId}:`, err.message);
    });
  }

  /**
   * Tear down a peer connection and its audio element.
   * @param {string} peerId
   * @param {RTCPeerConnection} pc
   */
  _closePeerConnection(peerId, pc) {
    this._pendingCandidates.delete(peerId);
    const el = this._audioContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    if (el) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    try { pc.close(); } catch (_) { /* ignore */ }
  }

  async _applyPendingCandidates(peerId, pc) {
    const candidates = this._pendingCandidates.get(peerId) ?? [];
    this._pendingCandidates.delete(peerId);
    for (const candidate of candidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  /**
   * Returns the first local audio track from AudioManager, or null.
   * @returns {MediaStreamTrack|null}
   */
  _getLocalTrack() {
    return this._audioManager?.destinationNode?.stream?.getAudioTracks()[0] ?? null;
  }

  /** Ensure the hidden audio container div exists in the DOM. */
  _ensureAudioContainer() {
    if (this._audioContainer) return;
    let el = document.getElementById('rtc-audio-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rtc-audio-container';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    this._audioContainer = el;
  }

  /**
   * Send a JSON message over the WebSocket if it is open.
   * @param {object} message
   */
  _send(message) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
    }
  }

  /** Start sending keepalive pings. */
  _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      this._send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  /** Stop keepalive pings. */
  _stopPing() {
    if (this._pingInterval !== null) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  /**
   * Emit a status change event to the caller.
   * @param {string} status  e.g. 'connected' | 'disconnected' | 'error'
   * @param {string} message Human-readable description
   */
  _emitStatus(status, message) {
    this.onStatusChange?.(status, message);
  }
}

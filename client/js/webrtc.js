/**
 * @file webrtc.js
 * @description Production WebRTC peer-to-peer audio client for Worship Audio Room.
 *
 * ── WebRTC Signaling Flow ─────────────────────────────────────────────────────
 *
 *  New peer joins room "/ws/{roomId}/{clientId}":
 *
 *    Server → Joiner : { type:"peer-joined", peerId, peers:["<existing_id>",...] }
 *
 *    For each existing peer ID in `peers`, joiner acts as INITIATOR:
 *      Joiner  → createOffer() → setLocalDescription()
 *              → Server → Existing peer : { type:"signal", signalType:"offer", ... }
 *
 *    Existing peer (RECEIVER) responds:
 *      Existing → setRemoteDescription(offer) → createAnswer() → setLocalDescription()
 *               → Server → Joiner : { type:"signal", signalType:"answer", ... }
 *
 *    Joiner sets remote description from answer.
 *
 *    Both peers exchange ICE candidates throughout:
 *      Peer → { type:"signal", signalType:"candidate", targetId, candidate:{...} }
 *
 *  Peer departure:
 *    Server → All : { type:"peer-left", peerId }
 *    → close RTCPeerConnection, remove audio element + peer card from DOM.
 *
 * ── Audio Track ───────────────────────────────────────────────────────────────
 *
 *  The local outgoing track is read from:
 *    audioManager.destinationNode.stream.getAudioTracks()[0]
 *
 *  This carries the AudioManager's mixed output (voice + ducked music),
 *  so remote attendees hear the full worship mix.
 *
 * @module WebRTCClient
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** STUN server for NAT traversal. */
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

/** Keep-alive ping interval (ms). Prevents proxy/LB idle disconnection. */
const PING_INTERVAL_MS = 25_000;

// ═══════════════════════════════════════════════════════════════════════════════
// WebRTCClient
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @class WebRTCClient
 *
 * Manages one WebSocket signaling connection and N RTCPeerConnections,
 * one per remote peer in the room.
 *
 * Usage:
 *   const rtc = new WebRTCClient();
 *   rtc.onPeerJoined   = (peerId, stream)  => addPeerCard(peerId, stream);
 *   rtc.onPeerLeft     = (peerId)          => removePeerCard(peerId);
 *   rtc.onStatusChange = (status, message) => updateBadge(status, message);
 *
 *   await rtc.join('grace-hall', audioManager);
 *   // ...session in progress...
 *   rtc.leave();
 */
export class WebRTCClient {

  constructor() {
    /**
     * Map of active RTCPeerConnections keyed by remote peer ID.
     * @type {Map<string, RTCPeerConnection>}
     */
    this.peers = new Map();

    /** @type {WebSocket|null} Signaling WebSocket connection. */
    this._ws = null;

    /** @type {string|null} This client's UUID, generated on join(). */
    this._clientId = null;

    /** @type {string|null} Current room ID. */
    this._roomId = null;

    /**
     * Reference to AudioManager — used to read the outgoing audio track
     * lazily at offer/connection time so the engine can start after joining.
     * @type {object|null}
     */
    this._audioManager = null;

    /** Keep-alive ping interval handle. @type {number|null} */
    this._pingInterval = null;

    // ── DOM container for remote <audio> elements ──────────────────────────
    // Hidden elements appended to body so streams play without UI coupling.
    this._audioContainer = null;

    // ── Event callbacks ────────────────────────────────────────────────────

    /**
     * Fired when a remote peer's audio stream arrives.
     * @type {((peerId: string, stream: MediaStream) => void) | null}
     */
    this.onPeerJoined = null;

    /**
     * Fired when a remote peer disconnects.
     * @type {((peerId: string) => void) | null}
     */
    this.onPeerLeft = null;

    /**
     * Fired on signaling status changes.
     * status: 'connecting' | 'live' | 'disconnected' | 'error'
     * @type {((status: string, message: string) => void) | null}
     */
    this.onStatusChange = null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Joins a room by connecting to the WebSocket signaling server.
   *
   * The WebSocket URL is built from the current page origin so the same
   * bundle works in development (ws://) and production (wss://).
   *
   * @param {string} roomId        - Room identifier (e.g. "grace-hall").
   * @param {object} audioManager  - AudioManager instance — provides track.
   * @returns {Promise<void>}      Resolves when WS handshake completes.
   */
  join(roomId, audioManager) {
    return new Promise((resolve, reject) => {
      this._roomId      = roomId;
      this._audioManager = audioManager;
      this._clientId    = crypto.randomUUID();

      // Build DOM container for hidden <audio> elements
      this._ensureAudioContainer();

      // Auto-detect ws:// vs wss:// from current page protocol
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl    = `${protocol}//${location.host}/ws/${encodeURIComponent(roomId)}/${this._clientId}`;

      this._emitStatus('connecting', `Connecting to room "${roomId}"…`);
      console.log(`[WebRTCClient] Connecting to: ${wsUrl}`);

      try {
        this._ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(new Error(`[WebRTCClient] Cannot open WebSocket: ${err.message}`));
        return;
      }

      // Resolve once the WS handshake succeeds
      this._ws.addEventListener('open', () => {
        this._startPing();
        resolve();
        console.log('[WebRTCClient] WebSocket open.');
      }, { once: true });

      // Reject if the connection fails before opening
      this._ws.addEventListener('error', () => {
        reject(new Error('[WebRTCClient] WebSocket connection failed.'));
      }, { once: true });

      this._ws.addEventListener('message', (event) => {
        try {
          this._onMessage(JSON.parse(event.data));
        } catch (err) {
          console.warn('[WebRTCClient] Message parse error:', err);
        }
      });

      this._ws.addEventListener('close', (event) => {
        this._stopPing();
        console.log(`[WebRTCClient] WS closed (${event.code} ${event.reason}).`);
        this._emitStatus('disconnected', 'Disconnected from room.');
      });
    });
  }

  /**
   * Leaves the room: closes all RTCPeerConnections and the WebSocket.
   * Fires `onPeerLeft` for each disconnected peer so the UI can clean up.
   */
  leave() {
    this._stopPing();

    // Close all peer connections
    for (const [peerId, pc] of this.peers) {
      this._closePeerConnection(peerId, pc);
    }
    this.peers.clear();

    // Close the signaling WS cleanly
    if (this._ws && this._ws.readyState !== WebSocket.CLOSED) {
      this._ws.close(1000, 'User left room.');
    }
    this._ws = null;

    // Remove the hidden audio container
    this._audioContainer?.remove();
    this._audioContainer = null;

    this._clientId     = null;
    this._roomId       = null;
    this._audioManager = null;

    this._emitStatus('disconnected', 'Left room.');
    console.log('[WebRTCClient] Left room.');
  }

  /**
   * Refreshes the local audio track across all existing peer connections.
   * Call this when the AudioManager engine starts after WebRTC is already live.
   */
  refreshLocalTrack() {
    const track = this._getLocalTrack();
    if (!track) return;

    for (const [, pc] of this.peers) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        sender.replaceTrack(track).catch(console.error);
      } else {
        pc.addTrack(track);
      }
    }
    console.log('[WebRTCClient] Local track refreshed across all peers.');
  }

  // ─── WebSocket Message Dispatch ────────────────────────────────────────────

  /**
   * Routes an incoming server message to the appropriate handler.
   * @param {object} msg - Parsed JSON message from the server.
   * @private
   */
  _onMessage(msg) {
    console.debug(`[WebRTCClient] ◄ ${msg.type}`, msg.peerId || msg.fromId || '');

    switch (msg.type) {
      case 'peer-joined': this._onPeerJoined(msg);  break;
      case 'peer-left':   this._onPeerLeft(msg);    break;
      case 'signal':      this._onSignal(msg);      break;
      case 'pong':        /* keep-alive ack */       break;
      case 'error':
        console.error('[WebRTCClient] Server error:', msg.message);
        this._emitStatus('error', msg.message || 'Server error.');
        break;
      default:
        console.debug('[WebRTCClient] Unknown message type:', msg.type);
    }
  }

  // ─── Signaling Event Handlers ─────────────────────────────────────────────

  /**
   * Handles `peer-joined`:
   *   - If `peers` array is non-empty, we are the newcomer joining.
   *     For each existing peer ID, we act as INITIATOR and send an offer.
   *   - If `peers` has a single new entrant (we're the established peer),
   *     we wait to receive their offer.
   *
   * @param {{peerId: string, peers: string[]}} msg
   * @private
   */
  _onPeerJoined(msg) {
    const existingPeers = msg.peers ?? [];

    if (existingPeers.length > 0) {
      // We are the newcomer — initiate offers to all established peers
      console.log(`[WebRTCClient] Joined; sending offers to ${existingPeers.length} peer(s).`);
      for (const remotePeerId of existingPeers) {
        this._initiateOffer(remotePeerId);
      }
    } else {
      // We are an established peer; a new peer just joined.
      // They will initiate the offer — nothing to do here except log.
      console.log(`[WebRTCClient] New peer incoming: ${msg.peerId}`);
    }
  }

  /**
   * Handles `peer-left` — closes the peer connection and notifies the UI.
   * @param {{peerId: string}} msg
   * @private
   */
  _onPeerLeft(msg) {
    const { peerId } = msg;
    const pc = this.peers.get(peerId);
    if (pc) {
      this._closePeerConnection(peerId, pc);
      this.peers.delete(peerId);
    }
    if (this.onPeerLeft) this.onPeerLeft(peerId);
    console.log(`[WebRTCClient] Peer left: ${peerId}`);
  }

  /**
   * Routes an incoming signal to the offer/answer/candidate handler.
   * @param {{fromId: string, signalType: string, sdp?: string, candidate?: object}} msg
   * @private
   */
  _onSignal(msg) {
    const { fromId, signalType } = msg;
    switch (signalType) {
      case 'offer':     this._handleOffer(fromId, msg.sdp);       break;
      case 'answer':    this._handleAnswer(fromId, msg.sdp);      break;
      case 'candidate': this._handleCandidate(fromId, msg.candidate); break;
      default:
        console.debug('[WebRTCClient] Unknown signalType:', signalType);
    }
  }

  // ─── SDP & ICE Handlers ───────────────────────────────────────────────────

  /**
   * We are INITIATOR — creates an RTCPeerConnection, adds the local track,
   * generates an SDP offer, and sends it to the remote peer via signaling.
   *
   * @param {string} remotePeerId
   * @private
   */
  async _initiateOffer(remotePeerId) {
    const pc = this._createPeerConnection(remotePeerId);

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      this._sendSignal({
        signalType: 'offer',
        targetId:   remotePeerId,
        sdp:        offer.sdp,
      });

      console.log(`[WebRTCClient] Offer → ${remotePeerId}`);
    } catch (err) {
      console.error('[WebRTCClient] createOffer failed:', err);
    }
  }

  /**
   * We are RECEIVER — sets the remote offer, generates an answer, and
   * sends it back to the initiating peer.
   *
   * @param {string} fromId - Peer ID who sent the offer.
   * @param {string} sdp    - The raw SDP offer string.
   * @private
   */
  async _handleOffer(fromId, sdp) {
    // Create (or reuse) the peer connection for this remote peer
    let pc = this.peers.get(fromId);
    if (!pc) pc = this._createPeerConnection(fromId);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this._sendSignal({
        signalType: 'answer',
        targetId:   fromId,
        sdp:        answer.sdp,
      });

      console.log(`[WebRTCClient] Answer → ${fromId}`);
    } catch (err) {
      console.error('[WebRTCClient] handleOffer failed:', err);
    }
  }

  /**
   * Sets the remote SDP answer on the corresponding peer connection.
   *
   * @param {string} fromId - Peer who sent the answer.
   * @param {string} sdp    - The raw SDP answer string.
   * @private
   */
  async _handleAnswer(fromId, sdp) {
    const pc = this.peers.get(fromId);
    if (!pc) {
      console.warn('[WebRTCClient] Answer for unknown peer:', fromId);
      return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      console.log(`[WebRTCClient] Answer set from ${fromId}`);
    } catch (err) {
      console.error('[WebRTCClient] setRemoteDescription(answer) failed:', err);
    }
  }

  /**
   * Adds an incoming ICE candidate to the appropriate peer connection.
   *
   * @param {string} fromId             - Peer who sent the candidate.
   * @param {RTCIceCandidateInit} candidate
   * @private
   */
  async _handleCandidate(fromId, candidate) {
    const pc = this.peers.get(fromId);
    if (!pc || !candidate?.candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // Benign: may arrive before remote description is set
      console.debug('[WebRTCClient] addIceCandidate queued/dropped:', err.message);
    }
  }

  // ─── RTCPeerConnection Factory ────────────────────────────────────────────

  /**
   * Creates a fully wired RTCPeerConnection for a remote peer.
   * Adds the local audio track and registers ICE/track event handlers.
   *
   * @param {string} remotePeerId
   * @returns {RTCPeerConnection}
   * @private
   */
  _createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(remotePeerId, pc);

    // ── Add local audio track ─────────────────────────────────────────────
    // Reads from audioManager.destinationNode.stream lazily — the engine may
    // start before or after WebRTC connections are established.
    const track = this._getLocalTrack();
    if (track) {
      pc.addTrack(track);
      console.log(`[WebRTCClient] Local track added to PC (${remotePeerId})`);
    } else {
      console.warn('[WebRTCClient] No local track yet — engine may not be started.');
    }

    // ── ICE candidate discovered locally ─────────────────────────────────
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        this._sendSignal({
          signalType: 'candidate',
          targetId:   remotePeerId,
          candidate:  candidate.toJSON(),
        });
      }
    });

    // ── ICE connection monitoring ─────────────────────────────────────────
    pc.addEventListener('iceconnectionstatechange', () => {
      console.log(`[WebRTCClient] ICE [${remotePeerId}]: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        console.warn('[WebRTCClient] ICE failed — restarting.');
        pc.restartIce();
      }
    });

    // ── Remote audio track received ───────────────────────────────────────
    // Attach to a hidden <audio autoplay> element so the stream plays immediately.
    // Also notify the UI via onPeerJoined so a visual peer card can be rendered.
    pc.addEventListener('track', (event) => {
      const [remoteStream] = event.streams;
      if (!remoteStream) return;

      console.log(`[WebRTCClient] Remote track from ${remotePeerId}`);
      this._attachRemoteStream(remotePeerId, remoteStream);

      if (this.onPeerJoined) this.onPeerJoined(remotePeerId, remoteStream);
    });

    // ── Renegotiation ─────────────────────────────────────────────────────
    pc.addEventListener('negotiationneeded', async () => {
      // Only re-offer if we are not in the middle of an existing exchange
      if (pc.signalingState === 'stable') {
        console.log(`[WebRTCClient] Renegotiation needed for ${remotePeerId}`);
        try { await this._initiateOffer(remotePeerId); }
        catch (err) { console.error('[WebRTCClient] Renegotiation failed:', err); }
      }
    });

    return pc;
  }

  // ─── Audio Stream Plumbing ────────────────────────────────────────────────

  /**
   * Attaches a remote MediaStream to a hidden <audio autoplay> element.
   * The element is appended to `_audioContainer` and keyed by peer ID
   * so it can be removed cleanly when the peer leaves.
   *
   * @param {string}      peerId
   * @param {MediaStream} stream
   * @private
   */
  _attachRemoteStream(peerId, stream) {
    // Remove any stale element for this peer first
    this._audioContainer?.querySelector(`[data-peer-id="${peerId}"]`)?.remove();

    const audio = document.createElement('audio');
    audio.autoplay  = true;
    audio.srcObject = stream;
    audio.setAttribute('data-peer-id', peerId);
    audio.style.display = 'none'; // hidden — audio only
    this._audioContainer?.appendChild(audio);
  }

  /**
   * Removes the hidden <audio> element associated with a remote peer.
   * Also closes the RTCPeerConnection cleanly.
   *
   * @param {string}            peerId
   * @param {RTCPeerConnection} pc
   * @private
   */
  _closePeerConnection(peerId, pc) {
    // Stop the remote audio element
    const audio = this._audioContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }

    // Close the peer connection
    if (pc.signalingState !== 'closed') {
      pc.getSenders().forEach(s => {
        try { pc.removeTrack(s); } catch (_) { /* ok */ }
      });
      pc.close();
    }

    console.log(`[WebRTCClient] PC closed: ${peerId}`);
  }

  /**
   * Retrieves the local outgoing audio track from AudioManager's destination stream.
   * Returns null if the engine has not been started yet.
   *
   * @returns {MediaStreamTrack|null}
   * @private
   */
  _getLocalTrack() {
    return (
      this._audioManager?.destinationNode?.stream?.getAudioTracks()[0] ?? null
    );
  }

  /**
   * Creates (or re-uses) the hidden DOM container for remote <audio> elements.
   * @private
   */
  _ensureAudioContainer() {
    if (!this._audioContainer) {
      this._audioContainer = document.createElement('div');
      this._audioContainer.id = 'rtc-audio-container';
      this._audioContainer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this._audioContainer);
    }
  }

  // ─── WebSocket Helpers ────────────────────────────────────────────────────

  /**
   * Sends a WebRTC signal payload to a named remote peer via the server.
   * Automatically attaches `type: "signal"` and `from` on the client side.
   *
   * @param {object} payload - Must include `signalType` and `targetId`.
   * @private
   */
  _sendSignal(payload) {
    this._send({ type: 'signal', ...payload });
  }

  /**
   * Sends a raw JSON payload over the WebSocket.
   * @param {object} message
   * @private
   */
  _send(message) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
    } else {
      console.warn('[WebRTCClient] Cannot send — WS not open.', message.type);
    }
  }

  // ─── Keep-Alive Ping ──────────────────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      this._send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingInterval !== null) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  // ─── Status Emitter ───────────────────────────────────────────────────────

  _emitStatus(status, message) {
    if (this.onStatusChange) this.onStatusChange(status, message);
  }

  // ─── Public Getters ───────────────────────────────────────────────────────

  /** @returns {string|null} This client's server-assigned ID. */
  get clientId()   { return this._clientId; }

  /** @returns {number} Number of active remote peer connections. */
  get peerCount()  { return this.peers.size; }

  /** @returns {boolean} Whether the WebSocket is currently open. */
  get isConnected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  /** @returns {string[]} All current remote peer IDs. */
  get remotePeerIds() { return Array.from(this.peers.keys()); }
}

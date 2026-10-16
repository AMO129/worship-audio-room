/**
 * @file webrtc.js
 * @description WebRTC peer connection management and WebSocket signaling client.
 *
 * Responsibilities:
 *  - Opens a WebSocket connection to the FastAPI signaling server.
 *  - Handles SDP offer/answer exchange.
 *  - Manages ICE candidate negotiation.
 *  - Exposes the remote MediaStream to AudioManager.
 *
 * @module WebRTCManager
 */

// ─── ICE Configuration ────────────────────────────────────────────────────────

/** STUN servers for NAT traversal. */
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ─── WebRTCManager Class ──────────────────────────────────────────────────────

/**
 * @class WebRTCManager
 * Manages one RTCPeerConnection per room session.
 */
export class WebRTCManager {
  constructor() {
    /** @type {RTCPeerConnection|null} */
    this._pc = null;
    /** @type {WebSocket|null} */
    this._ws = null;
    /** @type {string|null} Room identifier */
    this._roomId = null;
    /** @type {Function|null} Callback for remote stream receipt */
    this.onRemoteStream = null;
  }

  // ─── Connection Lifecycle ──────────────────────────────────────────────────

  /**
   * Opens a WebSocket connection to the signaling server and joins a room.
   * @param {string} roomId - The room identifier to join.
   * @param {string} [signalingUrl] - WebSocket URL (defaults to same origin).
   * @returns {Promise<void>}
   */
  async connect(roomId, signalingUrl) {
    this._roomId = roomId;
    const wsUrl = signalingUrl || `ws://${location.host}/ws/signal/${roomId}`;

    // TODO (Phase 3): Implement WebSocket connection and message routing.
    console.log(`[WebRTCManager] connect() to ${wsUrl} — stub.`);
  }

  /**
   * Adds a local MediaStream track to the peer connection.
   * @param {MediaStream} stream
   */
  addLocalStream(stream) {
    if (!this._pc) return;
    stream.getTracks().forEach(track => this._pc.addTrack(track, stream));
    console.log('[WebRTCManager] Local stream tracks added.');
  }

  /**
   * Cleanly closes the peer connection and WebSocket.
   */
  disconnect() {
    if (this._pc) { this._pc.close(); this._pc = null; }
    if (this._ws) { this._ws.close(); this._ws = null; }
    console.log('[WebRTCManager] Disconnected.');
  }

  // ─── Signaling Handlers ────────────────────────────────────────────────────

  /**
   * Handles an incoming signaling message from the WebSocket server.
   * Routes to offer/answer/candidate handlers.
   * @param {MessageEvent} event
   * @private
   */
  _onSignalingMessage(event) {
    // TODO (Phase 3): Parse JSON, route by message type.
    const msg = JSON.parse(event.data);
    console.log('[WebRTCManager] Signaling message received:', msg.type);
  }

  /**
   * Creates and sends an SDP offer.
   * @returns {Promise<void>}
   * @private
   */
  async _createOffer() {
    // TODO (Phase 3): pc.createOffer() → setLocalDescription → send via WS.
    console.log('[WebRTCManager] _createOffer() — stub.');
  }

  /**
   * Handles an incoming SDP answer from a remote peer.
   * @param {RTCSessionDescriptionInit} answer
   * @private
   */
  async _handleAnswer(answer) {
    // TODO (Phase 3): pc.setRemoteDescription(answer).
    console.log('[WebRTCManager] _handleAnswer() — stub.');
  }

  /**
   * Handles an incoming ICE candidate from the signaling server.
   * @param {RTCIceCandidateInit} candidate
   * @private
   */
  async _handleIceCandidate(candidate) {
    // TODO (Phase 3): pc.addIceCandidate(candidate).
    console.log('[WebRTCManager] _handleIceCandidate() — stub.');
  }
}

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
    this._cameraStream = null;
    this._pingInterval  = null;
    this._audioContainer = null;
    this._userName      = 'Host';
    this._hostId        = null;
    this._mutedPeers    = new Set();
    this._peerNames     = new Map();
    this.waitingPeers   = new Map();
    this._settleJoin    = null;
    this._isAdmitted    = false;
    this._rtcConfig     = RTC_CONFIG;
    this._iceRestartTimers = new Map();
    this._iceRestartAttempts = new Map();
    this.screenSenders = new Map();
    this.screenReceivers = new Map();
    this._pendingScreenCandidates = new Map();
    this._screenStream = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._shouldReconnect = false;

    // Public callbacks — set by the caller before joining
    this.onPeerJoined   = null;   // (peerId, stream, displayName) => void
    this.onPeerRenamed  = null;   // (peerId, displayName) => void
    this.onPeerLeft     = null;   // (peerId) => void
    this.onStatusChange = null;   // (status, message) => void
    this.onChatMessage  = null;   // (msg) => void
    this.onCaption      = null;   // (msg) => void
    this.onHostChange   = null;   // (hostId) => void
    this.onPeerMuted    = null;   // (peerId, muted) => void
    this.onKicked        = null;   // () => void
    this.onWaitingRoom   = null;   // () => void
    this.onWaitingPeersChange = null; // (waitingPeers) => void
    this.onAdmissionDenied = null; // () => void
    this.onRoomClosed = null; // (message) => void
    this.onRoomJoined   = null;   // () => void
    this.onPeerConnectionState = null; // (peerId, state) => void
    this.onScreenShareStarted = null; // (stream) => void
    this.onScreenShareStopped = null; // () => void
    this.onRemoteScreenShare = null; // (peerId, stream) => void
    this.onRemoteScreenShareStopped = null; // (peerId) => void
    this.onRemoteStream = null; // (peerId, stream) => void
    this.onCameraStarted = null; // (stream) => void
    this.onCameraStopped = null; // () => void
    this.onRaiseHand = null; // (msg) => void
    this.onReaction = null; // (msg) => void
    this.onPoll = null; // (msg) => void
    this.onQuestion = null; // (msg) => void
    this.onNotification = null; // (msg) => void
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
  async join(roomId, audioManager, userName = 'Host') {
    this._roomId       = roomId;
    this._audioManager = audioManager;
    this._userName     = userName;
    this._clientId     = crypto.randomUUID();
    this._shouldReconnect = true;
    this._reconnectAttempt = 0;
    this._ensureAudioContainer();
    this._rtcConfig = await this._loadRtcConfig();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(roomId)}/${this._clientId}?name=${encodeURIComponent(userName)}`;

    return new Promise((resolve, reject) => {
      this._openSocket(resolve, reject, wsUrl, true);
    });
  }

  _openSocket(resolve, reject, wsUrl, isInitialConnection = false) {
      this._settleJoin = isInitialConnection ? (error, result) => {
        const settle = this._settleJoin;
        this._settleJoin = null;
        if (error) reject(error);
        else resolve(result);
      } : null;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.addEventListener('open', () => {
        this._reconnectAttempt = 0;
        this._startPing();
        this._emitStatus('connecting', 'Signaling connected');
      });

      ws.addEventListener('error', (err) => {
        this._emitStatus('error', 'WebSocket error');
        this._settleJoin?.(err);
        if (!isInitialConnection) this._scheduleReconnect(wsUrl);
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
        if (this._settleJoin) {
          this._settleJoin(new Error('Connection closed before room admission'));
        } else {
          this._scheduleReconnect(wsUrl);
        }
      });
  }

  /** Gracefully leave: close all peer connections and the WebSocket. */
  leave() {
    this._stopPing();
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.stopScreenShare();
    this.stopCamera();

    for (const [peerId, pc] of this.screenReceivers) {
      try { pc.close(); } catch (_) { /* ignore */ }
      this.onRemoteScreenShareStopped?.(peerId);
    }
    this.screenReceivers.clear();
    this._pendingScreenCandidates.clear();

    for (const [peerId, pc] of this.peers) {
      this._closePeerConnection(peerId, pc);
    }
    this.peers.clear();
    this._pendingCandidates.clear();
    this._mutedPeers.clear();
    this._peerNames.clear();
    this.waitingPeers.clear();
    this._settleJoin = null;
    this._isAdmitted = false;
    for (const timer of this._iceRestartTimers.values()) clearTimeout(timer);
    this._iceRestartTimers.clear();
    this._iceRestartAttempts.clear();

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
    this._hostId        = null;
    this.onHostChange?.(null);
  }

  /**
   * Broadcast a chat message to the room.
   * @param {string} text
   */
  sendChat(text) {
    this._send({ type: 'chat-message', sender_name: this._userName, text });
  }

  sendCaption(text, isFinal) {
    this._send({ type: 'caption', text, is_final: isFinal });
  }

  setHandRaised(raised) {
    this._send({ type: 'raise-hand', raised: Boolean(raised) });
  }

  sendReaction(reaction) {
    const value = String(reaction ?? '').trim();
    if (value) this._send({ type: 'emoji-reaction', emoji: value.slice(0, 16) });
  }

  createPoll(question, options) {
    this._send({ type: 'poll-create', question, options });
  }

  votePoll(pollId, optionIndex) {
    this._send({ type: 'poll-vote', poll_id: pollId, option_index: optionIndex });
  }

  askQuestion(text) {
    this._send({ type: 'question-submit', text });
  }

  answerQuestion(questionId) {
    this._send({ type: 'question-answer', question_id: questionId });
  }

  muteEveryone() {
    if (this.isHost) this._send({ type: 'mute-all', muted: true });
  }

  setDisplayName(displayName) {
    const name = String(displayName ?? '').trim();
    if (name && this.isConnected) {
      this._userName = name;
      this._send({ type: 'set-display-name', display_name: name });
    }
  }

  setPeerMuted(peerId, muted) {
    if (this.isHost) this._send({ type: 'mute-peer', target_id: peerId, muted });
  }

  removePeer(peerId) {
    if (this.isHost) this._send({ type: 'kick-peer', target_id: peerId });
  }

  async startScreenShare() {
    if (!this.isActiveParticipant) throw new Error('Join the room before sharing your screen.');
    if (this._screenStream) return this._screenStream;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No screen video track was selected.');

    this._screenStream = stream;
    track.addEventListener('ended', () => this.stopScreenShare(), { once: true });
    this.onScreenShareStarted?.(stream);
    for (const peerId of this.remotePeerIds) {
      this._createScreenSender(peerId, stream);
    }
    return stream;
  }

  async startCamera() {
      if (!this.isActiveParticipant) throw new Error('Join the room before enabling your camera.');
      if (this._cameraStream) return this._cameraStream;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('No camera video track was available.');
      this._cameraStream = stream;
      track.addEventListener('ended', () => this.stopCamera(), { once: true });
      this.onCameraStarted?.(stream);
      for (const [peerId, pc] of this.peers) {
        const transceiver = this._getVideoTransceiver(pc);
        await transceiver.sender.replaceTrack(track);
        await this._renegotiate(peerId, pc);
    }
    return stream;
  }

  stopCamera() {
      if (!this._cameraStream) return;
      const stream = this._cameraStream;
      this._cameraStream = null;
      for (const pc of this.peers.values()) {
        const transceiver = this._getVideoTransceiver(pc);
        transceiver.sender.replaceTrack(null).catch((error) => {
          console.warn('[WebRTCManager] Could not stop camera track:', error.message);
        });
      }
      stream.getTracks().forEach((track) => track.stop());
      this.onCameraStopped?.();
      for (const [peerId, pc] of this.peers) this._renegotiate(peerId, pc);
  }

  stopScreenShare() {
    if (!this._screenStream) return;
    const stream = this._screenStream;
    this._screenStream = null;
    this._send({ type: 'screen-share-stop' });
    for (const [peerId, pc] of this.screenSenders) {
      try { pc.close(); } catch (_) { /* ignore */ }
      this.screenSenders.delete(peerId);
    }
    stream.getTracks().forEach((track) => track.stop());
    this.onScreenShareStopped?.();
  }

  decideAdmission(peerId, admit) {
    if (this.isHost) this._send({ type: 'admission-decision', target_id: peerId, admit });
  }

  isPeerMuted(peerId) {
    return this._mutedPeers.has(peerId);
  }

  getPeerName(peerId) {
    return this._peerNames.get(peerId) ?? 'Guest';
  }

  /**
   * Hot-swap the local audio track across all active peer connections.
   * Call this whenever AudioManager changes its output stream.
   */
  refreshLocalTrack() {
    const track = this._getLocalTrack();
    if (!track) return;

    for (const [peerId, pc] of this.peers) {
      let transceiver = pc.getTransceivers().find(
        (item) => item.receiver.track?.kind === 'audio',
      );
      if (!transceiver) {
        transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      }
      transceiver.direction = 'sendrecv';
      transceiver.sender.replaceTrack(track)
        .then(() => this._renegotiate(peerId, pc))
        .catch((error) => console.warn('[WebRTCManager] Could not refresh audio track:', error));
    }
  }

  // ─────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────

  get clientId()      { return this._clientId; }
  get peerCount()     { return this.peers.size; }
  get isConnected()   { return this._ws?.readyState === WebSocket.OPEN; }
  get cameraActive()  { return Boolean(this._cameraStream); }
  get isHost()        { return this._hostId !== null && this._clientId === this._hostId; }
  get isActiveParticipant() { return this._isAdmitted; }
  get hostId()        { return this._hostId; }
  get userName()      { return this._userName; }
  get remotePeerIds() { return [...this.peers.keys()]; }

  // ─────────────────────────────────────────────
  // Signalling message dispatch
  // ─────────────────────────────────────────────

  /** @param {object} msg */
  _onMessage(msg) {
    switch (msg.type) {
      case 'waiting-room': this._onWaitingRoom();                   break;
      case 'admitted':     this._emitStatus('connecting', 'Joining room'); break;
      case 'admission-request': this._onAdmissionRequest(msg);       break;
      case 'admission-cancelled': this._onAdmissionCancelled(msg);   break;
      case 'admission-denied':
        this._isAdmitted = false;
        this.onAdmissionDenied?.();
        break;
      case 'room-closed':
        this._isAdmitted = false;
        this._shouldReconnect = false;
        this._settleJoin?.(new Error(msg.message || 'This room is closed to new guests.'));
        this.onRoomClosed?.(msg.message || 'This room is closed to new guests.');
        break;
      case 'room-invalid':
        this._isAdmitted = false;
        this._shouldReconnect = false;
        this._settleJoin?.(new Error(msg.message || 'This meeting link is no longer valid.'));
        this.onRoomClosed?.(msg.message || 'This meeting link is no longer valid.');
        break;
      case 'room-users':    this._onRoomUsers(msg);        break;
      case 'peer-joined':   this._onPeerJoined(msg);       break;
      case 'participant-renamed': this._onPeerRenamed(msg); break;
      case 'peer-left':     this._onPeerLeft(msg);         break;
      case 'participant-mute': this._onParticipantMute(msg); break;
      case 'peer-kicked':   this.onKicked?.();             break;
      case 'offer':         this._handleOffer(msg);        break;
      case 'answer':        this._handleAnswer(msg);       break;
      case 'ice-candidate': this._handleCandidate(msg);    break;
      case 'ice-restart-request': this._onIceRestartRequest(msg); break;
      case 'screen-offer': this._handleScreenOffer(msg); break;
      case 'screen-answer': this._handleScreenAnswer(msg); break;
      case 'screen-ice-candidate': this._handleScreenCandidate(msg); break;
      case 'screen-share-stop': this._onScreenShareStop(msg); break;
      case 'chat-message':  this.onChatMessage?.(msg);     break;
      case 'chat-history':
        for (const message of msg.messages ?? []) this.onChatMessage?.(message);
        break;
      case 'caption':       this.onCaption?.(msg);         break;
      case 'raise-hand':    this.onRaiseHand?.(msg);       break;
      case 'emoji-reaction': this.onReaction?.(msg);        break;
      case 'poll-created':
      case 'poll-vote':
      case 'poll-closed':    this.onPoll?.(msg);             break;
      case 'question-submitted':
      case 'question-answered': this.onQuestion?.(msg);     break;
      case 'browser-notification': this.onNotification?.(msg); break;
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
    this._isAdmitted = true;
    this._emitStatus('connected', 'Connected to room');
    this._hostId = msg.host_id ?? null;
    this._peerNames = new Map(Object.entries(msg.peer_names ?? {}));
    this._mutedPeers = new Set(msg.muted_peers ?? []);
    this.onHostChange?.(this._hostId);
    for (const peerId of this._mutedPeers) {
      this._applyRemoteMute(peerId);
      this.onPeerMuted?.(peerId, true);
    }
    for (const peerId of msg.peers ?? []) {
      this._preparePeer(peerId, this.getPeerName(peerId));
    }
    this.onRoomJoined?.();
    this._settleJoin?.(null, 'joined');
  }

  _onWaitingRoom() {
    this._isAdmitted = false;
    this._emitStatus('waiting', 'Waiting for host approval');
    this.onWaitingRoom?.();
    this._settleJoin?.(null, 'waiting');
  }

  _onAdmissionRequest(msg) {
    this.waitingPeers.set(msg.peer_id, msg.peer_name || 'Guest');
    this.onWaitingPeersChange?.(this.waitingPeers);
  }

  _onAdmissionCancelled(msg) {
    this.waitingPeers.delete(msg.peer_id);
    this.onWaitingPeersChange?.(this.waitingPeers);
  }

  /**
   * A new peer has joined — they will offer us, so just prepare the PC.
   * @param {{ peer_id: string }} msg
   */
  _onPeerJoined(msg) {
    this._peerNames.set(msg.peer_id, msg.peer_name || 'Guest');
    this._preparePeer(msg.peer_id, this.getPeerName(msg.peer_id));
  }

  _onPeerRenamed(msg) {
    if (!msg.peer_id || typeof msg.peer_name !== 'string') return;
    this._peerNames.set(msg.peer_id, msg.peer_name);
    if (msg.peer_id === this._clientId) this._userName = msg.peer_name;
    this.onPeerRenamed?.(msg.peer_id, msg.peer_name);
  }

  _preparePeer(remotePeerId, displayName = this.getPeerName(remotePeerId)) {
    if (!remotePeerId || remotePeerId === this._clientId) return;
    const isNewPeer = !this.peers.has(remotePeerId);
    const pc = this._createPeerConnection(remotePeerId);
    if (isNewPeer) this.onPeerJoined?.(remotePeerId, null, displayName);

    if (this._clientId.localeCompare(remotePeerId) < 0) {
      if (isNewPeer) this._initiateOffer(remotePeerId, pc);
    }
    if (this._screenStream && !this.screenSenders.has(remotePeerId)) {
      this._createScreenSender(remotePeerId, this._screenStream);
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

    this._mutedPeers.delete(msg.peer_id);
    this._peerNames.delete(msg.peer_id);
    const sender = this.screenSenders.get(msg.peer_id);
    if (sender) {
      try { sender.close(); } catch (_) { /* ignore */ }
      this.screenSenders.delete(msg.peer_id);
    }
    const receiver = this.screenReceivers.get(msg.peer_id);
    if (receiver) {
      try { receiver.close(); } catch (_) { /* ignore */ }
      this.screenReceivers.delete(msg.peer_id);
      this.onRemoteScreenShareStopped?.(msg.peer_id);
    }
    this._pendingScreenCandidates.delete(msg.peer_id);
    if (msg.host_id !== undefined && msg.host_id !== this._hostId) {
      this._hostId = msg.host_id;
      this.onHostChange?.(this._hostId);
    }

    this.onPeerLeft?.(msg.peer_id);
  }

  _onParticipantMute(msg) {
    if (msg.muted) this._mutedPeers.add(msg.peer_id);
    else this._mutedPeers.delete(msg.peer_id);
    this._applyRemoteMute(msg.peer_id);
    this.onPeerMuted?.(msg.peer_id, msg.muted);
  }

  _applyRemoteMute(peerId) {
    const audio = this._audioContainer?.querySelector(`[data-peer-id="${peerId}"]`);
    if (audio) audio.muted = this._mutedPeers.has(peerId);
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
      const videoTransceiver = this._getVideoTransceiver(pc);
      videoTransceiver.direction = 'sendrecv';
      await videoTransceiver.sender.replaceTrack(this._getCameraTrack());

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
      const videoTransceiver = this._getVideoTransceiver(pc);
      videoTransceiver.direction = 'sendrecv';
      await videoTransceiver.sender.replaceTrack(this._getCameraTrack());

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

    const pc = new RTCPeerConnection(this._rtcConfig);
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
      const state = pc.iceConnectionState;
      console.log(`[WebRTCManager] ICE state (${remotePeerId}):`, state);
      this.onPeerConnectionState?.(remotePeerId, state);
      if (state === 'connected' || state === 'completed') {
        clearTimeout(this._iceRestartTimers.get(remotePeerId));
        this._iceRestartTimers.delete(remotePeerId);
        this._iceRestartAttempts.delete(remotePeerId);
      } else if (state === 'failed' || state === 'disconnected') {
        this._scheduleIceRestart(remotePeerId, pc, state === 'failed' ? 0 : 2000);
      } else if (state === 'checking') {
        this._scheduleIceRestart(remotePeerId, pc, 10000);
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

  _getVideoTransceiver(pc) {
    let transceiver = pc.getTransceivers().find((item) => item.receiver.track?.kind === 'video');
    if (!transceiver) transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    return transceiver;
  }

  async _renegotiate(peerId, pc) {
    if (pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', target_id: peerId, sdp: offer.sdp });
    } catch (error) {
      console.error(`[WebRTCManager] Camera renegotiation with ${peerId} failed:`, error);
    }
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
    el.muted = this._mutedPeers.has(peerId);
    el.srcObject = stream;
    el.play().catch((err) => {
      console.warn(`[WebRTCManager] Autoplay blocked for peer ${peerId}:`, err.message);
    });
    this.onRemoteStream?.(peerId, stream);
  }

  /**
   * Tear down a peer connection and its audio element.
   * @param {string} peerId
   * @param {RTCPeerConnection} pc
   */
  _closePeerConnection(peerId, pc) {
    this._pendingCandidates.delete(peerId);
    clearTimeout(this._iceRestartTimers.get(peerId));
    this._iceRestartTimers.delete(peerId);
    this._iceRestartAttempts.delete(peerId);
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

  async _createScreenSender(peerId, stream) {
    if (this.screenSenders.has(peerId)) return;
    const pc = new RTCPeerConnection(this._rtcConfig);
    this.screenSenders.set(peerId, pc);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._send({
          type: 'screen-ice-candidate',
          target_id: peerId,
          candidate: candidate.toJSON(),
        });
      }
    };
    const track = stream.getVideoTracks()[0];
    pc.addTrack(track, stream);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'screen-offer', target_id: peerId, sdp: offer.sdp });
    } catch (error) {
      console.error(`[WebRTCManager] Screen offer to ${peerId} failed:`, error);
      pc.close();
      this.screenSenders.delete(peerId);
    }
  }

  async _handleScreenOffer(msg) {
    try {
      let pc = this.screenReceivers.get(msg.sender_id);
      if (pc) {
        try { pc.close(); } catch (_) { /* ignore */ }
      }
      pc = new RTCPeerConnection(this._rtcConfig);
      this.screenReceivers.set(msg.sender_id, pc);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          this._send({
            type: 'screen-ice-candidate',
            target_id: msg.sender_id,
            candidate: candidate.toJSON(),
          });
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams?.[0] ?? new MediaStream([event.track]);
        this.onRemoteScreenShare?.(msg.sender_id, stream);
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
      const candidates = this._pendingScreenCandidates.get(msg.sender_id) ?? [];
      this._pendingScreenCandidates.delete(msg.sender_id);
      for (const candidate of candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._send({ type: 'screen-answer', target_id: msg.sender_id, sdp: answer.sdp });
    } catch (error) {
      console.error(`[WebRTCManager] Screen offer from ${msg.sender_id} failed:`, error);
    }
  }

  async _handleScreenAnswer(msg) {
    const pc = this.screenSenders.get(msg.sender_id);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
      const candidates = this._pendingScreenCandidates.get(msg.sender_id) ?? [];
      this._pendingScreenCandidates.delete(msg.sender_id);
      for (const candidate of candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      console.error(`[WebRTCManager] Screen answer from ${msg.sender_id} failed:`, error);
    }
  }

  async _handleScreenCandidate(msg) {
    const pc = this.screenReceivers.get(msg.sender_id) ?? this.screenSenders.get(msg.sender_id);
    if (!pc || !pc.remoteDescription) {
      const pending = this._pendingScreenCandidates.get(msg.sender_id) ?? [];
      pending.push(msg.candidate);
      this._pendingScreenCandidates.set(msg.sender_id, pending);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (error) {
      console.error(`[WebRTCManager] Screen ICE candidate from ${msg.sender_id} failed:`, error);
    }
  }

  _onScreenShareStop(msg) {
    const pc = this.screenReceivers.get(msg.peer_id);
    if (pc) {
      try { pc.close(); } catch (_) { /* ignore */ }
      this.screenReceivers.delete(msg.peer_id);
      this.onRemoteScreenShareStopped?.(msg.peer_id);
    }
    this._pendingScreenCandidates.delete(msg.peer_id);
  }

  async _loadRtcConfig() {
    try {
      const response = await fetch('/api/ice-servers', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`ICE config request failed: ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn('[WebRTCManager] Using public STUN fallback:', error.message);
      return RTC_CONFIG;
    }
  }

  _scheduleReconnect(wsUrl) {
      if (!this._shouldReconnect || this._reconnectTimer) return;
      const delay = Math.min(1000 * (2 ** this._reconnectAttempt), 15000);
      this._reconnectAttempt += 1;
      this._emitStatus('connecting', `Reconnecting in ${Math.ceil(delay / 1000)}s`);
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (!this._shouldReconnect) return;
        this._openSocket(
          () => {},
          () => this._scheduleReconnect(wsUrl),
          wsUrl,
          false,
        );
      }, delay);
  }

  _scheduleIceRestart(peerId, pc, delay) {
    if (this._iceRestartTimers.has(peerId)) return;
    const timer = setTimeout(() => {
      this._iceRestartTimers.delete(peerId);
      this._requestIceRestart(peerId, pc);
    }, delay);
    this._iceRestartTimers.set(peerId, timer);
  }

  _requestIceRestart(peerId, pc) {
    if (pc.connectionState === 'closed') return;
    if (this._clientId.localeCompare(peerId) < 0) {
      this._restartIce(peerId, pc);
    } else {
      this._send({ type: 'ice-restart-request', target_id: peerId });
    }
  }

  _onIceRestartRequest(msg) {
    const pc = this.peers.get(msg.sender_id);
    if (pc && this._clientId.localeCompare(msg.sender_id) < 0) {
      this._restartIce(msg.sender_id, pc);
    }
  }

  async _restartIce(peerId, pc) {
    if (pc.connectionState === 'closed') return;
    if (pc.signalingState !== 'stable') {
      this._scheduleIceRestart(peerId, pc, 1000);
      return;
    }

    const attempts = this._iceRestartAttempts.get(peerId) ?? 0;
    if (attempts >= 5) {
      this.onPeerConnectionState?.(peerId, 'failed');
      return;
    }
    this._iceRestartAttempts.set(peerId, attempts + 1);

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', target_id: peerId, sdp: offer.sdp });
      this._scheduleIceRestart(peerId, pc, Math.min(1000 * (2 ** attempts), 8000));
    } catch (error) {
      console.warn(`[WebRTCManager] ICE restart for ${peerId} failed:`, error);
      this._scheduleIceRestart(peerId, pc, Math.min(1000 * (2 ** attempts), 8000));
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

  _getCameraTrack() {
    return this._cameraStream?.getVideoTracks()[0] ?? null;
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

/**
 * @file app.js
 * @description Frontend controller for Worship Audio Room.
 *
 * Responsibilities:
 *  - Instantiates AudioManager and wires all DOM interactions to it.
 *  - Drives the VU meter and FSM badge via a requestAnimationFrame render loop.
 *  - Manages the dual-source playlist engine (factory presets + custom uploads).
 *  - Handles drag-and-drop file ingestion with URL lifecycle management.
 *  - Wires threshold sliders to live AudioManager parameters.
 *  - WebRTCManager: deep-linked room sharing, multi-peer mesh, live chat.
 *
 * @module app
 */

import { AudioManager, EngineState } from './AudioManager.js?v=3';
import { WebRTCManager }              from './WebRTCManager.js?v=13';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Google OAuth Client ID.
 * Replace with your real Client ID from https://console.cloud.google.com/
 * When the placeholder value is detected on localhost, a Dev Login button is shown.
 */
let googleClientId = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

/**
 * VU meter formula: maps dBFS range [-60, 0] → percentage [0, 100].
 * Uses a slight headroom compression (96% at 0 dBFS) for visual safety.
 * @param {number} db - RMS level in dBFS (typically -60 to 0).
 * @returns {number} Width percentage 0–100.
 */
const dbToPercent = (db) => Math.min(Math.max((db + 60) * 1.6, 0), 100);

/**
 * FSM badge configuration — defines the CSS class, label, and gain label
 * for each EngineState value.
 */
const FSM_CONFIG = {
  [EngineState.SWELL]: {
    cssClass:  'fsm-badge--swell',
    label:     'SWELL',
    gainLabel: '80%',
  },
  [EngineState.CONVERSATIONAL]: {
    cssClass:  'fsm-badge--conversational',
    label:     'CONVERSATIONAL',
    gainLabel: '20%',
  },
  [EngineState.CLIMAX]: {
    cssClass:  'fsm-badge--climax',
    label:     'CLIMAX',
    gainLabel: '40%',
  },
};

/** All possible FSM badge CSS classes (used to strip previous state styling). */
const ALL_FSM_CLASSES = Object.values(FSM_CONFIG).map(c => c.cssClass);

/**
 * Procedural preset definitions.
 *
 * Each entry maps to a factory preset list item in index.html (by position).
 * `type`  → passed to AudioManager.playProceduralPreset() to select the
 *            synthesis algorithm.
 * `notes` → frequency array in Hz for each chord voice.
 *
 * Note names / tuning reference:
 *   C3=130.81, G3=196.00, C4=261.63, E4=329.63
 *   G3=196.00, B3=246.94, D4=293.66, G4=392.00
 *   D2=73.42,  A2=110.00, D3=146.83, F#3=185.00
 *   Eb3=155.56,Bb3=233.08,Eb4=311.13,G4=392.00
 *   A2=110.00, E3=164.81, A3=220.00, C#4=277.18
 */
const PRESET_DEFINITIONS = {
  'c-major': {
    id:    'preset-1',
    name:  'Deep Pad — C Major',
    type:  'pad',
    notes: [130.81, 196.00, 261.63, 329.63],
  },
  'g-major': {
    id:    'preset-2',
    name:  'Warm Strings — G Major',
    type:  'strings',
    notes: [196.00, 246.94, 293.66, 392.00],
  },
  'd-minor-drone': {
    id:    'preset-3',
    name:  'Cinematic Drone — D Major',
    type:  'drone',
    notes: [73.42, 110.00, 146.83, 185.00],
  },
  'eb-major': {
    id:    'preset-4',
    name:  'Heavenly Choir — E♭ Major',
    type:  'choir',
    notes: [155.56, 233.08, 311.13, 392.00],
  },
  'a-major': {
    id:    'preset-5',
    name:  'Altar Piano — A Major',
    type:  'piano',
    notes: [110.00, 164.81, 220.00, 277.18],
  },
};

/**
 * Ordered array of preset keys matching the DOM order in index.html.
 * Index 0 → first <li> in #panel-presets, index 4 → last <li>.
 */
const PRESET_KEYS_ORDERED = [
  'c-major',
  'g-major',
  'd-minor-drone',
  'eb-major',
  'a-major',
];

// ═══════════════════════════════════════════════════════════════════════════════
// APPLICATION STATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Singleton AudioManager instance */
const audioManager = new AudioManager();

/** Singleton WebRTCManager instance (re-created implicitly on each join). */
const webrtcClient = new WebRTCManager();

/** Whether the audio engine + mic are currently active */
let isEngineActive = false;

/** RAF handle for the app-level render loop */
let renderRafId = null;

/**
 * Custom playlist state.
 * @type {Array<{id: string, name: string, size: number, url: string, file: File}>}
 */
let customPlaylist = [];

/**
 * Tracks DOM elements for connected remote peers so they can be removed on leave.
 * Key: peerId, Value: HTMLElement (.peer-card)
 * @type {Map<string, HTMLElement>}
 */
const peerElements = new Map();
const peerConnectionStates = new Map();

/**
 * ID of the currently active (playing) track, or null if none.
 * Used to highlight the active track row in both preset and custom lists.
 * @type {string|null}
 */
let activeTrackId = null;

/**
 * Currently connected room ID (placeholder until Phase 5).
 * @type {string|null}
 */
let currentRoomId = null;
let authenticatedUser = null;

/**
 * Stores the ?room= param value so we can auto-join after sign-in completes.
 * @type {string|null}
 */
let pendingRoomId = null;

// ═══════════════════════════════════════════════════════════════════════════════
// DOM ELEMENT REFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

// -- Header / Room Controls --
const $roomIdInput      = document.getElementById('room-id-input');
const $btnJoin          = document.getElementById('btn-join');
const $btnLeave         = document.getElementById('btn-leave');
const $connectionStatus = document.getElementById('connection-status');
const $statusText       = document.getElementById('status-text');

// -- Engine Toggle --
const $btnEngineToggle  = document.getElementById('btn-engine-toggle');
const $engineToggleLabel = $btnEngineToggle?.querySelector('.engine-toggle-label');

// -- FSM Badge --
const $fsmBadge         = document.getElementById('fsm-badge');
const $fsmBadgeText     = document.getElementById('fsm-badge-text');
const $fsmBadgeGain     = document.getElementById('fsm-badge-gain');

// -- VU Meter --
const $vuBar            = document.getElementById('vu-bar');
const $vuDbReadout      = document.getElementById('vu-db-readout');

// -- Threshold Sliders --
const $sliderSpeech     = document.getElementById('slider-speech');
const $speechThreshVal  = document.getElementById('speech-threshold-val');
const $sliderClimax     = document.getElementById('slider-climax');
const $climaxThreshVal  = document.getElementById('climax-threshold-val');

// -- Master Gain --
const $sliderMasterGain = document.getElementById('slider-master-gain');
const $masterGainVal    = document.getElementById('master-gain-val');

// -- Tabs --
const $tabPresets       = document.getElementById('tab-presets');
const $tabCustom        = document.getElementById('tab-custom');
const $panelPresets     = document.getElementById('panel-presets');
const $panelCustom      = document.getElementById('panel-custom');

// -- Factory Preset Track List --
const $presetTrackItems = document.querySelectorAll('#panel-presets .track-item');

// -- Custom Playlist --
const $dropZone         = document.getElementById('drop-zone');
const $fileInput        = document.getElementById('file-input');
const $btnBrowse        = document.getElementById('btn-browse');
const $customTrackList  = document.getElementById('custom-track-list');
const $customListEmpty  = document.getElementById('custom-list-empty');
const $customTrackCount = document.getElementById('custom-track-count');
const $btnClearPlaylist = document.getElementById('btn-clear-playlist');

// -- Now Playing --
const $nowPlayingPill   = document.getElementById('now-playing-pill');
const $nowPlayingTitle  = document.getElementById('now-playing-title');
const $btnPlayPause     = document.getElementById('btn-play-pause');

// -- Stage / Peer --
const $localSpeakingRing = document.getElementById('local-speaking-indicator');
const $peerCountBadge   = document.getElementById('peer-count-badge');
const $participantCount = document.getElementById('participant-count');
const $signalQuality    = document.getElementById('signal-quality');
const $roomModeDisplay  = document.getElementById('room-mode-display');

// -- Footer Metrics --
const $metricSampleRate = document.getElementById('metric-sample-rate');
const $metricLatency    = document.getElementById('metric-latency');
const $metricOutput     = document.getElementById('metric-output');
const $metricEngine     = document.getElementById('metric-engine');

// -- Chat --
const $chatMessages   = document.getElementById('chat-messages');
const $chatInput      = document.getElementById('chat-input');
const $btnChatSend    = document.getElementById('btn-chat-send');
const $chatUsername   = document.getElementById('chat-username');
const $chatUnreadBadge = document.getElementById('chat-unread-badge');
const $btnEmojiPicker = document.getElementById('btn-emoji-picker');
const $emojiPicker    = document.getElementById('emoji-picker');

// -- Room sharing --
const $btnShare       = document.getElementById('btn-share');
const $shareOptions   = document.getElementById('share-options');
const $shareNative    = document.getElementById('share-native');
const $shareWhatsapp  = document.getElementById('share-whatsapp');
const $shareEmail     = document.getElementById('share-email');
const $btnCopyLink    = document.getElementById('btn-copy-link');
const $shareEmailAddress = document.getElementById('share-email-address');
const $btnInviteEmail = document.getElementById('btn-invite-email');
const $btnToggleChat  = document.getElementById('btn-toggle-chat');
const $chatToggleLabel = document.getElementById('chat-toggle-label');
const $chatSidebar    = document.getElementById('chat-sidebar');
const $stageGrid      = document.querySelector('.stage-grid');
const $localPeerName  = document.getElementById('local-peer-name');
const $localPeerRole  = document.getElementById('local-peer-role');
const $btnSignIn      = document.getElementById('btn-sign-in');
const $btnSignOut     = document.getElementById('btn-sign-out');
const $accountLabel   = document.getElementById('account-label');
const $waitingRoomStatus = document.getElementById('waiting-room-status');
const $admissionPanel = document.getElementById('admission-panel');
const $admissionList  = document.getElementById('admission-list');
const $btnShareScreen = document.getElementById('btn-share-screen');
const $btnStopScreenShare = document.getElementById('btn-stop-screen-share');
const $btnToggleCamera = document.getElementById('btn-toggle-camera');
const $localCameraVideo = document.getElementById('local-camera-video');
const $btnToggleCaptions = document.getElementById('btn-toggle-captions');
const $btnRaiseHand = document.getElementById('btn-raise-hand');
const $btnReaction = document.getElementById('btn-reaction');
const $btnRecord = document.getElementById('btn-record');
const $btnCalendar = document.getElementById('btn-calendar');
const $btnMuteEveryone = document.getElementById('btn-mute-everyone');
const $screenShareGrid = document.getElementById('screen-share-grid');
const $captionsPanel = document.getElementById('captions-panel');
const $captionsFeed = document.getElementById('captions-feed');
let captionRecognition = null;
let captionsActive = false;
let handRaised = false;
let recorder = null;
let recordingChunks = [];

// -- Auth Overlay --
const $authOverlay      = document.getElementById('auth-overlay');
const $googleSigninBtn  = document.getElementById('google-signin-btn');
const $authOauthLink    = document.getElementById('auth-oauth-link');
const $authConfigStatus  = document.getElementById('auth-config-status');
const $devLoginBtn      = document.getElementById('dev-login-btn');
const $userProfileBadge = document.getElementById('user-profile-badge');
const $userAvatar       = document.getElementById('user-avatar');
const $roomControls     = document.querySelector('.room-controls');

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reads the `?room=` query param from the URL and pre-fills the Room ID input.
 * Called at the very start of bootstrap so the field is set before any binding.
 * Also stashes the room ID for post-login auto-join.
 */
function applyDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam && $roomIdInput) {
    $roomIdInput.value = roomParam;
    pendingRoomId = roomParam;
    return true;
  }
  return false;
}

/**
 * Binds the global Music Play/Pause toggle.
 * Operates independently of the microphone engine.
 */
function bindPlayPause() {
  $btnPlayPause?.addEventListener('click', () => {
    if (!audioManager.ctx) {
      showAlert('Select a track to start playback.', 'info');
      return;
    }
    if (audioManager._isMusicPlaying) {
      audioManager.pauseMusic();
      updatePlayPauseUI();
    } else {
      audioManager.resumeMusic().then(updatePlayPauseUI).catch((err) => {
        console.error('[app] Music resume failed:', err);
        showAlert('Could not start background audio. Please try again.', 'warn');
      });
    }
  });
}

function bindCollaborationTools() {
  $btnRaiseHand?.addEventListener('click', () => {
    handRaised = !handRaised;
    webrtcClient.setHandRaised(handRaised);
    $btnRaiseHand.textContent = handRaised ? 'Lower Hand' : 'Raise Hand';
    $btnRaiseHand.setAttribute('aria-pressed', String(handRaised));
  });
  $btnReaction?.addEventListener('click', () => webrtcClient.sendReaction('❤️'));
  $btnMuteEveryone?.addEventListener('click', () => {
    webrtcClient.muteEveryone();
    showAlert('Everyone has been muted.', 'info');
  });
  $btnRecord?.addEventListener('click', toggleLocalRecording);
  $btnCalendar?.addEventListener('click', downloadCalendarInvite);
}

function handleRoomNotification(message) {
  const text = message?.body || message?.message || 'Room update';
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Worship Room', { body: text });
  }
  showAlert(text, 'info');
}

function toggleLocalRecording() {
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  const audioStream = audioManager.destinationNode?.stream;
  if (!audioStream || typeof MediaRecorder === 'undefined') {
    showAlert('Local recording is not supported in this browser yet.', 'warn');
    return;
  }
  const stream = new MediaStream(audioStream.getTracks());
  if ($localCameraVideo?.srcObject) {
    $localCameraVideo.srcObject.getVideoTracks().forEach(track => stream.addTrack(track));
  }
  recordingChunks = [];
  try {
    recorder = new MediaRecorder(stream);
  } catch (error) {
    console.error('[app] Could not start local recording:', error);
    showAlert('Could not start local recording.', 'error');
    return;
  }
  recorder.ondataavailable = event => {
    if (event.data.size) recordingChunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recordingChunks, { type: recorder.mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `worship-room-${new Date().toISOString().replaceAll(':', '-')}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    recordingChunks = [];
    $btnRecord.textContent = 'Record locally';
    $btnRecord.setAttribute('aria-pressed', 'false');
  };
  recorder.start();
  $btnRecord.textContent = 'Stop recording';
  $btnRecord.setAttribute('aria-pressed', 'true');
}

function downloadCalendarInvite() {
  if (!currentRoomId) return;
  const start = new Date();
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const format = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const roomUrl = getCleanRoomUrl(currentRoomId);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Worship Room//EN',
    'BEGIN:VEVENT', `UID:${currentRoomId}@worship-room`,
    `DTSTAMP:${format(new Date())}`, `DTSTART:${format(start)}`, `DTEND:${format(end)}`,
    'SUMMARY:Worship Room gathering', `DESCRIPTION:Join Worship Room: ${roomUrl}`,
    `URL:${roomUrl}`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `worship-room-${currentRoomId}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Updates the Play/Pause button icons based on current playback state.
 */
function updatePlayPauseUI() {
  if (!$btnPlayPause) return;

  const isPlaying = audioManager._isMusicPlaying;
  const $playIcon  = $btnPlayPause.querySelector('.icon-play');
  const $pauseIcon = $btnPlayPause.querySelector('.icon-pause');

  if (isPlaying) {
    $playIcon.style.display = 'none';
    $pauseIcon.style.display = 'block';
    $btnPlayPause.classList.add('is-playing');
  } else {
    $playIcon.style.display = 'block';
    $pauseIcon.style.display = 'none';
    $btnPlayPause.classList.remove('is-playing');
  }
}

/**
 * Main application entry point. Called once on DOMContentLoaded.
 */
async function bootstrap() {
  const hasDeepLink = applyDeepLink();

  // Wire AudioManager state callbacks
  audioManager.onTransition = handleFSMTransition;

  // Wire WebRTCClient callbacks
  webrtcClient.onPeerJoined   = addPeerCard;
  webrtcClient.onRemoteStream = updatePeerMedia;
  webrtcClient.onPeerRenamed  = updatePeerDisplayName;
  webrtcClient.onCaption = renderCaption;
  webrtcClient.onRaiseHand = (message) => {
    const name = webrtcClient.getPeerName(message.peer_id) || message.peer_id;
    showAlert(`${name} ${message.raised ? 'raised' : 'lowered'} their hand.`, 'info');
  };
  webrtcClient.onReaction = (message) => {
    const name = webrtcClient.getPeerName(message.peer_id) || 'Someone';
    showAlert(`${name} reacted ${message.emoji || ''}`, 'info');
  };
  webrtcClient.onPoll = (message) => {
    showAlert(message.question ? `Poll: ${message.question}` : 'Poll updated.', 'info');
  };
  webrtcClient.onQuestion = (message) => {
    showAlert(message.text ? `Question: ${message.text}` : 'Question updated.', 'info');
  };
  webrtcClient.onNotification = handleRoomNotification;
  webrtcClient.onPeerLeft     = removePeerCard;
  webrtcClient.onHostChange   = updateHostControls;
  webrtcClient.onPeerMuted    = (peerId) => updatePeerModerationControls(peerId);
  webrtcClient.onPeerConnectionState = updatePeerConnectionState;
  webrtcClient.onRoomJoined   = completeRoomJoin;
  webrtcClient.onScreenShareStarted = (stream) => {
    renderScreenShareTile(webrtcClient.clientId, stream, `${webrtcClient.userName} · You`, true);
    $btnShareScreen.hidden = true;
    $btnStopScreenShare.hidden = false;
  };
  webrtcClient.onScreenShareStopped = () => {
    removeScreenShareTile(webrtcClient.clientId);
    $btnShareScreen.hidden = false;
    $btnStopScreenShare.hidden = true;
  };
  webrtcClient.onCameraStarted = (stream) => {
    $localCameraVideo.srcObject = stream;
    $localCameraVideo.hidden = false;
    $btnToggleCamera.textContent = 'Disable Camera';
    $btnToggleCamera.setAttribute('aria-pressed', 'true');
  };
  webrtcClient.onCameraStopped = () => {
    $localCameraVideo.srcObject = null;
    $localCameraVideo.hidden = true;
    $btnToggleCamera.textContent = 'Enable Camera';
    $btnToggleCamera.setAttribute('aria-pressed', 'false');
  };
  webrtcClient.onRemoteScreenShare = (peerId, stream) => {
    renderScreenShareTile(peerId, stream, webrtcClient.getPeerName(peerId), false);
  };
  webrtcClient.onRemoteScreenShareStopped = removeScreenShareTile;
  webrtcClient.onWaitingRoom  = () => {
    $waitingRoomStatus.hidden = false;
    $roomModeDisplay.textContent = 'Waiting';
  };
  webrtcClient.onWaitingPeersChange = renderAdmissionQueue;
  webrtcClient.onAdmissionDenied = () => {
    showAlert('The host did not admit you to this room.', 'warn');
    handleLeaveRoom();
  };
  webrtcClient.onRoomClosed = (message) => {
    showAlert(message, 'warn');
  };
  webrtcClient.onKicked       = () => {
    showAlert('The host removed you from this room.', 'warn');
    handleLeaveRoom();
  };
  webrtcClient.onStatusChange = (status, msg) => {
    // 'connected' and 'live' both map to the 'live' badge style
    const badgeStatus = (status === 'connected' || status === 'live')
      ? 'live'
      : status === 'waiting' || status === 'connecting'
        ? 'waiting'
        : 'disconnected';
    const displayMsg = status === 'connected'
      ? `Live · Connected to Room: ${currentRoomId ?? $roomIdInput.value}`
      : msg;
    setConnectionStatus(badgeStatus, displayMsg);
    updatePeerCountBadge();
  };

  // Bind all interactive elements
  bindEngineToggle();
  bindThresholdSliders();
  bindMasterGainSlider();
  bindTabNavigation();
  bindFactoryPresets();
  bindCustomPlaylist();
  bindRoomControls();
  bindScreenShare();
  bindCamera();
  bindCaptions();
  bindChatVisibility();
  bindShareMenu();
  bindChat();
  bindPlayPause();
  bindCollaborationTools();

  // Initialise UI to a known idle state
  syncFSMBadge(EngineState.SWELL);
  updateVuMeter(-Infinity);
  updateFooterMetrics();

  // Lock room controls until auth completes
  lockRoomControls();

  // Check for existing session first (server-side OAuth or prior GIS login)
  await refreshAuthentication();

  // Initialise Google Identity Services
  await initGoogleSignIn();

  // Bind sign-out
  bindAuthentication();

  console.log('[app] Bootstrap complete.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE SIGN-IN  (Google Identity Services — client-side credential flow)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Whether the configured Google client ID is usable.
 */
function isRealClientId() {
  return googleClientId && !googleClientId.startsWith('YOUR_');
}

/**
 * Initialises the Google Identity Services (GIS) library.
 * Renders the branded sign-in button into the auth overlay.
 * On localhost with a placeholder Client ID, shows a "Dev Login" fallback instead.
 */
async function initGoogleSignIn() {
  const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(location.hostname);

  // If already authenticated (session cookie / sessionStorage), skip overlay
  if (authenticatedUser?.sub || getUserSession()) {
    return;
  }

  try {
    const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
    if (response.ok) {
      const config = await response.json();
      if (typeof config.google_client_id === 'string' && config.google_client_id) {
        googleClientId = config.google_client_id;
      }
      if (config.google_oauth_enabled && $authOauthLink) {
        $authOauthLink.hidden = false;
      } else if ($authOauthLink) {
        $authOauthLink.textContent = 'Google sign-in setup required';
        $authOauthLink.setAttribute('aria-disabled', 'true');
        $authOauthLink.addEventListener('click', (event) => {
          event.preventDefault();
          showAlert('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Render to enable Google sign-in.', 'warn');
        });
      }
    }
  } catch (err) {
    console.warn('[app] Could not load authentication configuration:', err);
  }

  if (isRealClientId() && typeof google !== 'undefined' && google.accounts?.id) {
    google.accounts.id.initialize({
      client_id: googleClientId,
      callback:  handleCredentialResponse,
      auto_select: true,
      cancel_on_tap_outside: false,
    });

    google.accounts.id.renderButton($googleSigninBtn, {
      type:  'standard',
      theme: 'filled_blue',
      size:  'large',
      shape: 'pill',
      text:  'signin_with',
      width: 280,
    });

    // Also prompt One Tap
    google.accounts.id.prompt();
  } else if (isLocalhost) {
    // Dev/Test fallback for localhost without a real Client ID
    if ($devLoginBtn) {
      $devLoginBtn.hidden = false;
      $devLoginBtn.addEventListener('click', handleDevLogin);
    }
    // Hide the GIS button container since it won't render anything
    if ($googleSigninBtn) $googleSigninBtn.style.display = 'none';
  } else if ($authConfigStatus) {
    $authConfigStatus.hidden = false;
    $authConfigStatus.textContent = 'Google sign-in is not configured on this deployment.';
  }
}

/**
 * Called by GIS when the user completes Google Sign-In.
 * The `response.credential` contains a JWT ID token.
 */
async function handleCredentialResponse(response) {
  const idToken = response.credential;

  try {
    // Try server-side verification first
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: idToken }),
    });

    if (res.ok) {
      const data = await res.json();
      const user = {
        sub:     data.sub || data.email,
        name:    data.name || 'Participant',
        email:   data.email || '',
        picture: data.picture || '',
        token:   idToken,
      };
      saveUserSession(user);
      authenticatedUser = user;
      onAuthSuccess();
      return;
    }
  } catch (err) {
    console.warn('[app] Server auth/google call failed, falling back to JWT decode:', err);
  }

  showAlert('Sign-in failed. Please try again.', 'error');
}

/**
 * Dev/Test login — creates a fake user session for localhost testing.
 */
function handleDevLogin() {
  const user = {
    sub:     'dev-user-localhost',
    name:    'Dev Tester',
    email:   'dev@localhost',
    picture: '',
    token:   'dev-token',
  };
  saveUserSession(user);
  authenticatedUser = user;
  onAuthSuccess();
}

/**
 * Called after successful authentication (Google or Dev).
 * Hides the auth overlay, shows profile badge, unlocks room controls,
 * and auto-joins a pending room if one was in the URL.
 */
function onAuthSuccess() {
  // Hide overlay
  if ($authOverlay) $authOverlay.hidden = true;

  // Update header UI
  updateProfileBadge();
  unlockRoomControls();

  // Auto-populate chat display name
  if ($chatUsername && authenticatedUser?.name) {
    $chatUsername.value = authenticatedUser.name;
  }

  // Auto-join pending room from ?room= deep link
  if (pendingRoomId) {
    const roomToJoin = pendingRoomId;
    pendingRoomId = null;
    $roomIdInput.value = roomToJoin;
    handleJoinRoom();
  }
}

/**
 * Saves the user session to sessionStorage.
 */
function saveUserSession(user) {
  sessionStorage.setItem('worship_user', JSON.stringify(user));
}

/**
 * Retrieves the user session from sessionStorage, or null.
 */
function getUserSession() {
  try {
    const data = sessionStorage.getItem('worship_user');
    if (!data) return null;
    const user = JSON.parse(data);
    return user?.sub ? user : null;
  } catch {
    return null;
  }
}

/**
 * Clears the user session from sessionStorage.
 */
function clearUserSession() {
  sessionStorage.removeItem('worship_user');
}

/**
 * Locks room creation/join controls (shown before authentication).
 */
function lockRoomControls() {
  $roomControls?.classList.add('auth-locked');
}

/**
 * Unlocks room creation/join controls (shown after authentication).
 */
function unlockRoomControls() {
  $roomControls?.classList.remove('auth-locked');
}

/**
 * Updates the header profile badge with the authenticated user's info.
 */
function updateProfileBadge() {
  const isSignedIn = Boolean(authenticatedUser?.sub);

  // Hide the old sign-in link
  if ($btnSignIn) $btnSignIn.hidden = true;

  if (isSignedIn && $userProfileBadge) {
    $userProfileBadge.hidden = false;
    if ($userAvatar) {
      if (authenticatedUser.picture) {
        $userAvatar.src = authenticatedUser.picture;
        $userAvatar.style.display = '';
      } else {
        $userAvatar.style.display = 'none';
      }
    }
    if ($accountLabel) {
      $accountLabel.textContent = authenticatedUser.name || authenticatedUser.email || 'Signed in';
    }
  } else if ($userProfileBadge) {
    $userProfileBadge.hidden = true;
  }
}

/**
 * Checks existing server-side session or sessionStorage for a prior login.
 */
async function refreshAuthentication() {
  const authResult = new URLSearchParams(window.location.search).get('auth');

  // 1. Check sessionStorage first (GIS / dev login)
  const stored = getUserSession();
  if (stored) {
    authenticatedUser = stored;
    if ($authOverlay) $authOverlay.hidden = true;
    updateProfileBadge();
    unlockRoomControls();
    if ($chatUsername && authenticatedUser.name) {
      $chatUsername.value = authenticatedUser.name;
    }
    // Auto-join pending room
    if (pendingRoomId) {
      const roomToJoin = pendingRoomId;
      pendingRoomId = null;
      $roomIdInput.value = roomToJoin;
      // Defer join to after all bindings complete
      setTimeout(() => handleJoinRoom(), 0);
    }
    return;
  }

  // 2. Check server-side session (Authlib OAuth redirect flow)
  try {
    const response = await fetch('/auth/me', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Auth status request failed: ${response.status}`);
    const data = await response.json();
    if (data.user?.sub) {
      authenticatedUser = data.user;
      saveUserSession(authenticatedUser);
      if ($authOverlay) $authOverlay.hidden = true;
      updateProfileBadge();
      unlockRoomControls();
      if ($chatUsername) {
        $chatUsername.value = authenticatedUser.name || authenticatedUser.email || 'Participant';
      }
      // Auto-join pending room
      if (pendingRoomId) {
        const roomToJoin = pendingRoomId;
        pendingRoomId = null;
        $roomIdInput.value = roomToJoin;
        setTimeout(() => handleJoinRoom(), 0);
      }
      return;
    }
  } catch (error) {
    console.warn('[app] Could not read authentication state:', error);
  }

  // Not authenticated — show the overlay
  authenticatedUser = null;
  if ($authOverlay) $authOverlay.hidden = false;
  lockRoomControls();

  if (authResult === 'success') {
    showAlert(
      'Google sign-in completed, but this browser did not receive the app session. Check that cookies are enabled, then try again.',
      'error',
    );
  } else if (authResult === 'error') {
    showAlert(
      'Google sign-in could not be completed. Please try again; if it continues, check the Render service logs.',
      'error',
    );
  }

  if (authResult) {
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

function bindAuthentication() {
  $btnSignOut?.addEventListener('click', async () => {
    // Clear client-side session
    clearUserSession();
    authenticatedUser = null;

    // Revoke GIS credential if available
    if (isRealClientId() && typeof google !== 'undefined' && google.accounts?.id) {
      google.accounts.id.disableAutoSelect();
    }

    // Clear server-side session too
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }

    // Reload page to reset all state
    window.location.assign('/');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE TOGGLE — Mic init & AudioContext unlock
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wires the "Enable Mic / Audio Engine" toggle button.
 */
function bindEngineToggle() {
  $btnEngineToggle.addEventListener('click', handleEngineToggle);
}

/**
 * Handles the engine toggle click.
 * Activates the AudioContext (requires user gesture) and requests mic access.
 */
async function handleEngineToggle() {
  if (isEngineActive) {
    deactivateEngine();
    return;
  }

  // Disable button while initialising to prevent double-clicks
  $btnEngineToggle.disabled = true;
  setEngineToggleLabel('Starting…');

  try {
    // Phase 1: Init AudioContext (requires user gesture)
    await audioManager.init();

    // Phase 2: Request mic access and attach to DSP chain
    await audioManager.attachMicrophone();

    // Phase 3: Apply current slider values to the live engine
    applySliderStatesToEngine();

    // Phase 4: Start the app render loop
    startRenderLoop();

    // If already in a room, push the freshly available local track to existing peers
    if (webrtcClient.isConnected) {
      webrtcClient.refreshLocalTrack();
    }

    // Mark active
    isEngineActive = true;
    $btnEngineToggle.setAttribute('aria-pressed', 'true');
    setEngineToggleLabel('On Air');
    $btnEngineToggle.disabled = false;

    // Update footer
    updateFooterMetrics();

    console.log('[app] Engine activated.');
  } catch (err) {
    $btnEngineToggle.disabled = false;
    setEngineToggleLabel('Enable Mic');
    handleMicError(err);
  }
}

/**
 * Deactivates the audio engine and mic, stopping all processing.
 */
function deactivateEngine() {
  stopRenderLoop();
  audioManager.detachMicrophone();

  isEngineActive = false;
  $btnEngineToggle.setAttribute('aria-pressed', 'false');
  setEngineToggleLabel('Enable Mic');

  // Reset VU meter to idle
  updateVuMeter(-Infinity);
  syncFSMBadge(EngineState.SWELL);
  setLocalSpeakingRing(false);
  updateFooterMetrics();

  console.log('[app] Engine deactivated.');
}

/**
 * Updates the engine toggle button label text.
 * @param {string} label
 */
function setEngineToggleLabel(label) {
  if ($engineToggleLabel) $engineToggleLabel.textContent = label;
}

/**
 * Handles mic permission denial or other getUserMedia errors.
 * Displays an inline status alert in the UI.
 * @param {Error} err
 */
function handleMicError(err) {
  console.warn('[app] Mic error:', err.name, err.message);

  let userMessage;
  switch (err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      userMessage = '🎙 Microphone access denied. Please allow mic permission in your browser settings.';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      userMessage = '🎙 No microphone detected. Please connect an audio input device.';
      break;
    case 'NotReadableError':
      userMessage = '🎙 Microphone is in use by another application.';
      break;
    default:
      userMessage = `🎙 Could not start audio engine: ${err.message}`;
  }

  showAlert(userMessage, 'error');
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER LOOP — VU Meter & FSM Badge (requestAnimationFrame)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Starts the app-level requestAnimationFrame render loop.
 * Polls AudioManager for the latest dB reading and state every frame.
 * Intentionally separate from AudioManager's own internal RAFloop so the
 * UI can degrade gracefully without blocking the DSP thread.
 */
function startRenderLoop() {
  if (renderRafId !== null) return; // guard double-start

  const frame = () => {
    renderRafId = requestAnimationFrame(frame);
    renderFrame();
  };
  renderRafId = requestAnimationFrame(frame);
}

/**
 * Stops the render loop.
 */
function stopRenderLoop() {
  if (renderRafId !== null) {
    cancelAnimationFrame(renderRafId);
    renderRafId = null;
  }
}

/**
 * Single render tick — called every animation frame when engine is active.
 * Reads latest state from AudioManager and updates all visual components.
 */
function renderFrame() {
  const db    = audioManager.getCurrentDecibels();
  const state = audioManager.currentState;

  updateVuMeter(db);
  syncFSMBadge(state);
  setLocalSpeakingRing(db > audioManager.SPEECH_THRESHOLD);
}

/**
 * Updates the VU bar width and the dB numeric readout.
 * Uses the spec formula: (db + 60) * 1.6 → 0–100% range.
 *
 * The CSS transition on .vu-bar is `80ms ease` so this is visually smooth
 * at 60fps without any additional JS interpolation overhead.
 *
 * @param {number} db - RMS level in dBFS (-Infinity if silent/inactive).
 */
function updateVuMeter(db) {
  const isFinite = Number.isFinite(db);
  const pct = isFinite ? dbToPercent(db) : 0;

  // Clamp and apply
  $vuBar.style.width = `${pct}%`;

  // Colour the bar by zone: green (safe) → yellow (speech) → red (climax)
  // This is handled by the CSS gradient + box-shadow, so just update readout.
  $vuDbReadout.textContent = isFinite ? `${db.toFixed(1)} dB` : '— dB';

  // Update ARIA value for accessibility
  const ariaVal = isFinite ? Math.round(db) : -60;
  $vuBar.closest('[role="meter"]')?.setAttribute('aria-valuenow', ariaVal);
}

/**
 * Updates the FSM state badge to reflect the current engine state.
 * Strips previous state classes and applies the new one.
 *
 * @param {string} state - One of the EngineState enum values.
 */
function syncFSMBadge(state) {
  const config = FSM_CONFIG[state] || FSM_CONFIG[EngineState.SWELL];

  // Swap CSS classes
  $fsmBadge.classList.remove(...ALL_FSM_CLASSES);
  $fsmBadge.classList.add(config.cssClass);

  // Update text
  $fsmBadgeText.textContent = config.label;
  $fsmBadgeGain.textContent = config.gainLabel;

  // ARIA live region — screen readers announce transitions
  $fsmBadge.setAttribute('aria-label', `Ducking state: ${config.label} at ${config.gainLabel}`);
}

/**
 * Called by AudioManager.onTransition whenever the FSM changes state.
 * Triggers any one-shot visual effects beyond the render loop.
 * @param {string} newState
 * @param {string} prevState
 */
function handleFSMTransition(newState, prevState) {
  console.log(`[app] FSM transition: ${prevState} → ${newState}`);
  // Sync immediately (render loop will continue updating)
  syncFSMBadge(newState);
}

/**
 * Toggles the speaking ring animation on the local peer card.
 * @param {boolean} active
 */
function setLocalSpeakingRing(active) {
  $localSpeakingRing?.classList.toggle('speaking-ring--active', active);
  $localSpeakingRing?.classList.toggle('speaking-ring--inactive', !active);
}

// ═══════════════════════════════════════════════════════════════════════════════
// THRESHOLD SLIDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Binds the threshold calibration sliders to live AudioManager parameters.
 */
function bindThresholdSliders() {
  // ── Speech Threshold ─────────────────────────────────────────────────────────
  $sliderSpeech.addEventListener('input', () => {
    const val = parseInt($sliderSpeech.value, 10);
    audioManager.SPEECH_THRESHOLD = val;
    $speechThreshVal.textContent = `${val} dB`;
    $sliderSpeech.setAttribute('aria-valuenow', val);
  });

  // ── Climax Upper Threshold ───────────────────────────────────────────────────
  $sliderClimax.addEventListener('input', () => {
    const val = parseInt($sliderClimax.value, 10);
    audioManager.CLIMAX_UPPER = val;
    // Enforce hysteresis: CLIMAX_LOWER must stay ≥ 6 dB below CLIMAX_UPPER
    audioManager.CLIMAX_LOWER = val - 6;
    $climaxThreshVal.textContent = `${val} dB`;
    $sliderClimax.setAttribute('aria-valuenow', val);
  });
}

/**
 * Pushes current slider values to the live engine.
 * Called once after engine initialisation to sync any pre-set slider positions.
 */
function applySliderStatesToEngine() {
  audioManager.SPEECH_THRESHOLD = parseInt($sliderSpeech.value, 10);
  audioManager.CLIMAX_UPPER     = parseInt($sliderClimax.value, 10);
  audioManager.CLIMAX_LOWER     = audioManager.CLIMAX_UPPER - 6;

  const masterLinear = parseInt($sliderMasterGain.value, 10) / 100;
  audioManager.setMasterGain(masterLinear);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MASTER GAIN SLIDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wires the Master Music Gain slider.
 * Maps slider range [0, 100] → linear gain [0.0, 1.0] for AudioManager.
 */
function bindMasterGainSlider() {
  $sliderMasterGain.addEventListener('input', () => {
    const pct = parseInt($sliderMasterGain.value, 10);
    const linear = pct / 100;

    audioManager.setMasterGain(linear);
    $masterGainVal.textContent = `${pct}%`;
    $sliderMasterGain.setAttribute('aria-valuenow', pct);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB NAVIGATION — Factory Presets ↔ My Custom Playlist
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wires the segmented tab buttons to show/hide their corresponding panels.
 */
function bindTabNavigation() {
  $tabPresets.addEventListener('click', () => activateTab('presets'));
  $tabCustom.addEventListener('click',  () => activateTab('custom'));
}

/**
 * Switches the active tab and panel.
 * @param {'presets'|'custom'} tab
 */
function activateTab(tab) {
  const isPresets = tab === 'presets';

  // Buttons
  $tabPresets.classList.toggle('tab-btn--active', isPresets);
  $tabPresets.setAttribute('aria-selected', String(isPresets));
  $tabCustom.classList.toggle('tab-btn--active', !isPresets);
  $tabCustom.setAttribute('aria-selected', String(!isPresets));

  // Panels (use hidden attribute for accessibility)
  $panelPresets.classList.toggle('tab-panel--active', isPresets);
  $panelPresets.hidden = !isPresets;
  $panelCustom.classList.toggle('tab-panel--active', !isPresets);
  $panelCustom.hidden = isPresets;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FACTORY PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wires preset track "Crossfade" buttons from the static HTML list.
 *
 * Each button triggers `audioManager.playProceduralPreset()` with the
 * corresponding synthesised chord voicing — no audio files required.
 */
function bindFactoryPresets() {
  $presetTrackItems.forEach((item, index) => {
    const key    = PRESET_KEYS_ORDERED[index];
    const preset = PRESET_DEFINITIONS[key];
    if (!preset) return;

    // Stamp the preset id onto the DOM element for active-track highlighting
    item.dataset.trackId = preset.id;

    const $playBtn = item.querySelector('.btn-play-track');
    if (!$playBtn) return;

    $playBtn.addEventListener('click', () => {
      playProceduralTrack(preset);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM PLAYLIST ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sets up all custom playlist interactions:
 *   - File input selection
 *   - Drag-and-drop onto the drop zone
 *   - "Clear Playlist" button
 *   - "Browse files" trigger
 */
function bindCustomPlaylist() {
  // ── File input ───────────────────────────────────────────────────────────────
  $fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      addFilesToPlaylist(Array.from(e.target.files));
      // Reset the input so the same file can be re-selected if removed
      e.target.value = '';
    }
  });

  // ── Browse button (triggers the hidden file input) ────────────────────────────
  $btnBrowse?.addEventListener('click', (e) => {
    e.stopPropagation();       // prevent drop zone click propagation
    $fileInput.click();
  });

  // ── Drop Zone — keyboard activation ──────────────────────────────────────────
  $dropZone.addEventListener('click', () => $fileInput.click());
  $dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $fileInput.click();
    }
  });

  // ── Drag-and-Drop ─────────────────────────────────────────────────────────────
  $dropZone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    $dropZone.classList.add('drag-over');
  });

  $dropZone.addEventListener('dragover', (e) => {
    e.preventDefault(); // required to allow drop
    e.dataTransfer.dropEffect = 'copy';
    $dropZone.classList.add('drag-over');
  });

  $dropZone.addEventListener('dragleave', (e) => {
    // Only remove class when leaving the drop zone itself (not child elements)
    if (!$dropZone.contains(e.relatedTarget)) {
      $dropZone.classList.remove('drag-over');
    }
  });

  $dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    $dropZone.classList.remove('drag-over');

    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('audio/')
    );

    if (files.length === 0) {
      showAlert('Please drop audio files only (MP3, WAV, OGG, FLAC, AAC).', 'warn');
      return;
    }

    addFilesToPlaylist(files);
  });

  // ── Clear Playlist ────────────────────────────────────────────────────────────
  $btnClearPlaylist.addEventListener('click', clearPlaylist);
}

/**
 * Adds an array of File objects to the custom playlist.
 * Creates Blob URLs for each file and renders track rows.
 * @param {File[]} files
 */
function addFilesToPlaylist(files) {
  const audioFiles = files.filter((f) => f.type.startsWith('audio/'));

  if (audioFiles.length === 0) {
    showAlert('No audio files detected. Supported: MP3, WAV, OGG, FLAC, AAC.', 'warn');
    return;
  }

  for (const file of audioFiles) {
    const id  = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = URL.createObjectURL(file);

    const track = { id, name: stripExtension(file.name), size: file.size, url, file };
    customPlaylist.push(track);
    renderCustomTrackRow(track);
  }

  syncCustomPlaylistMeta();
}

/**
 * Renders a single custom track row into the custom track list.
 * @param {{id: string, name: string, size: number, url: string}} track
 */
function renderCustomTrackRow(track) {
  // Remove the empty-state placeholder on first track
  $customListEmpty.style.display = 'none';

  const li = document.createElement('li');
  li.className = 'track-item';
  li.role = 'listitem';
  li.dataset.trackId = track.id;

  li.innerHTML = `
    <div class="track-info">
      <div class="track-icon track-icon--custom" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.4"/>
        </svg>
      </div>
      <div>
        <span class="track-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</span>
        <span class="track-meta">${formatFileSize(track.size)}</span>
      </div>
    </div>
    <div class="track-actions">
      <span class="track-size-badge">${formatFileSize(track.size)}</span>
      <button
        class="btn-play-track"
        data-action="play"
        aria-label="Play or crossfade ${escapeHtml(track.name)}"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <path d="M2 1.5l9 4.5-9 4.5z"/>
        </svg>
        Crossfade
      </button>
      <button
        class="btn-remove-track"
        data-action="remove"
        aria-label="Remove ${escapeHtml(track.name)} from playlist"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 4h10M6 4V2h4v2M5 4l.5 10M8 4v10M11 4l-.5 10"
            stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  // Bind play button
  li.querySelector('[data-action="play"]').addEventListener('click', () => {
    playTrack(track.id, track.name, track.url);
  });

  // Bind remove button
  li.querySelector('[data-action="remove"]').addEventListener('click', () => {
    removeCustomTrack(track.id);
  });

  $customTrackList.appendChild(li);
}

/**
 * Removes a custom track by ID.
 * Revokes its Blob URL to prevent memory leaks.
 * @param {string} trackId
 */
function removeCustomTrack(trackId) {
  const index = customPlaylist.findIndex((t) => t.id === trackId);
  if (index === -1) return;

  const [removed] = customPlaylist.splice(index, 1);

  // Release the Blob URL
  URL.revokeObjectURL(removed.url);

  // If this was the active track, clear the now-playing display
  if (activeTrackId === trackId) {
    activeTrackId = null;
    setNowPlaying(null);
  }

  // Remove the DOM row
  const $row = $customTrackList.querySelector(`[data-track-id="${trackId}"]`);
  $row?.remove();

  syncCustomPlaylistMeta();
}

/**
 * Clears the entire custom playlist, revoking all Blob URLs.
 */
function clearPlaylist() {
  // Revoke all object URLs before clearing
  for (const track of customPlaylist) {
    URL.revokeObjectURL(track.url);
  }
  customPlaylist = [];

  // If the active track was in the custom list, clear now-playing
  if (activeTrackId?.startsWith('custom-')) {
    activeTrackId = null;
    setNowPlaying(null);
  }

  // Rebuild the list DOM: remove all LI elements except the empty-state
  const rows = $customTrackList.querySelectorAll('.track-item:not(#custom-list-empty)');
  rows.forEach((row) => row.remove());

  syncCustomPlaylistMeta();
}

/**
 * Syncs the track count badge and Clear button enabled state.
 */
function syncCustomPlaylistMeta() {
  const count = customPlaylist.length;
  $customTrackCount.textContent = `${count} track${count !== 1 ? 's' : ''}`;
  $btnClearPlaylist.disabled = count === 0;

  // Show/hide empty state placeholder
  $customListEmpty.style.display = count === 0 ? '' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE TRACK — Crossfade & Highlight Logic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Triggers a procedural synthesised preset via AudioManager.
 *
 * - Fades out any running procedural preset (cross-dissolve).
 * - Calls `audioManager.playProceduralPreset()` with the preset's timbre
 *   type and chord frequencies.
 * - Updates the active-track highlight and now-playing pill.
 * - Guard: engine must be initialised (init() called) but mic is NOT required
 *   — the user can audition synth pads before enabling the mic.
 *
 * @param {{ id: string, name: string, type: string, notes: number[] }} preset
 */
async function playProceduralTrack(preset) {
  // Auto-initialise the AudioContext on first user gesture if needed.
  // Synth pads do NOT require the mic — they only need the audio graph.
  if (!audioManager.ctx) {
    try {
      await audioManager.init();
    } catch (err) {
      console.error('[app] AudioManager init failed:', err);
      showAlert('Could not initialise the audio engine. Please try again.', 'error');
      return;
    }
  }

  // Deactivate previous row highlight
  clearActiveTrackHighlight();

  try {
    await audioManager.playProceduralPreset(preset.type, preset.notes, 2.0);
    webrtcClient.refreshLocalTrack();

    // Update UI
    activeTrackId = preset.id;
    highlightActiveTrack(preset.id);
    setNowPlaying(preset.name);
    updatePlayPauseUI();
  } catch (err) {
    console.error('[app] Procedural preset error:', err);
    showAlert(`Could not start preset "${preset.name}": ${err.message}`, 'error');
  }
}

/**
 * Plays or crossfades to a file-based track by its URL.
 * Used exclusively by the Custom Playlist panel.
 *
 * Before starting file playback, any active procedural synth preset is faded
 * out cleanly to prevent audio layering.
 *
 * @param {string} trackId   - Unique track identifier.
 * @param {string} trackName - Display name for the now-playing indicator.
 * @param {string} url       - Blob URL (custom upload) or CDN link.
 */
async function playTrack(trackId, trackName, url) {
  if (!url) {
    showAlert(`"${trackName}" has no audio file attached.`, 'warn');
    return;
  }

  if (!audioManager.ctx) await audioManager.init();
  if (audioManager.ctx.state === 'suspended') await audioManager.ctx.resume();

  // Fade out any running procedural synth preset before playing a file
  audioManager.stopProceduralPreset(1.5);

  // Deactivate previous track row
  clearActiveTrackHighlight();

  // Crossfade via AudioManager deck engine
  audioManager.crossfadeTo(url);
  webrtcClient.refreshLocalTrack();

  // Mark new active track
  activeTrackId = trackId;
  highlightActiveTrack(trackId);
  setNowPlaying(trackName);
  updatePlayPauseUI();
}

/**
 * Highlights the currently active track row in the DOM.
 * Searches both preset and custom lists.
 * @param {string} trackId
 */
function highlightActiveTrack(trackId) {
  const $row = document.querySelector(`[data-track-id="${trackId}"]`);
  $row?.classList.add('active-track');
}

/**
 * Removes the active-track highlight from all track rows.
 */
function clearActiveTrackHighlight() {
  document.querySelectorAll('.track-item.active-track').forEach((el) => {
    el.classList.remove('active-track');
  });
}

/**
 * Updates the "Now Playing" pill in the Music Deck card header.
 * @param {string|null} trackName - Track name, or null to show idle state.
 */
function setNowPlaying(trackName) {
  if (trackName) {
    $nowPlayingTitle.textContent = trackName;
    $nowPlayingPill.classList.add('is-playing');
    $nowPlayingPill.setAttribute('aria-label', `Now playing: ${trackName}`);
  } else {
    $nowPlayingTitle.textContent = 'No track loaded';
    $nowPlayingPill.classList.remove('is-playing');
    $nowPlayingPill.setAttribute('aria-label', 'No track playing');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM & SESSION CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wires the Room ID input, Join, and Leave buttons to WebRTCClient.
 */
function bindRoomControls() {
  $btnJoin.addEventListener('click', handleJoinRoom);
  $btnLeave.addEventListener('click', handleLeaveRoom);

  // Allow pressing Enter in the Room ID input to join
  $roomIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  });
}

function bindChatVisibility() {
  $btnToggleChat?.addEventListener('click', () => {
    const hidden = !$chatSidebar.hidden;
    $chatSidebar.hidden = hidden;
    $stageGrid.classList.toggle('stage-grid--chat-hidden', hidden);
    $btnToggleChat.setAttribute('aria-pressed', String(hidden));
    $btnToggleChat.setAttribute('aria-label', hidden ? 'Show chat' : 'Hide chat');
    $chatToggleLabel.textContent = hidden ? 'Show Chat' : 'Hide Chat';
  });
}

function bindScreenShare() {
  $btnShareScreen?.addEventListener('click', async () => {
    $btnShareScreen.disabled = true;
    try {
      await webrtcClient.startScreenShare();
    } catch (error) {
      console.warn('[app] Screen sharing could not start:', error);
      if (error.name !== 'NotAllowedError') {
        showAlert('Could not start screen sharing. Check browser permissions and try again.', 'warn');
      }

    } finally {
      $btnShareScreen.disabled = false;
      $btnToggleCamera.disabled = false;
    }
  });
  $btnStopScreenShare?.addEventListener('click', () => webrtcClient.stopScreenShare());
}

function bindCamera() {
  $btnToggleCamera?.addEventListener('click', async () => {
    $btnToggleCamera.disabled = true;
    try {
      if (webrtcClient.cameraActive) {
        webrtcClient.stopCamera();
      } else {
        await webrtcClient.startCamera();
      }
    } catch (error) {
      console.warn('[app] Camera could not start:', error);
      if (error.name !== 'NotAllowedError') {
        showAlert('Could not start the camera. Check camera permission and try again.', 'warn');
      }
    } finally {
      $btnToggleCamera.disabled = !webrtcClient.isActiveParticipant;
    }
  });
}

function bindCaptions() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $btnToggleCaptions.title = 'Captions are not supported by this browser';
    return;
  }
  $btnToggleCaptions.disabled = false;
  $btnToggleCaptions.addEventListener('click', () => {
    if (captionsActive) {
      stopCaptions();
    } else {
      startCaptions(SpeechRecognition);
    }
  });
}

function startCaptions(SpeechRecognition) {
  captionRecognition = new SpeechRecognition();
  captionRecognition.continuous = true;
  captionRecognition.interimResults = true;
  captionRecognition.lang = navigator.language || 'en-US';
  captionRecognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript?.trim();
      if (text) webrtcClient.sendCaption(text, result.isFinal);
    }
  };
  captionRecognition.onerror = (event) => {
    if (event.error !== 'no-speech') {
      showAlert(`Captions stopped: ${event.error}.`, 'warn');
      stopCaptions();
    }
  };
  captionRecognition.onend = () => {
    if (captionsActive) {
      try { captionRecognition.start(); } catch (_) { /* browser is already restarting */ }
    }
  };
  try {
    captionRecognition.start();
    captionsActive = true;
    $btnToggleCaptions.textContent = 'Stop Captions';
    $btnToggleCaptions.setAttribute('aria-pressed', 'true');
    $captionsPanel.hidden = false;
  } catch (error) {
    showAlert('Could not start captions. Check microphone permission.', 'warn');
  }
}

function stopCaptions() {
  captionsActive = false;
  captionRecognition?.stop();
  captionRecognition = null;
  $btnToggleCaptions.textContent = 'Start Captions';
  $btnToggleCaptions.setAttribute('aria-pressed', 'false');
}

function renderCaption(message) {
  if (!message?.text) return;
  $captionsPanel.hidden = false;
  const line = document.createElement('div');
  line.className = 'caption-line';
  const speaker = document.createElement('strong');
  speaker.textContent = message.speaker_name || 'Participant';
  line.append(speaker, document.createTextNode(message.text));
  $captionsFeed.appendChild(line);
  while ($captionsFeed.children.length > 30) $captionsFeed.firstElementChild.remove();
  $captionsFeed.scrollTop = $captionsFeed.scrollHeight;
}

function renderScreenShareTile(peerId, stream, displayName, isLocal) {
  removeScreenShareTile(peerId);
  const tile = document.createElement('div');
  tile.className = 'screen-share-tile';
  tile.dataset.screenPeerId = peerId;

  const label = document.createElement('div');
  label.className = 'screen-share-label';
  label.textContent = `${displayName} is sharing`;

  const video = document.createElement('video');
  video.className = 'screen-share-video';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.srcObject = stream;
  video.play().catch((error) => console.warn('[app] Screen playback was blocked:', error));

  tile.append(label, video);
  $screenShareGrid.appendChild(tile);
  $screenShareGrid.hidden = false;
}

function removeScreenShareTile(peerId) {
  const tile = [...$screenShareGrid.children].find((item) => item.dataset.screenPeerId === peerId);
  if (tile) {
    const video = tile.querySelector('video');
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    tile.remove();
  }
  $screenShareGrid.hidden = $screenShareGrid.childElementCount === 0;
}

/**
 * Handles the "Join Room" action.
 * Validates the Room ID, opens the WebSocket signaling channel,
 * then hands the AudioManager's outgoing stream to WebRTC (if live).
 */
async function handleJoinRoom() {
  if (currentRoomId || webrtcClient.isConnected || webrtcClient.isActiveParticipant) {
    showAlert('You are already in a room. Leave it before joining another call.', 'warn');
    return;
  }
  const roomId = $roomIdInput.value.trim().toLowerCase().replace(/\s+/g, '-');

  // Block if no valid user session exists
  if (!authenticatedUser?.sub && !getUserSession()) {
    pendingRoomId = roomId || null;
    showAlert('Please sign in with Google before joining a room.', 'warn');
    if ($authOverlay) $authOverlay.hidden = false;
    return;
  }

  // Ensure authenticatedUser is populated from sessionStorage if needed
  if (!authenticatedUser?.sub) {
    authenticatedUser = getUserSession();
  }

  if (!roomId) {
    showAlert('Please enter a Room ID before joining.', 'warn');
    $roomIdInput.focus();
    return;
  }

  if (roomId.length < 3) {
    showAlert('Room ID must be at least 3 characters.', 'warn');
    return;
  }

  // Disable controls during connection attempt
  $btnJoin.disabled = true;
  $roomIdInput.disabled = true;
  setConnectionStatus('disconnected', 'Connecting…');

  try {
    // Pass the live AudioManager stream (if available) so WebRTCManager can
    // attach it immediately to any peer connections it creates.
    const userName = ($chatUsername?.value || authenticatedUser.name || authenticatedUser.email || 'Participant').trim();
    if ($chatUsername) $chatUsername.value = userName;
    const joinState = await webrtcClient.join(roomId, audioManager, userName);

    currentRoomId = roomId;
    updateHostControls();

    // Push room to URL for deep linking / sharing
    const roomUrl = new URL(window.location.href);
    roomUrl.searchParams.set('room', roomId);
    window.history.pushState({}, '', `${roomUrl.pathname}${roomUrl.search}${roomUrl.hash}`);

    $btnLeave.disabled = false;

    if (joinState === 'waiting') {
      $waitingRoomStatus.hidden = false;
      $roomModeDisplay.textContent = 'Waiting';
      $btnShare.disabled = true;
      setConnectionStatus('waiting', 'Waiting for host approval');
      return;
    }

    completeRoomJoin();

    console.log(`[app] Joined room: ${roomId}`);
  } catch (err) {
    console.error('[app] Join room failed:', err);
    webrtcClient.leave();
    const roomClosed = err?.message === 'This room is no longer accepting new guests.'
      || err?.message === 'The host left before you were admitted.'
      || err?.message === 'This meeting link is no longer valid.';
    showAlert(
      roomClosed ? err.message : `Could not connect to room "${roomId}". Is the server running?`,
      roomClosed ? 'warn' : 'error',
    );

    // Re-enable controls so the user can retry
    $btnJoin.disabled = false;
    $roomIdInput.disabled = false;
    setConnectionStatus('disconnected', 'Disconnected');
  }
}

function completeRoomJoin() {
  if (!currentRoomId || !webrtcClient.isActiveParticipant) return;
  $waitingRoomStatus.hidden = true;
  $btnLeave.disabled = false;
  $btnShare.disabled = false;
  $chatInput.disabled = false;
  $btnChatSend.disabled = false;
  $btnEmojiPicker.disabled = false;
  $btnShareScreen.disabled = false;
  $btnToggleCaptions.disabled = false;
  $btnToggleCamera.disabled = false;
  $btnRaiseHand.disabled = false;
  $btnReaction.disabled = false;
  $btnRecord.disabled = false;
  $btnCalendar.disabled = false;
  $btnJoin.disabled = true;
  $roomIdInput.disabled = true;
  $roomModeDisplay.textContent = 'Live';
  $signalQuality.textContent = 'Excellent';
  $signalQuality.className = 'stage-info-value stage-info-value--good';
  updateHostControls();
  setConnectionStatus('live', `Live · Connected to Room: ${currentRoomId}`);
}

function renderAdmissionQueue(waitingPeers = webrtcClient.waitingPeers) {
  $admissionList.replaceChildren();
  const isHost = webrtcClient.isHost;
  $admissionPanel.hidden = !isHost || waitingPeers.size === 0;
  if (!isHost) return;

  for (const [peerId, displayName] of waitingPeers) {
    const row = document.createElement('div');
    row.className = 'admission-request';

    const name = document.createElement('span');
    name.className = 'admission-request-name';
    name.textContent = displayName;

    const actions = document.createElement('div');
    actions.className = 'admission-request-actions';
    for (const [label, admit, className] of [
      ['Admit', true, 'btn-primary'],
      ['Deny', false, 'btn-danger'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn ${className}`;
      button.textContent = label;
      button.addEventListener('click', () => {
        webrtcClient.decideAdmission(peerId, admit);
        webrtcClient.waitingPeers.delete(peerId);
        renderAdmissionQueue();
      });
      actions.appendChild(button);
    }

    row.append(name, actions);
    $admissionList.appendChild(row);
  }
}

/**
 * Handles the "Leave Room" action.
 * Closes all peer connections and the signaling WebSocket.
 */
function handleLeaveRoom() {
  stopCaptions();
  webrtcClient.leave();
  $waitingRoomStatus.hidden = true;
  renderAdmissionQueue(new Map());
  $screenShareGrid.replaceChildren();
  $screenShareGrid.hidden = true;
  $btnShareScreen.disabled = true;
  $btnToggleCamera.disabled = true;
  $btnToggleCaptions.disabled = true;
  $btnRaiseHand.disabled = true;
  $btnReaction.disabled = true;
  $btnRecord.disabled = true;
  $btnCalendar.disabled = true;
  $btnMuteEveryone.disabled = true;
  $btnMuteEveryone.hidden = true;
  if (recorder?.state === 'recording') recorder.stop();
  handRaised = false;
  $btnRaiseHand.textContent = 'Raise Hand';
  $btnRaiseHand.setAttribute('aria-pressed', 'false');
  $btnShareScreen.hidden = false;
  $btnStopScreenShare.hidden = true;
  $btnToggleCamera.textContent = 'Enable Camera';
  $btnToggleCamera.setAttribute('aria-pressed', 'false');
  $localCameraVideo.srcObject = null;
  $localCameraVideo.hidden = true;

  // Reset URL
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  if ($btnShare) $btnShare.disabled = true;
  if ($chatInput)   $chatInput.disabled   = true;
  if ($btnChatSend) $btnChatSend.disabled = true;
  if ($btnEmojiPicker) $btnEmojiPicker.disabled = true;
  if ($emojiPicker) $emojiPicker.hidden = true;
  $btnEmojiPicker?.setAttribute('aria-expanded', 'false');

  currentRoomId = null;

  // Remove all dynamically added remote peer cards
  for (const [peerId] of peerElements) {
    removePeerCard(peerId);
  }

  setConnectionStatus('disconnected', 'Disconnected');
  $roomModeDisplay.textContent = 'Lobby';
  $signalQuality.textContent   = 'Good';
  $signalQuality.className     = 'stage-info-value';

  $btnJoin.disabled  = false;
  $btnLeave.disabled = true;
  $roomIdInput.disabled = false;
  updatePeerCountBadge();
  updateHostControls();

  console.log('[app] Left room.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PEER GRID — Dynamic Attendee Cards
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The peer grid container — reference pulled once for DOM manipulation.
 * @type {HTMLElement}
 */
const $peerGrid = document.getElementById('peer-grid');

/**
 * Adds a remote peer card to the meeting stage peer grid.
 * Called by webrtcClient.onPeerJoined when a remote MediaStream arrives.
 *
 * @param {string}      peerId - The remote peer's ID (assigned by the server).
 * @param {MediaStream} stream - The remote peer's audio/video MediaStream.
 */
function addPeerCard(peerId, stream, displayName = webrtcClient.getPeerName(peerId)) {
  if (peerElements.has(peerId)) {
    updatePeerMedia(peerId, stream);
    return;
  }

  // Build the peer card element
  const li = document.createElement('div');
  li.className = 'peer-card peer-card--remote';
  li.setAttribute('role', 'listitem');
  li.dataset.peerId = peerId;

  const shortId = peerId.slice(0, 8);
  const safeName = escapeHtml(displayName || 'Guest');

  li.innerHTML = `
    <div class="peer-avatar" aria-hidden="true">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="12" r="6" fill="#38bdf8" opacity="0.6"/>
        <path d="M4 28c0-6.627 5.373-12 12-12s12 5.373 12 12"
          stroke="#38bdf8" stroke-width="1.5" fill="none" opacity="0.4"/>
      </svg>
    </div>
    <div class="peer-info">
      <span class="peer-name" title="${safeName}">${safeName}</span>
      <span class="peer-role" style="color: var(--emerald)">Attendee</span>
    </div>
    <video class="peer-video" autoplay playsinline hidden></video>
    <div class="peer-indicators" aria-hidden="true">
      <div class="speaking-ring speaking-ring--inactive" id="ring-${peerId}"></div>
      <div class="peer-mic-icon">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="1" width="6" height="9" rx="3" stroke="currentColor" stroke-width="1.4"/>
          <path d="M3 8c0 2.76 2.24 5 5 5s5-2.24 5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <line x1="8" y1="13" x2="8" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </div>
    </div>
  `;

  $peerGrid.appendChild(li);
  peerElements.set(peerId, li);
  renderPeerModerationControls(li, peerId);
  updatePeerCountBadge();

  console.log(`[app] Peer card added: ${peerId}`);
  updatePeerMedia(peerId, stream);
}

function updatePeerMedia(peerId, stream) {
  const card = peerElements.get(peerId);
  if (!card || !stream) return;
  const video = card.querySelector('.peer-video');
  const hasVideo = stream.getVideoTracks().length > 0;
  if (video && hasVideo) {
    video.srcObject = stream;
    video.hidden = false;
    video.play().catch(() => {});
  }
}

/**
 * Removes a remote peer card from the meeting stage grid.
 * Called by webrtcClient.onPeerLeft.
 *
 * @param {string} peerId - The peer ID to remove.
 */
function removePeerCard(peerId) {
  const $card = peerElements.get(peerId);
  if (!$card) return;
  peerConnectionStates.delete(peerId);

  // Stop the audio element to release resources
  const $audio = $card.querySelector('audio');
  if ($audio) { $audio.pause(); $audio.srcObject = null; }
  const $video = $card.querySelector('video');
  if ($video) { $video.pause(); $video.srcObject = null; }

  $card.remove();
  peerElements.delete(peerId);
  updatePeerCountBadge();

  console.log(`[app] Peer card removed: ${peerId}`);
}

/**
 * Syncs the peer count badge and participant count display.
 */
function updatePeerCountBadge() {
  const count = webrtcClient.peerCount;
  const total = count + 1; // +1 for self
  $peerCountBadge.textContent   = `${count} connected`;
  $participantCount.textContent = String(total);
}

function updateHostControls() {
  const isInRoom = Boolean(currentRoomId && webrtcClient.isActiveParticipant);
  const isHost = isInRoom && webrtcClient.isHost;
  if ($btnMuteEveryone) {
    $btnMuteEveryone.hidden = !isHost;
    $btnMuteEveryone.disabled = !isHost;
  }
  if ($localPeerName) $localPeerName.textContent = webrtcClient.userName || 'You';
  if ($localPeerRole) {
    $localPeerRole.textContent = isInRoom
      ? (isHost ? 'Host · You' : 'Participant · You')
      : 'Not in a room';
  }

  for (const [peerId, card] of peerElements) {
    renderPeerModerationControls(card, peerId);
  }
}

function updatePeerDisplayName(peerId, displayName) {
  const name = String(displayName || 'Guest').trim() || 'Guest';
  if (peerId === webrtcClient.clientId) {
    if ($localPeerName) $localPeerName.textContent = name;
    if ($chatUsername && document.activeElement !== $chatUsername) {
      $chatUsername.value = name;
    }
    return;
  }
  const card = peerElements.get(peerId);
  const nameElement = card?.querySelector('.peer-name');
  if (nameElement) {
    nameElement.textContent = name;
    nameElement.title = name;
  }
}

function updatePeerModerationControls(peerId) {
  const card = peerElements.get(peerId);
  if (card) renderPeerModerationControls(card, peerId);
}

function updatePeerConnectionState(peerId, state) {
  peerConnectionStates.set(peerId, state);
  const card = peerElements.get(peerId);
  if (!card) return;
  card.classList.toggle('peer-card--reconnecting', state === 'disconnected' || state === 'checking');
  card.classList.toggle('peer-card--connection-failed', state === 'failed');
  const role = card.querySelector('.peer-role');
  if (role) {
    role.textContent = state === 'failed'
      ? 'Connection failed'
      : state === 'disconnected' || state === 'checking'
        ? 'Reconnecting…'
        : webrtcClient.isPeerMuted(peerId) ? 'Attendee · Muted' : 'Attendee';
  }
}

function renderPeerModerationControls(card, peerId) {
  let controls = card.querySelector('.peer-moderation-controls');
  if (!webrtcClient.isHost) {
    controls?.remove();
    return;
  }

  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'peer-moderation-controls';
    const muteButton = document.createElement('button');
    muteButton.type = 'button';
    muteButton.className = 'peer-moderation-btn';
    muteButton.dataset.action = 'mute';
    muteButton.addEventListener('click', () => {
      webrtcClient.setPeerMuted(peerId, !webrtcClient.isPeerMuted(peerId));
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'peer-moderation-btn peer-moderation-btn--remove';
    removeButton.textContent = 'Remove';
    removeButton.setAttribute('aria-label', `Remove participant ${peerId.slice(0, 8)}`);
    removeButton.addEventListener('click', () => {
      if (window.confirm(`Remove participant ${peerId.slice(0, 8)} from this room?`)) {
        webrtcClient.removePeer(peerId);
      }
    });

    controls.append(muteButton, removeButton);
    card.appendChild(controls);
  }

  const muted = webrtcClient.isPeerMuted(peerId);
  const muteButton = controls.querySelector('[data-action="mute"]');
  card.classList.toggle('peer-card--muted', muted);
  updatePeerConnectionState(peerId, peerConnectionStates.get(peerId) ?? 'connected');
  muteButton.textContent = muted ? 'Unmute' : 'Mute';
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} participant ${peerId.slice(0, 8)}`);
}

/**
 * Updates the connection status badge appearance and text.
 * @param {'live'|'disconnected'} status
 * @param {string} label
 */
function setConnectionStatus(status, label) {
  $connectionStatus.className = `status-badge status-${status}`;
  $statusText.textContent = label;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FOOTER METRICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Updates the footer metrics bar with current AudioContext diagnostics.
 * Called on engine start/stop and periodically via the render loop.
 */
function updateFooterMetrics() {
  const ctx = audioManager.context;

  if (ctx) {
    $metricSampleRate.textContent = `${ctx.sampleRate.toLocaleString()} Hz`;
    $metricLatency.textContent    = ctx.baseLatency != null
      ? `${(ctx.baseLatency * 1000).toFixed(1)} ms`
      : 'N/A';
    $metricOutput.textContent     = 'MediaStream + Local Monitor';
    $metricEngine.textContent     = isEngineActive ? 'Running' : 'Idle';
  } else {
    $metricSampleRate.textContent = '—';
    $metricLatency.textContent    = '—';
    $metricOutput.textContent     = '—';
    $metricEngine.textContent     = 'Idle';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Strips the file extension from a filename for display purposes.
 * @param {string} filename - e.g. "worship-pad-c.mp3"
 * @returns {string} e.g. "worship-pad-c"
 */
function stripExtension(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

/**
 * Formats a file size in bytes to a human-readable string.
 * @param {number} bytes
 * @returns {string} e.g. "4.2 MB"
 */
function formatFileSize(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Escapes HTML special characters to prevent XSS in dynamic innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/**
 * Displays a transient alert banner in the UI.
 * Auto-dismisses after 4 seconds.
 *
 * @param {string} message  - Message to display.
 * @param {'info'|'warn'|'error'} [type='info'] - Alert severity.
 */
function showAlert(message, type = 'info') {
  // Remove any existing alert
  document.getElementById('app-alert')?.remove();

  const $alert = document.createElement('div');
  $alert.id = 'app-alert';
  $alert.className = `app-alert app-alert--${type}`;
  $alert.setAttribute('role', 'alert');
  $alert.setAttribute('aria-live', 'assertive');

  $alert.innerHTML = `
    <span class="app-alert-msg">${escapeHtml(message)}</span>
    <button class="app-alert-close" aria-label="Dismiss alert">×</button>
  `;

  $alert.querySelector('.app-alert-close').addEventListener('click', () => $alert.remove());

  document.body.appendChild($alert);

  // Auto-dismiss
  setTimeout(() => $alert.remove(), 4500);
}

// ── Alert Styles (injected once, avoids needing stylesheet changes in Phase 4) ─
(function injectAlertStyles() {
  if (document.getElementById('app-alert-styles')) return;
  const style = document.createElement('style');
  style.id = 'app-alert-styles';
  style.textContent = `
    .app-alert {
      position: fixed;
      bottom: calc(var(--footer-h, 42px) + 12px);
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-radius: 10px;
      font-family: var(--font-ui, sans-serif);
      font-size: 0.8125rem;
      font-weight: 500;
      border: 1px solid transparent;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      z-index: 9999;
      max-width: 480px;
      animation: alertSlideUp 0.25s ease;
    }
    @keyframes alertSlideUp {
      from { opacity: 0; transform: translateX(-50%) translateY(12px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    .app-alert--info  { background: #1e293b; color: #38bdf8; border-color: rgba(56,189,248,0.25); }
    .app-alert--warn  { background: #1e2010; color: #f59e0b; border-color: rgba(245,158,11,0.3); }
    .app-alert--error { background: #200f0f; color: #ef4444; border-color: rgba(239,68,68,0.3); }
    .app-alert-close  {
      background: none; border: none; color: inherit; cursor: pointer;
      font-size: 1.1rem; line-height: 1; opacity: 0.7; padding: 0 2px;
      flex-shrink: 0;
    }
    .app-alert-close:hover { opacity: 1; }
    .app-alert-msg { flex: 1; line-height: 1.4; }
  `;
  document.head.appendChild(style);
}());

/**
 * Binds the chat interface:
 * - Enter key to send
 * - Send button click
 * - Emoji selector (Phase 6 upgrade)
 * - Incoming message rendering
 */
function bindChat() {
  const updateName = () => {
    if (!webrtcClient.isConnected) return;
    const name = $chatUsername.value.trim();
    if (name) webrtcClient.setDisplayName(name);
  };

  $chatUsername?.addEventListener('change', updateName);
  $chatUsername?.addEventListener('blur', updateName);

  const sendMessage = () => {
    const text = $chatInput.value.trim();
    if (!text || !webrtcClient.isConnected) return;

    webrtcClient.sendChat(text);
    $chatInput.value = '';
    $chatInput.focus();
  };

  $btnChatSend.addEventListener('click', sendMessage);
  $chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // Handle incoming messages
  webrtcClient.onChatMessage = (msg) => {
    renderChatMessage(msg);
    $chatMessages.scrollTop = $chatMessages.scrollHeight;
  };

  $btnEmojiPicker?.addEventListener('click', () => {
    const isOpen = $btnEmojiPicker.getAttribute('aria-expanded') === 'true';
    $btnEmojiPicker.setAttribute('aria-expanded', String(!isOpen));
    $emojiPicker.hidden = isOpen;
  });

  $emojiPicker?.addEventListener('click', (event) => {
    const button = event.target.closest('.emoji-option');
    if (!button) return;

    const start = $chatInput.selectionStart ?? $chatInput.value.length;
    const end = $chatInput.selectionEnd ?? start;
    $chatInput.setRangeText(button.textContent, start, end, 'end');
    $chatInput.focus();
    $emojiPicker.hidden = true;
    $btnEmojiPicker.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('click', (event) => {
    if (!$emojiPicker?.contains(event.target) && !$btnEmojiPicker?.contains(event.target)) {
      $emojiPicker.hidden = true;
      $btnEmojiPicker?.setAttribute('aria-expanded', 'false');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $emojiPicker && !$emojiPicker.hidden) {
      $emojiPicker.hidden = true;
      $btnEmojiPicker?.setAttribute('aria-expanded', 'false');
      $btnEmojiPicker?.focus();
    }
  });
}

/**
 * Renders a chat message into the feed.
 * @param {object} msg { sender_name, text, timestamp, sender_id }
 */
function renderChatMessage(msg) {
  // Remove empty state
  const $empty = $chatMessages.querySelector('.chat-empty');
  if ($empty) $empty.remove();

  const isMe = msg.sender_id === webrtcClient.clientId;
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  const div = document.createElement('div');
  div.className = `chat-bubble ${isMe ? 'chat-bubble--self' : 'chat-bubble--remote'}`;

  div.innerHTML = `
    <div class="chat-bubble-meta">
      <span class="chat-bubble-name">${escapeHtml(msg.sender_name || 'Guest')}</span>
      <span class="chat-bubble-time">${time}</span>
    </div>
    <div class="chat-bubble-text">${escapeHtml(String(msg.text ?? ''))}</div>
  `;

  $chatMessages.appendChild(div);
  $chatMessages.scrollTop = $chatMessages.scrollHeight;
}

function getMeetingShareUrl() {
  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('room', currentRoomId);
  return url.toString();
}

function closeShareMenu() {
  $shareOptions.hidden = true;
  $btnShare.setAttribute('aria-expanded', 'false');
}

function bindShareMenu() {
  $btnShare.addEventListener('click', () => {
    if (!currentRoomId) return;
    const shareUrl = getMeetingShareUrl();
    const message = `Join my Worship Room: ${shareUrl}`;
    $shareWhatsapp.href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    $shareEmail.href = `mailto:?subject=${encodeURIComponent('Join my Worship Room')}&body=${encodeURIComponent(message)}`;
    $shareNative.hidden = typeof navigator.share !== 'function';
    $shareOptions.hidden = !$shareOptions.hidden;
    $btnShare.setAttribute('aria-expanded', String(!$shareOptions.hidden));
  });

  $shareNative.addEventListener('click', async () => {
    try {
      await navigator.share({
        title: 'Join my Worship Room',
        text: 'Join my Worship Room',
        url: getMeetingShareUrl(),
      });
      closeShareMenu();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('[app] Native share failed:', error);
        showAlert('Could not open the sharing options.', 'warn');
      }
    }
  });

  $btnCopyLink.addEventListener('click', async () => {
    try {
      const shareUrl = getMeetingShareUrl();
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(shareUrl);
          copied = true;
        } catch (_) {
          // Fall back when clipboard permissions are unavailable.
        }
      }

      if (!copied) {
        const $copyField = document.createElement('textarea');
        $copyField.value = shareUrl;
        $copyField.setAttribute('readonly', '');
        $copyField.style.position = 'fixed';
        $copyField.style.opacity = '0';
        document.body.appendChild($copyField);
        $copyField.select();
        copied = document.execCommand('copy');
        $copyField.remove();
        if (!copied) throw new Error('Clipboard copy command failed');
      }

      // Visual feedback
      closeShareMenu();
      showAlert('Meeting link copied to clipboard!', 'info');
    } catch (err) {
      console.error('[app] Copy failed:', err);
      showAlert('Failed to copy link. Please copy the URL manually.', 'warn');
    }
  });

  $btnInviteEmail?.addEventListener('click', () => {
    const recipient = $shareEmailAddress.value.trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      showAlert('Enter a valid email address first.', 'warn');
      $shareEmailAddress.focus();
      return;
    }
    const message = `Join my Worship Room: ${getMeetingShareUrl()}`;
    window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent('Join my Worship Room')}&body=${encodeURIComponent(message)}`;
    closeShareMenu();
  });

  document.addEventListener('click', (event) => {
    if (!$shareOptions.hidden && !event.target.closest('.share-menu')) closeShareMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeShareMenu();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', bootstrap);

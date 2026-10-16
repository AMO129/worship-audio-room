/**
 * @file AudioManager.js
 * @description Core DSP module for Worship Audio Room.
 *
 * Responsibilities:
 *  - Manages the Web Audio API AudioContext and node graph.
 *  - Implements the 3-state FSM ducking engine:
 *      SWELL (~80%), CONVERSATIONAL (~20%), CLIMAX (~40%)
 *  - Applies anti-jitter hysteresis for Climax state transitions.
 *  - Runs the Deck Engine for equal-power crossfading between pads/songs.
 *  - Exposes gain transitions via native Web Audio scheduling
 *    (setTargetAtTime, linearRampToValueAtTime) — never setInterval.
 *
 * FSM State Thresholds:
 *  - Climax entry:  voice RMS > -16 dBFS
 *  - Climax exit:   voice RMS < -22 dBFS  (hysteresis gap = 6 dB)
 *  - Hold time:     2000 ms before swelling back
 *  - Attack time:   300 ms into speech detection
 *  - Release time:  1500 ms into ambient swell
 *
 * Voice Isolation Filter:
 *  - Bandpass: 200 Hz – 3500 Hz (speech fundamentals)
 *
 * @module AudioManager
 */

// ─── DSP Constants ────────────────────────────────────────────────────────────

/** Gain levels per FSM state (linear 0–1) */
const GAIN_LEVELS = {
  SWELL:          0.80,   // Ambient music at ~80%
  CONVERSATIONAL: 0.20,   // Background bed at ~20%
  CLIMAX:         0.40,   // Supportive drive at ~40%
};

/** Climax entry RMS threshold in dBFS (-16 dB → linear) */
const CLIMAX_ENTRY_DB  = -16;
const CLIMAX_EXIT_DB   = -22;   // Hysteresis: exit at -22 dB

/** Timing constants (seconds) */
const HOLD_TIME_S    = 2.0;
const ATTACK_TIME_S  = 0.3;
const RELEASE_TIME_S = 1.5;

/** Voice isolation bandpass range (Hz) */
const BP_FREQ_LOW  = 200;
const BP_FREQ_HIGH = 3500;

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Converts a dBFS value to a linear gain scalar.
 * @param {number} db - Value in decibels (e.g., -16).
 * @returns {number} Linear gain (0.0 – 1.0+).
 */
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// ─── AudioManager Class ───────────────────────────────────────────────────────

/**
 * @class AudioManager
 * Central audio processing hub. Instantiate once per session.
 */
export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;

    // ── FSM State ──────────────────────────────────────────────────────────
    /** @type {'SWELL'|'CONVERSATIONAL'|'CLIMAX'} */
    this._state = 'SWELL';
    this._holdTimer = null;

    // ── Audio Nodes ────────────────────────────────────────────────────────
    /** Master gain for the music/pad bus */
    this._musicGain   = null;
    /** Bandpass filter on the microphone input for voice isolation */
    this._voiceBPF    = null;
    /** AnalyserNode for voice RMS metering */
    this._voiceAnalyser = null;

    // ── Deck Engine ────────────────────────────────────────────────────────
    /** @type {AudioBufferSourceNode|null} Active deck source */
    this._deckA = null;
    /** @type {AudioBufferSourceNode|null} Cross-fade target */
    this._deckB = null;
    /** @type {GainNode|null} */
    this._deckAGain = null;
    /** @type {GainNode|null} */
    this._deckBGain = null;

    // ── Analysis Buffer ────────────────────────────────────────────────────
    this._fftBuffer = null;
    this._rafId = null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialises the AudioContext and builds the node graph.
   * Must be called from a user-gesture handler (click/keydown).
   * @returns {Promise<void>}
   */
  async init() {
    // TODO (Phase 2): Implement AudioContext creation and node graph wiring.
    console.log('[AudioManager] init() — stub. Phase 2 implementation pending.');
  }

  /**
   * Attaches a MediaStream (microphone) to the voice-analysis chain.
   * @param {MediaStream} stream
   */
  attachMicStream(stream) {
    // TODO (Phase 2): Create MediaStreamSourceNode → BPF → AnalyserNode chain.
    console.log('[AudioManager] attachMicStream() — stub.');
  }

  /**
   * Tears down the AudioContext and stops all sources.
   */
  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
    this.ctx = null;
    console.log('[AudioManager] Destroyed.');
  }

  // ─── FSM Ducking Engine ────────────────────────────────────────────────────

  /**
   * Starts the real-time voice RMS polling loop.
   * Uses requestAnimationFrame for frame-aligned analysis.
   * @private
   */
  _startAnalysisLoop() {
    // TODO (Phase 2): Implement RMS calculation and FSM transition logic.
    console.log('[AudioManager] _startAnalysisLoop() — stub.');
  }

  /**
   * Computes the RMS level of the voice analyser's time-domain buffer.
   * @returns {number} RMS value in dBFS.
   * @private
   */
  _getVoiceRmsDb() {
    // TODO (Phase 2): Implement FFT/time-domain RMS computation.
    return -60; // placeholder silence
  }

  /**
   * Transitions the FSM to a new state and schedules gain ramps.
   * @param {'SWELL'|'CONVERSATIONAL'|'CLIMAX'} newState
   * @private
   */
  _transitionTo(newState) {
    if (newState === this._state) return;
    console.log(`[AudioManager] FSM: ${this._state} → ${newState}`);
    this._state = newState;
    // TODO (Phase 2): Schedule gain ramps via setTargetAtTime.
  }

  // ─── Deck Engine ───────────────────────────────────────────────────────────

  /**
   * Loads an audio buffer from a URL for use in the deck engine.
   * @param {string} url - URL to the audio asset.
   * @returns {Promise<AudioBuffer>}
   */
  async loadBuffer(url) {
    // TODO (Phase 2): Implement fetch → decodeAudioData pipeline.
    console.log(`[AudioManager] loadBuffer(${url}) — stub.`);
    return null;
  }

  /**
   * Crossfades from the currently playing deck to a new AudioBuffer.
   * Uses equal-power crossfade math: sin/cos curves.
   * @param {AudioBuffer} buffer - The next pad or song buffer.
   * @param {number} [fadeDuration=3.0] - Crossfade duration in seconds.
   */
  crossfadeTo(buffer, fadeDuration = 3.0) {
    // TODO (Phase 2): Implement equal-power crossfade with deck A/B switching.
    console.log('[AudioManager] crossfadeTo() — stub.');
  }

  // ─── Public Getters ────────────────────────────────────────────────────────

  /** @returns {'SWELL'|'CONVERSATIONAL'|'CLIMAX'} Current FSM state */
  get state() { return this._state; }

  /** @returns {AudioContext|null} */
  get context() { return this.ctx; }
}

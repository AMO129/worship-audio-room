/**
 * @file AudioManager.js
 * @description Production-grade DSP engine for Worship Audio Room.
 *
 * ── Audio Node Graph ──────────────────────────────────────────────────────────
 *
 *  Microphone (getUserMedia)
 *    │
 *    ├──► BiquadFilterNode (Bandpass 1850 Hz, Q=0.7)
 *    │         │
 *    │         └──► AnalyserNode (fftSize=512, smoothing=0.4) ◄── RMS loop
 *    │                                                              │
 *    │                                                         FSM engine
 *    │                                                              │
 *    └──► [raw]──► destinationNode (MediaStreamDestination)         │
 *                        ▲                               masterMusicGain.gain
 *                        │                                          │
 *  playerA ──► gainNodeA ─┤                                         │
 *  playerB ──► gainNodeB ─┘──► masterMusicGain ──► ctx.destination  │
 *                                                (local monitor)    │
 *                              └──────────────────────────────── set by FSM
 *
 * ── FSM State Machine ─────────────────────────────────────────────────────────
 *
 *  SWELL (80%)  ◄──── silence ≥ 2.0s ──────────────────────┐
 *      │                                                    │
 *      └──► voice > -40 dB ──► CONVERSATIONAL (20%) ────────┤
 *                                    │                      │
 *                                    └──► voice > -16 dB ──► CLIMAX (40%)
 *                                              │ (hysteresis)
 *                                    voice < -22 dB ──────► CONVERSATIONAL
 *
 * @module AudioManager
 */

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS — Engine State Enum
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Finite-state machine state identifiers for the ducking engine.
 * @enum {string}
 */
export const EngineState = Object.freeze({
  /** Full ambient music bed (~80% gain). No voice detected. */
  SWELL:          'SWELL',
  /** Background bed during speech (~20% gain). Voice below -16 dBFS. */
  CONVERSATIONAL: 'CONVERSATIONAL',
  /** Supportive drive during intense speech (~40% gain). Voice above -16 dBFS. */
  CLIMAX:         'CLIMAX',
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Converts a dBFS value to a linear gain scalar.
 * @param {number} db
 * @returns {number}
 */
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

/**
 * Computes RMS from a Float32Array PCM time-domain buffer.
 * Returns -Infinity if the buffer is silent.
 * @param {Float32Array} buffer
 * @returns {number} RMS level in dBFS
 */
function computeRmsDb(buffer) {
  let sumSq = 0;
  for (let i = 0; i < buffer.length; i++) {
    sumSq += buffer[i] * buffer[i];
  }
  const rms = Math.sqrt(sumSq / buffer.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AudioManager CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @class AudioManager
 *
 * Central audio processing hub for Worship Audio Room.
 * Manages mic ingestion, voice-isolation DSP chain, 3-state FSM ducking,
 * the equal-power crossfading deck engine, and the procedural synth bus.
 *
 * Usage:
 *   const am = new AudioManager();
 *   await am.init();           // unlock AudioContext (call from user gesture)
 *   await am.attachMicrophone();
 *   am.crossfadeTo('/assets/pads/pad-a.mp3');   // file-based deck
 *   am.playProceduralPreset('pad', [130.81, 196, 261.63, 329.63]); // synth
 *   am.onStateChange = (state, db) => updateUI(state, db);
 */
export class AudioManager {

  // ─── Constructor ─────────────────────────────────────────────────────────────

  constructor() {

    // ── AudioContext ──────────────────────────────────────────────────────────
    /** @type {AudioContext|null} */
    this.ctx = null;

    // ── Output destinations ───────────────────────────────────────────────────
    /** MediaStreamDestination — carries outgoing mix (music + voice) for WebRTC */
    this._destinationNode = null;
    /**
     * FSM-controlled music bus gain (values: 0.20 / 0.40 / 0.80).
     * The FSM writes to this node exclusively.
     */
    this._masterMusicGain = null;
    /**
     * User-facing master volume node — sits downstream of _masterMusicGain.
     * Controlled by setMasterGain() / the Master Gain slider.
     * Default: 1.0 (full pass-through).
     */
    this._masterVolumeGain = null;
    this._voiceOutputGain = null;
    this._duckingEnabled = true;

    /** Last computed RMS level in dBFS. Exposed via getCurrentDecibels(). */
    this._currentDb = -Infinity;

    // ── Deck Engine — dual HTML audio element players ─────────────────────────
    /** @type {HTMLAudioElement} */ this._playerA = null;
    /** @type {HTMLAudioElement} */ this._playerB = null;
    /** @type {GainNode} */        this._gainNodeA = null;
    /** @type {GainNode} */        this._gainNodeB = null;
    /** Tracks which deck is currently active ('A' | 'B') */
    this._activeDeck = 'A';

    // ── Microphone / Voice DSP chain ──────────────────────────────────────────
    /** @type {MediaStream|null} */          this._micStream = null;
    /** @type {MediaStreamAudioSourceNode|null} */ this._micSource = null;
    /** @type {BiquadFilterNode|null} */     this._voiceBPF = null;
    /** @type {AnalyserNode|null} */         this._voiceAnalyser = null;
    /** Reusable time-domain sample buffer */
    this._timeDomainBuffer = null;

    /** @type {boolean} Track playback state of music (decks + synth) */
    this._isMusicPlaying = false;

    // ── FSM State ─────────────────────────────────────────────────────────────
    /** @type {string} */ this._state = EngineState.SWELL;
    /** Timestamp (ms) when silence began; null if currently speaking */
    this._silenceStart = null;
    /** RAF handle for the analysis loop */
    this._rafId = null;

    // ── DSP Parameters (tuneable) ─────────────────────────────────────────────
    /**
     * Minimum voice level to trigger CONVERSATIONAL (dBFS).
     * Signals below this are treated as silence.
     */
    this.SPEECH_THRESHOLD = -40;

    /**
     * Hysteresis upper bound — voice above this enters CLIMAX (dBFS).
     */
    this.CLIMAX_UPPER = -16;

    /**
     * Hysteresis lower bound — voice below this exits CLIMAX (dBFS).
     */
    this.CLIMAX_LOWER = -22;

    /** Target gain for SWELL state (linear 0–1) */
    this.VOL_SWELL          = 0.80;
    /** Target gain for CONVERSATIONAL state */
    this.VOL_CONVERSATIONAL = 0.20;
    /** Target gain for CLIMAX state */
    this.VOL_CLIMAX         = 0.40;

    /**
     * Duration of silence (ms) before transitioning back to SWELL.
     */
    this.HOLD_TIME_MS = 2000;

    // ── Callbacks / Event Hooks ───────────────────────────────────────────────
    /**
     * Called on every analysis frame with the current FSM state and RMS level.
     * @type {((state: string, db: number) => void) | null}
     *
     * @example
     * am.onStateChange = (state, db) => {
     *   badge.textContent = state;
     *   meter.value = db;
     * };
     */
    this.onStateChange = null;

    /**
     * Called any time the FSM transitions to a new state.
     * @type {((newState: string, prevState: string) => void) | null}
     */
    this.onTransition = null;

    // ── Procedural Synth Bus ──────────────────────────────────────────────────
    /**
     * Master gain node for the procedural synth bus.
     * Sits in parallel with the deck engine, both feeding into _masterMusicGain.
     * Initialised to 0 (silent) — ramped up by playProceduralPreset().
     * @type {GainNode|null}
     */
    this.synthGain = null;

    /**
     * All active oscillator, filter, and LFO nodes for the current procedural
     * preset. Cleared and recreated on each playProceduralPreset() call.
     * @type {AudioNode[]}
     */
    this.synthNodes = [];
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Creates the AudioContext and builds the static node graph.
   * **Must be called from a user-gesture handler** (browser autoplay policy).
   *
   * @returns {Promise<void>}
   */
  async init() {
    if (this.ctx) return; // idempotent

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // ── Build music bus ───────────────────────────────────────────────────────
    // Node chain:
    //   deckA/B gainNodes → _masterMusicGain (FSM duck) → _masterVolumeGain (user) → destinations

    // FSM duck layer — values written by _updateFSM()
    this._masterMusicGain = this.ctx.createGain();
    this._masterMusicGain.gain.value = this.VOL_SWELL; // initial: SWELL = 80%

    // User volume layer — controlled by setMasterGain() slider
    this._masterVolumeGain = this.ctx.createGain();
    this._masterVolumeGain.gain.value = 1.0; // pass-through by default

    // Connect FSM layer → volume layer
    this._masterMusicGain.connect(this._masterVolumeGain);

    // Connect volume layer → output destinations
    this._destinationNode = this.ctx.createMediaStreamDestination();
    this._masterVolumeGain.connect(this.ctx.destination);
    this._masterVolumeGain.connect(this._destinationNode);
    this._voiceOutputGain = this.ctx.createGain();
    this._voiceOutputGain.gain.value = 1;
    this._voiceOutputGain.connect(this._destinationNode);

    // ── Build dual-deck gain nodes ────────────────────────────────────────────
    this._gainNodeA = this.ctx.createGain();
    this._gainNodeA.gain.value = 0; // silent until first crossfade
    this._gainNodeA.connect(this._masterMusicGain);

    this._gainNodeB = this.ctx.createGain();
    this._gainNodeB.gain.value = 0;
    this._gainNodeB.connect(this._masterMusicGain);

    // ── Build procedural synth bus ────────────────────────────────────────────
    // Sits in parallel with the deck engine; both merge at _masterMusicGain
    // so the FSM ducking sidechain governs all music sources uniformly.
    this.synthGain = this.ctx.createGain();
    this.synthGain.gain.setValueAtTime(0, this.ctx.currentTime); // muted until preset is loaded
    this.synthGain.connect(this._masterMusicGain);

    // ── Create HTML audio elements for deck playback ───────────────────────────
    this._playerA = this._createAudioElement();
    this._playerB = this._createAudioElement();

    console.log('[AudioManager] Initialised. AudioContext state:', this.ctx.state);
  }

  /**
   * Global Pause: Stops the deck players and mutes the synth bus.
   */
  pauseMusic() {
    if (!this.ctx) return;
    this._isMusicPlaying = false;

    // Pause decks
    this._playerA.pause();
    this._playerB.pause();

    // Mute synth (we don't stop oscillators to allow "resume" if we wanted,
    // but here we might just ramp gain to 0).
    const now = this.ctx.currentTime;
    this.synthGain.gain.cancelScheduledValues(now);
    this.synthGain.gain.setTargetAtTime(0, now, 0.1);

    console.log('[AudioManager] Music paused.');
  }

  /**
   * Global Resume: Starts the active deck player and restores synth bus gain.
   */
  resumeMusic() {
    if (!this.ctx) return Promise.resolve();

    return (async () => {
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      const activePlayer = this._activeDeck === 'A' ? this._playerA : this._playerB;
      if (activePlayer.src) await activePlayer.play();

      if (this.synthNodes.length > 0) {
        const now = this.ctx.currentTime;
        this.synthGain.gain.cancelScheduledValues(now);
        this.synthGain.gain.setTargetAtTime(1.0, now, 0.02);
      }

      this._isMusicPlaying = true;
      console.log('[AudioManager] Music resumed.');
    })();
  }

  /** Stop microphone capture and analysis without interrupting music playback. */
  detachMicrophone() {
    this._stopAnalysisLoop();
    this._micSource?.disconnect();
    this._voiceBPF?.disconnect();
    this._voiceAnalyser?.disconnect();
    this._voiceOutputGain?.disconnect();
    this._micSource = null;
    this._voiceBPF = null;
    this._voiceAnalyser = null;
    this._timeDomainBuffer = null;

    if (this._micStream) {
      this._micStream.getTracks().forEach((track) => track.stop());
      this._micStream = null;
    }

    this._currentDb = -Infinity;
    this._silenceStart = null;
    if (this.ctx && this._masterMusicGain) {
      const previousState = this._state;
      this._state = EngineState.SWELL;
      this._masterMusicGain.gain.setTargetAtTime(
        this.VOL_SWELL,
        this.ctx.currentTime,
        0.02,
      );
      if (previousState !== EngineState.SWELL) {
        this.onTransition?.(EngineState.SWELL, previousState);
      }
      this.onStateChange?.(EngineState.SWELL, -Infinity);
    }
  }

  /**
   * Tears down all audio nodes, stops the analysis loop, and releases resources.
   */
  destroy() {
    this._stopAnalysisLoop();

    // Stop procedural synth immediately (no fade — context is closing)
    for (const node of this.synthNodes) {
      try { node.stop?.(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    }
    this.synthNodes = [];

    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }

    [this._playerA, this._playerB].forEach(p => {
      if (p) { p.pause(); p.src = ''; }
    });

    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }

    this.ctx = null;
    console.log('[AudioManager] Destroyed.');
  }

  // ─── Microphone Ingestion & Voice DSP Chain ───────────────────────────────────

  /**
   * Requests microphone access and wires up the voice-isolation DSP chain.
   *
   * Chain:
   *   MediaStreamSource (raw mic)
   *     ├──► BiquadFilterNode (bandpass 1850 Hz, Q=0.7) ──► AnalyserNode
   *     └──► destinationNode (raw voice for outgoing WebRTC — uncoloured)
   *
   * The bandpass filter is **only** used for RMS analysis; the voice that
   * attendees hear is always the raw, unprocessed microphone signal.
   *
   * @returns {Promise<MediaStream>} The raw microphone MediaStream.
   * @throws {DOMException} If getUserMedia is denied or unavailable.
   */
  async attachMicrophone() {
    if (!this.ctx) throw new Error('[AudioManager] Call init() before attachMicrophone().');

    // Ensure AudioContext is running (may be suspended on page load)
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Request mic with precise constraints.
    // noiseSuppression: false → preserve natural dynamics for RMS accuracy.
    // autoGainControl: false → prevent AGC from masking soft speech.
    this._micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  true,
        noiseSuppression:  false,
        autoGainControl:   false,
      },
      video: false,
    });

    // ── Create mic source node ────────────────────────────────────────────────
    this._micSource = this.ctx.createMediaStreamSource(this._micStream);

    // ── Bandpass filter for speech isolation (analysis only) ──────────────────
    // Center frequency 1850 Hz is the geometric mean of [200, 3500] Hz:
    //   √(200 × 3500) ≈ 837 Hz, but perceptual centre of speech lies higher.
    // Setting fc=1850 Hz with Q=0.7 yields a -3dB bandwidth of ≈2640 Hz,
    // effectively covering 200–3500 Hz for vowel formants and consonants.
    this._voiceBPF = this.ctx.createBiquadFilter();
    this._voiceBPF.type            = 'bandpass';
    this._voiceBPF.frequency.value = 1850;  // Hz — geometric speech centre
    this._voiceBPF.Q.value         = 0.7;   // Bandwidth: ~200–3500 Hz

    // ── Analyser for RMS metering ─────────────────────────────────────────────
    this._voiceAnalyser = this.ctx.createAnalyser();
    this._voiceAnalyser.fftSize              = 512;
    this._voiceAnalyser.smoothingTimeConstant = 0.4; // moderate temporal smoothing
    this._timeDomainBuffer = new Float32Array(this._voiceAnalyser.fftSize);

    // ── Wire the analysis chain (mic → BPF → analyser) ───────────────────────
    this._micSource.connect(this._voiceBPF);
    this._voiceBPF.connect(this._voiceAnalyser);
    // Note: analyser is a dead-end; Web Audio doesn't require connect to destination.

    // ── Route RAW mic to the outgoing WebRTC stream (uncoloured voice) ────────
    this._micSource.connect(this._voiceOutputGain);

    // ── Start real-time processing loop ──────────────────────────────────────
    this._startAnalysisLoop();

    console.log('[AudioManager] Microphone attached. Analysis loop running.');
    return this._micStream;
  }

  // ─── Real-Time Analysis Loop & FSM Engine ─────────────────────────────────────

  /**
   * Begins the requestAnimationFrame-based RMS analysis loop.
   * @private
   */
  _startAnalysisLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      this._processTick();
    };
    this._rafId = requestAnimationFrame(tick);
  }

  /**
   * Stops the analysis loop and cancels any pending RAF.
   * @private
   */
  _stopAnalysisLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Single analysis tick — reads the AnalyserNode time-domain buffer,
   * computes RMS in dBFS, then drives the FSM.
   * @private
   */
  _processTick() {
    if (!this._voiceAnalyser || !this._timeDomainBuffer) return;

    // Pull time-domain samples (PCM floats in [-1, 1])
    this._voiceAnalyser.getFloatTimeDomainData(this._timeDomainBuffer);
    const db = computeRmsDb(this._timeDomainBuffer);

    // Cache latest dB reading for polling via getCurrentDecibels()
    this._currentDb = db;

    // Drive the FSM
    this._updateFSM(db);

    // Fire per-frame callback for UI (VU meter, waveform, etc.)
    if (this.onStateChange) {
      this.onStateChange(this._state, db);
    }
  }

  /**
   * 3-State FSM ducking logic with anti-jitter hysteresis.
   *
   * Priority order (highest to lowest):
   *   1. Voice above CLIMAX_UPPER (-16 dBFS)  → CLIMAX  (40%)
   *   2. In CLIMAX + voice below CLIMAX_LOWER  → CONVERSATIONAL (20%)
   *   3. Voice above SPEECH_THRESHOLD (-40 dB) → CONVERSATIONAL (20%)
   *   4. Silence ≥ HOLD_TIME_MS                → SWELL   (80%)
   *
   * All gain transitions use Web Audio scheduling (setTargetAtTime) for
   * sub-millisecond accuracy — never setTimeout/setInterval.
   *
   * Time constants map to approximate durations:
   *   τ=0.3 →  ~300 ms attack  (speech detection)
   *   τ=0.4 →  ~400 ms for CLIMAX onset
   *   τ=1.5 → ~1500 ms release back to SWELL
   *
   * @param {number} db - Current voice RMS in dBFS.
   * @private
   */
  _updateFSM(db) {
    const now = this.ctx.currentTime;
    if (!this._duckingEnabled) {
      this._masterMusicGain.gain.setTargetAtTime(this.VOL_SWELL, now, 0.1);
      return;
    }

    // ── Priority 1: CLIMAX — loud voice above -16 dBFS ───────────────────────
    if (db > this.CLIMAX_UPPER) {
      if (this._state !== EngineState.CLIMAX) {
        this._setState(EngineState.CLIMAX);
        // Quick attack into supportive drive level
        this._masterMusicGain.gain.setTargetAtTime(
          this.VOL_CLIMAX,
          now,
          0.4  // τ ≈ 400 ms
        );
      }
      // Voice present — reset silence timer
      this._silenceStart = null;
      return;
    }

    // ── Priority 2: Hysteresis exit — CLIMAX → CONVERSATIONAL ────────────────
    // Only exit CLIMAX once dB drops below the lower hysteresis threshold (-22).
    // This 6 dB gap prevents rapid CLIMAX↔CONVERSATIONAL oscillation on
    // plosives, breaths, or short word gaps.
    if (this._state === EngineState.CLIMAX && db < this.CLIMAX_LOWER) {
      this._setState(EngineState.CONVERSATIONAL);
      this._masterMusicGain.gain.setTargetAtTime(
        this.VOL_CONVERSATIONAL,
        now,
        0.3  // τ ≈ 300 ms — responsive but not jarring
      );
      this._silenceStart = null;
      return;
    }

    // ── While in CLIMAX, hold the level — don't react to minor dips ──────────
    if (this._state === EngineState.CLIMAX) {
      // Voice is between CLIMAX_LOWER and CLIMAX_UPPER: maintain current state.
      this._silenceStart = null;
      return;
    }

    // ── Priority 3: CONVERSATIONAL — voice present but below CLIMAX ───────────
    if (db > this.SPEECH_THRESHOLD) {
      if (this._state !== EngineState.CONVERSATIONAL) {
        this._setState(EngineState.CONVERSATIONAL);
        this._masterMusicGain.gain.setTargetAtTime(
          this.VOL_CONVERSATIONAL,
          now,
          0.3  // τ ≈ 300 ms speech attack
        );
      }
      // Active speech — reset silence timer
      this._silenceStart = null;
      return;
    }

    // ── Priority 4: SILENCE — below SPEECH_THRESHOLD (-40 dB) ───────────────
    // Start silence timer on first silent frame, then wait for HOLD_TIME_MS.
    const nowMs = performance.now();
    if (this._silenceStart === null) {
      this._silenceStart = nowMs;
    }

    const silenceElapsedMs = nowMs - this._silenceStart;

    if (silenceElapsedMs >= this.HOLD_TIME_MS) {
      if (this._state !== EngineState.SWELL) {
        this._setState(EngineState.SWELL);
        // Slow, gentle swell back to full ambient level over ~1.5s
        this._masterMusicGain.gain.setTargetAtTime(
          this.VOL_SWELL,
          now,
          1.5  // τ = 1.5 s release
        );
      }
    }
  }

  /**
   * Updates internal state and fires the transition callback.
   * @param {string} newState - One of the EngineState values.
   * @private
   */
  _setState(newState) {
    const prev = this._state;
    this._state = newState;
    console.log(`[AudioManager] FSM: ${prev} → ${newState}`);
    if (this.onTransition) {
      this.onTransition(newState, prev);
    }
  }

  // ─── Deck Engine — Equal-Power Crossfader ─────────────────────────────────────

  /**
   * Crossfades from the currently active deck to a new audio source.
   *
   * Algorithm:
   *   - Equal-power crossfade over 2.0 seconds using linearRampToValueAtTime.
   *   - The outgoing deck fades from current gain → 0.
   *   - The incoming deck starts from 0 → 1 (pre-master).
   *   - The FSM-controlled `masterMusicGain` applies the current duck level
   *     to the combined output transparently.
   *   - After the fade, the outgoing HTML audio element is paused and its
   *     src is cleared to release memory.
   *
   * @param {string} audioSourceUrl - URL of the new pad or song to play.
   * @param {number} [fadeDuration=2.0] - Crossfade duration in seconds.
   * @returns {void}
   */
  crossfadeTo(audioSourceUrl, fadeDuration = 2.0) {
    if (!this.ctx) {
      console.warn('[AudioManager] crossfadeTo() called before init().');
      return;
    }

    const now = this.ctx.currentTime;
    const endTime = now + fadeDuration;

    // ── Identify incoming and outgoing decks ──────────────────────────────────
    const isAActive  = (this._activeDeck === 'A');
    const outGain    = isAActive ? this._gainNodeA : this._gainNodeB;
    const inGain     = isAActive ? this._gainNodeB : this._gainNodeA;
    const inPlayer   = isAActive ? this._playerB   : this._playerA;
    const outPlayer  = isAActive ? this._playerA   : this._playerB;

    // ── Wire incoming player into AudioContext (if not already connected) ─────
    // HTML audio elements need a MediaElementAudioSourceNode bridge.
    // We create it once per player and reuse it.
    if (!inPlayer._sourceNode) {
      inPlayer._sourceNode = this.ctx.createMediaElementSource(inPlayer);
      inPlayer._sourceNode.connect(inGain);
    }

    // ── Soft-start: set incoming gain to 0 before playing ────────────────────
    inGain.gain.cancelScheduledValues(now);
    inGain.gain.setValueAtTime(0, now);

    // ── Load and play the new track ───────────────────────────────────────────
    inPlayer.src  = audioSourceUrl;
    inPlayer.loop = true;  // Pads loop seamlessly by default
    inPlayer.play().catch(err => {
      console.error('[AudioManager] crossfadeTo playback error:', err);
    });

    this._isMusicPlaying = true;

    // ── Schedule equal-power crossfade gains ──────────────────────────────────
    // Incoming: linear ramp 0 → 1
    inGain.gain.linearRampToValueAtTime(1.0, endTime);

    // Outgoing: linear ramp from current value → 0
    const currentOutGain = outGain.gain.value;
    outGain.gain.cancelScheduledValues(now);
    outGain.gain.setValueAtTime(currentOutGain, now);
    outGain.gain.linearRampToValueAtTime(0, endTime);

    // ── After fade: pause and release outgoing player ─────────────────────────
    const pauseDelay = (fadeDuration + 0.1) * 1000; // slight buffer past fade end
    setTimeout(() => {
      outPlayer.pause();
      outPlayer.src = '';
      console.log(`[AudioManager] Deck ${isAActive ? 'A' : 'B'} released.`);
    }, pauseDelay);

    // ── Swap active deck ──────────────────────────────────────────────────────
    this._activeDeck = isAActive ? 'B' : 'A';

    console.log(
      `[AudioManager] Crossfading → "${audioSourceUrl}" on deck ` +
      `${this._activeDeck} over ${fadeDuration}s.`
    );
  }

  // ─── Procedural Synth Engine ──────────────────────────────────────────────────

  /**
   * Synthesises and plays a worship pad preset using Web Audio oscillators.
   *
   * All synthesis nodes are routed through `this.synthGain`, which connects to
   * `_masterMusicGain` so the FSM ducking sidechain governs volume automatically.
   *
   * Sound design per presetType:
   *  'pad' / 'strings' — Detuned sawtooth + triangle pairs per note, 24 dB/oct
   *                       lowpass at 550 Hz, slow LFO sweeping the cutoff.
   *  'drone'           — Sine sub-octave reinforcement, lowpass at 350 Hz,
   *                       slow pitch vibrato via a dedicated LFO.
   *  'choir'           — Sine base tones + dual peaking (formant) filters at
   *                       800 Hz and 2.4 kHz with slight shimmer detuning.
   *  'piano'           — Sine/triangle mix with a soft exponential decay into
   *                       a warm sustain tail (electric-Rhodes character).
   *
   * @param {'pad'|'strings'|'drone'|'choir'|'piano'} presetType
   * @param {number[]} frequencies  Array of note frequencies in Hz.
   * @param {number}   [fadeTime=2.0]  Cross-fade duration in seconds.
   * @returns {Promise<void>}
   */
  async playProceduralPreset(presetType, frequencies, fadeTime = 2.0) {
    if (!this.ctx) {
      console.warn('[AudioManager] playProceduralPreset() called before init().');
      return;
    }

    // Resume a suspended AudioContext (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    const now = this.ctx.currentTime;

    // ── Fade out and tear down any previously running synth nodes ─────────────
    if (this.synthNodes.length > 0) {
      this.synthGain.gain.cancelScheduledValues(now);
      this.synthGain.gain.setValueAtTime(this.synthGain.gain.value, now);
      this.synthGain.gain.linearRampToValueAtTime(0.0001, now + fadeTime);

      // Stop oscillators after the fade completes
      const nodesToStop = [...this.synthNodes];
      setTimeout(() => {
        for (const node of nodesToStop) {
          try { node.stop?.(); } catch (_) { /* already stopped */ }
          try { node.disconnect(); } catch (_) { /* already disconnected */ }
        }
      }, (fadeTime + 0.1) * 1000);

      this.synthNodes = [];
    }

    // ── Prepare a fresh preset gain node ─────────────────────────────────────
    // Re-use this.synthGain (already connected to _masterMusicGain).
    // Soft-start from near-zero to avoid click artefacts.
    this.synthGain.gain.cancelScheduledValues(now);
    this.synthGain.gain.setValueAtTime(0.0001, now);

    // ── Build synthesis network based on preset type ──────────────────────────
    switch (presetType) {

      // ───────────────────────────────────────────────────────────────────────
      case 'pad':
      case 'strings': {
        // 24 dB/oct lowpass — tames harsh harmonics for a warm pad character
        const lpf = this.ctx.createBiquadFilter();
        lpf.type            = 'lowpass';
        lpf.frequency.value = presetType === 'pad' ? 500 : 600;
        lpf.Q.value         = 2.0;
        lpf.connect(this.synthGain);
        this.synthNodes.push(lpf);

        // LFO sweeps filter cutoff for organic, breathing swell
        const lfo = this.ctx.createOscillator();
        lfo.type            = 'sine';
        lfo.frequency.value = 0.1;  // 10-second period

        const lfoGain = this.ctx.createGain();
        lfoGain.gain.value = lpf.frequency.value * 0.3; // ±30% of cutoff
        lfo.connect(lfoGain);
        lfoGain.connect(lpf.frequency);
        lfo.start(now);
        this.synthNodes.push(lfo, lfoGain);

        // Detuned oscillator pair per note (sawtooth + triangle)
        for (const freq of frequencies) {
          const saw = this.ctx.createOscillator();
          saw.type            = 'sawtooth';
          saw.frequency.value = freq;
          saw.detune.value    = -6; // slightly flat saw

          const tri = this.ctx.createOscillator();
          tri.type            = 'triangle';
          tri.frequency.value = freq;
          tri.detune.value    = +6; // slightly sharp triangle

          // Per-voice gain to prevent clipping on dense chords
          const voiceGain = this.ctx.createGain();
          voiceGain.gain.value = 0.18 / frequencies.length;

          saw.connect(voiceGain);
          tri.connect(voiceGain);
          voiceGain.connect(lpf);

          saw.start(now);
          tri.start(now);
          this.synthNodes.push(saw, tri, voiceGain);
        }
        break;
      }

      // ───────────────────────────────────────────────────────────────────────
      case 'drone': {
        // Deep lowpass — reinforces bass weight, removes presence harshness
        const lpf = this.ctx.createBiquadFilter();
        lpf.type            = 'lowpass';
        lpf.frequency.value = 350;
        lpf.Q.value         = 1.5;
        lpf.connect(this.synthGain);
        this.synthNodes.push(lpf);

        for (const freq of frequencies) {
          // Sub-octave sine for chest-filling low-end
          const sub = this.ctx.createOscillator();
          sub.type            = 'sine';
          sub.frequency.value = freq / 2;

          // Detuned sawtooth for body/texture
          const saw = this.ctx.createOscillator();
          saw.type            = 'sawtooth';
          saw.frequency.value = freq;
          saw.detune.value    = -8;

          // Slow pitch vibrato LFO per voice (slightly offset per note for life)
          const vibratoLFO  = this.ctx.createOscillator();
          vibratoLFO.type            = 'sine';
          vibratoLFO.frequency.value = 0.08 + Math.random() * 0.04; // 0.08–0.12 Hz

          const vibratoDepth = this.ctx.createGain();
          vibratoDepth.gain.value = 3; // ±3 cents of pitch drift
          vibratoLFO.connect(vibratoDepth);
          vibratoDepth.connect(saw.detune);
          vibratoLFO.start(now);

          const voiceGain = this.ctx.createGain();
          voiceGain.gain.value = 0.22 / frequencies.length;

          sub.connect(voiceGain);
          saw.connect(voiceGain);
          voiceGain.connect(lpf);

          sub.start(now);
          saw.start(now);
          this.synthNodes.push(sub, saw, vibratoLFO, vibratoDepth, voiceGain);
        }
        break;
      }

      // ───────────────────────────────────────────────────────────────────────
      case 'choir': {
        // Dual formant (peaking) filters simulate vowel resonance chambers
        const formant1 = this.ctx.createBiquadFilter();
        formant1.type            = 'peaking';
        formant1.frequency.value = 800;   // first vowel formant (F1)
        formant1.Q.value         = 4.0;
        formant1.gain.value      = 9;     // dB boost

        const formant2 = this.ctx.createBiquadFilter();
        formant2.type            = 'peaking';
        formant2.frequency.value = 2400;  // second vowel formant (F2)
        formant2.Q.value         = 5.0;
        formant2.gain.value      = 7;

        formant1.connect(formant2);
        formant2.connect(this.synthGain);
        this.synthNodes.push(formant1, formant2);

        // Slow shimmer LFO — gently modulates formant frequencies for an
        // "ahh" breathing quality
        const shimmerLFO  = this.ctx.createOscillator();
        shimmerLFO.type            = 'sine';
        shimmerLFO.frequency.value = 0.15;

        const shimmerGain = this.ctx.createGain();
        shimmerGain.gain.value = 40; // ±40 Hz sweep on F1

        shimmerLFO.connect(shimmerGain);
        shimmerGain.connect(formant1.frequency);
        shimmerLFO.start(now);
        this.synthNodes.push(shimmerLFO, shimmerGain);

        for (const freq of frequencies) {
          // Slightly detuned sine pair for shimmer
          const s1 = this.ctx.createOscillator();
          s1.type            = 'sine';
          s1.frequency.value = freq;
          s1.detune.value    = -4;

          const s2 = this.ctx.createOscillator();
          s2.type            = 'sine';
          s2.frequency.value = freq;
          s2.detune.value    = +4;

          const voiceGain = this.ctx.createGain();
          voiceGain.gain.value = 0.16 / frequencies.length;

          s1.connect(voiceGain);
          s2.connect(voiceGain);
          voiceGain.connect(formant1);

          s1.start(now);
          s2.start(now);
          this.synthNodes.push(s1, s2, voiceGain);
        }
        break;
      }

      // ───────────────────────────────────────────────────────────────────────
      case 'piano': {
        // Warm bell / electric Rhodes character:
        // Each note gets a sine + triangle hit with a fast exponential decay
        // into a quiet sustain tail — emulates hammer strike with resonance.
        for (const freq of frequencies) {
          const sine = this.ctx.createOscillator();
          sine.type            = 'sine';
          sine.frequency.value = freq;

          const tri = this.ctx.createOscillator();
          tri.type            = 'triangle';
          tri.frequency.value = freq;
          tri.detune.value    = +2;

          // Per-note envelope gain: fast attack, exponential decay to sustain
          const envGain = this.ctx.createGain();
          const peakAmp = 0.35 / frequencies.length;
          const sustainAmp = peakAmp * 0.3; // sustain at 30% of peak

          // Immediate strike
          envGain.gain.setValueAtTime(0.0001, now);
          envGain.gain.linearRampToValueAtTime(peakAmp, now + 0.015); // 15 ms attack
          // Decay to sustain level over ~1.8 s (exponential feel)
          envGain.gain.setTargetAtTime(sustainAmp, now + 0.015, 0.6);

          sine.connect(envGain);
          tri.connect(envGain);
          envGain.connect(this.synthGain);

          sine.start(now);
          tri.start(now);
          this.synthNodes.push(sine, tri, envGain);
        }
        break;
      }

      default:
        console.warn(`[AudioManager] Unknown presetType: "${presetType}"`);
        return;
    }

    // ── Fade synthGain up to full level ───────────────────────────────────────
    this.synthGain.gain.linearRampToValueAtTime(1.0, now + fadeTime);

    this._isMusicPlaying = true;

    console.log(
      `[AudioManager] Procedural preset "${presetType}" started ` +
      `(${frequencies.length} notes, fade ${fadeTime}s).`
    );
  }

  /**
   * Fades out and stops all active procedural synth nodes.
   *
   * @param {number} [fadeTime=1.5]  Fade-out duration in seconds.
   */
  stopProceduralPreset(fadeTime = 1.5) {
    if (!this.ctx || this.synthNodes.length === 0) return;

    const now = this.ctx.currentTime;

    this.synthGain.gain.cancelScheduledValues(now);
    this.synthGain.gain.setValueAtTime(this.synthGain.gain.value, now);
    this.synthGain.gain.linearRampToValueAtTime(0.0001, now + fadeTime);

    const nodesToStop = [...this.synthNodes];
    this.synthNodes = [];

    setTimeout(() => {
      for (const node of nodesToStop) {
        try { node.stop?.(); } catch (_) { /* already stopped */ }
        try { node.disconnect(); } catch (_) { /* already disconnected */ }
      }
      console.log('[AudioManager] Procedural preset stopped.');
    }, (fadeTime + 0.1) * 1000);
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────────

  /**
   * Creates a configured HTMLAudioElement for use in the deck engine.
   * crossOrigin is set to 'anonymous' for CORS-compliant CDN audio sources.
   * @returns {HTMLAudioElement}
   * @private
   */
  _createAudioElement() {
    const el = new Audio();
    el.crossOrigin   = 'anonymous';
    el.preload       = 'auto';
    el._sourceNode   = null; // MediaElementAudioSourceNode, created lazily
    return el;
  }

  // ─── Public Getters & Methods ─────────────────────────────────────────────────

  /**
   * The current FSM state.
   * @returns {string} One of EngineState.SWELL | CONVERSATIONAL | CLIMAX
   */
  get state() { return this._state; }

  /**
   * Alias for `state` — used by app.js render loop.
   * @returns {string}
   */
  get currentState() { return this._state; }

  /**
   * Returns the most recently computed RMS level in dBFS.
   * Updated every animation frame by _processTick().
   * Returns -Infinity when the engine is not active.
   * @returns {number}
   */
  getCurrentDecibels() {
    return this._currentDb;
  }

  /**
   * Sets the user-facing master volume level independently of FSM ducking.
   *
   * Architecture:
   *   _masterMusicGain (FSM) → _masterVolumeGain (user) → destinations
   *
   * This node sits downstream of the FSM duck layer so both operate
   * independently without interfering with each other.
   *
   * @param {number} linearValue - Gain from 0.0 (silence) to 1.0 (full).
   */
  setMasterGain(linearValue) {
    const clamped = Math.min(Math.max(linearValue, 0), 1);
    if (!this._masterVolumeGain) return;
    // Use setTargetAtTime for a smooth 50ms ramp on slider drag
    this._masterVolumeGain.gain.setTargetAtTime(
      clamped,
      this.ctx.currentTime,
      0.05  // τ = 50 ms — imperceptibly fast but avoids zipper noise
    );
  }

  setVoiceGain(linearValue) {
    const clamped = Math.min(Math.max(linearValue, 0), 1);
    if (!this._voiceOutputGain || !this.ctx) return;
    this._voiceOutputGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.05);
  }

  setSmartDucking(enabled) {
    this._duckingEnabled = Boolean(enabled);
    if (!this._duckingEnabled && this._masterMusicGain && this.ctx) {
      this._masterMusicGain.gain.setTargetAtTime(this.VOL_SWELL, this.ctx.currentTime, 0.1);
    }
  }

  /**
   * The underlying AudioContext (for external node graph extensions).
   * @returns {AudioContext|null}
   */
  get context() { return this.ctx; }

  /**
   * The MediaStreamDestination node — use `.stream` to feed WebRTC tracks.
   *
   * @example
   *   const track = audioManager.destinationStream.getTracks()[0];
   *   peerConnection.addTrack(track, audioManager.destinationStream);
   *
   * @returns {MediaStreamAudioDestinationNode|null}
   */
  get destinationNode() { return this._destinationNode; }

  /**
   * Convenience accessor for the outgoing WebRTC MediaStream.
   * @returns {MediaStream|null}
   */
  get destinationStream() {
    return this._destinationNode ? this._destinationNode.stream : null;
  }

  /**
   * The FSM-level music gain node (read-only reference for diagnostics).
   * @returns {GainNode|null}
   */
  get masterMusicGain() { return this._masterMusicGain; }

  /**
   * Whether the microphone is currently attached and the analysis loop is live.
   * @returns {boolean}
   */
  get isListening() { return this._rafId !== null; }
}

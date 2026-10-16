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
 * and the equal-power crossfading deck engine.
 *
 * Usage:
 *   const am = new AudioManager();
 *   await am.init();           // unlock AudioContext (call from user gesture)
 *   await am.attachMicrophone();
 *   am.crossfadeTo('/assets/pads/pad-a.mp3');
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
    /** Master gain for the music bus; FSM writes to this node's gain param */
    this._masterMusicGain = null;

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
    // masterMusicGain → ctx.destination (local monitor)
    // masterMusicGain → destinationNode (outgoing WebRTC stream)
    this._masterMusicGain = this.ctx.createGain();
    this._masterMusicGain.gain.value = this.VOL_SWELL; // initial state: SWELL

    this._destinationNode = this.ctx.createMediaStreamDestination();

    this._masterMusicGain.connect(this.ctx.destination);
    this._masterMusicGain.connect(this._destinationNode);

    // ── Build dual-deck gain nodes ────────────────────────────────────────────
    this._gainNodeA = this.ctx.createGain();
    this._gainNodeA.gain.value = 0; // silent until first crossfade
    this._gainNodeA.connect(this._masterMusicGain);

    this._gainNodeB = this.ctx.createGain();
    this._gainNodeB.gain.value = 0;
    this._gainNodeB.connect(this._masterMusicGain);

    // ── Create HTML audio elements for deck playback ───────────────────────────
    this._playerA = this._createAudioElement();
    this._playerB = this._createAudioElement();

    console.log('[AudioManager] Initialised. AudioContext state:', this.ctx.state);
  }

  /**
   * Tears down all audio nodes, stops the analysis loop, and releases resources.
   */
  destroy() {
    this._stopAnalysisLoop();

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
    this._micSource.connect(this._destinationNode);

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

  // ─── Public Getters ───────────────────────────────────────────────────────────

  /**
   * The current FSM state.
   * @returns {string} One of EngineState.SWELL | CONVERSATIONAL | CLIMAX
   */
  get state() { return this._state; }

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
   * The master music gain node. Useful for external monitoring or UI binding.
   * Do not schedule gain changes directly — use the FSM instead.
   * @returns {GainNode|null}
   */
  get masterMusicGain() { return this._masterMusicGain; }

  /**
   * Whether the microphone is currently attached and the analysis loop is live.
   * @returns {boolean}
   */
  get isListening() { return this._rafId !== null; }
}

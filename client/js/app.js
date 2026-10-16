/**
 * @file app.js
 * @description UI orchestration and application entry point for Worship Audio Room.
 *
 * Responsibilities:
 *  - Bootstraps the application on DOMContentLoaded.
 *  - Manages DOM rendering and user interaction events.
 *  - Coordinates between AudioManager (DSP) and WebRTCManager (signaling).
 *  - Reflects FSM state changes in the UI (meter, state badge, deck controls).
 *
 * @module app
 */

import { AudioManager } from './AudioManager.js';
import { WebRTCManager } from './webrtc.js';

// ─── Module Instances ─────────────────────────────────────────────────────────

const audioManager = new AudioManager();
const webrtcManager = new WebRTCManager();

// ─── DOM References ────────────────────────────────────────────────────────────

// Populated after DOMContentLoaded when Phase 2 renders the full UI.
let $app         = null;
let $statebadge   = null;
let $vuMeter     = null;
let $deckControls = null;

// ─── Application Bootstrap ─────────────────────────────────────────────────────

/**
 * Initialises the DOM, binds event listeners, and boots audio on first interaction.
 */
function bootstrap() {
  $app = document.getElementById('app');

  // TODO (Phase 2): Render full UI component tree into #app.
  // For now, log readiness.
  console.log('[app] Bootstrap complete. Waiting for Phase 2 UI.');
}

/**
 * Handles the user's first click/interaction to unlock AudioContext
 * (required by browser autoplay policy).
 */
async function onFirstInteraction() {
  console.log('[app] First interaction — initialising AudioManager...');
  await audioManager.init();
  // TODO (Phase 2): Remove the one-time listener and show the main UI.
}

/**
 * Updates the UI components to reflect the current FSM state.
 * Called whenever AudioManager emits a state transition event.
 * @param {'SWELL'|'CONVERSATIONAL'|'CLIMAX'} state
 */
function onStateChange(state) {
  // TODO (Phase 2): Update state badge color, animate VU meter response.
  console.log(`[app] FSM state updated → ${state}`);
}

/**
 * Updates the VU meter canvas with the current voice RMS level.
 * @param {number} rmsDb - RMS level in dBFS.
 */
function onVuUpdate(rmsDb) {
  // TODO (Phase 2): Draw meter bar on canvas.
}

// ─── Entry Point ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', bootstrap);

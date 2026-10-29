# Worship Room

> A real-time virtual meeting platform with an intelligent praise & worship audio deck.

## Architecture

```
worship-audio-room/
├── client/
│   ├── index.html           # SPA entry point
│   ├── style.css            # Design system & component styles
│   ├── js/
│   │   ├── AudioManager.js  # Web Audio API DSP engine (FSM, ducking, deck)
│   │   ├── app.js           # UI orchestration & event coordination
│   │   └── webrtc.js        # WebRTC peer connection & WS signaling client
│   └── assets/
│       └── pads/            # Instrumental pad audio files (.mp3 / .ogg)
├── server/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py          # FastAPI app factory & routing
│   │   ├── signaling.py     # WebSocket signaling relay hub
│   │   └── config.py        # Pydantic settings (env vars)
│   ├── venv/                # Python virtual environment (not committed)
│   └── requirements.txt
├── .vscode/settings.json
├── Procfile                 # Render/Heroku deployment
├── runtime.txt              # Python version pin
└── README.md
```

## Audio DSP Specification

| Parameter | Value |
|---|---|
| Voice bandpass | 200 Hz – 3.5 kHz |
| SWELL state | 80% music level |
| CONVERSATIONAL state | 20% background bed |
| CLIMAX state | 40% supportive drive |
| Climax entry (hysteresis high) | -16 dBFS |
| Climax exit (hysteresis low) | -22 dBFS |
| Hold time | 2.0 s |
| Speech attack time | 300 ms |
| Release / swell time | 1.5 s |

## Getting Started

### Backend

```bash
cd server
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Client

Open `client/index.html` directly in a browser, or serve via the FastAPI static mount at `http://localhost:8000/`.

## Deployment

- **Backend**: Render (`web` dyno using `Procfile`)
- **Frontend**: Static files served by FastAPI or Vercel

### Google Sign-In

Create a Google OAuth web client and configure these URLs:

- Authorized JavaScript origin: `https://worship-audio-room.onrender.com`
- Authorized redirect URI: `https://worship-audio-room.onrender.com/auth/google/callback`

Set these environment variables on the Render web service:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET` (generate a long random value; Render Blueprint can generate one)
- `SESSION_COOKIE_SECURE=true`
- `ALLOWED_ORIGINS` (comma-separated exact origins only if the frontend is hosted on another domain; the default deployment is same-origin)

The Google credentials must be entered in the Render dashboard for an existing service. Until configured, `/auth/google` returns `503` and room sign-in is unavailable.

After signing in, participants can change their room display name from the
display-name field in the chat panel. The server validates and broadcasts the
updated name to all room members. Host removal is tied to the authenticated
account and blocks that account from rejoining the active room without a new
admission.

### TURN Relay

Direct WebRTC uses public Google STUN servers by default. For networks that block direct peer connections, configure a TURN provider that supports coturn REST/shared-secret credentials:

- `TURN_URLS`: comma-separated `turn:` or `turns:` URLs, for example `turn:turn.example.net:3478?transport=udp,turns:turn.example.net:5349`
- `TURN_SHARED_SECRET`: the provider's REST credential shared secret

The server returns short-lived credentials to authenticated users. Do not put the shared secret in frontend code. Render's free web-service plan does not provide a TURN relay; TURN usage and cost are separate from the Render service.

### Connection recovery and captions

The browser reconnects the signaling WebSocket with bounded exponential
backoff and preserves an authenticated participant's room role across a
transient disconnect. WebRTC peers also use ICE restart when connectivity
changes.

Captions are opt-in and browser-based (`SpeechRecognition`/
`webkitSpeechRecognition`). Transcripts are sent to current room members only,
are labeled with the server-authoritative speaker name, and are not stored.
Browsers without speech recognition support leave the captions control
unavailable. The browser asks for microphone permission when captions start;
captions should only be enabled after participants have consented to live
transcription.

## License

MIT

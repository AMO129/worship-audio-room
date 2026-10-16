# Worship Audio Room

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

## License

MIT

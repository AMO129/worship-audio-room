"""
main.py — FastAPI application entry point for Worship Audio Room.

Routes (order matters — API routes registered before static mount):
  GET  /health                     → Liveness probe for Render/cloud health checks.
  WS   /ws/{room_id}/{client_id}  → WebRTC signaling relay (delegates to ConnectionManager).
  GET  /*                          → Static frontend files served from client/.

CORS is set to allow_origins=["*"] for development and cross-origin Render deployments.
In production, replace "*" with your specific frontend domain.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from .signaling import manager

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Application Factory ──────────────────────────────────────────────────────

app = FastAPI(
    title="Worship Audio Room",
    description="Real-time virtual meeting platform with intelligent P&W audio deck.",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ─── CORS ─────────────────────────────────────────────────────────────────────
# allow_origins=["*"] allows any origin — required for cross-origin WebSocket
# connections from browsers on different ports or domains.
# Restrict to specific origins in production to prevent CSRF.

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════════════════════════════════════════════
# API ROUTES  (must be registered BEFORE the static mount to avoid interception)
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health", tags=["meta"], summary="Liveness probe")
async def health_check() -> JSONResponse:
    """
    Returns HTTP 200 with { "status": "healthy" } for cloud health-check pings
    (Render, Heroku, GCP Cloud Run, etc.).
    """
    return JSONResponse({
        "status": "healthy",
        "rooms":  manager.room_count,
        "peers":  manager.total_connections,
    })


# ─── WebSocket Signaling Endpoint ─────────────────────────────────────────────

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    client_id: str,
) -> None:
    """
    WebRTC signaling relay for a specific room and client.

    Protocol:
      Client → Server:
                { "type": "offer|answer", "target_id": "<peer_id>", "sdp": "..." }
                { "type": "ice-candidate", "target_id": "<peer_id>", "candidate": {...} }
                { "type": "chat-message", "sender_name": "...", "text": "..." }
        { "type": "ping" }

      Server → Client:
                { "type": "room-users", "peers": ["<id>", ...] }
                { "type": "peer-joined|peer-left", "peer_id": "<id>" }
                { "type": "offer|answer|ice-candidate", "sender_id": "<id>", ... }
                { "type": "chat-message", "sender_id": "<id>", "timestamp": "...", ... }
        { "type": "pong" }
    """
    # Register peer and broadcast peer-joined to room members
    await manager.connect(websocket, room_id, client_id)
    logger.info("WS open  — room='%s' client='%s'", room_id, client_id)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "")

            # ── Keep-alive ────────────────────────────────────────────────────
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            # ── WebRTC signal relay (offer / answer / ice-candidate) ───────────
            if msg_type in ("offer", "answer", "ice-candidate"):
                await manager.relay_rtc(
                    room_id=room_id,
                    sender_id=client_id,
                    msg_type=msg_type,
                    payload=data,
                )
                continue

            # ── Chat broadcast ────────────────────────────────────────────────
            if msg_type == "chat-message":
                await manager.broadcast_chat(
                    room_id=room_id,
                    sender_id=client_id,
                    payload=data,
                )
                continue

            # ── Legacy signal relay (signalType envelope) ─────────────────────
            if msg_type == "signal":
                target_id = data.get("targetId")
                if not target_id:
                    logger.debug("Signal missing targetId — dropped.")
                    continue
                signal_data = {
                    k: v for k, v in data.items()
                    if k not in ("type", "targetId")
                }
                await manager.relay_signal(
                    room_id=room_id,
                    sender_id=client_id,
                    target_id=target_id,
                    signal_data=signal_data,
                )
                continue

            logger.debug("Unknown message type '%s' from '%s'", msg_type, client_id)

    except WebSocketDisconnect:
        logger.info("WS close — room='%s' client='%s'", room_id, client_id)

    except Exception as exc:
        logger.error("WS error — room='%s' client='%s': %s", room_id, client_id, exc)

    finally:
        # Unregister peer and notify remaining room members
        manager.disconnect(room_id, client_id)
        await manager.broadcast_peer_left(room_id, client_id)


# ═══════════════════════════════════════════════════════════════════════════════
# STATIC FILE SERVING
# Must be mounted LAST so it does not shadow the API routes above.
# html=True → serves client/index.html for any path that has no matching file
# (enables browser-side routing / direct URL navigation).
# ═══════════════════════════════════════════════════════════════════════════════

_CLIENT_DIR = Path(__file__).parents[2] / "client"

if _CLIENT_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(_CLIENT_DIR), html=True),
        name="client",
    )
    logger.info("Static files mounted from: %s", _CLIENT_DIR)
else:
    logger.warning("Client directory not found at %s — static serving disabled.", _CLIENT_DIR)

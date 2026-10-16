"""
signaling.py — WebRTC signaling hub via WebSockets.

Architecture:
  - Each room is identified by a `room_id` string.
  - The server acts as a relay: it forwards SDP offers/answers and
    ICE candidates between peers in the same room.
  - No media flows through the server (true peer-to-peer WebRTC).

Message Protocol (JSON):
  { "type": "offer",     "sdp":  "<SDP string>",          "from": "<peer_id>" }
  { "type": "answer",    "sdp":  "<SDP string>",          "from": "<peer_id>" }
  { "type": "candidate", "candidate": { ... RTCIceCandidate ... }, "from": "<peer_id>" }
  { "type": "join",      "room": "<room_id>",             "peer_id": "<uuid>" }

Phase 1: Connection acceptance and echo. Full relay in Phase 3.
"""

import json
import uuid
import logging
from typing import Dict, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ws", tags=["signaling"])

# ─── Room Registry ────────────────────────────────────────────────────────────

# Maps room_id → set of connected WebSocket clients.
_rooms: Dict[str, Set[WebSocket]] = {}


async def _broadcast(room_id: str, message: dict, exclude: WebSocket | None = None):
    """Broadcast a JSON message to all peers in a room, optionally excluding one."""
    payload = json.dumps(message)
    for ws in list(_rooms.get(room_id, [])):
        if ws is not exclude:
            try:
                await ws.send_text(payload)
            except Exception:
                logger.warning("Failed to send to a peer in room %s", room_id)


# ─── Signaling Endpoint ──────────────────────────────────────────────────────

@router.websocket("/signal/{room_id}")
async def signaling_endpoint(websocket: WebSocket, room_id: str):
    """
    WebSocket endpoint for WebRTC signaling.
    Peers connect here to exchange SDP and ICE candidates.
    """
    await websocket.accept()
    peer_id = str(uuid.uuid4())
    logger.info("Peer %s joined room %s", peer_id, room_id)

    # Register peer in room
    _rooms.setdefault(room_id, set()).add(websocket)

    # Notify peer of their assigned ID
    await websocket.send_json({"type": "connected", "peer_id": peer_id, "room": room_id})

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            message["from"] = peer_id  # Tag message with sender

            msg_type = message.get("type")
            logger.debug("Room %s | %s from %s", room_id, msg_type, peer_id)

            # Phase 1: Relay everything to all other peers.
            # Phase 3: Add type-specific routing and room capacity limits.
            await _broadcast(room_id, message, exclude=websocket)

    except WebSocketDisconnect:
        logger.info("Peer %s left room %s", peer_id, room_id)
    finally:
        _rooms[room_id].discard(websocket)
        if not _rooms[room_id]:
            del _rooms[room_id]
        # Notify remaining peers of departure
        await _broadcast(room_id, {"type": "peer_left", "peer_id": peer_id})

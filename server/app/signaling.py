"""
signaling.py — Production WebRTC signaling hub with ConnectionManager.

Architecture:
  - ConnectionManager owns a dict of rooms: Dict[str, Dict[str, WebSocket]]
    mapping room_id → { client_id: WebSocket }.
  - connect()        : accept socket, register peer, send joiner room-users list,
                       broadcast peer-joined to pre-existing peers.
  - disconnect()     : remove peer, GC empty rooms, broadcast peer-left.
  - relay_signal()   : forward SDP offer/answer/ICE directly to a named peer.
  - relay_rtc()      : new unified relay for offer/answer/ice-candidate messages.
  - broadcast_chat() : attach timestamp + sender_id, broadcast chat to whole room.
  - No media ever transits the server — purely a TURN-free relay.

Message Protocol (server → client):
  { "type": "room-users",  "peers": ["<existing_id>", ...] }          ← sent to joiner only
  { "type": "peer-joined", "peer_id": "<id>" }                        ← broadcast to pre-existing peers
  { "type": "peer-left",   "peer_id": "<id>" }                        ← broadcast on disconnect
  { "type": "offer"|"answer"|"ice-candidate",
    "sender_id": "<id>", ...forwarded_payload }                        ← relayed RTC signal
  { "type": "chat-message", "sender_id": "<id>",
    "timestamp": "<iso8601>", ...forwarded_payload }                   ← broadcast chat
  { "type": "pong" }                                                   ← handled in main.py
"""

import logging
from datetime import datetime, timezone
from typing import Dict

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages multi-room WebSocket connections for WebRTC peer signaling.

    Attributes:
        rooms: Maps room_id → { client_id: WebSocket } for all active rooms.
    """

    def __init__(self) -> None:
        self.rooms: Dict[str, Dict[str, WebSocket]] = {}

    # ─── Lifecycle ────────────────────────────────────────────────────────────

    async def connect(
        self,
        websocket: WebSocket,
        room_id: str,
        client_id: str,
    ) -> None:
        """
        Accept the WebSocket, register the peer in its room, then:
          1. Send the joiner a `room-users` message containing the list of
             already-connected peer IDs (so it knows who to expect offers from).
             2. Broadcast a `peer-joined` message to every PRE-EXISTING peer so
                 clients can establish their mesh connection.

        Args:
            websocket: The connecting peer's WebSocket.
            room_id:   Identifier of the room to join.
            client_id: Unique identifier for this peer (generated client-side).
        """
        await websocket.accept()

        # Snapshot existing peers before registering the newcomer
        room = self.rooms.setdefault(room_id, {})
        existing_peer_ids = list(room.keys())

        # Register newcomer
        room[client_id] = websocket
        logger.info(
            "Peer %s joined room '%s' (%d peer(s) now)",
            client_id, room_id, len(room),
        )

        # Tell the joiner who is already in the room
        await self._send(websocket, {
            "type":  "room-users",
            "peers": existing_peer_ids,
        })

        # Notify each pre-existing peer so clients establish the mesh connection
        for existing_id, existing_ws in list(room.items()):
            if existing_id != client_id:
                await self._send(existing_ws, {
                    "type":    "peer-joined",
                    "peer_id": client_id,
                })

    def disconnect(self, room_id: str, client_id: str) -> None:
        """
        Remove a peer from its room. Deletes the room entry if it becomes empty.

        Args:
            room_id:   Room the peer is leaving.
            client_id: The departing peer's ID.
        """
        room = self.rooms.get(room_id, {})
        room.pop(client_id, None)

        if not room:
            self.rooms.pop(room_id, None)
            logger.info("Room '%s' is empty — removed.", room_id)

        logger.info("Peer %s left room '%s'.", client_id, room_id)

    # ─── Broadcast ────────────────────────────────────────────────────────────

    async def broadcast_peer_left(self, room_id: str, client_id: str) -> None:
        """
        Notify remaining peers that `client_id` has left the room.

        Args:
            room_id:   The room the peer left.
            client_id: The ID of the departed peer.
        """
        room = self.rooms.get(room_id, {})
        payload = {"type": "peer-left", "peer_id": client_id}
        for peer_id, ws in list(room.items()):
            await self._send(ws, payload)

    async def broadcast_chat(
        self,
        room_id: str,
        sender_id: str,
        payload: dict,
    ) -> None:
        """
        Attach `sender_id` and a UTC ISO-8601 `timestamp` to `payload`, then
        broadcast the resulting chat-message to every peer in the room
        (including the sender, so they receive confirmation with the
        authoritative timestamp).

        Args:
            room_id:   Target room.
            sender_id: ID of the peer who sent the chat message.
            payload:   Original message dict from the client (will not be mutated).
        """
        room = self.rooms.get(room_id, {})
        enriched = {
            **payload,
            "type":      "chat-message",
            "sender_id": sender_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        for ws in list(room.values()):
            await self._send(ws, enriched)

    # ─── Signal Relay ─────────────────────────────────────────────────────────

    async def relay_rtc(
        self,
        room_id: str,
        sender_id: str,
        msg_type: str,
        payload: dict,
    ) -> None:
        """
        Forward a WebRTC signaling payload (offer, answer, ice-candidate) to
        the peer identified by `payload["target_id"]`.

        `sender_id` is injected server-side; clients cannot spoof the origin.

        Args:
            room_id:   Room context.
            sender_id: ID of the peer sending the signal.
            msg_type:  One of "offer", "answer", or "ice-candidate".
            payload:   Client payload, must contain a "target_id" key.
        """
        room = self.rooms.get(room_id, {})
        target_id = payload.get("target_id")
        target_ws = room.get(target_id) if target_id else None

        if not target_ws:
            logger.debug(
                "RTC relay target '%s' not found in room '%s' — dropped.",
                target_id, room_id,
            )
            return

        forwarded = {
            **payload,
            "type":      msg_type,
            "sender_id": sender_id,
        }
        await self._send(target_ws, forwarded)

    async def relay_signal(
        self,
        room_id: str,
        sender_id: str,
        target_id: str,
        signal_data: dict,
    ) -> None:
        """
        Forward a WebRTC signaling payload (offer, answer, ICE candidate)
        directly to the named target peer within the room.

        The `sender_id` field is injected server-side so clients cannot spoof
        the sender identity.

        Args:
            room_id:     Room context.
            sender_id:   ID of the peer sending the signal.
            target_id:   ID of the intended recipient.
            signal_data: Arbitrary dict — signalType, sdp, candidate, etc.
        """
        room = self.rooms.get(room_id, {})
        target_ws = room.get(target_id)

        if not target_ws:
            logger.debug(
                "Relay target '%s' not found in room '%s' — dropped.",
                target_id, room_id,
            )
            return

        payload = {"type": "signal", "sender_id": sender_id, **signal_data}
        await self._send(target_ws, payload)

    # ─── Diagnostics ──────────────────────────────────────────────────────────

    @property
    def total_connections(self) -> int:
        """Total number of connected peers across all rooms."""
        return sum(len(peers) for peers in self.rooms.values())

    @property
    def room_count(self) -> int:
        """Number of active rooms."""
        return len(self.rooms)

    # ─── Internal ─────────────────────────────────────────────────────────────

    @staticmethod
    async def _send(websocket: WebSocket, payload: dict) -> None:
        """Send a JSON payload to a single WebSocket, swallowing transient errors."""
        try:
            await websocket.send_json(payload)
        except Exception as exc:
            logger.warning("Send failed: %s", exc)


# Module-level singleton — imported by main.py
manager = ConnectionManager()

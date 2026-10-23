"""
signaling.py — Production WebRTC signaling hub with ConnectionManager.

Architecture:
  - ConnectionManager owns a dict of rooms: Dict[str, Dict[str, WebSocket]]
    mapping room_id → { client_id: WebSocket }.
  - connect()      : accept socket, register peer, broadcast peer-joined.
  - disconnect()   : remove peer, GC empty rooms, broadcast peer-left.
  - relay_signal() : forward SDP offer/answer/ICE directly to a named peer.
  - No media ever transits the server — purely a TURN-free relay.

Message Protocol (server → client):
  { "type": "peer-joined", "peerId": "<id>", "peers": ["<existing_id>", ...] }
  { "type": "peer-left",   "peerId": "<id>" }
  { "type": "signal",      "fromId": "<id>", "signalType": "offer|answer|candidate",
                           "sdp": "...",  "candidate": {...} }
  { "type": "pong" }
"""

import logging
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
        Accept the WebSocket, register the peer in its room, then broadcast
        a `peer-joined` payload so all existing peers can initiate offers.

        The joining peer receives the full list of existing peer IDs so it
        knows who to expect offers from. Existing peers each receive a
        `peer-joined` with only the newcomer's ID so they send her an offer.

        Args:
            websocket: The connecting peer's WebSocket.
            room_id:   Identifier of the room to join.
            client_id: Unique identifier for this peer (generated client-side).
        """
        await websocket.accept()

        # Snapshot existing peers before registering the newcomer
        room = self.rooms.setdefault(room_id, {})
        existing_peer_ids = list(room.keys())

        # Register
        room[client_id] = websocket
        logger.info(
            "Peer %s joined room '%s' (%d peer(s) now)",
            client_id, room_id, len(room),
        )

        # Send the newcomer the list of existing peers.
        # The client uses this list to know who will initiate offers to her.
        await self._send(websocket, {
            "type":   "peer-joined",
            "peerId": client_id,
            "peers":  existing_peer_ids,
        })

        # Notify each existing peer of the newcomer.
        # Existing peers are the initiators — they will each create an offer.
        for existing_id, existing_ws in list(room.items()):
            if existing_id != client_id:
                await self._send(existing_ws, {
                    "type":   "peer-joined",
                    "peerId": client_id,
                    "peers":  [client_id],
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
        payload = {"type": "peer-left", "peerId": client_id}
        for peer_id, ws in list(room.items()):
            await self._send(ws, payload)

    # ─── Signal Relay ─────────────────────────────────────────────────────────

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

        The `fromId` field is injected server-side so clients cannot spoof
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

        payload = {"type": "signal", "fromId": sender_id, **signal_data}
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

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
from uuid import uuid4

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
        self.peer_names: Dict[str, Dict[str, str]] = {}
        self.peer_users: Dict[str, Dict[str, str]] = {}
        self.muted_peers: Dict[str, set[str]] = {}
        self.room_hosts: Dict[str, str] = {}
        self.room_host_users: Dict[str, str] = {}
        self.waiting: Dict[str, Dict[str, tuple[WebSocket, str, str]]] = {}
        self.kicked_users: Dict[str, set[str]] = {}
        self.invalidated_rooms: set[str] = set()
        self.raised_hands: Dict[str, set[str]] = {}
        self.polls: Dict[str, Dict[str, dict]] = {}
        self.questions: Dict[str, Dict[str, dict]] = {}
        self.question_votes: Dict[str, Dict[str, set[str]]] = {}

    # ─── Lifecycle ────────────────────────────────────────────────────────────

    async def connect(
        self,
        websocket: WebSocket,
        room_id: str,
        client_id: str,
        display_name: str = "Guest",
        user_id: str = "",
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

        clean_name = " ".join(
            "".join(char for char in display_name if char.isprintable()).split()
        )[:24] or "Guest"

        if room_id in self.invalidated_rooms:
            await self._send(websocket, {
                "type": "room-invalid",
                "message": "This meeting link is no longer valid.",
            })
            await websocket.close(code=4004, reason="Meeting link is invalid")
            return

        room = self.rooms.get(room_id)
        if room:
            was_kicked = bool(user_id and user_id in self.kicked_users.get(room_id, set()))
            existing_id = next(
                (peer_id for peer_id, peer_user in self.peer_users.get(room_id, {}).items()
                 if peer_user and peer_user == user_id),
                None,
            )
            if (
                user_id
                and user_id == self.room_host_users.get(room_id)
                and not existing_id
            ):
                room[client_id] = websocket
                self.peer_names.setdefault(room_id, {})[client_id] = clean_name
                self.peer_users.setdefault(room_id, {})[client_id] = user_id
                self.room_hosts[room_id] = client_id
                await self._send(websocket, {
                    "type": "room-users",
                    "peers": list(room.keys())[:-1],
                    "peer_names": {
                        peer_id: self.peer_names.get(room_id, {}).get(peer_id, "Guest")
                        for peer_id in room if peer_id != client_id
                    },
                    "host_id": client_id,
                    "muted_peers": list(self.muted_peers.get(room_id, set())),
                })
                return
            if existing_id and not was_kicked:
                room[existing_id] = websocket
                self.peer_names.setdefault(room_id, {})[existing_id] = clean_name
                await self._send(websocket, {
                    "type": "room-users",
                    "peers": [peer_id for peer_id in room if peer_id != existing_id],
                    "peer_names": {
                        peer_id: self.peer_names.get(room_id, {}).get(peer_id, "Guest")
                        for peer_id in room if peer_id != existing_id
                    },
                    "host_id": self.room_hosts.get(room_id),
                    "muted_peers": list(self.muted_peers.get(room_id, set())),
                })
                return
            if room_id in self.invalidated_rooms:
                await self._send(websocket, {
                    "type": "room-invalid",
                    "message": "This meeting link is no longer valid.",
                })
                await websocket.close(code=4004, reason="Meeting link is invalid")
                return
            waiting = self.waiting.setdefault(room_id, {})
            waiting[client_id] = (websocket, clean_name, user_id)
            await self._send(websocket, {"type": "waiting-room"})
            host_socket = room.get(self.room_hosts.get(room_id, ""))
            if host_socket:
                await self._send(host_socket, {
                    "type": "admission-request",
                    "peer_id": client_id,
                    "peer_name": clean_name,
                })
            return

        room = self.rooms.setdefault(room_id, {})
        names = self.peer_names.setdefault(room_id, {})
        users = self.peer_users.setdefault(room_id, {})
        self.room_hosts[room_id] = client_id
        self.room_host_users[room_id] = user_id
        muted_peers = self.muted_peers.setdefault(room_id, set())
        self.raised_hands.setdefault(room_id, set())
        self.polls.setdefault(room_id, {})
        self.questions.setdefault(room_id, {})
        self.question_votes.setdefault(room_id, {})

        # Register newcomer
        room[client_id] = websocket
        names[client_id] = clean_name
        users[client_id] = user_id
        logger.info(
            "Peer %s joined room '%s' (%d peer(s) now)",
            client_id, room_id, len(room),
        )

        # Tell the joiner who is already in the room
        await self._send(websocket, {
            "type":        "room-users",
            "peers":       [],
            "peer_names":  {},
            "host_id":     client_id,
            "muted_peers": list(muted_peers),
        })

    @staticmethod
    def _clean_name(display_name: object) -> str:
        return " ".join(
            "".join(char for char in str(display_name) if char.isprintable()).split()
        )[:24] or "Guest"

    async def update_display_name(
        self,
        room_id: str,
        client_id: str,
        display_name: object,
    ) -> bool:
        room = self.rooms.get(room_id, {})
        if client_id not in room:
            return False
        name = self._clean_name(display_name)
        names = self.peer_names.setdefault(room_id, {})
        if names.get(client_id) == name:
            return True
        names[client_id] = name
        payload = {"type": "participant-renamed", "peer_id": client_id, "peer_name": name}
        for websocket in list(room.values()):
            await self._send(websocket, payload)
        return True

    async def broadcast_caption(
        self,
        room_id: str,
        sender_id: str,
        text: object,
        is_final: bool,
    ) -> bool:
        room = self.rooms.get(room_id, {})
        if sender_id not in room:
            return False
        clean_text = " ".join(str(text).split())[:240]
        if not clean_text:
            return False
        payload = {
            "type": "caption",
            "peer_id": sender_id,
            "speaker_name": self.peer_names.get(room_id, {}).get(sender_id, "Guest"),
            "text": clean_text,
            "is_final": bool(is_final),
        }
        for websocket in list(room.values()):
            await self._send(websocket, payload)
        return True

    async def decide_admission(
        self,
        room_id: str,
        sender_id: str,
        target_id: str,
        admit: bool,
    ) -> bool:
        """Admit or deny a waiting peer, allowing only the active room host."""
        room = self.rooms.get(room_id, {})
        if self.room_hosts.get(room_id) != sender_id:
            return False

        waiting = self.waiting.get(room_id, {})
        pending = waiting.pop(target_id, None)
        if pending is None:
            return False
        if not waiting:
            self.waiting.pop(room_id, None)

        target_ws, target_name, target_user = pending
        if not admit:
            await self._send(target_ws, {"type": "admission-denied"})
            try:
                await target_ws.close(code=4003, reason="Admission denied")
            except Exception as exc:
                logger.warning("Could not close denied peer '%s': %s", target_id, exc)
            return True

        peer_ids = list(room.keys())
        names = self.peer_names.setdefault(room_id, {})
        room[target_id] = target_ws
        names[target_id] = target_name
        self.peer_users.setdefault(room_id, {})[target_id] = target_user
        self.kicked_users.get(room_id, set()).discard(target_user)
        await self._send(target_ws, {"type": "admitted"})
        await self._send(target_ws, {
            "type": "room-users",
            "peers": peer_ids,
            "peer_names": {peer_id: names.get(peer_id, "Guest") for peer_id in peer_ids},
            "host_id": self.room_hosts.get(room_id),
            "muted_peers": list(self.muted_peers.get(room_id, set())),
        })

        for peer_id, peer_ws in list(room.items()):
            if peer_id != target_id:
                await self._send(peer_ws, {
                    "type": "peer-joined",
                    "peer_id": target_id,
                    "peer_name": target_name,
                })
        return True

    async def disconnect(
        self,
        room_id: str,
        client_id: str,
        websocket: WebSocket | None = None,
    ) -> bool:
        """
        Remove a peer from the active room or waiting queue.

        Args:
            room_id:   Room the peer is leaving.
            client_id: The departing peer's ID.
        """
        room = self.rooms.get(room_id, {})
        waiting = self.waiting.get(room_id, {})
        if client_id in waiting:
            if websocket is not None and waiting[client_id][0] is not websocket:
                return False
            waiting.pop(client_id, None)
            if not waiting:
                self.waiting.pop(room_id, None)
            host_socket = room.get(self.room_hosts.get(room_id, ""))
            if host_socket:
                await self._send(host_socket, {
                    "type": "admission-cancelled",
                    "peer_id": client_id,
                })
            return False

        if client_id not in room or (
            websocket is not None and room[client_id] is not websocket
        ):
            return False

        departing_user = self.peer_users.get(room_id, {}).get(client_id, "")
        was_host = self.room_hosts.get(room_id) == client_id
        room.pop(client_id, None)
        names = self.peer_names.get(room_id, {})
        names.pop(client_id, None)
        self.peer_users.get(room_id, {}).pop(client_id, None)
        self.muted_peers.get(room_id, set()).discard(client_id)

        if not room:
            if was_host:
                self.invalidated_rooms.add(room_id)
            self.rooms.pop(room_id, None)
            self.peer_names.pop(room_id, None)
            self.peer_users.pop(room_id, None)
            self.muted_peers.pop(room_id, None)
            self.raised_hands.pop(room_id, None)
            self.polls.pop(room_id, None)
            self.questions.pop(room_id, None)
            self.question_votes.pop(room_id, None)
            self.room_hosts.pop(room_id, None)
            self.room_host_users.pop(room_id, None)
            self.kicked_users.pop(room_id, None)
            logger.info("Room '%s' is empty — removed.", room_id)
        else:
            if was_host:
                self.invalidated_rooms.add(room_id)
                self.room_host_users[room_id] = departing_user
                self.room_hosts[room_id] = next(iter(room))
                waiting = self.waiting.pop(room_id, {})
                for waiting_ws, _, _ in waiting.values():
                    await self._send(waiting_ws, {
                        "type": "room-closed",
                        "message": "The host left before you were admitted.",
                    })
                    try:
                        await waiting_ws.close(code=4004, reason="Host left the room")
                    except Exception as exc:
                        logger.warning("Could not close waiting peer: %s", exc)

        logger.info("Peer %s left room '%s'.", client_id, room_id)
        return True

    # ─── Broadcast ────────────────────────────────────────────────────────────

    async def broadcast_peer_left(self, room_id: str, client_id: str) -> None:
        """
        Notify remaining peers that `client_id` has left the room.

        Args:
            room_id:   The room the peer left.
            client_id: The ID of the departed peer.
        """
        room = self.rooms.get(room_id, {})
        if not room:
            waiting = self.waiting.pop(room_id, {})
            for waiting_ws, _, _ in waiting.values():
                await self._send(waiting_ws, {"type": "admission-denied"})
                try:
                    await waiting_ws.close(code=4003, reason="Host left the room")
                except Exception as exc:
                    logger.warning("Could not close waiting peer: %s", exc)
            return

        payload = {
            "type": "peer-left",
            "peer_id": client_id,
            "host_id": self.room_hosts.get(room_id),
        }
        for peer_id, ws in list(room.items()):
            await self._send(ws, payload)

        new_host = self.room_hosts.get(room_id)
        if new_host and new_host != client_id and room_id not in self.invalidated_rooms:
            host_socket = room.get(new_host)
            if host_socket:
                for waiting_id, (_, waiting_name, _) in self.waiting.get(room_id, {}).items():
                    await self._send(host_socket, {
                        "type": "admission-request",
                        "peer_id": waiting_id,
                        "peer_name": waiting_name,
                    })

    async def set_peer_muted(
        self,
        room_id: str,
        sender_id: str,
        target_id: str,
        muted: bool,
    ) -> bool:
        """Apply and broadcast host-only remote audio moderation."""
        room = self.rooms.get(room_id, {})
        if not room or self.room_hosts.get(room_id) != sender_id or target_id not in room or target_id == sender_id:
            return False

        muted_peers = self.muted_peers.setdefault(room_id, set())
        if muted:
            muted_peers.add(target_id)
        else:
            muted_peers.discard(target_id)

        payload = {"type": "participant-mute", "peer_id": target_id, "muted": muted}
        for websocket in list(room.values()):
            await self._send(websocket, payload)
        return True

    async def set_hand_raised(self, room_id: str, sender_id: str, raised: bool) -> bool:
        """Validate and broadcast a participant's hand state."""
        room = self.rooms.get(room_id, {})
        if sender_id not in room or not isinstance(raised, bool):
            return False
        hands = self.raised_hands.setdefault(room_id, set())
        (hands.add if raised else hands.discard)(sender_id)
        await self._broadcast(room, {
            "type": "raise-hand",
            "peer_id": sender_id,
            "raised": raised,
        })
        return True

    async def broadcast_reaction(self, room_id: str, sender_id: str, emoji: str) -> bool:
        """Broadcast a bounded, non-empty emoji reaction."""
        room = self.rooms.get(room_id, {})
        if sender_id not in room or not isinstance(emoji, str):
            return False
        emoji = emoji.strip()
        if not emoji or len(emoji) > 16 or any(ord(char) < 32 for char in emoji):
            return False
        await self._broadcast(room, {
            "type": "emoji-reaction",
            "peer_id": sender_id,
            "emoji": emoji,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        return True

    async def mute_all(self, room_id: str, sender_id: str, muted: bool) -> bool:
        """Apply host-only mute-all moderation and notify every participant."""
        room = self.rooms.get(room_id, {})
        if (
            sender_id not in room
            or self.room_hosts.get(room_id) != sender_id
            or not isinstance(muted, bool)
        ):
            return False
        targets = set(room) - {sender_id}
        muted_peers = self.muted_peers.setdefault(room_id, set())
        if muted:
            muted_peers.update(targets)
        else:
            muted_peers.difference_update(targets)
        await self._broadcast(room, {
            "type": "mute-all",
            "sender_id": sender_id,
            "muted": muted,
            "peer_ids": sorted(targets),
        })
        for target_id in targets:
            await self._broadcast(room, {
                "type": "participant-mute",
                "peer_id": target_id,
                "muted": muted,
            })
        return True

    async def create_poll(
        self, room_id: str, sender_id: str, poll_id: str, question: str, options: object
    ) -> bool:
        """Create a host-owned poll after validating its shape and size."""
        room = self.rooms.get(room_id, {})
        if (
            sender_id not in room
            or self.room_hosts.get(room_id) != sender_id
            or not isinstance(poll_id, str)
            or not isinstance(question, str)
            or not isinstance(options, list)
        ):
            return False
        poll_id, question = poll_id.strip()[:64], " ".join(question.split())[:240]
        clean_options = [
            " ".join(item.split())[:80] for item in options
            if isinstance(item, str) and item.strip()
        ]
        if (
            not poll_id or not question or not 2 <= len(clean_options) <= 10
            or len(set(clean_options)) != len(clean_options)
        ):
            return False
        polls = self.polls.setdefault(room_id, {})
        if poll_id in polls:
            return False
        polls[poll_id] = {"question": question, "options": clean_options, "votes": {}}
        await self._broadcast(room, {
            "type": "poll-created", "poll_id": poll_id, "question": question,
            "options": clean_options, "creator_id": sender_id,
        })
        return True

    async def vote_poll(self, room_id: str, sender_id: str, poll_id: str, option_index: object) -> bool:
        room = self.rooms.get(room_id, {})
        poll = self.polls.get(room_id, {}).get(poll_id)
        if (
            sender_id not in room or not isinstance(poll_id, str)
            or poll is None or not isinstance(option_index, int)
            or isinstance(option_index, bool)
            or not 0 <= option_index < len(poll["options"])
            or sender_id in poll["votes"]
        ):
            return False
        poll["votes"][sender_id] = option_index
        await self._broadcast(room, {
            "type": "poll-vote", "poll_id": poll_id,
            "voter_id": sender_id, "option_index": option_index,
        })
        return True

    async def close_poll(self, room_id: str, sender_id: str, poll_id: str) -> bool:
        room = self.rooms.get(room_id, {})
        if (
            sender_id not in room or self.room_hosts.get(room_id) != sender_id
            or not isinstance(poll_id, str)
            or poll_id not in self.polls.get(room_id, {})
        ):
            return False
        poll = self.polls[room_id].pop(poll_id)
        await self._broadcast(room, {
            "type": "poll-closed", "poll_id": poll_id,
            "results": list(poll["votes"].values()), "closed_by": sender_id,
        })
        return True

    async def submit_question(self, room_id: str, sender_id: str, text: str) -> bool:
        room = self.rooms.get(room_id, {})
        if sender_id not in room or not isinstance(text, str):
            return False
        text = " ".join(text.split())[:500]
        if not text:
            return False
        question_id = uuid4().hex
        self.questions.setdefault(room_id, {})[question_id] = {
            "text": text, "answered": False, "author_id": sender_id,
        }
        await self._broadcast(room, {
            "type": "question-submitted", "question_id": question_id,
            "text": text, "author_id": sender_id,
        })
        return True

    async def answer_question(
        self, room_id: str, sender_id: str, question_id: str, answered: bool
    ) -> bool:
        room = self.rooms.get(room_id, {})
        question = (
            self.questions.get(room_id, {}).get(question_id)
            if isinstance(question_id, str) else None
        )
        if (
            sender_id not in room or self.room_hosts.get(room_id) != sender_id
            or question is None or not isinstance(answered, bool)
        ):
            return False
        question["answered"] = answered
        await self._broadcast(room, {
            "type": "question-answered", "question_id": question_id,
            "answered": answered, "answered_by": sender_id,
        })
        return True

    async def broadcast_notification(
        self, room_id: str, sender_id: str, title: str, body: str
    ) -> bool:
        room = self.rooms.get(room_id, {})
        if sender_id not in room or not isinstance(title, str) or not isinstance(body, str):
            return False
        title, body = " ".join(title.split())[:120], " ".join(body.split())[:500]
        if not title or not body:
            return False
        await self._broadcast(room, {
            "type": "browser-notification", "sender_id": sender_id,
            "title": title, "body": body,
        })
        return True

    async def kick_peer(self, room_id: str, sender_id: str, target_id: str) -> bool:
        """Disconnect a participant when the current room host removes them."""
        room = self.rooms.get(room_id, {})
        target = room.get(target_id)
        if not room or self.room_hosts.get(room_id) != sender_id or not target or target_id == sender_id:
            return False

        target_user = self.peer_users.get(room_id, {}).get(target_id)
        if target_user:
            self.kicked_users.setdefault(room_id, set()).add(target_user)
        await self._send(target, {"type": "peer-kicked"})
        try:
            await target.close(code=4001, reason="Removed by host")
        except Exception as exc:
            logger.warning("Could not close removed peer '%s': %s", target_id, exc)
        return True

    async def broadcast_chat(
        self,
        room_id: str,
        sender_id: str,
        payload: dict,
    ) -> dict | None:
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
        if sender_id not in room:
            return None
        text = " ".join(str(payload.get("text", "")).split())[:500]
        if not text:
            return None
        enriched = {
            "type":      "chat-message",
            "sender_id": sender_id,
            "sender_name": self.peer_names.get(room_id, {}).get(sender_id, "Guest"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "text": text,
        }
        reply_to = payload.get("reply_to")
        if isinstance(reply_to, dict):
            reply_text = " ".join(str(reply_to.get("text", "")).split())[:500]
            if reply_text:
                enriched["reply_to"] = {
                    "sender_name": self._clean_name(reply_to.get("sender_name", "Guest")),
                    "text": reply_text,
                }
        for ws in list(room.values()):
            await self._send(ws, enriched)
        return enriched

    async def broadcast_screen_share_stopped(self, room_id: str, sender_id: str) -> None:
        room = self.rooms.get(room_id, {})
        if sender_id not in room:
            return
        payload = {"type": "screen-share-stop", "peer_id": sender_id}
        for websocket in list(room.values()):
            await self._send(websocket, payload)

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
        if sender_id not in room:
            return
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
        if sender_id not in room:
            return
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
    async def _broadcast(room: Dict[str, WebSocket], payload: dict) -> None:
        for websocket in list(room.values()):
            await ConnectionManager._send(websocket, payload)

    @staticmethod
    async def _send(websocket: WebSocket, payload: dict) -> None:
        """Send a JSON payload to a single WebSocket, swallowing transient errors."""
        try:
            await websocket.send_json(payload)
        except Exception as exc:
            logger.warning("Send failed: %s", exc)


# Module-level singleton — imported by main.py
manager = ConnectionManager()

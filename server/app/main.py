"""
main.py — FastAPI application entry point for Worship Audio Room.

Routes (order matters — API routes registered before static mount):
  GET  /health                     → Liveness probe for Render/cloud health checks.
  WS   /ws/{room_id}/{client_id}  → WebRTC signaling relay (delegates to ConnectionManager).
  GET  /*                          → Static frontend files served from client/.

CORS uses the explicit origins configured through ALLOWED_ORIGINS. The default
wildcard keeps the app same-origin-only for credentialed requests.
"""

import base64
import hashlib
import hmac
import logging
from pathlib import Path
import time
from urllib.parse import urlparse

from authlib.integrations.starlette_client import OAuth
from authlib.integrations.base_client.errors import OAuthError
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.id_token import verify_oauth2_token
from starlette.middleware.sessions import SessionMiddleware

from .config import settings
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
# The default wildcard is treated as same-origin-only for credentialed HTTP
# requests. Configure explicit origins when serving the frontend elsewhere.
_configured_origins = [
    origin.strip().rstrip("/")
    for origin in settings.allowed_origins.split(",")
    if origin.strip() and origin.strip() != "*"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_configured_origins,
    allow_credentials=bool(_configured_origins),
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    session_cookie="worship_session",
    max_age=60 * 60 * 24 * 7,
    same_site="lax",
    https_only=settings.session_cookie_secure,
)

oauth = OAuth()
if settings.google_client_id and settings.google_client_secret:
    oauth.register(
        name="google",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
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


@app.get("/auth/me", tags=["auth"])
async def current_user(request: Request) -> JSONResponse:
    response = JSONResponse({"user": request.session.get("user")})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/auth/config", tags=["auth"], summary="Return public authentication configuration")
async def auth_config() -> JSONResponse:
    return JSONResponse({
        "google_client_id": settings.google_client_id,
        "google_oauth_enabled": bool(
            settings.google_client_id and settings.google_client_secret
        ),
    })


@app.post("/api/auth/google", tags=["auth"], summary="Verify Google ID token (GIS client-side flow)")
async def api_auth_google(request: Request) -> JSONResponse:
    """
    Accepts a Google ID token (JWT credential) from the Google Identity Services
    client-side sign-in flow.  Decodes the payload and creates a server-side
    session so the WebSocket and ICE-server endpoints accept the user.

    Request body: { "credential": "<JWT>" }
    Response:     { "sub", "name", "email", "picture" }
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    credential = body.get("credential")
    if not isinstance(credential, str) or not credential:
        raise HTTPException(status_code=400, detail="Missing 'credential' field.")
    if not settings.google_client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")

    try:
        payload = verify_oauth2_token(
            credential,
            GoogleAuthRequest(),
            settings.google_client_id,
        )
    except (GoogleAuthError, ValueError) as exc:
        logger.warning("Google ID token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid Google credential.")

    subject = payload.get("sub")
    email = payload.get("email", "")
    name = payload.get("name") or email or "Participant"
    picture = payload.get("picture", "")

    if not subject:
        raise HTTPException(status_code=401, detail="Token missing subject (sub) claim.")

    # Persist into the server-side session (same shape as the redirect flow)
    user_data = {
        "sub": str(subject),
        "name": str(name)[:80],
        "email": str(email)[:254],
        "picture": str(picture)[:2048],
    }
    request.session["user"] = user_data

    return JSONResponse(user_data)


@app.get("/auth/google", tags=["auth"], name="google_login")
async def google_login(request: Request):
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")

    next_path = request.query_params.get("next", "/")
    parsed_next = urlparse(next_path)
    if not next_path.startswith("/") or next_path.startswith("//") or parsed_next.netloc:
        next_path = "/"
    request.session["auth_next"] = next_path
    return await oauth.google.authorize_redirect(
        request,
        request.url_for("google_callback"),
    )


@app.get("/auth/google/callback", tags=["auth"], name="google_callback")
async def google_callback(request: Request):
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")

    try:
        token = await oauth.google.authorize_access_token(request)
        profile = token.get("userinfo")
        if profile is None:
            profile = await oauth.google.parse_id_token(request, token)
    except (OAuthError, ValueError, KeyError, TypeError):
        logger.exception("Google OAuth callback failed")
        return RedirectResponse("/?auth=error")

    subject = profile.get("sub")
    if not subject:
        raise HTTPException(status_code=401, detail="Google did not return a verified account.")
    if profile.get("email") and profile.get("email_verified") is False:
        raise HTTPException(status_code=401, detail="A verified Google email is required.")

    request.session["user"] = {
        "sub": str(subject),
        "name": str(profile.get("name") or profile.get("email") or "Participant")[:80],
        "email": str(profile.get("email") or "")[:254],
        "picture": str(profile.get("picture") or "")[:2048],
    }
    next_path = request.session.pop("auth_next", "/")
    destination = next_path if next_path.startswith("/") and not next_path.startswith("//") else "/"
    separator = "&" if "?" in destination else "?"
    return RedirectResponse(f"{destination}{separator}auth=success")


@app.post("/auth/logout", tags=["auth"])
async def logout(request: Request) -> JSONResponse:
    request.session.clear()
    return JSONResponse({"ok": True})


@app.get("/api/ice-servers", tags=["realtime"])
async def ice_servers(request: Request) -> JSONResponse:
    user = request.session.get("user")
    if not isinstance(user, dict) or not user.get("sub"):
        raise HTTPException(status_code=401, detail="Sign in required.")

    servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]
    turn_urls = [value.strip() for value in settings.turn_urls.split(",") if value.strip()]
    valid_turn_urls = []
    for value in turn_urls:
        parsed = urlparse(value)
        authority = urlparse(f"//{parsed.path}")
        if parsed.scheme.lower() in ("turn", "turns") and authority.hostname:
            valid_turn_urls.append(value)
    turn_urls = valid_turn_urls
    if turn_urls and settings.turn_shared_secret:
        ttl = min(max(settings.turn_credential_ttl_seconds, 300), 86400)
        username = f"{int(time.time()) + ttl}:{user['sub']}"
        credential = base64.b64encode(
            hmac.new(
                settings.turn_shared_secret.encode("utf-8"),
                username.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")
        servers.append({"urls": turn_urls, "username": username, "credential": credential})
    elif turn_urls:
        logger.warning("TURN URLs are configured without TURN_SHARED_SECRET; omitting TURN servers.")

    return JSONResponse({"iceServers": servers})


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
    origin = websocket.headers.get("origin")
    if origin:
        host = websocket.headers.get("host", "")
        forwarded_proto = websocket.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        scheme = "https" if forwarded_proto == "https" or websocket.url.scheme == "wss" else "http"
        allowed_origins = {
            f"{scheme}://{host}".rstrip("/"),
            *(
                configured.strip().rstrip("/")
                for configured in settings.allowed_origins.split(",")
                if configured.strip() and configured.strip() != "*"
            ),
        }
        if origin.rstrip("/") not in allowed_origins:
            await websocket.close(code=4403, reason="Origin not allowed")
            return

    # WebSocket sessions are signed by SessionMiddleware; never trust a client-provided host/name.
    user = websocket.session.get("user")
    if not isinstance(user, dict) or not user.get("sub"):
        await websocket.close(code=4401, reason="Sign in required")
        return

    display_name = str(user.get("name") or user.get("email") or "Participant")
    await manager.connect(websocket, room_id, client_id, display_name, str(user["sub"]))
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
            if msg_type in (
                "offer", "answer", "ice-candidate", "ice-restart-request",
                "screen-offer", "screen-answer", "screen-ice-candidate",
            ):
                await manager.relay_rtc(
                    room_id=room_id,
                    sender_id=client_id,
                    msg_type=msg_type,
                    payload=data,
                )
                continue

            if msg_type == "screen-share-stop":
                await manager.broadcast_screen_share_stopped(room_id, client_id)
                continue

            # ── Chat broadcast ────────────────────────────────────────────────
            if msg_type == "chat-message":
                await manager.broadcast_chat(
                    room_id=room_id,
                    sender_id=client_id,
                    payload=data,
                )
                continue

            if msg_type == "set-display-name":
                display_name = data.get("display_name")
                if isinstance(display_name, str):
                    await manager.update_display_name(room_id, client_id, display_name)
                continue

            if msg_type == "caption":
                text = data.get("text")
                if isinstance(text, str):
                    await manager.broadcast_caption(
                        room_id, client_id, text, data.get("is_final") is True
                    )
                continue

            if msg_type == "mute-peer":
                target_id = data.get("target_id")
                if isinstance(target_id, str) and isinstance(data.get("muted"), bool):
                    await manager.set_peer_muted(
                        room_id, client_id, target_id, data["muted"]
                    )
                continue

            if msg_type == "kick-peer":
                target_id = data.get("target_id")
                if isinstance(target_id, str):
                    await manager.kick_peer(room_id, client_id, target_id)
                continue

            if msg_type == "admission-decision":
                target_id = data.get("target_id")
                admit = data.get("admit")
                if isinstance(target_id, str) and isinstance(admit, bool):
                    await manager.decide_admission(room_id, client_id, target_id, admit)
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
        was_active_peer = await manager.disconnect(room_id, client_id, websocket)
        if was_active_peer:
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

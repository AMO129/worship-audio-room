"""
main.py — FastAPI application entry point for Worship Audio Room.

Routes:
  GET  /         → Health check / static file serving.
  WS   /ws/signal/{room_id} → WebRTC signaling WebSocket endpoint.

Phase 1: Placeholder. Full room orchestration implemented in Phase 3.
"""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from .signaling import router as signaling_router
from .config import settings

# ─── App Factory ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="Worship Audio Room",
    description="Real-time virtual meeting platform with intelligent praise & worship audio deck.",
    version="0.1.0",
)

# ─── Routers ──────────────────────────────────────────────────────────────────

app.include_router(signaling_router)

# ─── Static Files ─────────────────────────────────────────────────────────────

CLIENT_DIR = Path(__file__).parents[2] / "client"

if CLIENT_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(CLIENT_DIR), html=True), name="static")

# ─── Health & Root ────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
async def health_check():
    """Returns server health status."""
    return {"status": "ok", "version": app.version}

@app.get("/", include_in_schema=False)
async def serve_root():
    """Serves the client index.html at the root path."""
    index = CLIENT_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return {"message": "Worship Audio Room API — client not built yet."}

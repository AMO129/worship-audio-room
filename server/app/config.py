"""
config.py — Application configuration via environment variables.

Uses Pydantic BaseSettings for typed, validated config.
Override any value by setting the corresponding environment variable.

Environment Variables:
  PORT          - Port FastAPI listens on (default: 8000).
  ALLOWED_ORIGINS - Comma-separated CORS origins (default: "*").
  MAX_ROOM_SIZE - Maximum peers per room (default: 12).
  LOG_LEVEL     - Python logging level (default: "INFO").
"""

import secrets

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Server
    port: int = 8000
    log_level: str = "INFO"

    # CORS — set to specific origins in production
    allowed_origins: str = "*"

    # Room limits
    max_room_size: int = 12

    # Authentication
    session_secret: str = Field(default_factory=lambda: secrets.token_urlsafe(32))
    session_cookie_secure: bool = False
    google_client_id: str | None = None
    google_client_secret: str | None = None

    # TURN REST credentials (coturn-compatible shared-secret mode)
    turn_urls: str = ""
    turn_shared_secret: str | None = None
    turn_credential_ttl_seconds: int = 3600


# Singleton settings instance imported by the rest of the app.
settings = Settings()

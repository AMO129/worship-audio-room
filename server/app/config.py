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


# Singleton settings instance imported by the rest of the app.
settings = Settings()

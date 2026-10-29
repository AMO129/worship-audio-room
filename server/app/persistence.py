"""Small optional PostgreSQL persistence layer for room state and chat."""

import logging
from datetime import datetime

logger = logging.getLogger(__name__)


class Persistence:
    def __init__(self, database_url: str | None) -> None:
        self.database_url = database_url
        self._pool = None
        self._unavailable_logged = False

    @property
    def enabled(self) -> bool:
        return bool(self.database_url)

    async def _get_pool(self):
        if not self.database_url:
            return None
        if self._pool is None:
            try:
                from psycopg_pool import AsyncConnectionPool
            except ImportError as exc:
                if not self._unavailable_logged:
                    logger.error("DATABASE_URL is set but psycopg_pool is unavailable: %s", exc)
                    self._unavailable_logged = True
                return None
            url = self.database_url.replace("postgres://", "postgresql://", 1)
            self._pool = AsyncConnectionPool(url, open=False, min_size=1, max_size=4)
            await self._pool.open()
            await self._initialize()
        return self._pool

    async def _initialize(self) -> None:
        async with self._pool.connection() as connection:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS worship_rooms (
                    room_id TEXT PRIMARY KEY,
                    host_user_id TEXT NOT NULL,
                    invalidated_at TIMESTAMPTZ
                )
                """
            )
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS worship_chat_messages (
                    id BIGSERIAL PRIMARY KEY,
                    room_id TEXT NOT NULL,
                    sender_user_id TEXT NOT NULL,
                    sender_name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await connection.execute(
                """
                CREATE INDEX IF NOT EXISTS worship_chat_room_created_idx
                ON worship_chat_messages (room_id, created_at DESC)
                """
            )
            await connection.commit()

    async def is_invalidated(self, room_id: str) -> bool:
        pool = await self._get_pool()
        if pool is None:
            return False
        async with pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT 1 FROM worship_rooms WHERE room_id = %s AND invalidated_at IS NOT NULL",
                (room_id,),
            )
            return await cursor.fetchone() is not None

    async def ensure_room(self, room_id: str, host_user_id: str) -> None:
        pool = await self._get_pool()
        if pool is None:
            return
        async with pool.connection() as connection:
            await connection.execute(
                """
                INSERT INTO worship_rooms (room_id, host_user_id)
                VALUES (%s, %s)
                ON CONFLICT (room_id) DO NOTHING
                """,
                (room_id, host_user_id),
            )
            await connection.commit()

    async def invalidate_room(self, room_id: str) -> None:
        pool = await self._get_pool()
        if pool is None:
            return
        async with pool.connection() as connection:
            await connection.execute(
                """
                UPDATE worship_rooms
                SET invalidated_at = COALESCE(invalidated_at, CURRENT_TIMESTAMP)
                WHERE room_id = %s
                """,
                (room_id,),
            )
            await connection.commit()

    async def save_chat(
        self,
        room_id: str,
        sender_user_id: str,
        sender_name: str,
        text: str,
        created_at: datetime,
    ) -> None:
        pool = await self._get_pool()
        if pool is None:
            return
        async with pool.connection() as connection:
            await connection.execute(
                """
                INSERT INTO worship_chat_messages
                    (room_id, sender_user_id, sender_name, text, created_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (room_id, sender_user_id, sender_name, text, created_at),
            )
            await connection.commit()

    async def recent_chat(self, room_id: str, limit: int = 100) -> list[dict]:
        pool = await self._get_pool()
        if pool is None:
            return []
        async with pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT sender_user_id, sender_name, text, created_at
                FROM worship_chat_messages
                WHERE room_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (room_id, min(max(limit, 1), 200)),
            )
            rows = await cursor.fetchall()
        return [
            {
                "sender_id": row[0],
                "sender_name": row[1],
                "text": row[2],
                "timestamp": row[3].isoformat(),
            }
            for row in reversed(rows)
        ]

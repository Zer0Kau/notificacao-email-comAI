"""Configuração do banco de dados SQLite com SQLAlchemy Async."""

import os
from datetime import datetime
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

# O caminho tem de ser absoluto e relativo ao projecto, não ao directório de
# trabalho. Com "./notifications.db" o ficheiro seguido depende de onde o
# processo arranca: o PM2 arrancava bem por acaso (tem cwd definido), mas
# qualquer outro arranque — manual, cron, container — abria silenciosamente
# uma BD vazia em vez de a existente. DATABASE_PATH permite apontar para
# outro sítio sem tocar em código.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("DATABASE_PATH") or _PROJECT_ROOT / "notifications.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


# Colunas adicionadas após a criação inicial da tabela, na ordem de aplicação.
# O SQLite só aceita um UPDATE numa coluna depois de a coluna existir, por isso
# o ALTER TABLE tem de preceder qualquer escrita.
_ADDED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("status", "TEXT NOT NULL DEFAULT 'open'"),
    ("resolved_at", "DATETIME"),
)


async def init_db() -> None:
    """Cria as tabelas em falta e aplica as migrações de esquema pendentes."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate(conn)


async def _migrate(conn) -> None:
    """Aplica migrações idempotentes — seguro correr em cada arranque."""
    existing = {
        row[1] for row in (await conn.execute(text("PRAGMA table_info(notifications)"))).all()
    }
    if not existing:
        return  # tabela ainda não existe; create_all já a criou com o esquema novo

    for column, ddl in _ADDED_COLUMNS:
        if column not in existing:
            await conn.execute(text(f"ALTER TABLE notifications ADD COLUMN {column} {ddl}"))

    # create_all só cria índices em tabelas novas — este precisa de ser explícito
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_notifications_status ON notifications (status)")
    )

    # ===== Archive do backlog importado =====
    # Quando APP_ARCHIVE_BACKLOG=true, arquiva UMA vez tudo o que estiver "open"
    # (histórico importado/migrado) para os contadores começarem do zero. Só corre
    # se ainda não houver nem arquivadas nem dados posteriores: a guarda
    # "nenhuma archived" garante que um reinício posterior não arquiva as novas.
    if os.environ.get("APP_ARCHIVE_BACKLOG", "").strip().lower() in ("1", "true", "yes"):
        archived = (
            await conn.execute(
                text("SELECT COUNT(*) FROM notifications WHERE status = 'archived'")
            )
        ).scalar_one()
        if archived == 0:
            changed = (
                await conn.execute(
                    text(
                        "UPDATE notifications SET status = 'archived',"
                        " resolved_at = :now WHERE status = 'open'"
                    ),
                    {"now": datetime.utcnow()},
                )
            ).rowcount
            if changed:
                print(f"[MIGRATE] Arquivadas {changed} notificações do backlog.")


async def get_session() -> AsyncSession:
    """Retorna uma sessão assíncrona do banco."""
    async with async_session() as session:
        yield session

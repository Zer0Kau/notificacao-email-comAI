"""Configuração do banco de dados SQLite com SQLAlchemy Async."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = "sqlite+aiosqlite:///./notifications.db"

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


async def get_session() -> AsyncSession:
    """Retorna uma sessão assíncrona do banco."""
    async with async_session() as session:
        yield session

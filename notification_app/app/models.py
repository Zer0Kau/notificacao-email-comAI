"""Modelos SQLAlchemy para o banco de dados."""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base

# Estados possíveis de uma notificação.
#   open       -> por tratar (estado inicial e valor por omissão)
#   resolved   -> concluída pelo operador (conta como trabalho executado)
#   discarded  -> dispensada, não é trabalho real (spam, duplicado, irrelevante)
NOTIFICATION_STATUSES = ("open", "resolved", "discarded")
STATUS_OPEN = "open"
STATUS_RESOLVED = "resolved"
STATUS_DISCARDED = "discarded"


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    sender: Mapped[str] = mapped_column(String(255), nullable=False)
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    rule_matched: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # server_default preenche as linhas já existentes sem reescrever a tabela
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=STATUS_OPEN, index=True
    )
    # instante em que saiu de "open" (NULL enquanto continuar por tratar)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PushSubscription(Base):
    """Armazena os endpoints de Web Push de cada dispositivo registado."""

    __tablename__ = "push_subscriptions"
    __table_args__ = (UniqueConstraint("endpoint", name="uq_push_endpoint"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # URL única do endpoint do browser (identifica o dispositivo)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    # Chaves de encriptação do cliente (JSON: {"p256dh": "...", "auth": "..."})
    keys_p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    keys_auth: Mapped[str] = mapped_column(Text, nullable=False)
    # User-agent opcional para auditoria
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )

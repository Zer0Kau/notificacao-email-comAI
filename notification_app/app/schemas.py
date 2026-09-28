"""Schemas Pydantic para validação e serialização."""

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, field_serializer


class NotificationBase(BaseModel):
    title: str
    message: str
    sender: str
    link: str | None = None
    rule_matched: str | None = None


class NotificationCreate(NotificationBase):
    pass


class NotificationOut(NotificationBase):
    id: int
    timestamp: datetime
    status: str = "open"
    resolved_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_serializer("timestamp", "resolved_at")
    def _serialise_utc(self, value: datetime | None) -> str | None:
        """Marca as datas como UTC.

        O SQLite devolve datetimes sem tzinfo. Sem isto o browser parseia a
        string como hora local e todos os horários aparecem deslocados no
        offset da máquina.
        """
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()


class NotificationStatusUpdate(BaseModel):
    """Alteração de estado de uma notificação.

    resolved  -> concluída (conta como trabalho executado)
    discarded -> dispensada (não é trabalho real)
    open      -> volta a ficar por tratar e limpa o resolved_at
    """

    status: Literal["open", "resolved", "discarded"]

"""Schemas Pydantic para validação e serialização."""

from datetime import datetime

from pydantic import BaseModel


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

    model_config = {"from_attributes": True}

"""FastAPI — Entry point, rotas SSE e lifecycle da aplicação."""

import asyncio
import io
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic_settings import BaseSettings
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select

from .database import async_session, init_db
from .mail_worker import imap_idle_worker
from .models import Notification
from .schemas import NotificationOut

load_dotenv()

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
)

# Silencia logs internos de bibliotecas
for _lib in ("httpcore", "httpx", "asyncio", "urllib3", "imapclient", "sqlalchemy.engine"):
    logging.getLogger(_lib).setLevel(logging.WARNING)


# ============================================
# Configurações via variáveis de ambiente
# ============================================
class Settings(BaseSettings):
    IMAP_HOST: str = "imap.exemplo.com"
    IMAP_PORT: int = 993
    IMAP_USER: str = ""
    IMAP_PASSWORD: str = ""
    IMAP_FOLDERS: str = "INBOX"
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    IMAP_RECONNECT_DELAY: int = 5
    IMAP_IDLE_TIMEOUT: int = 300
    ZABBIX_SENDER: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def imap_folder_list(self) -> list[str]:
        """Retorna a lista de pastas IMAP a monitorar."""
        return [f.strip() for f in self.IMAP_FOLDERS.split(",") if f.strip()]


settings = Settings()

# Fila de notificações compartilhada entre o worker e os clientes SSE
notification_queue: asyncio.Queue = asyncio.Queue()

# Set de queues dos clientes SSE conectados (fan-out)
sse_clients: set[asyncio.Queue] = set()

# Evento de shutdown — sinaliza SSE generators para encerrar
shutdown_event: asyncio.Event = asyncio.Event()


# ============================================
# Lifecycle — inicia DB e worker IMAP
# ============================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Banco de dados inicializado.")

    # Task de fan-out: distribui mensagens da fila principal para cada cliente SSE
    async def fanout():
        while True:
            data = await notification_queue.get()
            dead: list[asyncio.Queue] = []
            for client_q in sse_clients.copy():
                try:
                    client_q.put_nowait(data)
                except asyncio.QueueFull:
                    dead.append(client_q)
            for d in dead:
                sse_clients.discard(d)

    fanout_task = asyncio.create_task(fanout())

    # Inicia um worker IMAP IDLE para cada pasta configurada
    folders = settings.imap_folder_list
    worker_tasks: list[asyncio.Task] = []
    for folder in folders:
        task = asyncio.create_task(
            imap_idle_worker(
                host=settings.IMAP_HOST,
                port=settings.IMAP_PORT,
                user=settings.IMAP_USER,
                password=settings.IMAP_PASSWORD,
                folder=folder,
                queue=notification_queue,
                idle_timeout=settings.IMAP_IDLE_TIMEOUT,
                reconnect_delay=settings.IMAP_RECONNECT_DELAY,
                zabbix_sender=settings.ZABBIX_SENDER,
            )
        )
        worker_tasks.append(task)

    logger.info("Workers IMAP iniciados para pastas: %s", folders)
    yield

    logger.info("Iniciando shutdown...")
    shutdown_event.set()
    # Desbloqueia todos os SSE generators colocando None na fila
    for cq in sse_clients.copy():
        try:
            cq.put_nowait(None)
        except asyncio.QueueFull:
            pass
    for t in worker_tasks:
        t.cancel()
    fanout_task.cancel()
    for t in worker_tasks:
        try:
            await asyncio.wait_for(t, timeout=3)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
    try:
        await asyncio.wait_for(fanout_task, timeout=1)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass
    logger.info("Shutdown concluído.")


# ============================================
# App FastAPI
# ============================================
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(
    title="Middleware de Notificações Web",
    version="1.0.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ============================================
# Rotas
# ============================================
@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve a página principal."""
    html_path = STATIC_DIR / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.get("/api/notifications")
async def get_notifications(limit: int = 50):
    """Retorna o histórico de notificações (mais recentes primeiro)."""
    async with async_session() as session:
        stmt = (
            select(Notification)
            .order_by(Notification.timestamp.desc())
            .limit(limit)
        )
        result = await session.execute(stmt)
        rows = result.scalars().all()
    return [NotificationOut.model_validate(r).model_dump(mode="json") for r in rows]


@app.get("/api/notifications/history")
async def get_notification_history(limit: int = 50):
    """Retorna as últimas N notificações do banco (DESC por timestamp)."""
    async with async_session() as session:
        stmt = (
            select(Notification)
            .order_by(Notification.timestamp.desc())
            .limit(min(limit, 200))
        )
        result = await session.execute(stmt)
        rows = result.scalars().all()
    return [NotificationOut.model_validate(r).model_dump(mode="json") for r in rows]


@app.get("/api/stream")
async def sse_stream(request: Request):
    """Endpoint SSE — cada cliente recebe notificações em tempo real."""
    client_queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    sse_clients.add(client_queue)

    async def event_generator():
        try:
            yield {"event": "ping", "data": ""}

            while not shutdown_event.is_set():
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(client_queue.get(), timeout=5)
                    if data is None:
                        break  # Sinal de shutdown
                    yield {
                        "event": "notification",
                        "data": json.dumps(data, ensure_ascii=False),
                    }
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        except asyncio.CancelledError:
            pass
        finally:
            sse_clients.discard(client_queue)

    return EventSourceResponse(event_generator())


EDGE_TTS_VOICE = "pt-BR-FranciscaNeural"


@app.get("/api/tts")
async def tts_audio(text: str):
    """Gera áudio TTS usando Edge TTS (voz Francisca)."""
    if not text or len(text) > 500:
        return {"error": "Texto inválido ou muito longo (max 500 chars)"}

    communicate = edge_tts.Communicate(text, EDGE_TTS_VOICE)
    audio_buffer = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_buffer.write(chunk["data"])

    audio_buffer.seek(0)
    return StreamingResponse(
        audio_buffer,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-cache"},
    )


@app.post("/api/test-notification")
async def create_test_notification():
    """Cria uma notificação de teste para validar o fluxo SSE."""
    from datetime import datetime

    test_data = {
        "title": "🔔 Notificação de Teste",
        "message": "Esta é uma notificação de teste gerada manualmente para validar o sistema.",
        "sender": "sistema@teste.local",
        "link": None,
        "rule_matched": "Teste Manual",
    }

    async with async_session() as session:
        db_notif = Notification(
            title=test_data["title"],
            message=test_data["message"],
            sender=test_data["sender"],
            link=test_data["link"],
            rule_matched=test_data["rule_matched"],
            timestamp=datetime.utcnow(),
        )
        session.add(db_notif)
        await session.commit()
        await session.refresh(db_notif)

    out = NotificationOut.model_validate(db_notif).model_dump(mode="json")
    await notification_queue.put(out)
    return out

"""FastAPI — Entry point, rotas SSE e lifecycle da aplicação."""

import asyncio
import io
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydantic_settings import BaseSettings
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select, delete, func

from .database import async_session, init_db
from .mail_worker import _process_ai_features, imap_idle_worker, warmup_ollama
from .models import (
    Notification,
    PushSubscription,
    STATUS_DISCARDED,
    STATUS_OPEN,
    STATUS_RESOLVED,
)
from .schemas import NotificationOut, NotificationStatusUpdate

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
    SISTEMA_PROCESSOS_SENDER: str = ""
    SUAP_SENDER: str = ""
    # VAPID
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY_PATH: str = "vapid_private.pem"
    VAPID_MAILTO: str = "mailto:admin@localhost"

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def imap_folder_list(self) -> list[str]:
        """Retorna a lista de pastas IMAP a monitorar."""
        return [f.strip() for f in self.IMAP_FOLDERS.split(",") if f.strip()]

    @property
    def vapid_private_key_path(self) -> Path:
        """Caminho absoluto da chave privada VAPID."""
        return Path(__file__).resolve().parent.parent / self.VAPID_PRIVATE_KEY_PATH


settings = Settings()

# Fila de notificações compartilhada entre o worker e os clientes SSE
notification_queue: asyncio.Queue = asyncio.Queue()

# Set de queues dos clientes SSE conectados (fan-out)
sse_clients: set[asyncio.Queue] = set()

# Evento de shutdown — sinaliza SSE generators para encerrar
shutdown_event: asyncio.Event = asyncio.Event()

# Timestamp do último pulso do IMAP worker (health check)
last_imap_pulse: datetime = datetime.utcnow()


def _update_imap_pulse() -> None:
    """Atualiza o timestamp do último pulso do IMAP worker."""
    global last_imap_pulse
    last_imap_pulse = datetime.utcnow()


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

    # Pré-carrega modelo Ollama na memória (evita cold start de ~8s na 1ª notificação)
    asyncio.create_task(warmup_ollama(), name="ollama-warmup")

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
                sistema_processos_sender=settings.SISTEMA_PROCESSOS_SENDER,
                suap_sender=settings.SUAP_SENDER,
                pulse_callback=_update_imap_pulse,
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
async def get_notifications(limit: int = 50, status: str | None = None):
    """Retorna as notificações (mais recentes primeiro), opcionalmente filtradas por estado."""
    return await _fetch_notifications(limit=limit, status=status)


@app.get("/api/notifications/history")
async def get_notification_history(limit: int = 50, status: str | None = None):
    """Alias de /api/notifications mantido para compatibilidade (historicamente limitado a 200)."""
    return await _fetch_notifications(limit=min(limit, 200), status=status)


async def _fetch_notifications(limit: int, status: str | None) -> list[dict]:
    limit = max(1, min(limit, 500))
    async with async_session() as session:
        stmt = select(Notification).order_by(Notification.timestamp.desc())
        if status:
            stmt = stmt.where(Notification.status == status)
        stmt = stmt.limit(limit)
        result = await session.execute(stmt)
        rows = result.scalars().all()
    return [NotificationOut.model_validate(r).model_dump(mode="json") for r in rows]


# ============================================
# Estado das notificações (concluir / dispensar)
# ============================================
@app.patch("/api/notifications/{notif_id}")
async def update_notification_status(notif_id: int, payload: NotificationStatusUpdate):
    """Marca uma notificação como concluída, dispensada ou volta a ficar aberta.

    Devolve o objecto actualizado para o cliente corrigir a vista se a escrita falhar,
    e emite um evento SSE 'status' para os restantes ecrãs se sincronizarem.
    """
    async with async_session() as session:
        notif = await session.get(Notification, notif_id)
        if notif is None:
            return JSONResponse(
                status_code=404, content={"error": f"Notificação {notif_id} não encontrada"}
            )

        notif.status = payload.status
        # resolved_at só existe enquanto a notificação não voltar a "open"
        notif.resolved_at = (
            None if payload.status == STATUS_OPEN else datetime.utcnow()
        )
        await session.commit()
        await session.refresh(notif)
        out = NotificationOut.model_validate(notif).model_dump(mode="json")

    # Sincroniza os restantes ecrãs (TV do NOC, tablets) com a mesma origem de dados
    await notification_queue.put({
        "_sse_event": "status",
        "id": out["id"],
        "status": out["status"],
        "resolved_at": out["resolved_at"],
    })
    return out


@app.get("/api/stats")
async def get_stats(window_days: int = 7):
    """Contadores e resumo de conclusões.

    Substitui a contagem porCategorias fixa no frontend: deriva tudo do banco,
    por isso qualquer regra nova aparece automaticamente sem alterar o JS.
    """
    window_days = max(1, min(window_days, 90))
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    window_start = today_start - timedelta(days=window_days - 1)

    # Regra efectiva quando rule_matched é NULL ou vazio
    rule_col = func.coalesce(func.nullif(Notification.rule_matched, ""), "Geral")

    async with async_session() as session:
        open_rows = (
            await session.execute(
                select(rule_col, func.count(Notification.id))
                .where(Notification.status == STATUS_OPEN)
                .group_by(rule_col)
            )
        ).all()

        totals = (
            await session.execute(
                select(Notification.status, func.count(Notification.id)).group_by(
                    Notification.status
                )
            )
        ).all()

        resolved_today = (
            await session.execute(
                select(func.count(Notification.id)).where(
                    Notification.status == STATUS_RESOLVED,
                    Notification.resolved_at >= today_start,
                )
            )
        ).scalar_one()

        # Detalhe por dia na janela, já partido por regra
        day_rows = (
            await session.execute(
                select(
                    func.date(Notification.resolved_at),
                    rule_col,
                    func.count(Notification.id),
                )
                .where(
                    Notification.status == STATUS_RESOLVED,
                    Notification.resolved_at >= window_start,
                )
                .group_by(func.date(Notification.resolved_at), rule_col)
            )
        ).all()

    by_rule = {str(rule): int(count) for rule, count in open_rows}
    status_counts = {str(status): int(count) for status, count in totals}

    # Consolida as linhas (dia, regra, contagem) numa estrutura por dia
    by_day: dict[str, dict] = {}
    for day, rule, count in day_rows:
        entry = by_day.setdefault(str(day), {"day": str(day), "total": 0, "by_rule": {}})
        entry["total"] += int(count)
        entry["by_rule"][str(rule)] = int(count)
    days = sorted(by_day.values(), key=lambda d: d["day"], reverse=True)

    resolved_7d = sum(d["total"] for d in days)
    # Média só sobre os dias com resolução registada, nunca sobre a janela de
    # calendário: uma app instalada há 3 dias não deve reportar "1 hoje → 0.14/dia"
    # nem uma app com 2 dias de histórico diluir a média por 7.
    if days:
        first_day = datetime.strptime(days[-1]["day"], "%Y-%m-%d").date()
        span_days = (datetime.utcnow().date() - first_day).days + 1
        days_elapsed = min(window_days, max(1, span_days))
    else:
        # Sem histórico na janela não há média a fazer sentido
        days_elapsed = 0

    return {
        "open_total": status_counts.get(STATUS_OPEN, 0),
        "open_by_rule": by_rule,
        "resolved_total": status_counts.get(STATUS_RESOLVED, 0),
        "resolved_today": int(resolved_today or 0),
        "resolved_window": resolved_7d,
        "window_days": window_days,
        "days_elapsed": days_elapsed,
        "daily_average": round(resolved_7d / max(1, days_elapsed), 1),
        "discarded_total": status_counts.get(STATUS_DISCARDED, 0),
        "by_day": days,
    }


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
                    event_type = data.get("_sse_event", "notification")
                    payload = {k: v for k, v in data.items() if k != "_sse_event"}
                    yield {
                        "event": event_type,
                        "data": json.dumps(payload, ensure_ascii=False),
                    }
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        except asyncio.CancelledError:
            pass
        finally:
            sse_clients.discard(client_queue)

    return EventSourceResponse(event_generator())


@app.get("/api/health")
async def health_check():
    """Health check do IMAP Worker — verifica o último pulso.
    
    Retorna:
    - status="healthy" e code 200 se o último pulso foi há menos de 10 minutos
    - status="unhealthy" e code 503 caso contrário (worker pode estar travado)
    """
    global last_imap_pulse
    now = datetime.utcnow()
    elapsed = (now - last_imap_pulse).total_seconds()
    health_threshold = 10 * 60  # 10 minutos em segundos
    
    is_healthy = elapsed < health_threshold
    status_code = 200 if is_healthy else 503
    
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "healthy" if is_healthy else "unhealthy",
            "last_imap_pulse": last_imap_pulse.isoformat(),
            "elapsed_seconds": int(elapsed),
            "threshold_seconds": health_threshold,
        }
    )


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
async def create_test_notification(rule: str = "Teste Manual"):
    """Cria uma notificação de teste para validar o fluxo SSE.

    Tenta usar o e-mail mais recente da regra solicitada como modelo.
    Se não encontrar, usa dados sintéticos.
    """
    # Fallbacks sintéticos por regra — usados quando não há histórico no banco
    _defaults: dict[str, dict] = {
        "Zabbix NTI CJ": {
            "title": "[TESTE] PROBLEMA - Host Unavailable",
            "message": "ICMP Ping: Unavailable - Host unreachable. Trigger: Host down. Severity: High.",
            "sender": "Zabbix NTI CJ <zabbix@teste.local>",
        },
        "Sistema Processos": {
            "title": "[TESTE] Novo processo cadastrado",
            "message": "Um novo processo foi cadastrado no sistema e aguarda sua análise.",
            "sender": "Sistema Processos <sistema.processos@teste.local>",
        },
        "SUAP": {
            "title": "[TESTE] Novo Chamado Aberto #1234",
            "message": "Um novo chamado foi aberto e atribuído à sua equipe. Acesse o SUAP para mais detalhes.",
            "sender": "SUAP <suap.noreply@teste.local>",
        },
        "Monitoramento": {
            "title": "[TESTE] WARNING - Uso de CPU crítico",
            "message": "Monitor: CPU usage above 90% on server prod-01. Immediate action required.",
            "sender": "Monitoramento <monitor@teste.local>",
        },
    }

    # Tenta buscar o e-mail mais recente desta regra no banco como modelo
    # Exclui notificações de teste anteriores (título não começa com [TESTE])
    async with async_session() as session:
        stmt = (
            select(Notification)
            .where(
                Notification.rule_matched == rule,
                ~Notification.title.startswith("[TESTE]"),
            )
            .order_by(Notification.timestamp.desc())
            .limit(1)
        )
        result = await session.execute(stmt)
        template = result.scalars().first()

    if template:
        # Remove prefixo [TESTE] caso o template seja de um teste anterior
        base_title = template.title.removeprefix("[TESTE] ")
        title   = f"[TESTE] {base_title}"
        message = template.message
        sender  = template.sender
    else:
        fallback = _defaults.get(rule, {
            "title": "[TESTE] Notificação de Teste",
            "message": "Notificação de teste gerada manualmente.",
            "sender": "sistema@teste.local",
        })
        title   = fallback["title"]
        message = fallback["message"]
        sender  = fallback["sender"]

    async with async_session() as session:
        db_notif = Notification(
            title=title,
            message=message,
            sender=sender,
            link=None,
            rule_matched=rule,
            timestamp=datetime.utcnow(),
        )
        session.add(db_notif)
        await session.commit()
        await session.refresh(db_notif)

    out = NotificationOut.model_validate(db_notif).model_dump(mode="json")
    out["_sse_event"] = "notification"
    await notification_queue.put(out)

    # Dispara o mesmo fluxo de IA + TTS que ocorre em e-mails reais
    asyncio.create_task(
        _process_ai_features(db_notif.id, title, message, notification_queue, rule),
        name=f"ai-test-{db_notif.id}",
    )

    return out


# ============================================
# Web Push — VAPID e subscriptions
# ============================================

class SubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class SubscriptionPayload(BaseModel):
    endpoint: str
    keys: SubscriptionKeys


@app.get("/api/vapid-public-key")
async def get_vapid_public_key():
    """Devolve a chave pública VAPID para que o browser possa subscrever."""
    return JSONResponse({"publicKey": settings.VAPID_PUBLIC_KEY})


@app.post("/api/subscribe", status_code=201)
async def subscribe_push(payload: SubscriptionPayload, request: Request):
    """Regista (ou actualiza) um endpoint de Web Push no banco de dados."""
    ua = request.headers.get("user-agent", "")[:512]
    async with async_session() as session:
        # Upsert: se o endpoint já existir, actualiza as chaves (rotação de subscription)
        result = await session.execute(
            select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.keys_p256dh = payload.keys.p256dh
            existing.keys_auth = payload.keys.auth
            existing.user_agent = ua
        else:
            sub = PushSubscription(
                endpoint=payload.endpoint,
                keys_p256dh=payload.keys.p256dh,
                keys_auth=payload.keys.auth,
                user_agent=ua,
            )
            session.add(sub)
        await session.commit()
    logger.info("[Push] Subscription registada/actualizada: %s…", payload.endpoint[:60])
    return {"status": "subscribed"}


@app.delete("/api/subscribe")
async def unsubscribe_push(payload: SubscriptionPayload):
    """Remove um endpoint de Web Push (browser cancelou a subscrição)."""
    async with async_session() as session:
        await session.execute(
            delete(PushSubscription).where(PushSubscription.endpoint == payload.endpoint)
        )
        await session.commit()
    return {"status": "unsubscribed"}


@app.post("/api/push-test")
async def test_push():
    """Envia um push de teste para todos os dispositivos registados."""
    from .mail_worker import send_push_notifications
    async with async_session() as session:
        result = await session.execute(select(PushSubscription))
        count = len(result.scalars().all())
    if count == 0:
        return JSONResponse({"status": "no_subscriptions", "count": 0}, status_code=200)
    await send_push_notifications(
        title="🧪 Teste Push — NTI",
        body="Push nativo funcionando! Este dispositivo receberá os alertas.",
        rule="teste",
    )
    return {"status": "sent", "count": count}

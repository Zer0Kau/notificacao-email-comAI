"""Worker IMAP IDLE — monitora e-mails em tempo real com reconexão automática."""

import asyncio
import email
import json
import logging
import re
from datetime import datetime
from email.header import decode_header
from email.utils import parseaddr
from pathlib import Path
from typing import Callable

import aiohttp
from bs4 import BeautifulSoup
from imapclient import IMAPClient
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush
from sqlalchemy import select

from .database import async_session
from .models import Notification, PushSubscription
from .schemas import NotificationCreate

logger = logging.getLogger(__name__)

# Ollama — configurações de IA local
_OLLAMA_URL = "http://localhost:11434/api/generate"
_OLLAMA_MODEL = "nti-bot:latest"
_OLLAMA_TIMEOUT = 60  # segundos

# Sessão HTTP persistente — evita TCP/TLS handshake a cada chamada Ollama
_http_session: aiohttp.ClientSession | None = None


def _get_http_session() -> aiohttp.ClientSession:
    """Retorna (ou cria) a sessão aiohttp persistente."""
    global _http_session
    if _http_session is None or _http_session.closed:
        _http_session = aiohttp.ClientSession()
    return _http_session


# ============================================
# VAPID — carregado como objecto Vapid02
# ============================================
def _load_vapid() -> tuple[Vapid02 | None, str]:
    """Carrega a chave privada VAPID como objecto Vapid02.
    Retorna (vapid_obj, mailto). Vapid02.from_file() aceita PKCS8 e SEC1.
    """
    import os

    from .main import settings

    # Usa a setting em vez de um caminho fixo — VAPID_PRIVATE_KEY_PATH existia
    # mas nunca era lida, portanto mudar a variável não tinha efeito.
    key_path = Path(settings.vapid_private_key_path)
    if not key_path.exists():
        logger.warning("[Push] Ficheiro VAPID não encontrado em %s", key_path)
        return None, ""
    try:
        vapid = Vapid02.from_file(str(key_path))
    except Exception as exc:
        logger.error("[Push] Falha ao carregar chave VAPID: %s", exc)
        return None, ""
    mailto = settings.VAPID_MAILTO or os.environ.get("VAPID_MAILTO", "mailto:admin@localhost")
    return vapid, mailto


async def send_push_notifications(title: str, body: str, rule: str | None = None) -> None:
    """Envia Web Push para todos os dispositivos registados.

    Chamado após o resumo de IA estar pronto, garantindo que o corpo
    da notificação contém o texto final gerado pelo modelo.
    Subscrições expiradas/inválidas são apagadas automaticamente.
    """
    vapid, vapid_mailto = _load_vapid()
    if not vapid:
        logger.warning("[Push] Chave VAPID não configurada — push ignorado.")
        return

    async with async_session() as session:
        result = await session.execute(select(PushSubscription))
        subscriptions = result.scalars().all()

    if not subscriptions:
        return

    payload = json.dumps({
        "title": title,
        "body": body,
        "rule": rule or "",
        "icon": "/static/icons/icon-192.png",
        "badge": "/static/icons/icon-192.png",
        "tag": f"notifica-{rule or 'default'}",
    })

    expired_endpoints: list[str] = []

    for sub in subscriptions:
        try:
            await asyncio.to_thread(
                webpush,
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {
                        "p256dh": sub.keys_p256dh,
                        "auth": sub.keys_auth,
                    },
                },
                data=payload,
                vapid_private_key=vapid,
                vapid_claims={"sub": vapid_mailto},
                content_encoding="aes128gcm",
                ttl=3600,
            )
            logger.info("[Push] Enviado para %s…", sub.endpoint[:60])
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            # 404/410 = subscription expirada ou revogada pelo utilizador
            if status in (404, 410):
                logger.info("[Push] Subscription expirada (%d) — removendo: %s…", status, sub.endpoint[:60])
                expired_endpoints.append(sub.endpoint)
            else:
                logger.warning("[Push] Falha (%s) para %s…: %s", status, sub.endpoint[:60], exc)
        except Exception as exc:
            logger.warning("[Push] Erro inesperado para %s…: %s", sub.endpoint[:60], exc)

    # Remove subscriptions expiradas
    if expired_endpoints:
        async with async_session() as session:
            for ep in expired_endpoints:
                result = await session.execute(
                    select(PushSubscription).where(PushSubscription.endpoint == ep)
                )
                obj = result.scalar_one_or_none()
                if obj:
                    await session.delete(obj)
            await session.commit()
        logger.info("[Push] %d subscription(s) expirada(s) removida(s).", len(expired_endpoints))


async def warmup_ollama() -> None:
    """Envia prompt vazio para forçar o carregamento do modelo na memória."""
    try:
        session = _get_http_session()
        async with session.post(
            _OLLAMA_URL,
            json={"model": _OLLAMA_MODEL, "prompt": "", "stream": False,
                  "keep_alive": -1, "options": {"num_predict": 1}},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            logger.info("[IA] Warm-up Ollama: status %d — modelo pronto.", resp.status)
    except Exception as exc:
        logger.warning("[IA] Warm-up Ollama falhou (será tentado na 1ª notificação): %s", exc)

# ============================================
# Regras de filtragem de e-mails
# Cada regra: { "name": str, "sender": regex|None, "subject": regex|None }
# Se sender E subject estiverem definidos, ambos precisam casar.
# Se apenas um estiver definido, apenas ele é verificado.
# ============================================
def _build_filter_rules(
    zabbix_sender: str = "",
    sistema_processos_sender: str = "",
    suap_sender: str = "",
) -> list[dict]:
    """Constrói as regras de filtro. Usa re.escape() no e-mail para tratar pontos."""
    rules: list[dict] = []
    if zabbix_sender:
        rules.append({
            "name": "Zabbix Resolvido",
            "sender": re.compile(re.escape(zabbix_sender), re.IGNORECASE),
            "subject": re.compile(r"(resolved|recovered|resolvido|recuperado|\bok\b)", re.IGNORECASE),
        })
        rules.append({
            "name": "Zabbix NTI CJ",
            "sender": re.compile(re.escape(zabbix_sender), re.IGNORECASE),
            "subject": None,
        })
    if sistema_processos_sender:
        rules.append({
            "name": "Sistema Processos",
            "sender": re.compile(re.escape(sistema_processos_sender), re.IGNORECASE),
            "subject": None,
        })
    if suap_sender:
        rules.append({
            "name": "SUAP Resolvido",
            "sender": re.compile(re.escape(suap_sender), re.IGNORECASE),
            "subject": re.compile(r"(resolvido|resolvida|encerrado|encerrada|fechado|fechada|solucionado)", re.IGNORECASE),
        })
        rules.append({
            "name": "SUAP",
            "sender": re.compile(re.escape(suap_sender), re.IGNORECASE),
            "subject": re.compile(r"novo\s+chamado", re.IGNORECASE),
        })
    rules.append({
        "name": "Monitoramento",
        "sender": None,
        "subject": re.compile(r"(monitor|incidente|critical|warning)", re.IGNORECASE),
    })
    return rules


def _decode_mime_header(raw: str | None) -> str:
    """Decodifica cabeçalhos MIME (Subject, From, etc)."""
    if not raw:
        return ""
    parts: list[str] = []
    for fragment, charset in decode_header(raw):
        if isinstance(fragment, bytes):
            parts.append(fragment.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(fragment)
    return " ".join(parts)


def _strip_html(html: str) -> str:
    """Converte HTML para texto plano usando BeautifulSoup."""
    soup = BeautifulSoup(html, "html.parser")
    # Remove blocos que não contribuem com conteúdo legível
    for tag in soup(["script", "style", "head", "meta", "link", "noscript"]):
        tag.decompose()
    return soup.get_text(separator=" ")


def _extract_body_preview(msg: email.message.Message) -> str:
    """Extrai um preview em texto plano do corpo do e-mail."""
    text_body = ""
    html_body = ""

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="replace")
            if ct == "text/plain" and not text_body:
                text_body = decoded
            elif ct == "text/html" and not html_body:
                html_body = decoded
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="replace")
            if msg.get_content_type() == "text/html":
                html_body = decoded
            else:
                text_body = decoded

    # Prefere texto plano; se não tiver, converte HTML
    body = text_body or _strip_html(html_body)
    # Normaliza para linha única:
    # 1. Substitui espaços não-quebráveis (\xa0) e tabs por espaço normal
    body = body.replace("\xa0", " ").replace("\t", " ")
    # 2. Remove caracteres de controle (exceto espaço)
    body = re.sub(r"[\x00-\x1f\x7f]", " ", body)
    # 3. Colapsa qualquer sequência de espaços/newlines em um único espaço
    body = re.sub(r"\s+", " ", body).strip()
    return body[:600]


def _match_rules(sender: str, subject: str, rules: list[dict]) -> str | None:
    """Retorna o nome da regra que casou ou None."""
    for rule in rules:
        sender_match = rule["sender"].search(sender) if rule["sender"] else True
        subject_match = rule["subject"].search(subject) if rule["subject"] else True
        if sender_match and subject_match:
            return rule["name"]
    return None


async def _save_notification(notif: NotificationCreate) -> Notification:
    """Persiste a notificação no banco de dados."""
    async with async_session() as session:
        db_notif = Notification(
            title=notif.title,
            message=notif.message,
            sender=notif.sender,
            link=notif.link,
            rule_matched=notif.rule_matched,
            timestamp=datetime.utcnow(),
        )
        session.add(db_notif)
        await session.commit()
        await session.refresh(db_notif)
        return db_notif


async def _process_ai_features(
    notif_id: int,
    title: str,
    message: str,
    queue: asyncio.Queue,
    rule: str | None = None,
) -> None:
    """Gera resumo via Ollama e envia evento 'update' pelo SSE.

    Falhas são silenciosas — a notificação original não é afetada.
    """
    prompt = (
        "Resuma o seguinte alerta de monitoramento em no máximo 2 frases "
        "diretas e objetivas, sem introduções:\n\n"
        f"Assunto: {title}\n"
        f"Mensagem: {message}"
    )
    try:
        session = _get_http_session()
        async with session.post(
            _OLLAMA_URL,
            json={
                "model": _OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "keep_alive": -1,          # nunca descarrega o modelo da memória
                "options": {"num_predict": 80},  # ~2 frases; geração ~5× mais rápida
            },
            timeout=aiohttp.ClientTimeout(total=_OLLAMA_TIMEOUT),
        ) as resp:
                if resp.status != 200:
                    logger.warning(
                        "[IA] Ollama retornou status %d para notif %d", resp.status, notif_id
                    )
                    return
                body = await resp.json(content_type=None)

        summary = (body.get("response") or "").strip()
        if not summary:
            logger.warning("[IA] Resumo vazio para notif %d", notif_id)
            return

        # Limita ao máximo aceito pelo TTS
        summary = summary[:500]
        logger.info("[IA] Resumo gerado para notif %d: %s", notif_id, summary[:80])

        await queue.put({
            "_sse_event": "update",
            "id": notif_id,
            "summary": summary,
        })

        # Envia push com o resumo final. O `rule` faz o service worker escolher
        # o ícone/emoji por origem — sem ele todos os pushes saíam genéricos.
        await send_push_notifications(title=title, body=summary, rule=rule)

    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("[IA] Falha ao processar notif %d: %s", notif_id, exc)


def _process_email_message(raw_msg: bytes, folder: str, rules: list[dict]) -> NotificationCreate | None:
    """Parseia uma mensagem de e-mail e aplica as regras de filtro."""
    msg = email.message_from_bytes(raw_msg)
    subject = _decode_mime_header(msg.get("Subject"))
    from_raw = _decode_mime_header(msg.get("From"))
    _, sender_addr = parseaddr(from_raw)
    sender_display = from_raw or sender_addr

    logger.info("[%s] E-mail recebido — De: %s | Assunto: %s", folder, sender_display, subject)

    rule_name = _match_rules(sender_display, subject, rules)
    if rule_name is None:
        logger.info("[%s] Descartado (nenhuma regra casou)", folder)
        return None

    logger.info("[%s] ✓ Regra casou: '%s'", folder, rule_name)

    body_preview = _extract_body_preview(msg)
    message_id = msg.get("Message-ID", "")

    return NotificationCreate(
        title=subject or "(Sem assunto)",
        message=body_preview or "(Sem conteúdo)",
        sender=sender_display,
        link=f"mailto:{sender_addr}?subject=Re: {subject}",
        rule_matched=rule_name,
    )


async def imap_idle_worker(
    host: str,
    port: int,
    user: str,
    password: str,
    folder: str,
    queue: asyncio.Queue,
    idle_timeout: int = 300,
    reconnect_delay: int = 5,
    zabbix_sender: str = "",
    sistema_processos_sender: str = "",
    suap_sender: str = "",
    pulse_callback: Callable[[], None] | None = None,
) -> None:
    """Loop principal do worker IMAP IDLE com reconexão automática."""
    from .schemas import NotificationOut

    filter_rules = _build_filter_rules(zabbix_sender, sistema_processos_sender, suap_sender)
    if folder.casefold() == "inbox":
        # Tudo que chega à INBOX da conta monitorada é um contato para NT.CJ.
        # As regras específicas continuam primeiro para preservar a classificação.
        filter_rules.append({"name": "E-mail para NT.CJ", "sender": None, "subject": None})
    logger.info("[%s] Regras de filtro ativas: %s", folder, [r['name'] for r in filter_rules])

    first_connect = True
    known_uids: set[int] | None = None

    while True:
        client: IMAPClient | None = None
        try:
            logger.info("[%s] Conectando ao IMAP %s:%d ...", folder, host, port)
            client = await asyncio.to_thread(IMAPClient, host, port=port, ssl=True)
            await asyncio.to_thread(client.login, user, password)

            # Na primeira conexão, lista as pastas para diagnóstico
            if first_connect:
                available = await asyncio.to_thread(client.list_folders)
                folder_names = [f[-1] for f in available]
                logger.info("[%s] Pastas disponíveis: %s", folder, folder_names)
                if folder not in folder_names:
                    logger.warning(
                        "[%s] ATENÇÃO: Pasta '%s' não encontrada na lista! "
                        "Verifique o nome exato no .env.",
                        folder, folder,
                    )
                first_connect = False

            select_info = await asyncio.to_thread(client.select_folder, folder)
            msg_count = select_info.get(b"EXISTS", "?")

            # Guarda os UIDs atuais como ponto de partida. UNSEEN não é confiável:
            # outro cliente pode marcar a mensagem como lida antes deste worker
            # consultar a caixa, embora ela continue sendo uma mensagem nova para nós.
            current_uids = set(await asyncio.to_thread(client.search, ["ALL"]))
            if known_uids is None:
                known_uids = current_uids
            logger.info("[%s] Pasta aberta (%s mensagens, %d UIDs conhecidos). IDLE ativo (timeout=%ds).",
                        folder, msg_count, len(known_uids), idle_timeout)

            while True:
                await asyncio.to_thread(client.idle)

                # Checa IDLE em intervalos curtos para permitir cancelamento rápido
                responses = []
                elapsed = 0
                check_interval = 2  # segundos por check
                while elapsed < idle_timeout:
                    try:
                        chunk = await asyncio.to_thread(
                            client.idle_check, timeout=check_interval
                        )
                    except Exception as exc:
                        logger.warning("[%s] IDLE check falhou: %s", folder, exc)
                        chunk = None
                        break
                    if chunk:
                        responses.extend(chunk)
                        break  # Recebeu evento, processa imediatamente
                    elapsed += check_interval

                try:
                    extra = await asyncio.to_thread(client.idle_done)
                    # idle_done pode retornar respostas não solicitadas (ex: FLAGS \Seen)
                    # que chegaram enquanto o servidor encerrava o IDLE — é normal
                    if extra:
                        responses.extend(extra)
                except Exception as exc:
                    exc_str = str(exc)
                    # Respostas não solicitadas (FLAGS, EXISTS, EXPUNGE) durante idle_done
                    # são comportamento normal do Gmail — não reconectar
                    if "unexpected response" in exc_str or "FLAGS" in exc_str:
                        logger.debug("[%s] idle_done: resposta não solicitada ignorada: %s", folder, exc)
                    else:
                        logger.warning("[%s] idle_done falhou: %s", folder, exc)
                        break

                # Atualiza o pulso do health check (sinal de vida do worker)
                if pulse_callback:
                    pulse_callback()

                if chunk is None:
                    break  # Erro no idle_check, reconecta

                # Sem respostas = timeout normal, renova o IDLE
                if not responses:
                    continue

                # Qualquer resposta IDLE = possível novo e-mail
                logger.info("[%s] Atividade IDLE detectada: %s", folder, responses)

                all_uids = set(await asyncio.to_thread(client.search, ["ALL"]))
                seqs = sorted(all_uids - known_uids)

                if not seqs:
                    logger.info("[%s] Nenhum e-mail novo após evento IDLE.", folder)
                    continue

                # Registra para não reprocessar em ciclos futuros
                known_uids.update(seqs)

                logger.info("[%s] %d e-mail(s) novo(s) detectado(s).", folder, len(seqs))

                raw_messages = await asyncio.to_thread(
                    client.fetch, seqs, ["BODY.PEEK[]"]
                )

                for uid, data in raw_messages.items():
                    raw = data.get(b"BODY[]") or data.get(b"RFC822")
                    if not raw:
                        continue

                    notif_data = _process_email_message(raw, folder, filter_rules)
                    if notif_data is None:
                        continue

                    db_notif = await _save_notification(notif_data)
                    logger.info("[%s] Notificação salva: [%s] %s",
                                folder, notif_data.rule_matched, notif_data.title)

                    out = NotificationOut.model_validate(db_notif)
                    payload = out.model_dump(mode="json")
                    payload["_sse_event"] = "notification"
                    await queue.put(payload)

                    # Dispara processamento de IA em background (não bloqueia o worker)
                    asyncio.create_task(
                        _process_ai_features(
                            db_notif.id,
                            notif_data.title,
                            notif_data.message,
                            queue,
                            notif_data.rule_matched,
                        ),
                        name=f"ai-{db_notif.id}",
                    )

        except asyncio.CancelledError:
            logger.info("[%s] Worker cancelado (shutdown).", folder)
            if client:
                try:
                    await asyncio.to_thread(client.logout)
                except Exception:
                    pass
            return
        except Exception as exc:
            logger.error("[%s] Erro: %s — reconectando em %ds...", folder, exc, reconnect_delay)
        finally:
            if client:
                try:
                    await asyncio.to_thread(client.logout)
                except Exception:
                    pass
        await asyncio.sleep(reconnect_delay)

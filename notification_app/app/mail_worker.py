"""Worker IMAP IDLE — monitora e-mails em tempo real com reconexão automática."""

import asyncio
import email
import logging
import re
from datetime import datetime
from email.header import decode_header
from email.utils import parseaddr

from bs4 import BeautifulSoup
from imapclient import IMAPClient

from .database import async_session
from .models import Notification
from .schemas import NotificationCreate

logger = logging.getLogger(__name__)

# ============================================
# Regras de filtragem de e-mails
# Cada regra: { "name": str, "sender": regex|None, "subject": regex|None }
# Se sender E subject estiverem definidos, ambos precisam casar.
# Se apenas um estiver definido, apenas ele é verificado.
# ============================================
def _build_filter_rules(zabbix_sender: str = "") -> list[dict]:
    """Constrói as regras de filtro. Usa re.escape() no e-mail para tratar pontos."""
    rules: list[dict] = []
    if zabbix_sender:
        rules.append({
            "name": "Zabbix NTI CJ",
            "sender": re.compile(re.escape(zabbix_sender), re.IGNORECASE),
            "subject": None,
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
    return soup.get_text(separator=" ")


def _extract_body_preview(msg: email.message.Message, max_len: int = 300) -> str:
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
    # Limpa espaços múltiplos e quebras de linha excessivas
    body = re.sub(r"\s+", " ", body).strip()
    return body[:max_len]


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
) -> None:
    """Loop principal do worker IMAP IDLE com reconexão automática."""
    from .schemas import NotificationOut

    filter_rules = _build_filter_rules(zabbix_sender)
    logger.info("[%s] Regras de filtro ativas: %s", folder, [r['name'] for r in filter_rules])

    first_connect = True

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

            # Captura UIDs UNSEEN já existentes para ignorá-los
            existing_uids = set(await asyncio.to_thread(client.search, ["UNSEEN"]))
            logger.info("[%s] Pasta aberta (%s mensagens, %d UNSEEN pré-existentes ignorados). IDLE ativo (timeout=%ds).",
                        folder, msg_count, len(existing_uids), idle_timeout)

            while True:
                await asyncio.to_thread(client.idle)

                # Checa IDLE em intervalos curtos para permitir cancelamento rápido
                responses = []
                elapsed = 0
                check_interval = 5  # segundos por check
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
                    await asyncio.to_thread(client.idle_done)
                except Exception as exc:
                    logger.warning("[%s] idle_done falhou: %s", folder, exc)
                    break

                if chunk is None:
                    break  # Erro no idle_check, reconecta

                # Sem respostas = timeout normal, renova o IDLE
                if not responses:
                    continue

                # Qualquer resposta IDLE = possível novo e-mail, buscar UNSEEN
                logger.info("[%s] Atividade IDLE detectada: %s", folder, responses)

                all_unseen = await asyncio.to_thread(client.search, ["UNSEEN"])
                # Filtra apenas UIDs novos (que não existiam ao iniciar)
                uids = [uid for uid in all_unseen if uid not in existing_uids]
                if not uids:
                    logger.info("[%s] Nenhum e-mail novo após evento IDLE.", folder)
                    continue

                logger.info("[%s] %d e-mail(s) novo(s) detectado(s).", folder, len(uids))

                raw_messages = await asyncio.to_thread(
                    client.fetch, uids, ["RFC822"]
                )

                for uid, data in raw_messages.items():
                    raw = data.get(b"RFC822")
                    if not raw:
                        continue

                    notif_data = _process_email_message(raw, folder, filter_rules)
                    if notif_data is None:
                        continue

                    db_notif = await _save_notification(notif_data)
                    logger.info("[%s] Notificação salva: [%s] %s",
                                folder, notif_data.rule_matched, notif_data.title)

                    out = NotificationOut.model_validate(db_notif)
                    await queue.put(out.model_dump(mode="json"))

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

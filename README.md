# 🔔 Middleware de Notificações Web

Sistema de notificações em tempo real que monitora caixas de e-mail via **IMAP IDLE**, filtra mensagens por regras configuráveis e exibe alertas em uma interface web no estilo **Windows 11 Notification Center** — com suporte a **Text-to-Speech (TTS)**, alertas sonoros, **resumo automático por IA (Ollama)**, painel de contagem adequado a **TVs de NOC** e histórico persistente em **SQLite**.

---

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Arquitetura](#-arquitetura)
- [Stack Tecnológica](#-stack-tecnológica)
- [Estrutura do Projeto](#-estrutura-do-projeto)
- [Pré-requisitos](#-pré-requisitos)
- [Instalação](#-instalação)
- [Configuração](#-configuração)
- [Execução](#-execução)
- [Estados de Notificação](#-estados-de-notificação)
- [Dashboard e Contadores](#-dashboard-e-contadores)
- [Regras de Filtragem](#-regras-de-filtragem)
- [Endpoints da API](#-endpoints-da-api)
- [Deploy em Produção (Nginx + PM2)](#-deploy-em-produção-nginx--pm2)
- [Segurança](#-segurança)
- [Licença](#-licença)

---

## 🎯 Visão Geral

Projetado para equipes de **NOC/NTI** que precisam receber alertas visuais e sonoros de sistemas de monitoramento (como **Zabbix**) e de sistemas institucionais que enviam notificações por e-mail (SUAP, Sistema Processos, etc.). Ao invés de verificar manualmente a caixa de entrada, o sistema:

1. Conecta-se ao servidor IMAP e fica em modo **IDLE** (push em tempo real, sem polling)
2. Filtra e-mails recebidos usando regras de **regex** por remetente e/ou assunto
3. Envia notificações instantâneas a todos os ecrãs conectados via **Server-Sent Events (SSE)**
4. Reproduz um **ping sonoro** imediato ao chegar cada notificação
5. Gera um **resumo por IA (Ollama)** e atualiza o card com um badge violeta "IA"
6. Após o resumo, reproduz **Text-to-Speech (TTS)** (voz Francisca, pt-BR)
7. Mantém **estado de conclusão** no servidor: concluir / dispensar
8. Persiste tudo em um banco **SQLite** com histórico consultável e estatísticas por regra

---

## 🏗 Arquitetura

```
┌──────────────┐       IMAP IDLE        ┌─────────────────────┐
│  Servidor de │ ◄───────────────────── │    IMAP Workers      │
│    E-mail    │   push em tempo real   │   (1 por pasta)      │
└──────────────┘                        └──────────┬──────────┘
                                                   │
                                            Regex Filter
                                                   │
                              ┌────────────────────┴───────────────────┐
                              │                                        │
                     ┌────────▼────────┐                  ┌────────────▼───────────┐
                     │   SQLite (DB)   │                  │   asyncio.Queue        │
                     │  (persistência) │                  │   (fan-out SSE)        │
                     └─────────────────┘                  └────────────┬───────────┘
                                                                       │
                                                   ┌───────────────────┼───────────────────┐
                                                   │                   │                   │
                                          ┌────────▼────────┐   ┌───────▼────────┐  ...
                                          │  SSE (Cliente1) │   │  SSE (ClienteN)│
                                          └───────┬─────────┘   └────────────────┘
                                                  │
                                         ┌────────▼──────────────┐
                                         │   Frontend (Browser)  │
                                         │  • event "notification"│
                                         │    → card + ping       │
                                         │  • event "update" (IA) │
                                         │    → badge IA + TTS    │
                                         │  • /api/stats          │
                                         │    → contadores + rel. │
                                         └────────────────────────┘
                                                  ▲
                                   background task │
                                         ┌────────┴─────────┐
                                         │   Ollama (nti-bot)│
                                         │  resumo ~2 frases │
                                         └──────────────────┘
```

### Padrão de comunicação

- **IMAP → Backend:** `imapclient` com IDLE (push, não polling). O servidor de e-mail avisa o worker assim que chega um novo e-mail.
- **Backend → Frontend:** Server-Sent Events (SSE) com fan-out via `asyncio.Queue`. Dois tipos de evento:
  - `notification` — card imediato com os dados do e-mail
  - `update` — atualiza o card existente com o resumo da IA
- **Backend → Cliente:** também emite eventos `status` quando outro ecrã conclui/dispensa uma notificação (estado partilhado).
- **Frontend → Backend:** REST (`fetch`) para histórico, estatísticas, TTS e transições de estado.
- **Backend → Ollama:** chamada HTTP assíncrona com `aiohttp` (sessão persistente), `keep_alive: -1` para manter o modelo na memória. Falhas são silenciosas.

---

## 🛠 Stack Tecnológica

| Camada | Tecnologia | Função |
|--------|-----------|--------|
| **Backend** | FastAPI 0.115 | Framework async, rotas REST e SSE |
| **IMAP** | IMAPClient 3.0 | Conexão IMAP IDLE com reconexão automática |
| **SSE** | sse-starlette 2.1 | Streaming de eventos para o frontend |
| **Banco de Dados** | SQLAlchemy 2.0 (async) + aiosqlite | Persistência em SQLite assíncrono |
| **TTS** | edge-tts 7.2.8 | Síntese de voz Microsoft Edge (pt-BR, Francisca) — 100% em memória |
| **IA** | Ollama (`nti-bot`) + aiohttp | Resumo automático de e-mails via LLM local |
| **HTML Parsing** | BeautifulSoup4 | Extração e limpeza de texto de e-mails HTML |
| **Validação** | Pydantic v2 + pydantic-settings | Schemas e configuração via `.env` |
| **Push** | py-vapid + pywebpush | Notificações Web Push (PWA) |
| **Servidor** | Uvicorn | ASGI server com graceful shutdown |
| **Proxy** | Nginx | Proxy reverso com config SSE (buffering off) |
| **Process Manager** | PM2 | Gerenciamento de processos + restart automático |
| **Frontend** | HTML5, Tailwind CSS (CDN), JavaScript Vanilla | Interface responsiva (TV + mobile), sem framework JS |

---

## 📁 Estrutura do Projeto

```
notificacao-email-comAI/
├── README.md                     # Este documento
├── notification_app/
│   ├── app/
│   │   ├── __init__.py           # Marca o pacote Python
│   │   ├── main.py               # Entry point: rotas REST, SSE, TTS, health, fan-out
│   │   ├── mail_worker.py        # Worker IMAP IDLE + filtro regex + Ollama IA
│   │   ├── database.py           # Engine SQLAlchemy async + init_db() + migrações
│   │   ├── models.py             # Modelos Notification e PushSubscription (ORM)
│   │   └── schemas.py            # Schemas Pydantic (validação/serialização)
│   ├── nginx/
│   │   └── notifica.conf        # Config Nginx (proxy reverso + SSE sem buffering)
│   ├── scripts/
│   │   └── watchdog.sh          # Health check com auto-restart via PM2
│   ├── static/
│   │   ├── index.html           # SPA — Notification Center + dashboard
│   │   ├── script.js            # Lógica SSE, toasts, TTS, áudio, contadores
│   │   ├── sw.js                # Service Worker (PWA, cache do app shell)
│   │   ├── manifest.json        # Manifest da PWA
│   │   └── icons/               # Ícones PNG da PWA
│   ├── .env                     # ⚠️ Variáveis de ambiente (NÃO versionar)
│   ├── .env.example             # Template de configuração (valores fictícios)
│   ├── ecosystem.config.js      # Configuração PM2
│   ├── requirements.txt         # Dependências Python
│   └── run.py                   # Script de inicialização (uvicorn)
```

---

## ✅ Pré-requisitos

- **Python 3.11+** (testado em 3.13)
- **Ollama** instalado e rodando localmente com o modelo `nti-bot` *(opcional — sem ele o resumo IA é silenciosamente ignorado)*
- **Conta de e-mail com IMAP habilitado** (ex: Gmail)
- **App Password** (para Gmail com 2FA: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords))
- **Nginx + PM2** (para produção)
- **Navegador moderno** (Chrome, Edge, Firefox)

### Habilitar IMAP no Gmail

1. Gmail → Configurações → Ver todas as configurações → **Encaminhamento e POP/IMAP**
2. Ativar **Acesso IMAP** → Salvar alterações

### Configurar o modelo Ollama (opcional)

```bash
# Instalar Ollama (se necessário)
curl -fsSL https://ollama.com/install.sh | sh

# Criar o modelo nti-bot (se usar um Modelfile do projeto)
ollama create nti-bot -f Modelfile
```

---

## 🚀 Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/Zer0Kau/notificacao-email-comAI
cd notificacao-email-comAI/notification_app

# 2. Crie e ative o ambiente virtual
python -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows

# 3. Instale as dependências
pip install -r requirements.txt
```

---

## ⚙️ Configuração

```bash
cp .env.example .env
```

Edite o `.env` com suas credenciais:

```env
# ============================================
# Configuração do Servidor de E-mail (IMAP)
# ============================================
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=seu-email@gmail.com
IMAP_PASSWORD=xxxx xxxx xxxx xxxx
IMAP_FOLDERS=INBOX

# Remetentes usados nas regras de filtro
# Deixe em branco para desativar a regra correspondente
ZABBIX_SENDER=zabbix@seu-dominio.com
SISTEMA_PROCESSOS_SENDER=sistema.processos@seu-dominio.com
SUAP_SENDER=suap.noreply@seu-dominio.com

# ============================================
# Configuração da Aplicação
# ============================================
APP_HOST=0.0.0.0
APP_PORT=8000
IMAP_RECONNECT_DELAY=5
IMAP_IDLE_TIMEOUT=300
RELOAD=false

# Arquiva uma única vez todo o backlog "open" importado para que os contadores
# do dashboard comecem do zero. Deixar vazio/remover após a primeira execução.
APP_ARCHIVE_BACKLOG=false
```

### Variáveis de configuração

| Variável | Descrição |
|----------|-----------|
| `IMAP_HOST` | Servidor IMAP (ex: `imap.gmail.com`) |
| `IMAP_PORT` | Porta IMAP SSL (padrão: `993`) |
| `IMAP_USER` | Endereço de e-mail a monitorar |
| `IMAP_PASSWORD` | App Password (não é a senha normal) |
| `IMAP_FOLDERS` | Pastas a monitorar, separadas por vírgula |
| `ZABBIX_SENDER` | Remetente do Zabbix (habilita as regras Zabbix NTI CJ / Zabbix Resolvido) |
| `SISTEMA_PROCESSOS_SENDER` | Remetente do sistema de processos |
| `SUAP_SENDER` | Remetente do SUAP (habilita as regras SUAP / SUAP Resolvido) |
| `APP_HOST` | Host do servidor web (padrão: `0.0.0.0`) |
| `APP_PORT` | Porta do servidor web (padrão: `8000`) |
| `IMAP_RECONNECT_DELAY` | Segundos para tentar reconexão após falha |
| `IMAP_IDLE_TIMEOUT` | Segundos antes de renovar o ciclo IDLE |
| `RELOAD` | Auto-reload do Uvicorn — `false` em produção (o PM2 usa `run.py`) |
| `APP_ARCHIVE_BACKLOG` | Se `true` (ou `1`/`yes`), arquiva **uma única vez** todo o backlog `open` |
| `DATABASE_PATH` | Caminho alternativo do SQLite (por omissão: `notification_app/notifications.db`) |

> **Nota:** o caminho do SQLite resolve-se a partir da localização do código, sendo independente do diretório de trabalho.

---

## ▶️ Execução

```bash
python run.py
```

Acesse: **http://localhost:8000**

Logs esperados na inicialização:

```
INFO | Banco de dados inicializado.
INFO | [IA] Warm-up Ollama: status 200 — modelo pronto.
INFO | [INBOX] Pasta aberta (150 mensagens, 3 UNSEEN pré-existentes ignorados). IDLE ativo (timeout=300s).
```

> **Nota:** E-mails já marcados como não lidos ao iniciar são **ignorados**. Apenas e-mails recebidos após a inicialização geram notificações.

---

## 📌 Estados de Notificação

Cada notificação tem um estado persistido no servidor:

| Estado | Descrição |
|--------|-----------|
| `open` | Por tratar (estado inicial / valor por omissão). Conta como trabalho pendente. |
| `resolved` | Concluída pelo operador (ícone "visto" verde). **Conta como trabalho executado** nas estatísticas — só muda ao clicar no ícone; e-mails de resolução não auto-resolvem nada. |
| `discarded` | Dispensada (spam, duplicado, irrelevante). Não conta como trabalho executado. |
| `archived` | Histórico importado/migrado (backlog). **Não conta em nenhum contador.** |

Transição de estado via `PATCH /api/notifications/{id}` (botões ✓/✗ na interface).

---

## 📊 Dashboard e Contadores

O painel lateral exibe:

- **Cards coloridos por regra** — cada tag com um indicador de cor e a quantidade **aberta** (ex.: Zabbix NTI CJ, SUAP, Sistema Processos, E-mail para NT.CJ).
- **Relatório de conclusões** — concluídas hoje, total concluído, últimos dias, média/dia e dispensadas.
- **Modo TV** — em ecrãs panorâmicos (ex.: TV do NOC) o layout muda automaticamente: escala-se para caber sem scroll, mantendo os contadores visíveis; em telemóvel usa o layout vertical.

### O que NÃO entra na contagem

As tags a seguir não contam em nenhum contador (nem nos cards, nem em abertas/concluídas, relatório ou média):

- **Monitoramento** — regra genérica removida do worker; e-mails que casavam com ela agora caem noutra regra ou são descartados.
- **SUAP Resolvido** — e-mail de fecho do SUAP, não é um novo chamado.
- **Teste Manual** — notificações criadas pelo botão de teste (o botão continua disponível, mas não polui a contagem).

---

## 🔍 Regras de Filtragem

Definidas em `app/mail_worker.py` na função `_build_filter_rules()`. Ordem importa: **a primeira regra que casar define a tag**. Usam regex no remetente (`From`) e/ou assunto, sem diferenciar maiúsculas/minúsculas.

| Regra | Remetente | Assunto | Fonte |
|-------|-----------|---------|-------|
| **Zabbix Resolvido** | `ZABBIX_SENDER` | contém `resolved\|recovered\|resolvido\|recuperado\|\bok\b` | `.env` |
| **Zabbix NTI CJ** | `ZABBIX_SENDER` | qualquer | `.env` |
| **Sistema Processos** | `SISTEMA_PROCESSOS_SENDER` | qualquer | `.env` |
| **SUAP Resolvido** | `SUAP_SENDER` | contém `resolvido\|resolvida\|encerrado\|encerrada\|fechado\|fechada\|solucionado` | `.env` |
| **SUAP** | `SUAP_SENDER` | contém `novo chamado` | `.env` |
| **E-mail para NT.CJ** | qualquer | qualquer | regra de captura-tudo da **INBOX** |

Detalhes:

- Se `sender` **e** `subject` estiverem definidos, **ambos** precisam casar.
- Assuntos de resolução têm **prioridade** para que o e-mail de fecho não inflacione a tag do chamado aberto.
- Tudo o que chega à **INBOX** e não casa nenhuma regra específica cai em **E-mail para NT.CJ**.
- Fora da INBOX, e-mails que não casam nenhuma regra são **descartados** (não registados).
- O **corpo** do e-mail nunca é usado nas regras — só remetente + assunto.

### Como adicionar novas regras

Edite `_build_filter_rules()` em `mail_worker.py`:

```python
rules.append({
    "name": "Nome da Regra",
    "sender": re.compile(re.escape(settings_value), re.IGNORECASE),  # ou None
    "subject": re.compile(r"regex-do-assunto", re.IGNORECASE),       # ou None
})
```

- Use `re.escape()` para endereços de e-mail (trata os pontos literalmente).
- Use `None` no campo que não quiser restringir.

---

## 📡 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/` | Serve a interface web (SPA) |
| `GET` | `/api/notifications?limit=&status=` | Histórico de notificações (máx. 500) |
| `GET` | `/api/notifications/history?limit=&status=` | Alias de compatibilidade (máx. 200) |
| `PATCH` | `/api/notifications/{id}` | Muda o estado (`open` / `resolved` / `discarded`) |
| `GET` | `/api/stats?window_days=` | Contadores por regra, concluídas e histórico por dia |
| `GET` | `/api/stream` | SSE stream de notificações em tempo real |
| `GET` | `/api/health` | Status do IMAP worker (200 healthy / 503 unhealthy) |
| `GET` | `/api/tts?text=` | Gera áudio TTS em memória via Edge TTS (máx. 500 chars) |
| `POST` | `/api/test-notification?rule=` | Cria notificação de teste (padrão: `Teste Manual`) |
| `GET` | `/api/vapid-public-key` | Chave pública VAPID (Web Push) |
| `POST` | `/api/subscribe` | Regista subscrição de Web Push |
| `DELETE` | `/api/subscribe` | Remove subscrição de Web Push |
| `POST` | `/api/push-test` | Envia push de teste para todas as subscrições |

---

## 🔄 Como Funciona (Fluxo Completo)

```
1. pm2 start ecosystem.config.js  (ou: python run.py)
   └─ Uvicorn inicia FastAPI com lifespan manager

2. Lifespan startup:
   ├─ init_db()         → cria tabelas SQLite + migrações (ex.: archive do backlog)
   ├─ warmup_ollama()   → pré-carrega modelo nti-bot na memória (~2s, opcional)
   ├─ fanout task       → distribui msgs da fila para clientes SSE
   └─ 1 worker IMAP por pasta configurada

3. Worker IMAP IDLE (loop por pasta):
   ├─ Conecta SSL → login → seleciona pasta
   ├─ Captura sequências UNSEEN existentes (ignorar e-mails antigos)
   └─ Loop IDLE:
       ├─ client.idle() → aguarda push do servidor
       ├─ Evento → SEARCH UNSEEN → filtra apenas novas sequências
       ├─ FETCH RFC822 → parseia Subject, From, Body
       ├─ Body HTML → BeautifulSoup → linha única normalizada (max 600 chars)
       ├─ Aplica regras regex → casou? continua : descarta
       ├─ Salva no SQLite (estado "open")
       ├─ Enfileira evento "notification" → SSE imediato
       └─ asyncio.create_task(_process_ai_features)
               └─ Ollama nti-bot → resumo de ~2 frases
               └─ Enfileira evento "update" → SSE atualiza card
               └─ TTS lê o resumo (voz Francisca, pt-BR)

4. Frontend — evento "notification":
   ├─ Renderiza card (com data-notif-id para futura atualização)
   ├─ Exibe toast popup
   └─ Toca ping sonoro (AudioContext, 880Hz, 150ms)

5. Frontend — evento "update" (chega segundos depois):
   ├─ Localiza card pelo data-notif-id
   ├─ Atualiza texto → cor violeta + badge "IA"
   └─ Ping sonoro + TTS lê o resumo (voz Francisca, pt-BR)

6. Conclusão (qualquer ecrã):
   ├─ Operador clica ✓ / ✗ no card
   ├─ PATCH /api/notifications/{id} → estado "resolved"/"discarded"
   ├─ Evento SSE "status" → restantes ecrãs sincronizam
   └─ /api/stats reflete no dashboard (concluídas, contadores por regra)
```

---

## 🏭 Deploy em Produção (Nginx + PM2)

### Pré-requisitos

```bash
sudo apt update && sudo apt install -y nginx nodejs
sudo npm install -g pm2
```

### 1. Iniciar com PM2

```bash
cd /home/notificacao-email-comAI/notification_app
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u $USER --hp $HOME
```

### 2. Configurar Nginx

```bash
sudo cp nginx/notifica.conf /etc/nginx/sites-available/notifica
sudo ln -sf /etc/nginx/sites-available/notifica /etc/nginx/sites-enabled/notifica
sudo nginx -t && sudo systemctl restart nginx
```

O `nginx/notifica.conf` inclui configurações críticas para SSE:
- `proxy_buffering off` no `/api/stream`
- `proxy_read_timeout 24h`
- `Connection ""` (não `upgrade` — SSE ≠ WebSocket)
- `add_header X-Accel-Buffering "no"`
- `/static/*` servido direto com cache `immutable` (o Service Worker usa versionamento por `?v=`)

### 3. Watchdog automático

```bash
chmod +x scripts/watchdog.sh
(crontab -l 2>/dev/null; echo "*/5 * * * * $(pwd)/scripts/watchdog.sh >> /var/log/notifica_watchdog.log 2>&1") | crontab -
```

### Health Check

`GET /api/health` retorna `200` se o IMAP worker pulsou nos últimos 10 minutos, `503` caso contrário:

```json
{
  "status": "healthy",
  "last_imap_pulse": "2026-04-09T12:34:56.123456",
  "elapsed_seconds": 45,
  "threshold_seconds": 600
}
```

### Comandos úteis

```bash
pm2 list                          # Status dos processos
pm2 logs notifica-api             # Logs em tempo real
pm2 restart notifica-api          # Restart manual
curl http://localhost/api/health  # Testar health check
tail -f /var/log/notifica_watchdog.log
```

---

## 🔒 Segurança

- O arquivo `.env` com credenciais **nunca deve ser versionado** (está no `.gitignore`)
- Use sempre **App Passwords** — nunca a senha principal da conta
- Remetentes sensíveis ficam apenas no `.env`, nunca no código-fonte
- O frontend sanitiza todo texto exibido contra XSS via `escapeHtml()`
- O limit do histórico é limitado (200 na rota de histórico, 500 geral) no backend
- O texto de TTS é limitado a 500 caracteres no backend
- A chave privada VAPID (`vapid_private.pem`) está no `.gitignore` — nunca versionar

---

## 📄 Licença

Desenvolvido para uso interno. Adapte conforme necessário.
# 🔔 Middleware de Notificações Web

Sistema de notificações em tempo real que monitora caixas de e-mail via **IMAP IDLE**, filtra mensagens por regras configuráveis e exibe alertas em uma interface web inspirada no **Windows 11 Notification Center**, com suporte a **Text-to-Speech (TTS)**, alertas sonoros, **resumo automático por IA (Ollama)** e histórico persistente.

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
- [Funcionalidades](#-funcionalidades)
- [Endpoints da API](#-endpoints-da-api)
- [Regras de Filtragem](#-regras-de-filtragem)
- [Como Funciona (Fluxo Completo)](#-como-funciona-fluxo-completo)
- [Deploy em Produção (Nginx + PM2)](#-deploy-em-produção-nginx--pm2)

---

## 🎯 Visão Geral

Este middleware foi projetado para equipes de **NOC/NTI** que precisam receber alertas visuais e sonoros de sistemas de monitoramento (como **Zabbix**) e de outros sistemas institucionais que enviam notificações por e-mail. Ao invés de depender da verificação manual da caixa de entrada, o sistema:

1. Conecta-se ao servidor IMAP e fica em modo **IDLE** (push em tempo real)
2. Filtra e-mails recebidos usando regras de **regex** por remetente e/ou assunto
3. Envia notificações instantâneas para o navegador via **Server-Sent Events (SSE)**
4. Reproduz um **ping sonoro** imediato ao chegarem novas notificações
5. Em paralelo, gera um **resumo por IA** (Ollama) e atualiza o card com o texto e um badge violeta "IA"
6. Após o resumo, reproduz **Text-to-Speech (TTS)** com a voz Francisca (pt-BR)
7. Persiste tudo em um banco **SQLite** com histórico consultável

---

## 🏗 Arquitetura

```
┌──────────────┐      IMAP IDLE       ┌─────────────────────┐
│  Servidor de │  ◄──────────────────  │   IMAP Workers      │
│    E-mail    │  push em tempo real   │  (1 por pasta)      │
│   (Gmail)    │                       │                     │
└──────────────┘                       └────────┬────────────┘
                                                │
                                         Regex Filter
                                                │
                              ┌─────────────────┴──────────────────┐
                              │                                     │
                     ┌────────▼────────┐              ┌────────────▼────────────┐
                     │  SQLite (DB)    │              │   asyncio.Queue         │
                     │  (persistência) │              │   (fan-out SSE)         │
                     └─────────────────┘              └────────────┬────────────┘
                                                                   │
                                              ┌────────────────────┼───────────────────┐
                                              │                    │                   │
                                     ┌────────▼────────┐  ┌───────▼─────────┐   ...
                                     │  SSE (Cliente1) │  │  SSE (ClienteN) │
                                     └────────┬────────┘  └─────────────────┘
                                              │
                                     ┌────────▼────────────────┐
                                     │  Frontend (Browser)     │
                                     │  • event "notification" │
                                     │    → card + ping        │
                                     │  • event "update" (IA)  │
                                     │    → badge IA + TTS     │
                                     └─────────────────────────┘
                                              ▲
                              background task │
                                     ┌────────┴────────────────┐
                                     │   Ollama (nti-bot)      │
                                     │   resumo em ~2 frases   │
                                     └─────────────────────────┘
```

### Padrão de comunicação

- **IMAP → Backend:** `imapclient` com IDLE (push, não polling). O servidor de e-mail avisa o worker assim que chega um novo e-mail.
- **Backend → Frontend:** Server-Sent Events (SSE) com fan-out via `asyncio.Queue`. Dois tipos de evento:
  - `notification` — card imediato com dados do e-mail
  - `update` — atualiza o card existente com o resumo da IA
- **Frontend → Backend:** REST (`fetch`) para histórico e TTS sob demanda.
- **Backend → Ollama:** chamada HTTP assíncrona com `aiohttp` (sessão persistente), `keep_alive: -1` para manter o modelo na memória.

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
| **Servidor** | Uvicorn | ASGI server com graceful shutdown |
| **Proxy** | Nginx | Proxy reverso com config SSE (buffering off) |
| **Process Manager** | PM2 | Gerenciamento de processos + restart automático |
| **Frontend** | HTML5, Tailwind CSS (CDN), JavaScript Vanilla | SPA responsiva sem framework JS |

---

## 📁 Estrutura do Projeto

```
notification_app/
├── app/
│   ├── __init__.py          # Marca o pacote Python
│   ├── main.py              # Entry point FastAPI: rotas, SSE, TTS, health check, fan-out
│   ├── mail_worker.py       # Worker IMAP IDLE + filtro regex + Ollama IA
│   ├── database.py          # Engine SQLAlchemy async + init_db()
│   ├── models.py            # Modelo Notification (SQLAlchemy ORM)
│   └── schemas.py           # Schemas Pydantic (validação/serialização)
├── nginx/
│   └── notifica.conf        # Config Nginx (proxy reverso + SSE sem buffering)
├── scripts/
│   └── watchdog.sh          # Health check com auto-restart via PM2
├── static/
│   ├── index.html           # SPA — interface Windows 11 Notification Center
│   └── script.js            # Lógica SSE, toasts, TTS, áudio, histórico, update IA
├── .env                     # ⚠️ Variáveis de ambiente (NÃO versionar)
├── .env.example             # Template de configuração (valores fictícios)
├── ecosystem.config.js      # Configuração PM2
├── requirements.txt         # Dependências Python
└── run.py                   # Script de inicialização (uvicorn)
```

---

## ✅ Pré-requisitos

- **Python 3.11+** (testado em 3.13)
- **Ollama** instalado e rodando localmente com o modelo `nti-bot` criado
- **Conta de e-mail com IMAP habilitado** (ex: Gmail)
- **App Password** (para Gmail com 2FA: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords))
- **Nginx + PM2** (para produção)
- **Navegador moderno** (Chrome, Edge, Firefox)

### Habilitar IMAP no Gmail

1. Gmail → Configurações → Ver todas as configurações → **Encaminhamento e POP/IMAP**
2. Ativar **Acesso IMAP** → Salvar alterações

### Configurar o modelo Ollama

```bash
# Instalar Ollama (se necessário)
curl -fsSL https://ollama.com/install.sh | sh

# Criar o modelo nti-bot a partir do Modelfile do projeto
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
IMAP_FOLDERS=INBOX,Notificações Zabbix

# Remetentes usados nas regras de filtro
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
```

| Variável | Descrição |
|----------|-----------|
| `IMAP_HOST` | Servidor IMAP (ex: `imap.gmail.com`) |
| `IMAP_PORT` | Porta IMAP SSL (padrão: `993`) |
| `IMAP_USER` | Endereço de e-mail a monitorar |
| `IMAP_PASSWORD` | App Password (não é a senha normal) |
| `IMAP_FOLDERS` | Pastas a monitorar, separadas por vírgula |
| `ZABBIX_SENDER` | E-mail do Zabbix (todos os e-mails deste remetente) |
| `SISTEMA_PROCESSOS_SENDER` | E-mail do sistema de processos (todos os e-mails) |
| `SUAP_SENDER` | E-mail do SUAP (apenas assuntos com "novo chamado") |
| `APP_HOST` | Host do servidor web (padrão: `0.0.0.0`) |
| `APP_PORT` | Porta do servidor web (padrão: `8000`) |
| `IMAP_RECONNECT_DELAY` | Segundos para tentar reconexão após falha |
| `IMAP_IDLE_TIMEOUT` | Segundos antes de renovar o ciclo IDLE |

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
INFO | [Notificações Zabbix] Pasta aberta (500 mensagens, 0 UNSEEN pré-existentes ignorados). IDLE ativo (timeout=300s).
```

> **Nota:** E-mails já marcados como não lidos ao iniciar são **ignorados**. Apenas e-mails recebidos após a inicialização geram notificações.

---

## ✨ Funcionalidades

### Interface (Frontend)

- **Notification Center** estilo Windows 11 com efeito Mica/Acrylic (blur + transparência)
- **Cards de notificação** com ícone SVG dinâmico por remetente, borda colorida por regra, timestamp relativo e badge da regra
- **Badge violeta "IA"** aparece no card quando o resumo de IA fica pronto
- **Toast popups** no canto inferior direito com auto-dismiss
- **Indicador de conexão** em tempo real (verde = conectado, amarelo = conectando, vermelho = desconectado)
- **Badge contador** de novas notificações
- **Histórico (Bottom Sheet)** — painel slide-up com o histórico do banco, carregado sob demanda
- **Botão "Testar"** para gerar notificação de teste manualmente

### Cores das bordas por regra

| Regra | Cor | Critério |
|-------|-----|---------|
| Zabbix NTI CJ | 🔴 Vermelho | Remetente = `ZABBIX_SENDER` |
| Sistema Processos | 🟢 Verde | Remetente = `SISTEMA_PROCESSOS_SENDER` |
| SUAP | 🟡 Âmbar | Remetente = `SUAP_SENDER` + assunto contém "novo chamado" |
| Monitoramento | 🔵 Azul | Assunto contém: monitor / incidente / critical / warning |

### Áudio e Voz

- **Ping sonoro** curto (~150ms, 880Hz) via AudioContext ao receber notificação instantânea
- Quando o **resumo de IA** fica pronto: novo ping + **TTS lê o resumo** (voz Francisca, pt-BR)
- O áudio TTS é gerado 100% em memória via `edge-tts` — nenhum arquivo `.mp3` é gravado em disco

### Integração com IA (Ollama)

- Ao chegar um e-mail, o worker salva a notificação e envia o card **instantaneamente**
- Em paralelo (`asyncio.create_task`), chama o Ollama com o conteúdo do e-mail
- O modelo `nti-bot` gera um resumo em até 2 frases diretas
- O resumo é enviado como evento SSE `update` → o card existente é **atualizado in-place** com o texto em violeta e badge "IA"
- O modelo é pré-carregado na memória no startup (`keep_alive: -1`) para evitar cold start

### Backend

- **IMAP IDLE** — recepção push (sem polling), um worker por pasta
- **Reconexão automática** com `reconnect_delay` configurável
- **Filtragem por regex** — por remetente e/ou assunto; remetentes sensíveis no `.env`
- **Limpeza de e-mail HTML** — BeautifulSoup remove `<script>`, `<style>`, `<head>`; normaliza para linha única; elimina `\xa0`, tabs e caracteres de controle
- **Fan-out SSE imutável** — o dict de payload não é mutado, garantindo entrega correta para múltiplos clientes simultâneos
- **Graceful shutdown** — encerra IDLE e SSE corretamente em ≤3 segundos
- **Persistência SQLite** assíncrona via aiosqlite

---

## 📡 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/` | Serve a interface web (SPA) |
| `GET` | `/api/stream` | SSE stream de notificações em tempo real |
| `GET` | `/api/notifications?limit=50` | Histórico de notificações (JSON) |
| `GET` | `/api/notifications/history?limit=50` | Histórico para o Bottom Sheet (JSON) |
| `GET` | `/api/tts?text=...` | Gera áudio TTS em memória via Edge TTS |
| `GET` | `/api/health` | Status do IMAP worker (200 healthy / 503 unhealthy) |
| `POST` | `/api/test-notification` | Cria notificação de teste |

---

## 🔍 Regras de Filtragem

Definidas em `app/mail_worker.py` na função `_build_filter_rules()`. Os e-mails de remetentes específicos são lidos do `.env` (nunca hardcoded).

| Regra | Remetente | Assunto | Fonte |
|-------|-----------|---------|-------|
| **Zabbix NTI CJ** | `ZABBIX_SENDER` | qualquer | `.env` |
| **Sistema Processos** | `SISTEMA_PROCESSOS_SENDER` | qualquer | `.env` |
| **SUAP** | `SUAP_SENDER` | contém "novo chamado" | `.env` |
| **Monitoramento** | qualquer | contém: `monitor\|incidente\|critical\|warning` | regex hardcoded |

### Como adicionar novas regras

Edite `_build_filter_rules()` em `mail_worker.py`:

```python
rules.append({
    "name": "Nome da Regra",
    "sender": re.compile(re.escape(settings_value), re.IGNORECASE),  # ou None
    "subject": re.compile(r"regex-do-assunto", re.IGNORECASE),       # ou None
})
```

- Se `sender` **e** `subject` forem definidos, **ambos** precisam casar.
- Use `re.escape()` para endereços de e-mail (trata os pontos literalmente).

---

## 🔄 Como Funciona (Fluxo Completo)

```
1. pm2 start ecosystem.config.js  (ou: python run.py)
   └─ Uvicorn inicia FastAPI com lifespan manager

2. Lifespan startup:
   ├─ init_db()         → cria tabelas SQLite se não existirem
   ├─ warmup_ollama()   → pré-carrega modelo nti-bot na memória (~2s)
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
       ├─ Salva no SQLite
       ├─ Enfileira evento "notification" → SSE imediato
       └─ asyncio.create_task(_process_ai_features)
                └─ Ollama nti-bot → resumo 2 frases
                └─ Enfileira evento "update" → SSE atualiza card

4. Frontend — evento "notification":
   ├─ Renderiza card (com data-notif-id para futura atualização)
   ├─ Exibe toast popup
   └─ Toca ping sonoro (AudioContext, 880Hz, 150ms)

5. Frontend — evento "update" (chega segundos depois):
   ├─ Localiza card pelo data-notif-id
   ├─ Atualiza texto → cor violeta + badge "IA"
   └─ Ping sonoro + TTS lê o resumo (voz Francisca, pt-BR)
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
- Use sempre **App Passwords** — nunca a senha principal da conta Gmail
- Remetentes sensíveis ficam apenas no `.env`, nunca no código-fonte
- O frontend sanitiza todo texto exibido contra XSS via `escapeHtml()`
- O `limit` do histórico é limitado a 200 no backend (previne abuso)
- O texto de TTS é limitado a 500 caracteres no backend

---

## 📄 Licença

Desenvolvido para uso interno. Adapte conforme necessário.


Sistema de notificações em tempo real que monitora caixas de e-mail via **IMAP IDLE**, filtra mensagens por regras configuráveis e exibe alertas em uma interface web inspirada no **Windows 11 Notification Center**, com suporte a **Text-to-Speech (TTS)**, alertas sonoros e histórico persistente.

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
- [Funcionalidades](#-funcionalidades)
- [Endpoints da API](#-endpoints-da-api)
- [Regras de Filtragem](#-regras-de-filtragem)
- [Como Funciona (Fluxo Completo)](#-como-funciona-fluxo-completo)
- [Deploy em Produção (Nginx + PM2)](#-deploy-em-produção-nginx--pm2)

---

## 🎯 Visão Geral

Este middleware foi projetado para equipes de **NOC/NTI** que precisam receber alertas visuais e sonoros de sistemas de monitoramento (como **Zabbix**, **Grafana**, etc.) que enviam notificações por e-mail. Ao invés de depender da verificação manual da caixa de entrada, o sistema:

1. Conecta-se ao servidor IMAP e fica em modo **IDLE** (push em tempo real)
2. Filtra e-mails recebidos usando regras de **regex** por remetente e/ou assunto
3. Envia notificações instantâneas para o navegador via **Server-Sent Events (SSE)**
4. Reproduz um **alerta sonoro** + **leitura por voz (TTS)** com a voz Francisca (pt-BR)
5. Persiste tudo em um banco **SQLite** com histórico consultável

---

## 🏗 Arquitetura

```
┌──────────────┐      IMAP IDLE       ┌─────────────────────┐
│  Servidor de │  ◄──────────────────  │   IMAP Workers      │
│    E-mail    │  push em tempo real   │  (1 por pasta)      │
│   (Gmail)    │                       │                     │
└──────────────┘                       └────────┬────────────┘
                                                │
                                                │ Regex Filter
                                                │
                                       ┌────────▼────────────┐
                                       │  asyncio.Queue      │
                                       │  (fan-out p/ SSE)   │
                                       └────────┬────────────┘
                                                │
                          ┌─────────────────────┼──────────────────────┐
                          │                     │                      │
                 ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
                 │  SQLite (DB)    │   │  SSE Stream      │   │  SSE Stream     │
                 │  (persistência) │   │  (Cliente 1)     │   │  (Cliente N)    │
                 └─────────────────┘   └────────┬─────────┘   └─────────────────┘
                                                │
                                       ┌────────▼────────────┐
                                       │  Frontend (Browser) │
                                       │  • Card notification│
                                       │  • Toast popup      │
                                       │  • Ping sonoro      │
                                       │  • Edge TTS (voz)   │
                                       │  • Histórico (DB)   │
                                       └─────────────────────┘
```

### Padrão de comunicação

- **IMAP → Backend:** `imapclient` com IDLE (push, não polling). O servidor de e-mail avisa o worker assim que chega um novo e-mail.
- **Backend → Frontend:** Server-Sent Events (SSE) com fan-out via `asyncio.Queue` — cada aba/cliente conectado recebe uma cópia da notificação.
- **Frontend → Backend:** REST (`fetch`) para histórico e TTS sob demanda (lazy loading).

---

## 🛠 Stack Tecnológica

| Camada | Tecnologia | Função |
|--------|-----------|--------|
| **Backend** | FastAPI 0.115 | Framework async, rotas REST e SSE |
| **IMAP** | IMAPClient 3.0 | Conexão IMAP IDLE com reconexão automática |
| **SSE** | sse-starlette 2.1 | Streaming de eventos para o frontend |
| **Banco de Dados** | SQLAlchemy 2.0 (async) + aiosqlite | Persistência em SQLite assíncrono |
| **TTS** | edge-tts 7.2 | Síntese de voz Microsoft Edge (pt-BR, Francisca) |
| **HTML Parsing** | BeautifulSoup4 | Extração de texto limpo de e-mails HTML |
| **Validação** | Pydantic v2 + pydantic-settings | Schemas e configuração via `.env` |
| **Servidor** | Uvicorn | ASGI server com hot reload e graceful shutdown |
| **Frontend** | HTML5, Tailwind CSS (CDN), JavaScript Vanilla | Interface responsiva, sem framework JS |

---

## 📁 Estrutura do Projeto

```
notification_app/
├── app/
│   ├── __init__.py          # Marca o pacote Python
│   ├── main.py              # Entry point FastAPI: rotas, SSE, TTS, health check
│   ├── mail_worker.py       # Worker IMAP IDLE: conexão, filtro regex, parsing
│   ├── database.py          # Engine SQLAlchemy async + init_db()
│   ├── models.py            # Modelo Notification (SQLAlchemy ORM)
│   └── schemas.py           # Schemas Pydantic (validação/serialização)
├── nginx/
│   └── notifica.conf        # Configuração Nginx (proxy reverso + SSE)
├── scripts/
│   └── watchdog.sh          # Script de health check com auto-restart via PM2
├── static/
│   ├── index.html           # SPA — interface Windows 11 Notification Center
│   └── script.js            # Lógica SSE, toasts, TTS, áudio, histórico
├── .env                     # ⚠️ Variáveis de ambiente (NÃO versionar)
├── .env.example             # Template de configuração (valores fictícios)
├── ecosystem.config.js      # Configuração PM2 (process manager)
├── requirements.txt         # Dependências Python
├── run.py                   # Script de inicialização (uvicorn)
└── notifications.db         # Banco SQLite gerado automaticamente
```

---

## ✅ Pré-requisitos

- **Python 3.11+** (testado em 3.13)
- **Conta de e-mail com IMAP habilitado** (ex: Gmail)
- **App Password** (para Gmail com 2FA, gere em: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords))
- **Navegador moderno** (Chrome, Edge, Firefox)

### Habilitar IMAP no Gmail

1. Gmail → Configurações → Ver todas as configurações → **Encaminhamento e POP/IMAP**
2. Ativar **Acesso IMAP**
3. Salvar alterações

---

## 🚀 Instalação

```bash
# 1. Clone o repositório
git clone <url-do-repositorio>
cd notification_app

# 2. Crie o ambiente virtual
python -m venv .venv

# 3. Ative o ambiente virtual
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Windows (CMD):
.venv\Scripts\activate.bat
# Linux/macOS:
source .venv/bin/activate

# 4. Instale as dependências
pip install -r requirements.txt
```

---

## ⚙️ Configuração

Copie o arquivo de exemplo e preencha com suas credenciais:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
# ============================================
# Configuração do Servidor de E-mail (IMAP)
# ============================================
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=seu-email@gmail.com
IMAP_PASSWORD=xxxx xxxx xxxx xxxx
IMAP_FOLDERS=INBOX,Notificações Zabbix

# Remetente Zabbix (usado na regra de filtro)
ZABBIX_SENDER=zabbix@seu-dominio.com

# ============================================
# Configuração da Aplicação
# ============================================
APP_HOST=0.0.0.0
APP_PORT=8000

# Intervalo de reconexão IMAP em segundos
IMAP_RECONNECT_DELAY=5

# Timeout do IDLE em segundos
IMAP_IDLE_TIMEOUT=300
```

| Variável | Descrição |
|----------|-----------|
| `IMAP_HOST` | Servidor IMAP (ex: `imap.gmail.com`) |
| `IMAP_PORT` | Porta IMAP SSL (padrão: `993`) |
| `IMAP_USER` | Endereço de e-mail a monitorar |
| `IMAP_PASSWORD` | App Password (não é a senha normal) |
| `IMAP_FOLDERS` | Pastas a monitorar, separadas por vírgula |
| `ZABBIX_SENDER` | E-mail do remetente Zabbix para a regra de filtro |
| `APP_HOST` | Host do servidor web (padrão: `0.0.0.0`) |
| `APP_PORT` | Porta do servidor web (padrão: `8000`) |
| `IMAP_RECONNECT_DELAY` | Segundos para tentar reconexão após falha |
| `IMAP_IDLE_TIMEOUT` | Segundos antes de renovar o IDLE IMAP |

---

## ▶️ Execução

```bash
python run.py
```

Acesse no navegador: **http://localhost:8000**

O terminal exibirá logs como:

```
INFO | Banco de dados inicializado.
INFO | [INBOX] Conectando ao IMAP imap.gmail.com:993 ...
INFO | [INBOX] Pastas disponíveis: ['INBOX', 'Notificações Zabbix', ...]
INFO | [INBOX] Pasta aberta (150 mensagens, 3 UNSEEN pré-existentes ignorados). IDLE ativo (timeout=300s).
```

> **Nota:** E-mails que já estavam como não lidos antes da inicialização são **ignorados**. Apenas e-mails recebidos após o servidor iniciar geram notificações.

---

## ✨ Funcionalidades

### Interface (Frontend)

- **Notification Center** estilo Windows 11 com efeito Mica/Acrylic (blur + transparência)
- **Cards de notificação** com ícone SVG dinâmico por remetente, timestamp relativo e badge da regra
- **Toast popups** no canto inferior direito com auto-dismiss em 6 segundos
- **Indicador de conexão** em tempo real (verde = conectado, amarelo = conectando, vermelho = desconectado)
- **Badge contador** de novas notificações
- **Histórico (Bottom Sheet)** — painel slide-up com as últimas 50 notificações do banco, carregado sob demanda
- **Botão "Testar"** para gerar notificação de teste manualmente

### Áudio e Voz

- **Ping sonoro** curto (~150ms, 880Hz) via AudioContext ao receber notificação
- **Text-to-Speech** com voz brasileira (Microsoft Francisca, pt-BR) — lê o título da notificação
- O ping toca primeiro, depois o TTS reproduz em sequência
- Cache-bust automático evita que o browser reutilize áudio de textos idênticos

### Backend

- **IMAP IDLE** — recepção push de e-mails (sem polling), um worker por pasta
- **Reconexão automática** com backoff configurável
- **Filtragem por regex** — regras configuráveis por remetente e/ou assunto
- **Fan-out SSE** — múltiplos clientes simultâneos recebem a mesma notificação
- **Graceful shutdown** — encerra IDLE e SSE corretamente em ≤3 segundos
- **Persistência SQLite** assíncrona para histórico

---

## 📡 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/` | Serve a interface web (SPA) |
| `GET` | `/api/stream` | SSE stream de notificações em tempo real |
| `GET` | `/api/notifications?limit=50` | Histórico de notificações (JSON) |
| `GET` | `/api/notifications/history?limit=50` | Histórico para o Bottom Sheet (JSON) |
| `GET` | `/api/tts?text=...` | Gera áudio TTS (MP3) via Edge TTS |
| `GET` | `/api/health` | Status do IMAP worker (200 healthy / 503 unhealthy) |
| `POST` | `/api/test-notification` | Cria notificação de teste |

---

## 🔍 Regras de Filtragem

As regras são definidas em `app/mail_worker.py` na função `_build_filter_rules()`. Cada regra pode filtrar por **remetente** (sender), **assunto** (subject) ou **ambos**.

| Regra | Critério | Fonte |
|-------|----------|-------|
| **Zabbix NTI CJ** | Remetente = valor de `ZABBIX_SENDER` no `.env` | Variável de ambiente |
| **Monitoramento** | Assunto contém: `monitor`, `incidente`, `critical` ou `warning` | Hardcoded (regex) |

### Como adicionar novas regras

Edite a função `_build_filter_rules()` em `mail_worker.py`:

```python
rules.append({
    "name": "Nome da Regra",
    "sender": re.compile(r"regex-do-remetente", re.IGNORECASE),  # ou None
    "subject": re.compile(r"regex-do-assunto", re.IGNORECASE),   # ou None
})
```

- Se `sender` e `subject` forem definidos, **ambos** precisam casar.
- Se apenas um for definido, somente ele é verificado.
- Use `re.escape("email@dominio.com")` para e-mails com pontos.

---

## 🔄 Como Funciona (Fluxo Completo)

```
1. python run.py
   └─ Uvicorn inicia FastAPI com lifespan manager

2. Lifespan startup:
   ├─ init_db() → cria tabelas SQLite se não existirem
   ├─ Inicia task fan-out (distribui msgs da fila para clientes SSE)
   └─ Inicia 1 worker IMAP IDLE por pasta configurada

3. Worker IMAP IDLE (por pasta):
   ├─ Conecta ao IMAP via SSL
   ├─ Faz login com App Password
   ├─ Seleciona a pasta (ex: INBOX)
   ├─ Captura UIDs UNSEEN existentes (para ignorar)
   └─ Entra em loop IDLE:
       ├─ client.idle() → aguarda evento push do servidor
       ├─ Evento recebido → busca e-mails UNSEEN novos
       ├─ Parseia: Subject, From, Body (HTML→texto via BeautifulSoup)
       ├─ Aplica regras regex → casou? continua : descarta
       ├─ Salva no SQLite (modelo Notification)
       └─ Coloca na asyncio.Queue → fan-out distribui para SSE

4. Frontend (Browser):
   ├─ Abre EventSource em /api/stream
   ├─ Recebe evento "notification" →
   │   ├─ Renderiza card no painel principal
   │   ├─ Exibe toast popup (auto-dismiss 6s)
   │   ├─ Toca ping sonoro (AudioContext, 880Hz)
   │   └─ Reproduz TTS via Edge TTS (voz Francisca)
   └─ Botão "Histórico" →
       └─ fetch /api/notifications/history → renderiza Bottom Sheet
```

---

## 🏭 Deploy em Produção (Nginx + PM2)

Para ambientes de produção (LXC Debian/Ubuntu no Proxmox), a stack recomendada usa **Nginx** como proxy reverso e **PM2** como gerenciador de processos.

### Pré-requisitos

```bash
sudo apt update && sudo apt install -y nginx nodejs
sudo npm install -g pm2
```

### 1. Iniciar com PM2

```bash
cd /home/notificacao-email-comAI/notification_app

# Iniciar usando o ecosystem.config.js (já inclui o caminho correto do .venv)
pm2 start ecosystem.config.js

# Salvar e configurar para iniciar no boot
pm2 save
pm2 startup systemd -u $USER --hp $HOME
```

### 2. Configurar Nginx

O arquivo `nginx/notifica.conf` já contém a configuração completa, incluindo `proxy_buffering off` no endpoint SSE (crítico para que as notificações cheguem em tempo real).

```bash
sudo cp nginx/notifica.conf /etc/nginx/sites-available/notifica
sudo ln -sf /etc/nginx/sites-available/notifica /etc/nginx/sites-enabled/notifica
sudo nginx -t && sudo systemctl restart nginx
```

### 3. Health Check automático (Watchdog)

O script `scripts/watchdog.sh` consulta `GET /api/health` e executa `pm2 restart all` se o IMAP worker travar (pulso ausente por mais de 10 minutos).

```bash
chmod +x scripts/watchdog.sh

# Agendar a cada 5 minutos via crontab
(crontab -l 2>/dev/null; echo "*/5 * * * * $(pwd)/scripts/watchdog.sh >> /var/log/notifica_watchdog.log 2>&1") | crontab -
```

### Como o health check funciona

A cada ciclo do loop IMAP IDLE (a cada timeout ou evento), o worker atualiza a variável `last_imap_pulse` em `main.py`. A rota `GET /api/health` retorna:

- **`200 OK`** — pulso atualizado há menos de 10 minutos (`status: "healthy"`)
- **`503 Service Unavailable`** — pulso ausente há mais de 10 minutos (`status: "unhealthy"`)

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
pm2 list                   # Ver status dos processos
pm2 logs notifica-api      # Logs em tempo real
pm2 restart notifica-api   # Restart manual
tail -f /var/log/notifica_watchdog.log  # Logs do watchdog
curl http://localhost/api/health        # Testar health check
```

---

## 🔒 Segurança

- O arquivo `.env` com credenciais **nunca deve ser versionado** (está no `.gitignore`)
- Use sempre **App Passwords** — nunca a senha principal da conta
- O backend valida o tamanho do texto TTS (máx. 500 caracteres)
- O frontend sanitiza todo texto contra XSS via `escapeHtml()`
- O `limit` do histórico é limitado a 200 no backend para evitar abuso

---

## 📄 Licença

Este projeto foi desenvolvido para uso interno. Adapte conforme necessário.

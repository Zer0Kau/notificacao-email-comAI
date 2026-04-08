# 🔔 Middleware de Notificações Web

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
| **TTS** | edge-tts 6.1 | Síntese de voz Microsoft Edge (pt-BR, Francisca) |
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
│   ├── main.py              # Entry point FastAPI: rotas, SSE, TTS, lifespan
│   ├── mail_worker.py       # Worker IMAP IDLE: conexão, filtro regex, parsing
│   ├── database.py          # Engine SQLAlchemy async + init_db()
│   ├── models.py            # Modelo Notification (SQLAlchemy ORM)
│   └── schemas.py           # Schemas Pydantic (validação/serialização)
├── static/
│   ├── index.html           # SPA — interface Windows 11 Notification Center
│   └── script.js            # Lógica SSE, toasts, TTS, áudio, histórico
├── .env                     # ⚠️ Variáveis de ambiente (NÃO versionar)
├── .env.example             # Template de configuração (valores fictícios)
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

## 🔒 Segurança

- O arquivo `.env` com credenciais **nunca deve ser versionado** (está no `.gitignore`)
- Use sempre **App Passwords** — nunca a senha principal da conta
- O backend valida o tamanho do texto TTS (máx. 500 caracteres)
- O frontend sanitiza todo texto contra XSS via `escapeHtml()`
- O `limit` do histórico é limitado a 200 no backend para evitar abuso

---

## 📄 Licença

Este projeto foi desenvolvido para uso interno. Adapte conforme necessário.

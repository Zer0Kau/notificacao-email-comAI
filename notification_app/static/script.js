/**
 * Script.js — Lógica SSE, toasts, TTS e manipulação de DOM
 * Estilo: Windows 11 Notification Center
 */

// ===== Estado =====
let notificationCount = 0;

// ===== Elementos DOM =====
const notificationList = document.getElementById("notificationList");
const emptyState = document.getElementById("emptyState");
const toastContainer = document.getElementById("toastContainer");
const badgeCount = document.getElementById("badgeCount");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// ===== Som de alerta (ping curto ~150ms via AudioContext) =====
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playPing() {
    return new Promise((resolve) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.value = 880;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.15);
        osc.onended = resolve;
    });
}

// ===== TTS via Edge TTS (backend) =====
let currentTtsAudio = null;

function preloadTts(text) {
    const encoded = encodeURIComponent(text);
    // Cache-bust: adiciona timestamp para forçar novo download mesmo com texto idêntico
    const audio = new Audio(`/api/tts?text=${encoded}&_t=${Date.now()}`);
    audio.preload = "auto";
    audio.load();
    return audio;
}

async function alertAndSpeak(data) {
    // Resume AudioContext se estiver suspenso (política de autoplay)
    if (audioCtx.state === "suspended") await audioCtx.resume();

    // Cancela TTS anterior e libera recurso
    if (currentTtsAudio) {
        currentTtsAudio.pause();
        currentTtsAudio.removeAttribute("src");
        currentTtsAudio.load();
        currentTtsAudio = null;
    }

    const text = data.title || "Nova notificação";

    // Inicia download do TTS em paralelo com o ping
    currentTtsAudio = preloadTts(text);

    // Toca ping curto e espera terminar
    await playPing();

    // Espera o áudio estar pronto antes de tocar
    try {
        await new Promise((resolve, reject) => {
            currentTtsAudio.addEventListener("canplaythrough", resolve, { once: true });
            currentTtsAudio.addEventListener("error", reject, { once: true });
            // Timeout de segurança (5s)
            setTimeout(resolve, 5000);
        });
        await currentTtsAudio.play();
    } catch (e) {
        console.warn("TTS playback falhou:", e);
    }
}

// ===== TTS sem ping (usado para resumo de IA) =====
async function speakText(text) {
    if (!text) return;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    // Cancela qualquer TTS anterior
    if (currentTtsAudio) {
        currentTtsAudio.pause();
        currentTtsAudio.removeAttribute("src");
        currentTtsAudio.load();
        currentTtsAudio = null;
    }
    const encoded = encodeURIComponent(text.slice(0, 500));
    currentTtsAudio = new Audio(`/api/tts?text=${encoded}&_t=${Date.now()}`);
    currentTtsAudio.preload = "auto";
    currentTtsAudio.load();
    try {
        await new Promise((resolve, reject) => {
            currentTtsAudio.addEventListener("canplaythrough", resolve, { once: true });
            currentTtsAudio.addEventListener("error", reject, { once: true });
            setTimeout(resolve, 5000);
        });
        await currentTtsAudio.play();
    } catch (e) {
        console.warn("TTS resumo falhou:", e);
    }
}

// ===== SSE Connection =====
function connectSSE() {
    setConnectionStatus("connecting");

    const evtSource = new EventSource("/api/stream");

    evtSource.addEventListener("notification", (event) => {
        const data = JSON.parse(event.data);
        addNotificationCard(data);
        showToast(data);
        updateBadge(1);
        // TTS removido — apenas ping; o TTS toca após o resumo da IA
        playPing();
    });

    evtSource.addEventListener("ping", () => {
        // Heartbeat — mantém a conexão viva
    });

    evtSource.addEventListener("update", (event) => {
        const data = JSON.parse(event.data);
        // Localiza o card pelo data-notif-id
        const card = document.querySelector(`[data-notif-id="${data.id}"]`);
        if (card) {
            const msgEl = card.querySelector("[data-msg]");
            if (msgEl) {
                msgEl.textContent = data.summary;
                msgEl.classList.add("ai-summary");
            }
            // Adiciona badge de IA se ainda não existir
            if (!card.querySelector(".ai-badge")) {
                const badgeRow = card.querySelector(".flex.items-center.gap-2");
                if (badgeRow) {
                    const badge = document.createElement("span");
                    badge.className = "ai-badge text-[10px] px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-400";
                    badge.textContent = "IA";
                    badgeRow.appendChild(badge);
                }
            }
        }
        // Ping + fala o resumo de IA (único TTS desta notificação)
        playPing().then(() => speakText(data.summary));
    });

    evtSource.onopen = () => {
        setConnectionStatus("connected");
    };

    evtSource.onerror = () => {
        setConnectionStatus("disconnected");
        evtSource.close();
        // Reconecta após 3 segundos
        setTimeout(connectSSE, 3000);
    };
}

// ===== Status da Conexão =====
function setConnectionStatus(status) {
    statusDot.className = "status-dot";
    switch (status) {
        case "connected":
            statusDot.classList.add("status-connected");
            statusText.textContent = "Conectado";
            break;
        case "disconnected":
            statusDot.classList.add("status-disconnected");
            statusText.textContent = "Desconectado — reconectando...";
            break;
        case "connecting":
            statusDot.classList.add("status-connecting");
            statusText.textContent = "Conectando...";
            break;
    }
}

// ===== Badge (contador) =====
function updateBadge(increment) {
    notificationCount += increment;
    if (notificationCount > 0) {
        badgeCount.textContent = notificationCount > 99 ? "99+" : notificationCount;
        badgeCount.classList.remove("hidden");
        badgeCount.classList.add("badge-pulse");
        setTimeout(() => badgeCount.classList.remove("badge-pulse"), 600);
    } else {
        badgeCount.classList.add("hidden");
    }
}

// ===== Formatar timestamp =====
function formatTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return "Agora";
    if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;

    return date.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

// ===== Ícone por remetente / regra =====
function getSenderIcon(data) {
    const sender = (data.sender || "").toLowerCase();
    const rule = (data.rule_matched || "");

    // Ícones por remetente específico
    if (sender.includes("zabbix"))     return `<svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
    if (sender.includes("grafana"))    return `<svg class="w-6 h-6 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6m6 0h6m-6 0V9a2 2 0 012-2h2a2 2 0 012 2v10m6 0v-4a2 2 0 00-2-2h-2a2 2 0 00-2 2v4"/></svg>`;
    if (sender.includes("deploy") || sender.includes("jenkins") || sender.includes("github"))
        return `<svg class="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>`;
    if (sender.includes("suap"))
        return `<svg class="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/></svg>`;
    if (sender.includes("sistema.processos"))
        return `<svg class="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>`;
    if (sender.includes("noreply") || sender.includes("no-reply"))
        return `<svg class="w-6 h-6 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;

    // Fallback por regra
    const ruleIcons = {
        "Zabbix NTI CJ":      `<svg class="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        "Zabbix Alerts":      `<svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>`,
        "Monitoramento":      `<svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`,
        "Sistema Processos":  `<svg class="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>`,
        "SUAP":               `<svg class="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/></svg>`,
        "Deploy":             `<svg class="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>`,
        "Teste Manual":       `<svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>`,
    };
    return ruleIcons[rule] || `<svg class="w-6 h-6 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
}

// ===== Cor do badge da regra =====
function getRuleBadgeColor(rule) {
    const colors = {
        "Zabbix NTI CJ": "bg-red-500/20 text-red-400",
        "Zabbix Alerts": "bg-red-500/20 text-red-400",
        "Monitoramento":     "bg-blue-500/20 text-blue-400",
        "Sistema Processos": "bg-emerald-500/20 text-emerald-400",
        "SUAP":              "bg-amber-500/20 text-amber-400",
        "Deploy":            "bg-green-500/20 text-green-400",
        "Teste Manual":      "bg-blue-500/20 text-blue-400",
    };
    return colors[rule] || "bg-neutral-500/20 text-neutral-400";
}

// ===== Sanitizar texto contra XSS =====
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ===== Adicionar card na lista =====
function addNotificationCard(data) {
    // Remove o estado vazio
    if (emptyState) emptyState.remove();

    const card = document.createElement("div");
    card.className = "acrylic-card p-3.5 notif-enter cursor-default";
    card.dataset.notifId = data.id;  // permite localizar o card pelo update de IA
    card.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="mt-0.5 shrink-0">${getSenderIcon(data)}</div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2 mb-1">
                    <h3 class="text-sm font-semibold truncate">${escapeHtml(data.title)}</h3>
                    <span class="text-[10px] text-neutral-500 shrink-0">${formatTime(data.timestamp)}</span>
                </div>
                <p class="text-xs text-neutral-400 mb-2 line-clamp-2" data-msg>${escapeHtml(data.message)}</p>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] px-2 py-0.5 rounded-full ${getRuleBadgeColor(data.rule_matched)}">${escapeHtml(data.rule_matched || "")}</span>
                    <span class="text-[10px] text-neutral-500 truncate">${escapeHtml(data.sender)}</span>
                </div>
            </div>
            <button onclick="this.closest('.acrylic-card').remove()" class="text-neutral-500 hover:text-white text-sm mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
        </div>
    `;

    // Insere no topo da lista
    notificationList.prepend(card);
}

// ===== Toast (notificação flutuante) =====
function showToast(data) {
    const toast = document.createElement("div");
    toast.className = "mica-bg rounded-xl p-4 shadow-2xl shadow-black/40 border border-white/10 toast-enter pointer-events-auto";
    toast.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="shrink-0 mt-0.5">${getSenderIcon(data)}</div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">${escapeHtml(data.rule_matched || "E-mail")}</span>
                    <span class="text-[10px] text-neutral-500">Agora</span>
                </div>
                <h4 class="text-sm font-semibold mt-1 truncate">${escapeHtml(data.title)}</h4>
                <p class="text-xs text-neutral-400 mt-0.5 line-clamp-2">${escapeHtml(data.message)}</p>
            </div>
            <button onclick="dismissToast(this.closest('.mica-bg'))" class="text-neutral-500 hover:text-white text-xs shrink-0">✕</button>
        </div>
    `;

    toastContainer.appendChild(toast);

    // Auto-dismiss após 6 segundos
    setTimeout(() => dismissToast(toast), 6000);
}

function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove("toast-enter");
    el.classList.add("toast-exit");
    el.addEventListener("animationend", () => el.remove(), { once: true });
}

// ===== Limpar todas as notificações =====
function clearAll() {
    notificationList.innerHTML = `
        <div id="emptyState" class="flex flex-col items-center justify-center h-full text-neutral-500">
            <svg class="w-16 h-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
                    d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            <p class="text-sm">Nenhuma notificação</p>
            <p class="text-xs mt-1 text-neutral-600">As notificações aparecerão aqui em tempo real</p>
        </div>
    `;
    notificationCount = 0;
    updateBadge(0);
}

// ===== Botão Testar =====
async function sendTestNotification() {
    try {
        await fetch("/api/test-notification", { method: "POST" });
    } catch (e) {
        console.error("Erro ao enviar notificação de teste:", e);
    }
}

// ===== Bottom Sheet — Histórico =====
let historyOpen = false;
const historySheet   = document.getElementById("historySheet");
const sheetBackdrop  = document.getElementById("sheetBackdrop");
const historyList    = document.getElementById("historyList");
const historyCount   = document.getElementById("historyCount");
const historyBtn     = document.getElementById("historyBtn");

function getRuleBorderClass(rule) {
    if (!rule) return "rule-border-default";
    const r = rule.toLowerCase();
    if (r.includes("zabbix"))              return "rule-border-zabbix";
    if (r.includes("monitoramento"))        return "rule-border-monitoramento";
    if (r.includes("sistema processos"))    return "rule-border-sistema-processos";
    if (r.includes("suap"))                return "rule-border-suap";
    if (r.includes("deploy"))              return "rule-border-deploy";
    if (r.includes("teste"))               return "rule-border-teste";
    return "rule-border-default";
}

function buildHistoryCard(data) {
    const borderClass = getRuleBorderClass(data.rule_matched);
    return `
        <div class="acrylic-card ${borderClass} p-3 pl-4">
            <div class="flex items-start gap-3">
                <div class="mt-0.5 shrink-0">${getSenderIcon(data)}</div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-2 mb-0.5">
                        <h3 class="text-[13px] font-semibold truncate text-neutral-100">${escapeHtml(data.title)}</h3>
                        <span class="text-[10px] text-neutral-500 shrink-0">${formatTime(data.timestamp)}</span>
                    </div>
                    <p class="text-[11px] text-neutral-400 line-clamp-2 mb-1.5">${escapeHtml(data.message)}</p>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] px-2 py-0.5 rounded-full ${getRuleBadgeColor(data.rule_matched)}">${escapeHtml(data.rule_matched || "")}</span>
                        <span class="text-[10px] text-neutral-600 truncate">${escapeHtml(data.sender)}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function toggleHistory() {
    historyOpen = !historyOpen;

    if (historyOpen) {
        // Abre o sheet
        historySheet.classList.add("open");
        sheetBackdrop.classList.add("open");
        historyBtn.style.opacity = "0";
        historyBtn.style.pointerEvents = "none";

        // Lazy load — busca dados só ao abrir
        historyList.innerHTML = '<p class="text-xs text-neutral-500 text-center py-10">Carregando...</p>';
        try {
            const res = await fetch("/api/notifications/history?limit=50");
            const data = await res.json();
            if (data.length === 0) {
                historyList.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-14 text-neutral-500">
                        <svg class="w-10 h-10 mb-3 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <p class="text-xs">Nenhuma notificação no histórico</p>
                    </div>`;
            } else {
                historyCount.textContent = `(${data.length})`;
                historyList.innerHTML = data.map(buildHistoryCard).join("");
            }
        } catch (e) {
            historyList.innerHTML = '<p class="text-xs text-red-400 text-center py-10">Erro ao carregar histórico</p>';
        }
    } else {
        // Fecha o sheet
        historySheet.classList.remove("open");
        sheetBackdrop.classList.remove("open");
        historyBtn.style.opacity = "";
        historyBtn.style.pointerEvents = "";
        historyCount.textContent = "";
    }
}

// ===== Inicialização =====
document.addEventListener("DOMContentLoaded", () => {
    connectSSE();
});

/**
 * Script.js — Lógica SSE, toasts, TTS e manipulação de DOM
 * Estilo: Windows 11 Notification Center
 */

// ===== Estado =====
// O estado de conclusão vive no servidor (SQLite). O localStorage só guarda
// preferências de cada dispositivo (som, estação de rádio).
let notificationCount = 0;
let isMuted = localStorage.getItem('notifMuted') === 'true';
let stats = null;          // última resposta de /api/stats (fonte de verdade dos contadores)
let viewCleared = false;   // "Limpar" esvazia a vista sem tocar no banco
let statsRefreshTimer = null;
let isSpeaking = false;    // evita cortar a fala em curso
let pendingSpeech = null;  // guarda a fala mais recente à espera de turno

// Limpa chaves do modelo anterior (estado de conclusão em localStorage)
["resolvedNotificationIds", "resolvedAtById", "resolvedCategoryById", "deletedNotificationIds"]
    .forEach((key) => localStorage.removeItem(key));

// Estações com streaming público. A seleção e o volume ficam no dispositivo.
const radioStations = [
    { name: "89 A Rádio Rock", genre: "Rock", color: "#4ade80", url: "https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO_89FM.mp3" },
    { name: "SomaFM Metal Detector", genre: "Metal", color: "#f97316", url: "https://ice1.somafm.com/metal-128-mp3" },
    {
        name: "Rádio Saber",
        genre: "Variada",
        color: "#3b82f6",
        url: "https://server05.srvsh.com.br:7944/stream"
    },
    {name: "Nativa Jacarezinho", genre: "Variada", color: "#facc15", url: "https://streamingv2.shoutcast.com/nativaradiocj"},
];

let radioCurrentIndex = Number(localStorage.getItem("radioStationIndex")) || 0;
let radioWasPlayingBeforeSpeech = false;
let radioUserStarted = false;   // só o play explícito do utilizador arranca o áudio
let radioConnectTimer = null;   // deteta estações mortas na TV do NOC
let radioFailures = 0;
const RADIO_CONNECT_TIMEOUT = 10000;

// ===== Elementos DOM =====
const notificationList = document.getElementById("notificationList");
const toastContainer = document.getElementById("toastContainer");
const badgeCount = document.getElementById("badgeCount");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const categoryCounters = document.getElementById("categoryCounters");
const reportSummary = document.getElementById("reportSummary");
const notificationTotal = document.getElementById("notificationTotal");

const radioAudio = document.getElementById("radioAudio");
const radioPresets = document.getElementById("radioPresets");
const radioNowPlaying = document.getElementById("radioNowPlaying");

// ===== Som de alerta (ping curto ~150ms via AudioContext) =====
// AudioContext criado de forma LAZY (obrigatório no iOS — criação fora de gesto
// de utilizador pode lançar erro e impedir todo o script de executar)
let _audioCtx = null;

function ensureAudioCtx() {
    if (!_audioCtx) {
        try {
            _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[Audio] AudioContext não disponível:', e);
        }
    }
    return _audioCtx;
}

function playPing() {
    return new Promise((resolve) => {
        if (isMuted) return resolve();
        const ctx = ensureAudioCtx();
        if (!ctx) return resolve();
        if (ctx.state === "suspended") { ctx.resume().catch(() => { }); }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
        osc.onended = resolve;
    });
}

// ===== TTS via Edge TTS (backend) =====
// Usa fetch() + AudioContext.decodeAudioData() em vez de new Audio():
//   • fetch() → único request HTTP, sem o range-request extra do iOS Safari
//   • AudioContext → já desbloqueado pelo primeiro toque; HTMLAudioElement.play()
//     exigiria novo gesto do usuário no iOS e não funcionaria via SSE
let currentTtsSource = null;

function pauseRadioForSpeech() {
    if (!radioAudio || radioAudio.paused) return;
    radioWasPlayingBeforeSpeech = true;
    radioAudio.pause();
    updateRadioCards();
}

function resumeRadioAfterSpeech() {
    if (!radioAudio || !radioWasPlayingBeforeSpeech) return;
    radioWasPlayingBeforeSpeech = false;
    radioAudio.play().catch(() => { });
    updateRadioCards();
}

async function fetchAndPlayTts(text) {
    if (!text || isMuted) return;
    // Não corta a fala em curso: guarda a mais recente para depois
    if (isSpeaking) {
        pendingSpeech = text;
        return;
    }
    isSpeaking = true;
    pauseRadioForSpeech();
    try {
        const ctx = ensureAudioCtx();
        if (!ctx) return;
        if (ctx.state === "suspended") await ctx.resume();

        const encoded = encodeURIComponent(text.slice(0, 500));
        const url = `/api/tts?text=${encoded}&_t=${Date.now()}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        currentTtsSource = source;
        source.start(0);
        await new Promise((resolve) => { source.onended = resolve; });
    } catch (e) {
        console.warn("TTS playback falhou:", e);
    } finally {
        // O finally garante que a rádio volta mesmo se o AudioContext faltar
        currentTtsSource = null;
        isSpeaking = false;
        resumeRadioAfterSpeech();
        const next = pendingSpeech;
        pendingSpeech = null;
        if (next) fetchAndPlayTts(next);
    }
}

function renderRadioPresets() {
    if (!radioPresets) return;
    radioPresets.innerHTML = radioStations.map((station, index) => `
        <button class="radio-card acrylic-card p-2.5 text-left shrink-0" data-radio-index="${index}" onclick="playRadioStation(${index})" role="listitem" aria-label="Ouvir ${escapeHtml(station.name)}">
            <span class="flex items-center gap-2">
                <span class="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold" style="background:${station.color}22;color:${station.color}">${escapeHtml(station.name.slice(0, 2).toUpperCase())}</span>
                <span class="min-w-0">
                    <span class="block text-xs font-semibold text-slate-200 truncate">${escapeHtml(station.name)}</span>
                    <span class="block text-[10px] text-slate-500 truncate">${escapeHtml(station.genre)}</span>
                </span>
            </span>
            <span class="flex gap-0.5 items-end h-3 mt-2 ml-1 opacity-70" aria-hidden="true">
                <i class="radio-wave w-0.5 h-2 rounded-full" style="background:${station.color}"></i><i class="radio-wave w-0.5 h-3 rounded-full" style="background:${station.color};animation-delay:.15s"></i><i class="radio-wave w-0.5 h-1.5 rounded-full" style="background:${station.color};animation-delay:.3s"></i>
            </span>
        </button>
    `).join("");
    updateRadioCards();
}

function updateRadioCards() {
    document.querySelectorAll("[data-radio-index]").forEach((card) => {
        const isCurrent = Number(card.dataset.radioIndex) === radioCurrentIndex;
        card.classList.toggle("is-active", isCurrent);
        card.classList.toggle("is-playing", isCurrent && radioAudio && !radioAudio.paused);
    });
}

function updateRadioPlayButton() {
    const button = document.getElementById("radioPlayBtn");
    const icon = document.getElementById("radioPlayIcon");
    if (!button || !icon || !radioAudio) return;
    const isPlaying = !radioAudio.paused;
    icon.innerHTML = isPlaying
        ? '<path d="M7 5a2 2 0 012-2h1a2 2 0 012 2v14a2 2 0 01-2 2H9a2 2 0 01-2-2V5zm7 0a2 2 0 012-2h1a2 2 0 012 2v14a2 2 0 01-2 2h-1a2 2 0 01-2-2V5z"/>'
        : '<path d="M8 5.14v13.72a1 1 0 001.54.84l10.18-6.86a1 1 0 000-1.68L9.54 4.3A1 1 0 008 5.14z"/>';
    button.setAttribute("aria-label", isPlaying ? "Pausar rádio" : "Reproduzir rádio");
    button.title = isPlaying ? "Pausar rádio" : "Reproduzir rádio";
}

function toggleRadioPlayback() {
    if (!radioAudio) return;
    if (radioAudio.paused) {
        startRadio();
    } else {
        clearTimeout(radioConnectTimer);
        radioAudio.pause();
        radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · pausada`;
    }
}

function startRadio() {
    // Só o play explícito conta como gesto do utilizador (exigência do iOS)
    radioUserStarted = true;
    radioFailures = 0;
    radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · conectando...`;
    radioAudio.play().catch(() => {
        radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · transmissão indisponível`;
        updateRadioPlayButton();
    });
    armRadioConnectTimeout();
}

// Numa TV do NOC ninguém está a olhar para o ecrã: se a estação não responder
// em tempo razoável, avança sozinha até encontrar uma que funcione.
function armRadioConnectTimeout() {
    clearTimeout(radioConnectTimer);
    radioConnectTimer = setTimeout(() => {
        if (radioAudio.paused || radioAudio.readyState >= 3) return;
        radioFailures += 1;
        if (radioFailures >= radioStations.length) {
            clearTimeout(radioConnectTimer);
            radioNowPlaying.textContent = "Nenhuma estação disponível";
            updateRadioPlayButton();
            return;
        }
        changeRadioStation(1);
        armRadioConnectTimeout();
    }, RADIO_CONNECT_TIMEOUT);
}

function playRadioStation(index) {
    // Tocar numa estação do preset é gesto explícito do utilizador: conta para
    // efeitos de autoplay, tal como o botão play, e desbloqueia as setas.
    radioUserStarted = true;
    radioFailures = 0;
    selectRadio(index);
}

function changeRadioStation(direction) {
    const nextIndex = (radioCurrentIndex + direction + radioStations.length) % radioStations.length;
    // Só arranca o áudio se o utilizador já o tinha iniciado — numa parede
    // partilhada, trocar de estação não pode ligar o som sozinho.
    selectRadio(nextIndex, { autoplay: radioUserStarted });
}

function selectRadio(index, { autoplay = true } = {}) {
    const station = radioStations[index];
    if (!station || !radioAudio) return;
    const isSameStation = index === radioCurrentIndex;
    const wasPlaying = !radioAudio.paused;
    radioCurrentIndex = index;
    localStorage.setItem("radioStationIndex", index);
    if (!isSameStation) {
        radioAudio.src = station.url;
        radioAudio.load();
    }
    radioNowPlaying.textContent = `${station.name} · ${station.genre}`;
    updateRadioCards();
    if (isSameStation && wasPlaying) {
        // Clique na estação que já está a tocar serve para pausar
        clearTimeout(radioConnectTimer);
        radioAudio.pause();
        return;
    }
    if (!autoplay) return;

    radioNowPlaying.textContent = `${station.name} · conectando...`;
    radioAudio.play().catch(() => {
        radioNowPlaying.textContent = `${station.name} · transmissão indisponível`;
        updateRadioPlayButton();
    });
    armRadioConnectTimeout();
}

function initRadio() {
    if (!radioAudio || !radioPresets) return;
    radioAudio.addEventListener("play", updateRadioCards);
    radioAudio.addEventListener("pause", updateRadioCards);
    radioAudio.addEventListener("play", updateRadioPlayButton);
    radioAudio.addEventListener("pause", updateRadioPlayButton);
    radioAudio.addEventListener("error", () => {
        // Uma estação que falha a ligar não pode deixar a rádio morta: se o
        // utilizador já iniciara a reprodução, reagendamos o connect timeout
        // para passar à estação seguinte; caso contrário fica em pausa.
        if (radioUserStarted) {
            armRadioConnectTimeout();
        } else {
            clearTimeout(radioConnectTimer);
            radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · transmissão indisponível`;
            updateRadioPlayButton();
        }
    });
    radioAudio.addEventListener("playing", () => {
        clearTimeout(radioConnectTimer);
        radioFailures = 0;
        radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · ao vivo`;
        updateRadioPlayButton();
    });
    radioAudio.addEventListener("waiting", onRadioBuffering);
    radioAudio.addEventListener("stalled", onRadioBuffering);
    document.addEventListener("keydown", (event) => {
        if (!window.matchMedia("(min-width: 768px)").matches) return;
        if (!document.activeElement?.closest(".tv-radio")) return;
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            changeRadioStation(-1);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            changeRadioStation(1);
        }
    });
    renderRadioPresets();
    const station = radioStations[radioCurrentIndex] || radioStations[0];
    radioCurrentIndex = radioStations.indexOf(station);
    radioAudio.src = station.url;
    radioNowPlaying.textContent = `${station.name} · ${station.genre}`;
    updateRadioCards();
    updateRadioPlayButton();
}

function onRadioBuffering() {
    if (radioAudio.paused) return;
    radioNowPlaying.textContent = `${radioStations[radioCurrentIndex].name} · reconectando...`;
    armRadioConnectTimeout();
}

async function alertAndSpeak(data) {
    const ctx = ensureAudioCtx();
    if (ctx && ctx.state === "suspended") await ctx.resume();
    const text = data.title || "Nova notificação";
    await playPing();
    await fetchAndPlayTts(text);
}

// ===== TTS sem ping (usado para resumo de IA) =====
async function speakText(text) {
    if (!text) return;
    await fetchAndPlayTts(text);
}

// IDs de notificações cujo resumo de IA já foi processado (evita duplicação)
const _processedAiUpdates = new Set();

function connectSSE() {
    setConnectionStatus("connecting");

    const evtSource = new EventSource("/api/stream");

    evtSource.addEventListener("notification", (event) => {
        const data = JSON.parse(event.data);
        // Uma notificação que chegou depois de a vista ter sido limpa volta a aparecer
        viewCleared = false;
        addNotificationCard(data);
        showToast(data);
        refreshStats();
        playPing();
    });

    evtSource.addEventListener("ping", () => {
        // Heartbeat — mantém a conexão viva
    });

    // Sincroniza o estado quando outro ecrã conclui/dispensa uma demanda
    evtSource.addEventListener("status", (event) => {
        const data = JSON.parse(event.data);
        const card = document.querySelector(`[data-notif-id="${data.id}"]`);
        if (card) {
            viewCleared = false;
            removeCardDom(card);
        }
        scheduleStatsRefresh(0);
    });

    evtSource.addEventListener("update", (event) => {
        const data = JSON.parse(event.data);

        // Ignora se este resumo já foi processado (pode chegar duplicado em reconexões SSE ou com múltiplas abas abertas)
        if (_processedAiUpdates.has(data.id)) return;
        _processedAiUpdates.add(data.id);

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

function getNotificationCategory(dataOrCard) {
    if (typeof dataOrCard === "string") return dataOrCard || "Geral";
    return dataOrCard.rule_matched || dataOrCard.sender || "Geral";
}

// Cor do contador por regra. A ordem importa: as regras específicas
// ("SUAP Resolvido") têm de casar antes das genéricas.
const RULE_COLORS = [
    { match: "zabbix", color: "bg-red-400" },
    { match: "sistema processos", color: "bg-emerald-400" },
    { match: "suap", color: "bg-amber-400" },
    { match: "e-mail para nt.cj", color: "bg-sky-400" },
    { match: "monitoramento", color: "bg-blue-400" },
    { match: "teste", color: "bg-neutral-400" },
];

function getRuleColor(rule) {
    const lower = (rule || "").toLowerCase();
    const hit = RULE_COLORS.find((entry) => lower.includes(entry.match));
    return hit ? hit.color : "bg-neutral-500";
}

// ===== Contadores e relatório — derivados de /api/stats =====
// Vêm do servidor para que qualquer regra nova apareça sem alterar o JS
// (antes, as 4 categorias fixas ignoravam Monitoramento, Teste Manual,
// Zabbix Resolvido e SUAP Resolvido).
async function refreshStats() {
    try {
        const res = await fetch("/api/stats?window_days=7", { cache: "no-store" });
        if (!res.ok) throw new Error(`stats HTTP ${res.status}`);
        stats = await res.json();
        renderCounters();
    } catch (error) {
        console.warn("Não foi possível carregar as estatísticas:", error);
    }
}

function scheduleStatsRefresh(delay = 250) {
    clearTimeout(statsRefreshTimer);
    statsRefreshTimer = setTimeout(refreshStats, delay);
}

function renderCounters() {
    if (!stats) return;
    const rendered = document.querySelectorAll("#notificationList [data-notif-id]").length;
    notificationCount = rendered;

    const entries = Object.entries(stats.open_by_rule)
        .sort((a, b) => b[1] - a[1]);

    if (categoryCounters) {
        categoryCounters.innerHTML = entries.map(([rule, count]) => `
            <span class="counter-card flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-slate-800/70 border border-slate-700/60" title="${escapeHtml(rule)}: ${count}">
                <span class="w-2 h-2 rounded-full ${getRuleColor(rule)}"></span>
                <span class="text-[10px] text-slate-400 max-w-24 truncate">${escapeHtml(rule)}</span>
                <strong class="text-xs text-white">${count}</strong>
            </span>
        `).join("");
        categoryCounters.classList.remove("hidden");
    }

    renderCompletionReport();

    if (notificationTotal) {
        if (viewCleared && stats.open_total > 0) {
            notificationTotal.textContent = `vista limpa · ${stats.open_total} no servidor`;
        } else if (rendered < stats.open_total) {
            // A vista está truncada pelo limite da API — diz-lo em vez de mentir
            notificationTotal.textContent = `${rendered} de ${stats.open_total} abertas`;
        } else {
            notificationTotal.textContent = `${stats.open_total} abertas`;
        }
    }
    updateBadge(0);
}

function getDateKey(dateValue) {
    const date = new Date(dateValue);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getDayLabel(dateKey) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const today = getDateKey(new Date());
    const yesterday = getDateKey(new Date(Date.now() - 86400000));
    if (dateKey === today) return "Hoje";
    if (dateKey === yesterday) return "Ontem";
    return date.toLocaleDateString("pt-BR", {
        weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
    }).replace(/^./, (letter) => letter.toUpperCase());
}

// Estado vazio — markup espelhado do que está em index.html (first paint).
// O id é sempre re-querido ao DOM: guardar uma referência no load partia
// depois de um innerHTML, deixando o estado vazio e os cards coexistirem.
function showEmptyState(message = "As notificações aparecerão aqui em tempo real") {
    const existing = notificationList.querySelector("#emptyState");
    if (existing) {
        existing.querySelector("[data-empty-hint]").textContent = message;
        return;
    }
    const wrap = document.createElement("div");
    wrap.id = "emptyState";
    wrap.className = "flex flex-col items-center justify-center h-full py-24 text-slate-600";
    wrap.innerHTML = `
        <svg class="w-16 h-16 mb-4 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
        </svg>
        <p class="text-sm font-medium">Nenhuma notificação</p>
        <p class="text-xs mt-1 text-slate-700" data-empty-hint></p>
    `;
    wrap.querySelector("[data-empty-hint]").textContent = message;
    notificationList.appendChild(wrap);
}

function getOrCreateDayGroup(data) {
    const dateKey = getDateKey(data.timestamp);
    let group = notificationList.querySelector(`[data-day-key="${dateKey}"]`);
    if (group) return group;

    notificationList.querySelector("#emptyState")?.remove();
    group = document.createElement("section");
    group.className = "day-group space-y-2.5";
    group.dataset.dayKey = dateKey;
    group.innerHTML = `
        <div class="flex items-center justify-between px-1 pt-2 pb-1">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(getDayLabel(dateKey))}</h3>
            <span class="day-count text-[10px] text-slate-600">0 demandas</span>
        </div>
        <div data-day-items class="space-y-2.5"></div>
    `;
    notificationList.prepend(group);
    return group;
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
    if (sender.includes("zabbix")) return `<svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
    if (sender.includes("grafana")) return `<svg class="w-6 h-6 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6m6 0h6m-6 0V9a2 2 0 012-2h2a2 2 0 012 2v10m6 0v-4a2 2 0 00-2-2h-2a2 2 0 00-2 2v4"/></svg>`;
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
        "Zabbix NTI CJ": `<svg class="w-6 h-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
        "Zabbix Alerts": `<svg class="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>`,
        "Monitoramento": `<svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`,
        "Sistema Processos": `<svg class="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>`,
        "SUAP": `<svg class="w-6 h-6 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/></svg>`,
        "Deploy": `<svg class="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>`,
        "Teste Manual": `<svg class="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6 6 0 10-12 0v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>`,
    };
    return ruleIcons[rule] || `<svg class="w-6 h-6 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>`;
}

// ===== Cor do badge da regra =====
function getRuleBadgeColor(rule) {
    const colors = {
        "Zabbix NTI CJ": "bg-red-500/20 text-red-400",
        "Zabbix Alerts": "bg-red-500/20 text-red-400",
        "Monitoramento": "bg-blue-500/20 text-blue-400",
        "Sistema Processos": "bg-emerald-500/20 text-emerald-400",
        "SUAP": "bg-amber-500/20 text-amber-400",
        "Deploy": "bg-green-500/20 text-green-400",
        "Teste Manual": "bg-blue-500/20 text-blue-400",
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
    // O estado de conclusão já não vive no browser: um id só aparece se o
    // servidor o Continuar a devolver em ?status=open.
    if (document.querySelector(`[data-notif-id="${data.id}"]`)) return;
    viewCleared = false;

    const dayGroup = getOrCreateDayGroup(data);

    const card = document.createElement("div");
    card.className = "acrylic-card p-3.5 notif-enter cursor-default";
    card.dataset.notifId = data.id;  // permite localizar o card pelo update de IA
    card.dataset.category = getNotificationCategory(data);
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
            <div class="flex items-start gap-1 shrink-0">
                <button onclick="resolveNotificationCard(this)" class="text-emerald-400 hover:text-emerald-200 text-base px-1 transition-opacity" aria-label="Concluir demanda" title="Concluir demanda">✓</button>
                <button onclick="deleteNotificationCard(this)" class="text-slate-500 hover:text-red-300 text-base px-1 transition-opacity" aria-label="Dispensar demanda" title="Dispensar demanda">🗑</button>
            </div>
        </div>
    `;

    dayGroup.querySelector("[data-day-items]").prepend(card);
    const dayCards = dayGroup.querySelectorAll("[data-notif-id]").length;
    dayGroup.querySelector(".day-count").textContent = `${dayCards} ${dayCards === 1 ? "demanda" : "demandas"}`;
}

// ===== Toast (notificação flutuante) =====
function isMobile() {
    return window.innerWidth <= 768;
}

function showToast(data) {
    // No celular, não exibe o toast flutuante (só o card na lista)
    if (isMobile()) return;

    // Aceita tanto o payload de uma notificação como texto simples
    // (usado nas respostas a falhas de escrita e no teste de push)
    const payload = typeof data === "string"
        ? { title: data, message: "", sender: "", rule_matched: "" }
        : data;

    const toast = document.createElement("div");
    toast.className = "mica-bg rounded-xl p-4 shadow-2xl shadow-black/40 border border-white/10 toast-enter pointer-events-auto";
    toast.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="shrink-0 mt-0.5">${getSenderIcon(payload)}</div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">${escapeHtml(payload.rule_matched || "Sistema")}</span>
                    <span class="text-[10px] text-neutral-500">Agora</span>
                </div>
                <h4 class="text-sm font-semibold mt-1 truncate">${escapeHtml(payload.title)}</h4>
                ${payload.message ? `<p class="text-xs text-neutral-400 mt-0.5 line-clamp-2">${escapeHtml(payload.message)}</p>` : ""}
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
// "Limpar" esvazia apenas a vista. Não escreve nada no banco: as demandas
// continuam abertas e regressam no próximo carregamento.
// Para as tirar mesmo do backlog é o 🗑 (dispensar) em cada card.
function clearAll() {
    document.querySelectorAll("#notificationList [data-notif-id]").forEach(removeCardDom);
    document.querySelectorAll("#notificationList [data-day-key]").forEach((group) => group.remove());
    showEmptyState("Vista limpa — as demandas continuam abertas no servidor.");
    viewCleared = true;
    renderCounters();
}

// Remove o card do DOM e ajusta a contagem do grupo do dia.
function removeCardDom(card) {
    const group = card.closest("[data-day-key]");
    card.remove();
    if (!group) return;
    const remaining = group.querySelectorAll("[data-notif-id]").length;
    if (!remaining) {
        group.remove();
    } else {
        group.querySelector(".day-count").textContent = `${remaining} ${remaining === 1 ? "demanda" : "demandas"}`;
    }
}

async function setNotificationStatus(id, status) {
    const res = await fetch(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    return await res.json();
}

// Remoção optimista: some o card de imediato e repõe se o servidor recusar.
async function applyStatusChange(card, status) {
    const id = card.dataset.notifId;
    const parent = card.parentNode;
    const nextSibling = card.nextSibling;
    const label = status === "resolved" ? "concluída" : "dispensada";

    viewCleared = false;
    removeCardDom(card);
    scheduleStatsRefresh(0);

    try {
        await setNotificationStatus(id, status);
    } catch (error) {
        parent.insertBefore(card, nextSibling);
        showToast(`Falha ao marcar como ${label}.`);
        scheduleStatsRefresh(0);
    }
}

function resolveNotificationCard(button) {
    const card = button?.closest("[data-notif-id]");
    if (!card) return;
    applyStatusChange(card, "resolved");
}

function deleteNotificationCard(button) {
    const card = button?.closest("[data-notif-id]");
    if (!card) return;
    applyStatusChange(card, "discarded");
}

function renderCompletionReport() {
    if (!reportSummary || !stats) return;

    const avg = String(stats.daily_average ?? 0).replace(".", ",");
    // Monitoramento é uma regra genérica de fallback: incluí-la só distorce a
    // quebra por categoria.
    const dayRows = stats.by_day.map((day) => {
        const categoryText = Object.entries(day.by_rule)
            .filter(([rule]) => rule.toLowerCase() !== "monitoramento")
            .map(([rule, count]) => `${rule}: ${count}`)
            .join(" · ");
        return `<div class="flex items-start justify-between gap-2 text-[10px] text-slate-400"><span>${escapeHtml(getDayLabel(day.day))}</span><span class="text-right text-slate-500">${day.total} concluída(s)${categoryText ? `<br>${escapeHtml(categoryText)}` : ""}</span></div>`;
    }).join("");

    reportSummary.innerHTML = `
        <div class="flex items-end justify-between gap-3 mb-3">
            <div><p class="text-[10px] uppercase tracking-wider text-slate-500">Concluídas hoje</p><strong class="text-2xl text-emerald-300">${stats.resolved_today}</strong></div>
            <div class="text-right"><p class="text-[10px] uppercase tracking-wider text-slate-500">Total concluído</p><strong class="text-lg text-slate-200">${stats.resolved_total}</strong></div>
        </div>
        <div class="border-t border-slate-700/50 pt-2 mb-3">
            <div class="flex items-center justify-between mb-2"><p class="text-[10px] uppercase tracking-wider text-slate-500">Últimos ${stats.window_days} dias</p><strong class="text-sm text-slate-200">${stats.resolved_window}</strong></div>
            <p class="text-[10px] text-slate-600 mb-2">${stats.days_elapsed ? `Média: ${avg}/dia` : "Sem histórico no período"}</p>
            <div class="space-y-2">${dayRows || '<p class="text-[10px] text-slate-600">Nenhuma conclusão no período.</p>'}</div>
        </div>
        <div class="flex items-center justify-between border-t border-slate-700/50 pt-2 text-[10px]">
            <span class="text-slate-600">Abertas <strong class="text-amber-300">${stats.open_total}</strong></span>
            <span class="text-slate-600" title="Dispensadas: não contam como trabalho executado">Dispensadas <strong class="text-slate-400">${stats.discarded_total}</strong></span>
        </div>
    `;
}

async function loadNotificationHistory() {
    try {
        const response = await fetch('/api/notifications?limit=200&status=open', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Histórico HTTP ${response.status}`);
        const history = await response.json();
        // A API devolve do mais recente para o mais antigo; a lista cresce para cima
        history.reverse().forEach(addNotificationCard);
    } catch (error) {
        console.warn('Não foi possível carregar o histórico:', error);
    } finally {
        // O histórico já foi renderizado: sem isto, o primeiro refreshStats pode
        // ter corrido com a lista ainda vazia e ficavam contadores obsoletos.
        await refreshStats();
    }
}

// ===== Mute toggle =====
function toggleMute() {
    isMuted = !isMuted;
    localStorage.setItem('notifMuted', isMuted);
    updateMuteBtn();
}

function updateMuteBtn() {
    const icon = document.getElementById('muteIcon');
    const btn = document.getElementById('muteBtn');
    if (!icon || !btn) return;
    if (isMuted) {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/>';
        btn.title = 'Som desativado — clique para ativar';
        btn.classList.add('text-red-400');
        btn.classList.remove('text-slate-500');
    } else {
        icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>';
        btn.title = 'Som ativado — clique para mutar';
        btn.classList.remove('text-red-400');
        btn.classList.add('text-slate-500');
    }
}

// ===== Botão Testar =====
function toggleTestDropdown() {
    const menu = document.getElementById("testDropdownMenu");
    menu.classList.toggle("hidden");
}

// Fecha o dropdown ao clicar fora
document.addEventListener("click", (e) => {
    const wrapper = document.getElementById("testDropdownWrapper");
    if (wrapper && !wrapper.contains(e.target)) {
        document.getElementById("testDropdownMenu")?.classList.add("hidden");
    }
});

async function sendTestNotification(rule = "Teste Manual") {
    document.getElementById("testDropdownMenu")?.classList.add("hidden");
    try {
        const params = new URLSearchParams({ rule });
        await fetch(`/api/test-notification?${params}`, { method: "POST" });
    } catch (e) {
        console.error("Erro ao enviar notificação de teste:", e);
    }
}

// ===== Inicialização =====
/* ============================================================
   Encaixe na TV (16:9 / 4K) — escala o design sem o alterar
   ============================================================ */

// Tamanho lógico do painel. Alterar estes dois valores muda a densidade do
// design: menor = conteúdo maior em relação ao ecrã.
const APP_BASE_W = 1600;
const APP_BASE_H = 900;

function applyViewportScale() {
    const viewport = document.getElementById('appViewport');
    const container = document.querySelector('.app-container');
    if (!viewport || !container) return;

    // Medir o contentor depois de o transform ter sido limpo: um
    // getBoundingClientRect com transform aplicado devolveria já a caixa
    // escalada e o cálculo entraria em loop.
    container.style.transform = 'none';

    const boxWidth = container.offsetWidth;
    const boxHeight = container.offsetHeight;
    if (!boxWidth || !boxHeight) return;

    const availableWidth = viewport.clientWidth;
    const availableHeight = viewport.clientHeight;
    if (!availableWidth || !availableHeight) return;

    // min() e não max(): garante que o conteúdo cabe inteiro, deixando
    // bandas vazias em vez de cortar o topo e o fundo.
    const scale = Math.min(availableWidth / boxWidth, availableHeight / boxHeight);

    // Abaixo de 1 o design encolhe; num ecrã gigante deixamos crescer até
    // 2x para não ficar uma miniatura no meio de um painel 4K.
    const finalScale = Math.min(Math.max(scale, 0.1), 2);
    container.style.transform = `scale(${finalScale})`;
}

document.addEventListener("DOMContentLoaded", async () => {
    applyViewportScale();
    initRadio();
    // loadNotificationHistory() refresca os contadores no seu finally, por isso
    // não se chama refreshStats() aqui para não duplicar o pedido no arranque.
    await loadNotificationHistory();
    connectSSE();
    updateMuteBtn();

    // O APK da TV pode redimensionar a janela, e o browser também redimensiona
    // ao rodar o dispositivo — em ambos os casos o scale tem de ser recalculado.
    window.addEventListener('resize', applyViewportScale);
    window.addEventListener('orientationchange', applyViewportScale);

    // Avalia estado das notificações push e mostra banner se necessário
    evaluatePushState();
});

// ============================================================
// Web Push — lógica gesture-driven (obrigatório no iOS)
// ============================================================

function isStandalone() {
    // iOS: window.navigator.standalone === true quando aberto do ecrã inicial
    // Outros: matchMedia display-mode
    return (
        window.navigator.standalone === true ||
        window.matchMedia("(display-mode: standalone)").matches
    );
}

function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function evaluatePushState() {
    // Web Push não disponível
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;

    // iOS em Safari normal (não standalone): mostra instrução para adicionar ao ecrã
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) {
        showPushBanner(
            "📲",
            "Adicione ao Ecrã Inicial",
            "Para receber alertas push, toque em \ufe001 e depois \"Adicionar ao Ecrã Inicial\".",
            "Entendi",
            "ios-instructions"
        );
        return;
    }

    // Permissão já negada — não incomoda o utilizador
    if (Notification.permission === "denied") return;

    // PushManager não disponível (browser sem suporte)
    if (!("PushManager" in window)) return;

    // Permissão já concedida — regista silenciosamente a subscription
    if (Notification.permission === "granted") {
        await _registerSubscriptionSilently();
        return;
    }

    // Permissão ainda 'default' — mostra banner para o utilizador ativar
    showPushBanner(
        "🔔",
        "Ativar Notificações Push",
        "Receba alertas mesmo com o app fechado.",
        "Ativar",
        "request-permission"
    );
}

function showPushBanner(icon, title, desc, btnLabel, mode) {
    const banner = document.getElementById("pushBanner");
    if (!banner) return;

    document.getElementById("pushBannerIcon").textContent = icon;
    document.getElementById("pushBannerTitle").textContent = title;
    document.getElementById("pushBannerDesc").textContent = desc;
    document.getElementById("pushBannerBtn").textContent = btnLabel;
    banner.dataset.mode = mode;

    // "Entendi" em instruções iOS não deve parecer um botão de ação
    if (mode === "ios-instructions") {
        document.getElementById("pushBannerBtn").className =
            "shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-xl bg-slate-700 hover:bg-slate-600 active:scale-95 text-slate-200 transition-all";
    }

    banner.classList.add("visible");
}

function dismissPushBanner() {
    const banner = document.getElementById("pushBanner");
    if (banner) banner.classList.remove("visible");
}

// Chamado pelo botão do banner — ESTE é o gesto do utilizador que o iOS exige
async function handlePushBannerTap() {
    const banner = document.getElementById("pushBanner");
    const mode = banner ? banner.dataset.mode : "";

    if (mode === "ios-instructions") {
        dismissPushBanner();
        return;
    }

    // mode === "request-permission": pede permissão dentro do gesto
    dismissPushBanner();
    await _requestAndSubscribe();
    updateBellBtn();
}

// Chamado pelo botão sino no header — também um gesto genuino do utilizador
async function handleBellTap() {
    if (/(iphone|ipad|ipod)/i.test(navigator.userAgent) && !isStandalone()) {
        // iOS não-standalone: mostra instruções para adicionar ao ecrã inicial
        showPushBanner(
            "📲",
            "Adicione ao Ecrã Inicial",
            "Para receber alertas push no iPhone, toque em  na barra do Safari e selecione \"Adicionar ao Ecrã Inicial\".",
            "Entendi",
            "ios-instructions"
        );
        return;
    }

    if (!("Notification" in window) || !("PushManager" in window)) {
        alert("O seu browser não suporta notificações push.");
        return;
    }

    if (Notification.permission === "denied") {
        alert("As notificações estão bloqueadas. Ative-as nas definições do browser.");
        return;
    }

    // Pedir permissão (gesto) ou re-registar se já concedida
    await _requestAndSubscribe();
    updateBellBtn();
}

// Actualiza a cor do ponto no botão sino consoante o estado
function updateBellBtn() {
    const dot = document.getElementById("pushBellDot");
    const btn = document.getElementById("pushBellBtn");
    if (!dot || !btn) return;

    const perm = ("Notification" in window) ? Notification.permission : "unsupported";
    const isIosNonStandalone = /(iphone|ipad|ipod)/i.test(navigator.userAgent) && !isStandalone();

    if (perm === "granted" && !isIosNonStandalone) {
        // Verde = activo
        dot.className = "absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-1 ring-slate-950";
        btn.title = "Notificações push activas";
    } else if (perm === "denied") {
        // Vermelho = bloqueado
        dot.className = "absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500 ring-1 ring-slate-950";
        btn.title = "Notificações bloqueadas pelo browser";
    } else {
        // Amarelo pâ = pendênte/iOS
        dot.className = "absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400 ring-1 ring-slate-950 animate-pulse";
        btn.title = "Toque para ativar as notificações push";
    }
}

// Envia push de teste para todos os dispositivos registados
async function sendTestPush() {
    const btn = document.getElementById("testPushBtn");
    if (btn) { btn.textContent = "⏳ A enviar..."; btn.disabled = true; }
    try {
        const res = await fetch("/api/push-test", { method: "POST" });
        const data = await res.json();
        if (data.status === "no_subscriptions") {
            showToast("⚠️ Nenhum dispositivo registado. Active as notificações primeiro.");
        } else {
            showToast(`✅ Push enviado para ${data.count} dispositivo(s)!`);
        }
    } catch {
        showToast("❌ Erro ao enviar push de teste.");
    } finally {
        if (btn) { btn.textContent = "🔔 Teste Push Nativo"; btn.disabled = false; }
        document.getElementById("testDropdownMenu")?.classList.add("hidden");
    }
}

async function _requestAndSubscribe() {
    if (!("PushManager" in window)) return;

    // requestPermission DEVE ser chamado directamente de um handler de clique
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
        console.info("[Push] Permissão negada pelo utilizador.");
        return;
    }
    await _registerSubscriptionSilently();
}

async function _registerSubscriptionSilently() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    try {
        const registration = await navigator.serviceWorker.ready;

        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            const res = await fetch("/api/vapid-public-key");
            if (!res.ok) { console.warn("[Push] Falha ao obter VAPID public key."); return; }
            const { publicKey } = await res.json();

            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        }

        await sendSubscriptionToServer(subscription);
    } catch (e) {
        console.warn("[Push] Erro ao registar subscription:", e);
    }
}

async function sendSubscriptionToServer(subscription) {
    const json = subscription.toJSON();
    try {
        const res = await fetch("/api/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                endpoint: json.endpoint,
                keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            }),
        });
        if (res.ok) {
            console.info("[Push] Subscription registada no servidor.");
        } else {
            console.warn("[Push] Falha ao registar subscription:", res.status);
        }
    } catch (e) {
        console.warn("[Push] Erro de rede ao registar subscription:", e);
    }
}

/**
 * Service Worker — Notifica NTI
 * Estratégia: Stale-While-Revalidate para o shell da app.
 * Rotas /api/* nunca são interceptadas (SSE e TTS são streams).
 */

const CACHE_NAME = 'notifica-nti-v9';

// Ativos do app shell a pré-cachear no install
const SHELL_ASSETS = [
    '/',
    '/static/script.js?v=35',
    '/manifest.json',
];

// ===== Install — pré-carrega o shell =====
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    // Activa imediatamente sem esperar a tab anterior fechar
    self.skipWaiting();
});

// ===== Activate — limpa caches de versões antigas =====
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME)
                    .map((k) => caches.delete(k))
            )
        )
    );
    // Toma controlo de todas as tabs abertas sem reload
    self.clients.claim();
});

// ===== Fetch — Stale-While-Revalidate =====
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Nunca interceptar: API (SSE, TTS, etc.) e requests que não sejam GET
    if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

    // Recursos de CDN externos (ex.: cdn.tailwindcss.com) — deixar passar
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);

            // Dispara revalidação em background (o "revalidate" do SWR)
            const fetchPromise = fetch(event.request)
                .then((response) => {
                    // Só cacheia respostas válidas (200, não opaco)
                    if (response.ok && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                })
                .catch(() => {
                    // Offline: devolve o cache se existir
                    return cached;
                });

            // Devolve o cache instantaneamente (o "stale") e actualiza em background
            return cached || fetchPromise;
        })
    );
});

// ===== Push — Web Push nativo =====
self.addEventListener('push', (event) => {
    let data = {
        title: 'Notifica NTI',
        body: 'Nova notificação recebida.',
        icon: '/static/icons/icon-192.png',
        badge: '/static/icons/icon-192.png',
        tag: 'notifica-push',
        rule: '',
    };

    if (event.data) {
        try {
            const parsed = event.data.json();
            data = { ...data, ...parsed };
        } catch (_) {
            data.body = event.data.text();
        }
    }

    // Ícone colorido por origem baseado na regra
    const ruleColors = {
        zabbix:    '🔴',
        suap:      '🟡',
        processos: '🟢',
        monitor:   '🔵',
    };
    const ruleLower = (data.rule || '').toLowerCase();
    const emoji = Object.entries(ruleColors).find(([k]) => ruleLower.includes(k))?.[1] || '🔔';
    const displayTitle = `${emoji} ${data.title}`;

    event.waitUntil(
        self.registration.showNotification(displayTitle, {
            body:    data.body,
            icon:    data.icon,
            badge:   data.badge,
            tag:     data.tag,
            renotify: true,
            // Passa dados extras para o notificationclick
            data: { url: '/?history=1', rule: data.rule },
            // Vibração: padrão curto-longo (iOS ignora; Android usa)
            vibrate: [150, 50, 300],
        })
    );
});

// ===== Notification click — abre o histórico =====
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = (event.notification.data && event.notification.data.url)
        ? event.notification.data.url
        : '/?history=1';

    event.waitUntil(
        clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // 1. Tenta focar tab já aberta e enviar mensagem para abrir histórico
                for (const client of clientList) {
                    const clientUrl = new URL(client.url);
                    if (clientUrl.origin === self.location.origin && 'focus' in client) {
                        client.postMessage({ type: 'OPEN_HISTORY' });
                        return client.focus();
                    }
                }
                // 2. Nenhuma tab aberta — abre nova com flag para abrir histórico
                if (clients.openWindow) return clients.openWindow(targetUrl);
            })
    );
});

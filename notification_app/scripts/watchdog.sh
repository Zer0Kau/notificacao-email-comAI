#!/bin/bash
# Watchdog script — monitora a saúde do IMAP worker via /api/health
# Se unhealthy, reinicia a aplicação via PM2
#
# Instalação na crontab:
# */5 * * * * /home/notificacao-email-comAI/notification_app/scripts/watchdog.sh >> /var/log/notifica_watchdog.log 2>&1

set -euo pipefail

# Configuração
HEALTH_URL="http://127.0.0.1:8000/api/health"
HEALTH_CHECK_TIMEOUT=5
LOG_FILE="/var/log/notifica_watchdog.log"
APP_DIR="/home/notificacao-email-comAI/notification_app"

# Garante que o diretório de logs existe
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=== Iniciando health check ==="

# Tenta fazer curl para o endpoint de health
if ! response=$(curl -s -w "\n%{http_code}" --max-time "$HEALTH_CHECK_TIMEOUT" "$HEALTH_URL" 2>&1); then
    log "❌ ERRO: Falha ao conectar em $HEALTH_URL"
    log "Reiniciando aplicação via PM2..."
    pm2 restart all 2>&1 | tee -a "$LOG_FILE"
    exit 1
fi

# Extrai o HTTP status code da última linha
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

log "HTTP Status: $http_code"
log "Response: $body"

# Verifica se o status é 200 (healthy)
if [[ "$http_code" != "200" ]]; then
    log "⚠️  UNHEALTHY: status=$http_code"
    log "Reiniciando aplicação via PM2..."
    if pm2 restart all 2>&1 | tee -a "$LOG_FILE"; then
        log "✅ PM2 restart executado com sucesso"
        sleep 5
        log "Validando nova saúde pós-restart..."
        if curl -s --max-time "$HEALTH_CHECK_TIMEOUT" "$HEALTH_URL" > /dev/null 2>&1; then
            log "✅ Health check passou após restart"
        else
            log "❌ Health check ainda falhando após restart!"
        fi
    else
        log "❌ Erro ao executar PM2 restart"
        exit 1
    fi
else
    log "✅ HEALTHY: IMAP worker está respondendo normalmente"
fi

log "=== Health check concluído ==="

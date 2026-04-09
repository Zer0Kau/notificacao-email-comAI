/**
 * Configuração de Ecossistema do PM2
 * Esta configuração gerencia a aplicação FastAPI com monitoramento automático
 * 
 * Uso:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup systemd -u [usuario] --hp /home/notificacao-email-comAI
 */

module.exports = {
  apps: [
    {
      // Nome da aplicação
      name: "notifica-api",
      
      // Script a executar
      script: "./run.py",
      
      // Interpreter (Python via .venv)
      interpreter: "/home/notificacao-email-comAI/notification_app/.venv/bin/python",
      
      // Diretório de trabalho
      cwd: "/home/notificacao-email-comAI/notification_app",
      
      // Instâncias (1 para aplicação de single-thread)
      instances: 1,
      
      // Modo de execução
      exec_mode: "fork",
      
      // Auto-restart em caso de crash
      autorestart: true,
      
      // Não monitorar alterações de arquivo (production)
      watch: false,
      
      // Limite de memória antes de restart automático
      max_memory_restart: "256M",
      
      // Variáveis de ambiente
      env: {
        NODE_ENV: "production",
        PYTHONUNBUFFERED: "1",
      },
      
      // Arquivo de log de erro
      error_file: "/var/log/pm2/notifica-api.error.log",
      
      // Arquivo de log de output
      out_file: "/var/log/pm2/notifica-api.out.log",
      
      // Formato de data nos logs
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      
      // Timeout antes de SIGKILL (ms)
      kill_timeout: 5000,
      
      // Tentar reiniciar por até 15 vezes antes de parar definitivamente
      max_restarts: 15,
      
      // Esperar 30 segundos entre restarts
      min_uptime: "30s",
    },
  ],
};

"""run.py — Script para rodar a aplicação completa."""

import uvicorn
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

load_dotenv()


class RunSettings(BaseSettings):
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    # reload=True em produção (o PM2 corre este ficheiro) faz o Uvicorn
    # spawnar o reloader e reiniciar o worker IMAP a cada alteração de
    # ficheiro. Fica desligado por omissão e activa-se com RELOAD=true
    # durante o desenvolvimento.
    RELOAD: bool = False

    model_config = {"env_file": ".env", "extra": "ignore"}


if __name__ == "__main__":
    settings = RunSettings()
    uvicorn.run(
        "app.main:app",
        host=settings.APP_HOST,
        port=settings.APP_PORT,
        reload=settings.RELOAD,
        log_level="info",
        timeout_graceful_shutdown=3,
    )

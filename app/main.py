"""
Main entry point for the FastAPI application.
Initializes the app, includes routes, and starts the server.
"""

from fastapi import FastAPI
from fastapi.requests import Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded
from app.config import Config
from app.limiter import limiter
from app.routes import router_spa, router_api_v1
from app.https import cert_file, key_file
from app.logger import logger
import logging
import asyncio
import uvicorn

DEBUG_DELAY = 0  # seconds, simulate slow response

# Configs
host = Config.get("app.host")
port = Config.get("app.port")
debug = Config.get("app.debug")
log_level = logging.DEBUG if debug else logging.INFO
logger.setLevel(log_level)

# Initialize FastAPI app
app = FastAPI()

# Include routes
app.include_router(router_spa, tags=["SPA"])
app.include_router(router_api_v1, tags=["API"])

# Serve static files
app.mount("/static", StaticFiles(directory="app/static"), name="static")
app.mount("/partials", StaticFiles(directory="app/templates/partials"), name="partials")

# Set up rate limiting (limiter is the shared instance from app.limiter, which
# the per-route decorators in app.routes also use).
app.state.limiter = limiter
app.add_exception_handler(
    RateLimitExceeded,
    lambda request, exc: JSONResponse(
        status_code=429, content={"detail": "Rate limit exceeded"}
    ),
)
app.add_middleware(SlowAPIMiddleware)


if debug and DEBUG_DELAY > 0:
    @app.middleware("http")
    async def add_delay_middleware(request: Request, call_next):
        # Apply delay only to routes starting with "/api"
        if request.url.path.startswith(("/api", "/api/v1/files", "/api/v1/server")):
            await asyncio.sleep(DEBUG_DELAY)
        return await call_next(request)

if __name__ == "__main__":
    # Start web server
    uvicorn_app = "app.main:app" if __package__ else app
    uvicorn.run(
        uvicorn_app,
        host=host,
        port=port,
        log_level=log_level,
        reload=debug and __package__,
        access_log=log_level == logging.DEBUG,
        ssl_keyfile=key_file,
        ssl_certfile=cert_file,
    )
"""vonvon backend FastAPI application."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from app.routes import chat, sessions, models
from app.services import agent_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: load hermes config into agent_service globals
    agent_service.init_from_hermes_config()
    yield
    # Shutdown: nothing to clean up (SessionDB uses SQLite, no explicit close needed)


app = FastAPI(
    title="vonvon Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(sessions.router)
app.include_router(models.router)

"""vonvon backend FastAPI application."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import CORS_ORIGINS
from app.routes import chat, sessions, models, auth, mcp, workspace, skills, integrations
from app.services import agent_service, workspace_service, skills_service


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Order matters (DELTA-6):
    # 1. Load hermes model/provider state FIRST (reads the process HERMES_HOME)
    agent_service.init_from_hermes_config()
    # 2. Apply workspace — calls os.chdir + sets TERMINAL_CWD
    workspace_service.init_from_hermes_config()
    # 3. Apply vonvon's one-time default skill bootstrap for fresh installs.
    try:
        skills_service.ensure_vonvon_default_skills()
    except Exception as exc:
        logger.warning("Failed to initialize vonvon default skills: %s", exc)
    # 4. Eager SessionDB AFTER workspace is final so SQLite path is absolute
    agent_service.get_session_db()
    try:
        yield
    finally:
        agent_service.close_session_db()


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
app.include_router(auth.router)
app.include_router(mcp.router)
app.include_router(workspace.router)
app.include_router(skills.router)
app.include_router(integrations.router)

"""Chat routes: SSE streaming endpoint and context compression."""
import asyncio
import json

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from agent.context_compressor import ContextCompressor

import os

from app.schemas import ChatRequest, CompressRequest
from app.services import agent_service, session_service, workspace_service

router = APIRouter()


@router.post("/api/chat/send")
async def send_message(req: ChatRequest):
    """Send a message and stream the response as SSE events.

    Events emitted:
      message.delta  — streaming text token
      reasoning      — thinking/reasoning text
      tool.started   — tool execution started
      tool.completed — tool execution finished
      run.completed  — final result with usage stats
      run.failed     — error event (always followed by sentinel)
    """
    # DELTA-5: defensive re-apply — prevents stale TERMINAL_CWD if any hermes
    # call site mutated os.environ mid-run. workspace_service owns the truth.
    os.environ["TERMINAL_CWD"] = workspace_service.current_state()["path"]

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()

        # ── Callbacks (called from worker thread) ────────────────────────────

        def on_delta(delta):
            if delta is not None:
                queue.put_nowait({"event": "message.delta", "data": {"delta": delta}})

        def on_tool_progress(event_type, tool_name, preview, args, **kwargs):
            if event_type == "tool.started":
                queue.put_nowait({
                    "event": "tool.started",
                    "data": {"tool": tool_name, "preview": preview or tool_name},
                })
            elif event_type == "tool.completed":
                queue.put_nowait({
                    "event": "tool.completed",
                    "data": {
                        "tool": tool_name,
                        "duration": round(kwargs.get("duration", 0), 3),
                        "error": kwargs.get("is_error", False),
                    },
                })

        def on_thinking(text):
            queue.put_nowait({"event": "reasoning", "data": {"text": text}})

        # ── Agent execution ──────────────────────────────────────────────────

        history = session_service.get_messages(req.session_id)

        async def run_agent():
            try:
                async with agent_service._agent_lock:
                    agent = agent_service.create_agent(
                        session_id=req.session_id,
                        stream_delta_callback=on_delta,
                        tool_progress_callback=on_tool_progress,
                        thinking_callback=on_thinking,
                    )
                    result = await asyncio.to_thread(
                        agent.run_conversation,
                        user_message=req.message,
                        conversation_history=history,
                    )

                # NOTE: use last_prompt_tokens (last API call's prompt size),
                # NOT total_tokens (cumulative across all API calls in session).
                prompt_tokens = result.get("last_prompt_tokens", 0)
                model_ctx = agent_service.get_model_context_size()
                usage_pct = round(prompt_tokens / model_ctx * 100) if model_ctx else 0

                # Detect session_id drift (hermes compression creates a new session)
                new_session_id = getattr(agent, "session_id", req.session_id)

                queue.put_nowait({
                    "event": "run.completed",
                    "data": {
                        "output": result.get("final_response", ""),
                        "usage_percent": usage_pct,
                        "prompt_tokens": prompt_tokens,
                        "context_size": model_ctx,
                        "session_id": new_session_id,
                    },
                })
            except Exception as exc:
                queue.put_nowait({
                    "event": "run.failed",
                    "data": {"error": str(exc)},
                })
            finally:
                queue.put_nowait(None)  # sentinel — unblock event_generator

        asyncio.create_task(run_agent())

        # ── Stream queue → SSE ───────────────────────────────────────────────
        while True:
            item = await queue.get()
            if item is None:
                break
            yield f"event: {item['event']}\ndata: {json.dumps(item['data'])}\n\n"

    return EventSourceResponse(event_generator())


@router.post("/api/chat/compress")
async def compress_context(req: CompressRequest):
    """Manually trigger context compression using ContextCompressor (plan scheme B)."""
    # DELTA-5: defensive TERMINAL_CWD re-apply before tool-spawning operation
    os.environ["TERMINAL_CWD"] = workspace_service.current_state()["path"]
    # DELTA-4: resolve credentials from credential_pool instead of cached globals
    try:
        from agent.credential_pool import load_pool
        cur_cred = load_pool(agent_service.get_current_provider() or "openai").peek() if agent_service.get_current_provider() else None
    except Exception:
        cur_cred = None
    compressor = ContextCompressor(
        model=agent_service.get_current_model(),
        base_url=cur_cred.base_url if cur_cred else "",
        api_key=cur_cred.access_token if cur_cred else "",
    )
    messages = session_service.get_messages(req.session_id)
    compressed = await asyncio.to_thread(compressor.compress, messages)

    session_service.replace_messages(req.session_id, compressed)

    usage = session_service.get_usage(req.session_id)
    return {"compressed": True, **usage}

"""Chat routes: SSE streaming endpoint and context compression."""
import asyncio
import json
from typing import Any

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

        # Build effective user_message.
        #
        # When the user attaches images we pass a multimodal content list to
        # hermes.AIAgent.run_conversation. The list uses the OpenAI
        # chat.completions format (``{"type":"image_url","image_url":{"url":...}}``);
        # run_agent's ``_chat_messages_to_responses_input`` translates it to
        # the Responses API ``input_image`` shape for openai-codex so
        # gpt-5.3-codex actually sees the image.
        #
        # ``persist_user_message`` is set to a plain-text summary so the
        # SessionDB transcript (which stores ``messages.content`` as TEXT)
        # never has to serialize a list. Multimodal data only lives in the
        # current turn's API payload, not in history.
        plain_text = (req.message or "").strip()
        image_count = sum(1 for a in (req.attachments or []) if a.type == "image")
        if image_count:
            # Build OpenAI chat.completions multimodal content list.
            content_parts: list[dict] = []
            if plain_text:
                content_parts.append({"type": "text", "text": plain_text})
            for att in req.attachments:
                if att.type != "image" or not att.data_url:
                    continue
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": att.data_url},
                })
            effective_message: Any = content_parts
            # Plain-text placeholder for session DB: short and stable.
            image_names = [a.name for a in req.attachments if a.type == "image" and a.name]
            if image_names:
                placeholder_tail = " ".join(f"[图片:{n}]" for n in image_names)
            else:
                placeholder_tail = " ".join(["[图片]"] * image_count)
            persisted_text = (f"{plain_text} {placeholder_tail}" if plain_text else placeholder_tail).strip()
        else:
            effective_message = plain_text
            persisted_text = None

        async def run_agent():
            nonlocal effective_message, persisted_text
            lock_held = False
            try:
                # Acquire lock with 5s timeout so a stuck request can't freeze
                # the entire backend for subsequent sends. Note: we do NOT put
                # a timeout on run_conversation itself — legitimate long runs
                # are fine; only lock *waiting* is capped.
                try:
                    await asyncio.wait_for(
                        agent_service._agent_lock.acquire(), timeout=5.0
                    )
                    lock_held = True
                except asyncio.TimeoutError:
                    queue.put_nowait({
                        "event": "run.failed",
                        "data": {"error": "backend busy: previous request still running"},
                    })
                    return

                # Expand @file: references just before the run so the agent
                # sees file contents, while SessionDB still stores the raw
                # user-authored token for history/chip re-rendering.
                if "@file:" in plain_text:
                    try:
                        from agent.context_references import preprocess_context_references_async

                        msg_cwd = os.path.expanduser("~")
                        ctx_result = await preprocess_context_references_async(
                            plain_text,
                            cwd=msg_cwd,
                            context_length=agent_service.get_model_context_size(),
                            allowed_root=msg_cwd,
                        )
                        if ctx_result.blocked:
                            queue.put_nowait({
                                "event": "run.failed",
                                "data": {
                                    "error": "\n".join(ctx_result.warnings) or "Context reference blocked."
                                },
                            })
                            return
                        if ctx_result.expanded:
                            if isinstance(effective_message, str):
                                effective_message = ctx_result.message
                                persisted_text = plain_text
                            elif isinstance(effective_message, list):
                                replaced = False
                                for part in effective_message:
                                    if part.get("type") == "text":
                                        part["text"] = ctx_result.message
                                        replaced = True
                                        break
                                if not replaced:
                                    effective_message.insert(0, {"type": "text", "text": ctx_result.message})
                                persisted_text = (
                                    f"{plain_text} {persisted_text}".strip()
                                    if persisted_text and plain_text and not persisted_text.startswith(plain_text)
                                    else persisted_text
                                )
                    except Exception:
                        pass

                agent = agent_service.create_agent(
                    session_id=req.session_id,
                    stream_delta_callback=on_delta,
                    tool_progress_callback=on_tool_progress,
                    thinking_callback=on_thinking,
                )
                result = await asyncio.to_thread(
                    agent.run_conversation,
                    user_message=effective_message,
                    conversation_history=history,
                    persist_user_message=persisted_text,
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
                if lock_held:
                    agent_service._agent_lock.release()
                queue.put_nowait(None)  # sentinel — unblock event_generator

        asyncio.create_task(run_agent())

        # ── Stream queue → SSE ───────────────────────────────────────────────
        # NOTE: sse_starlette's EventSourceResponse expects dict/ServerSentEvent
        # instances. Yielding a pre-formatted string double-wraps it (the whole
        # string gets used as the `data` field, producing
        # `data: event: ...\ndata: data: ...`), which breaks the frontend SSE
        # parser and leaves the UI stuck in the loading state forever.
        while True:
            item = await queue.get()
            if item is None:
                break
            yield {"event": item["event"], "data": json.dumps(item["data"])}

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

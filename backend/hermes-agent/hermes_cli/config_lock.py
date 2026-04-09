"""Cross-process file lock for ~/.hermes/config.yaml read/modify/write.

Mirrors auth.py:_auth_store_lock to prevent concurrent CLI + UI writes
from corrupting yaml. Uses fcntl on POSIX, msvcrt on Windows.

Critic Minor-2: re-entrancy uses contextvars.ContextVar instead of
threading.local because vonvon-backend runs many service calls inside
asyncio.to_thread workers — each worker is a different OS thread, so
threading.local would not recognize the re-entrant context. ContextVar
is carried across to_thread and within the asyncio task tree.
"""
from __future__ import annotations
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
try:
    import fcntl
except ImportError:
    fcntl = None
try:
    import msvcrt
except ImportError:
    msvcrt = None
from hermes_cli.config import get_config_path

CONFIG_LOCK_TIMEOUT = 10.0
_lock_depth: ContextVar[int] = ContextVar("_config_lock_depth", default=0)

def _lock_path() -> Path:
    return get_config_path().with_suffix(".yaml.lock")

@contextmanager
def config_store_lock(timeout_seconds: float = CONFIG_LOCK_TIMEOUT):
    # Reentrant via ContextVar (survives asyncio.to_thread boundaries
    # because Python copies the context into the worker)
    current = _lock_depth.get()
    if current > 0:
        token = _lock_depth.set(current + 1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
        return

    lock_path = _lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        token = _lock_depth.set(1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
        return

    if msvcrt and (not lock_path.exists() or lock_path.stat().st_size == 0):
        lock_path.write_text(" ", encoding="utf-8")

    with lock_path.open("r+" if msvcrt else "a+") as lock_file:
        deadline = time.time() + max(1.0, timeout_seconds)
        while True:
            try:
                if fcntl:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except (BlockingIOError, OSError, PermissionError):
                if time.time() >= deadline:
                    raise TimeoutError("Timed out waiting for config store lock")
                time.sleep(0.05)
        token = _lock_depth.set(1)
        try:
            yield
        finally:
            _lock_depth.reset(token)
            if fcntl:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            elif msvcrt:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                except (OSError, IOError):
                    pass

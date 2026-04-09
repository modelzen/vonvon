"""AC-C6 / DELTA-7: Event loop latency test.

Under mixed concurrent load (auth credentials, mcp probe, skills listing),
GET /api/health p99 response time must stay < 200ms.

This proves all fcntl/disk blocking work is marshalled via asyncio.to_thread
and does not block the single event loop thread.
"""
import asyncio
import statistics
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app

# ── Helpers ───────────────────────────────────────────────────────────────────

HEALTH_SAMPLES = 40      # number of health probes during load
P99_THRESHOLD_MS = 200   # AC-C6 requirement


def _mock_all_services():
    """Patch every service that does disk/fcntl I/O so we test event-loop
    scheduling isolation, not real hermes disk performance."""
    patches = [
        # Auth service — mock public async functions (inner _load/_add are closure-scoped)
        patch('app.services.auth_service.list_all_credentials',
              new=AsyncMock(return_value=[])),
        patch('app.services.auth_service.add_api_key_credential',
              new=AsyncMock(return_value={
                  'id': 'c1', 'provider': 'openai', 'label': 'test',
                  'auth_type': 'api_key', 'last4': '…1234',
                  'source': 'manual', 'status': None, 'is_current': False,
              })),
        # MCP service — _probe_single_server and _get_mcp_servers imported at module level
        patch('app.services.mcp_service._probe_single_server',
              return_value=[('tool1', 'desc')]),
        patch('app.services.mcp_service._get_mcp_servers',
              return_value={'test-srv': {'url': 'http://localhost:9999'}}),
        # Skills service — list_skills is the public sync function called by the route
        patch('app.services.skills_service.list_skills', return_value=[]),
    ]
    return patches


# ── Load generators ───────────────────────────────────────────────────────────

async def _fire_auth_load(client: httpx.AsyncClient, n: int = 5):
    """POST /api/auth/credentials n times concurrently."""
    coros = [
        client.post('/api/auth/credentials', json={
            'provider': 'openai',
            'api_key': f'sk-fake-{i}',
            'auth_type': 'api_key',
        })
        for i in range(n)
    ]
    await asyncio.gather(*coros, return_exceptions=True)


async def _fire_mcp_probe_load(client: httpx.AsyncClient, n: int = 3):
    """POST /api/mcp/servers/{name}/test n times concurrently."""
    coros = [
        client.post(f'/api/mcp/servers/test-srv/test')
        for _ in range(n)
    ]
    await asyncio.gather(*coros, return_exceptions=True)


async def _fire_skills_load(client: httpx.AsyncClient, n: int = 2):
    """GET /api/skills n times concurrently."""
    coros = [client.get('/api/skills') for _ in range(n)]
    await asyncio.gather(*coros, return_exceptions=True)


async def _measure_health_p99(client: httpx.AsyncClient, samples: int) -> float:
    """Sample GET /api/health repeatedly and return p99 latency in ms."""
    latencies = []
    for _ in range(samples):
        t0 = time.perf_counter()
        r = await client.get('/api/health')
        elapsed_ms = (time.perf_counter() - t0) * 1000
        if r.status_code == 200:
            latencies.append(elapsed_ms)
        await asyncio.sleep(0.01)  # 10ms between probes

    if not latencies:
        pytest.fail('No successful /api/health responses during load test')

    latencies.sort()
    p99_idx = max(0, int(len(latencies) * 0.99) - 1)
    return latencies[p99_idx]


# ── Test ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_p99_under_concurrent_load():
    """AC-C6: /api/health p99 < 200ms under mixed concurrent service load."""
    all_patches = _mock_all_services()
    started = [p.start() for p in all_patches]

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
            # Fire background load + measure health concurrently
            # asyncio.gather() returns a Future in Python 3.14, not a coroutine;
            # wrap in an async def so create_task receives a proper coroutine.
            async def _all_load():
                await asyncio.gather(
                    _fire_auth_load(client, n=5),
                    _fire_mcp_probe_load(client, n=3),
                    _fire_skills_load(client, n=2),
                )
            load_task = asyncio.create_task(_all_load())
            p99_ms = await _measure_health_p99(client, samples=HEALTH_SAMPLES)
            await load_task
    finally:
        for p in all_patches:
            try:
                p.stop()
            except RuntimeError:
                pass

    assert p99_ms < P99_THRESHOLD_MS, (
        f'AC-C6 FAILED: /api/health p99 = {p99_ms:.1f}ms >= {P99_THRESHOLD_MS}ms. '
        f'This means blocking I/O is running on the event loop thread. '
        f'All service functions that touch fcntl/disk must use asyncio.to_thread.'
    )


@pytest.mark.asyncio
async def test_health_responds_during_mcp_probe():
    """Specifically verify /api/health is not blocked by a slow MCP probe."""
    slow_probe_done = asyncio.Event()

    async def slow_probe(*args, **kwargs):
        await asyncio.sleep(0.5)  # simulate 500ms probe
        slow_probe_done.set()
        return [('tool1', 'slow tool')]

    patches = _mock_all_services()
    started = [p.start() for p in patches]

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
            probe_task = asyncio.create_task(
                client.post('/api/mcp/servers/test-srv/test')
            )
            # Immediately measure health — must not block on probe
            t0 = time.perf_counter()
            r = await client.get('/api/health')
            health_ms = (time.perf_counter() - t0) * 1000
            await probe_task
    finally:
        for p in patches:
            try:
                p.stop()
            except RuntimeError:
                pass

    assert r.status_code == 200
    assert health_ms < P99_THRESHOLD_MS, (
        f'Health blocked by probe: {health_ms:.1f}ms >= {P99_THRESHOLD_MS}ms'
    )

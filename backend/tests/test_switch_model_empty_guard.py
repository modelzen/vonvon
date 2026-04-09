"""MF-6: switch_model must NOT clobber _current_model/_current_provider
with empty strings from ModelSwitchResult when alias resolves on current provider.
"""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.services import agent_service


def _make_result(success, new_model="", target_provider=""):
    r = MagicMock()
    r.success = success
    r.new_model = new_model
    r.target_provider = target_provider
    r.base_url = ""
    r.api_mode = "api_key"
    r.warning_message = None
    r.error_message = "failed" if not success else None
    return r


@pytest.mark.asyncio
async def test_empty_new_model_not_written():
    """MF-6: empty new_model from ModelSwitchResult must not overwrite _current_model."""
    agent_service._current_model = "original-model"
    agent_service._current_provider = "original-provider"

    result = _make_result(success=True, new_model="", target_provider="same-provider")
    with patch("app.services.agent_service._switch_model_sync", return_value=result):
        await agent_service.switch_model("some-alias", persist=False)

    assert agent_service._current_model == "original-model", (
        "MF-6: empty new_model should not overwrite _current_model"
    )


@pytest.mark.asyncio
async def test_empty_target_provider_not_written():
    """MF-6: empty target_provider from ModelSwitchResult must not overwrite _current_provider."""
    agent_service._current_model = "original-model"
    agent_service._current_provider = "original-provider"

    result = _make_result(success=True, new_model="original-model", target_provider="")
    with patch("app.services.agent_service._switch_model_sync", return_value=result):
        await agent_service.switch_model("some-alias", persist=False)

    assert agent_service._current_provider == "original-provider", (
        "MF-6: empty target_provider should not overwrite _current_provider"
    )


@pytest.mark.asyncio
async def test_nonempty_values_are_written():
    """switch_model DOES update globals when result has non-empty values."""
    agent_service._current_model = "old-model"
    agent_service._current_provider = "old-provider"

    result = _make_result(success=True, new_model="new-model", target_provider="new-provider")
    # Patch the underlying hermes function so real _switch_model_sync runs
    # and updates module globals based on MF-6 guard logic.
    with patch("hermes_cli.model_switch.switch_model", return_value=result):
        await agent_service.switch_model("new-model", persist=False)

    assert agent_service._current_model == "new-model"
    assert agent_service._current_provider == "new-provider"


@pytest.mark.asyncio
async def test_failed_result_not_written():
    """switch_model returns early on failure without touching globals."""
    agent_service._current_model = "old-model"
    agent_service._current_provider = "old-provider"

    result = _make_result(success=False, new_model="irrelevant", target_provider="irrelevant")
    with patch("app.services.agent_service._switch_model_sync", return_value=result):
        ret = await agent_service.switch_model("bad-model", persist=False)

    assert ret is result
    assert agent_service._current_model == "old-model"
    assert agent_service._current_provider == "old-provider"


def test_sync_mf6_guard_direct():
    """_switch_model_sync applies MF-6 guard: empty result values not written."""
    agent_service._current_model = "stable-model"
    agent_service._current_provider = "stable-provider"

    empty_result = _make_result(success=True, new_model="", target_provider="")
    with patch("hermes_cli.model_switch.switch_model", return_value=empty_result):
        agent_service._switch_model_sync("alias", False, None, None)

    assert agent_service._current_model == "stable-model"
    assert agent_service._current_provider == "stable-provider"


def test_sync_mf6_nonempty_direct():
    """_switch_model_sync updates globals when values are non-empty."""
    agent_service._current_model = "old"
    agent_service._current_provider = "old-prov"

    result = _make_result(success=True, new_model="new", target_provider="new-prov")
    with patch("hermes_cli.model_switch.switch_model", return_value=result):
        agent_service._switch_model_sync("new", False, None, None)

    assert agent_service._current_model == "new"
    assert agent_service._current_provider == "new-prov"

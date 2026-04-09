"""AC-C8: Atomic YAML write regression.

Verifies that hermes_cli/config.py:save_config uses tempfile + os.replace so
that a process crash mid-write leaves the previous complete YAML intact.
"""
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml


HERMES_AGENT_PATH = Path(__file__).parent.parent / 'hermes-agent'


@pytest.fixture()
def hermes_home(tmp_path):
    """Isolated ~/.hermes equivalent with a seeded config.yaml."""
    home = tmp_path / '.hermes'
    home.mkdir()
    cfg = {'model': {'name': 'gpt-4o', 'provider': 'openai'}, 'version': 1}
    (home / 'config.yaml').write_text(yaml.safe_dump(cfg), encoding='utf-8')
    return home


def _run_hermes_python(code: str, hermes_home: Path, timeout: int = 10) -> subprocess.CompletedProcess:
    """Run a Python snippet with hermes-agent on sys.path and HERMES_HOME set."""
    env = os.environ.copy()
    env['HERMES_HOME'] = str(hermes_home)
    return subprocess.run(
        [sys.executable, '-c', code],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(HERMES_AGENT_PATH),
    )


def test_save_config_atomic_write_survives_crash(hermes_home):
    """Simulate process crash during save_config; config.yaml must remain intact.

    Strategy: monkeypatch os.replace inside a subprocess to raise OSError
    after the tempfile is written but before the atomic swap. The original
    config.yaml must still be parseable and contain the original content.
    """
    script = textwrap.dedent(f"""
        import sys, os, yaml
        sys.path.insert(0, r'{HERMES_AGENT_PATH}')
        os.environ['HERMES_HOME'] = r'{hermes_home}'

        # Patch os.replace to simulate a crash mid-write
        _orig_replace = os.replace
        def _fail_replace(src, dst):
            # Write the temp file first (already done by atomic_yaml_write),
            # then raise to simulate power-loss before the rename commits.
            raise OSError('simulated crash during os.replace')
        os.replace = _fail_replace

        from hermes_cli.config import load_config, save_config
        cfg = load_config()
        cfg['model']['name'] = 'claude-opus-4-6'   # proposed change
        try:
            save_config(cfg)
        except (OSError, Exception):
            pass  # crash expected
        # Restore and verify original config is intact
        os.replace = _orig_replace
        result = load_config()
        print(result['model']['name'])
    """)

    proc = _run_hermes_python(script, hermes_home)
    # Process should not crash with unhandled exception
    assert proc.returncode == 0, f'subprocess failed:\n{proc.stderr}'
    # Original config value must be preserved (not the proposed change)
    assert 'gpt-4o' in proc.stdout, (
        f'Expected original model in config after crash, got: {proc.stdout!r}\n'
        f'stderr: {proc.stderr}'
    )


def test_config_yaml_parseable_after_normal_save(hermes_home):
    """Normal save_config produces a valid YAML file."""
    script = textwrap.dedent(f"""
        import sys, os
        sys.path.insert(0, r'{HERMES_AGENT_PATH}')
        os.environ['HERMES_HOME'] = r'{hermes_home}'
        from hermes_cli.config import load_config, save_config
        cfg = load_config()
        cfg.setdefault('vonvon', {{}})['workspace'] = '/tmp/test-proj'
        save_config(cfg)
        # Verify the file is valid YAML
        import yaml
        from pathlib import Path
        home = Path(r'{hermes_home}')
        text = (home / 'config.yaml').read_text()
        parsed = yaml.safe_load(text)
        assert parsed['vonvon']['workspace'] == '/tmp/test-proj'
        print('OK')
    """)

    proc = _run_hermes_python(script, hermes_home)
    assert proc.returncode == 0, f'subprocess failed:\n{proc.stderr}'
    assert 'OK' in proc.stdout


def test_load_config_returns_dict_on_empty_file(hermes_home):
    """load_config on a missing config.yaml should return a dict, not raise."""
    (hermes_home / 'config.yaml').unlink(missing_ok=True)
    script = textwrap.dedent(f"""
        import sys, os
        sys.path.insert(0, r'{HERMES_AGENT_PATH}')
        os.environ['HERMES_HOME'] = r'{hermes_home}'
        from hermes_cli.config import load_config
        cfg = load_config()
        assert isinstance(cfg, dict), f'expected dict, got {{type(cfg)}}'
        print('OK')
    """)
    proc = _run_hermes_python(script, hermes_home)
    assert proc.returncode == 0, f'subprocess failed:\n{proc.stderr}'
    assert 'OK' in proc.stdout

# -*- coding: utf-8 -*-
"""Regression test: the generated wrapper must expose ``__file__`` to scripts.

Long-running task scripts derive their own location from ``__file__``.  The
wrapper executes their source with ``exec(_code, _ns)``, so the namespace has
to carry the original absolute script path; otherwise the script dies with
``NameError: name '__file__' is not defined``.

This test runs the real wrapper in a subprocess (no fake exec) and lets the
probe script report both ``__file__`` and ``context.script_name`` as JSON.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from services.script_runner import ScriptRunner


def test_wrapper_exposes_original_script_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """The script must see its own absolute path in ``__file__``."""
    probe_script = tmp_path / "probe_script.py"
    probe_script.write_text(
        "import json\n"
        "import os\n"
        "payload = {'file': __file__, 'name': context.script_name}\n"
        "with open(os.environ['PROBE_OUT'], 'w', encoding='utf-8') as f:\n"
        "    json.dump(payload, f)\n",
        encoding="utf-8",
    )
    probe_output = tmp_path / "probe_output.json"

    runner = ScriptRunner()
    monkeypatch.setattr(runner, "_get_log_dir", lambda name: tmp_path)

    wrapper_path = runner._create_wrapper(str(probe_script), "probe")
    assert wrapper_path, "wrapper generation failed"

    completed = subprocess.run(
        [sys.executable, "-u", wrapper_path],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "PROBE_OUT": str(probe_output)},
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(probe_output.read_text(encoding="utf-8"))
    assert payload == {"file": str(probe_script), "name": "probe"}

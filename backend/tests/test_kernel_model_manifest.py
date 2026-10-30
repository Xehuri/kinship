# -*- coding: utf-8 -*-
"""内核模型清单测试：schema、来源、路径安全、tier 过滤与本地状态（零网络）。"""
from __future__ import annotations

import copy
import json
import socket
from pathlib import Path

import pytest

from services.kernel_model_manifest import (
    DEFAULT_MANIFEST_PATH,
    KernelModelManifestError,
    load_manifest,
    parse_manifest,
    resolve_target,
)

EXPECTED_IDS = [
    "eres2netv2",
    "sensevoice",
    "fsmn-vad",
    "pyannote-segmentation",
    "pyannote-diarization",
    "wespeaker",
    "kws-zipformer",
    "cnn14",
]


def _payload() -> dict:
    return json.loads(DEFAULT_MANIFEST_PATH.read_text(encoding="utf-8"))


def _model(payload: dict, model_id: str) -> dict:
    for model in payload["models"]:
        if model["id"] == model_id:
            return model
    raise AssertionError("missing model %s" % model_id)


class TestDefaultManifest:
    def test_loads_and_has_expected_models(self):
        manifest = load_manifest()

        assert manifest.schema == 1
        assert manifest.product == "axeuh-kernel-models"
        assert manifest.default_source == "modelscope"
        assert [model.id for model in manifest.models] == EXPECTED_IDS

    def test_tiers_and_sources(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        assert by_id["kws-zipformer"].tier == "recommended"
        assert by_id["cnn14"].tier == "optional"
        assert all(
            by_id[model_id].tier == "required"
            for model_id in EXPECTED_IDS
            if model_id not in {"kws-zipformer", "cnn14"}
        )
        for model_id in (
            "eres2netv2",
            "sensevoice",
            "fsmn-vad",
            "pyannote-segmentation",
            "pyannote-diarization",
            "wespeaker",
        ):
            assert by_id[model_id].source == "modelscope"
        assert by_id["kws-zipformer"].source == "upstream"
        assert by_id["cnn14"].source == "upstream"
        assert not [model for model in manifest.models if model.source == "huggingface_gated"]

    def test_eres2netv2_is_downloaded_not_bundled(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        model = by_id["eres2netv2"]
        assert model.tier == "required"
        assert model.source == "modelscope"
        assert model.repo == "iic/speech_eres2netv2_sv_zh-cn_16k-common"
        assert model.url is None
        assert model.mirrors == ()
        assert "不再随内核发行包分发" in model.notes
        assert "ModelScope" in model.notes
        assert (
            "0eb4057106b2573dd7b132cf0c36273ab29afd192c1610f80baa9c556dbb963c"
            in model.notes
        )

    def test_targets_are_exact(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        assert (
            by_id["eres2netv2"].target
            == "<kernel>/axeuh_kernel/models/speech_eres2netv2_sv_zh-cn_16k-common"
        )
        assert (
            by_id["sensevoice"].target
            == "~/.cache/modelscope/hub/models/iic/SenseVoiceSmall"
        )
        assert (
            by_id["fsmn-vad"].target
            == "~/.cache/modelscope/hub/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
        )
        assert (
            by_id["pyannote-segmentation"].target
            == "~/.cache/huggingface/hub/models--pyannote--segmentation-3.0"
        )
        assert (
            by_id["pyannote-diarization"].target
            == "~/.cache/huggingface/hub/models--pyannote--speaker-diarization-3.1"
        )
        assert (
            by_id["wespeaker"].target
            == "~/.cache/huggingface/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM"
        )
        assert (
            by_id["kws-zipformer"].target
            == "~/.cache/axeuh-kernel/models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"
        )
        assert (
            by_id["cnn14"].target
            == "~/.cache/axeuh-kernel/models/Cnn14_16k_mAP=0.438.pth"
        )

    def test_checksums_are_not_invented(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        assert (
            by_id["kws-zipformer"].sha256
            == "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"
        )
        assert (
            by_id["cnn14"].sha256
            == "e2ee543a27919542c2ea03eabaa70b24dcd4e6c8e05621de6b67a94e4c5058e6"
        )
        assert all(
            model.sha256 is None
            for model in manifest.models
            if model.id not in {"kws-zipformer", "cnn14"}
        )
        assert by_id["cnn14"].md5 == "362fc5ff18f1d6ad2f6d464b45893f2c"
        assert all(
            model.md5 is None for model in manifest.models if model.id != "cnn14"
        )
        assert all(model.gated is False for model in manifest.models)
        assert "gated" in by_id["pyannote-segmentation"].notes.lower()
        assert "gated" in by_id["wespeaker"].notes.lower()

    def test_mirrors_are_declared(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        assert by_id["kws-zipformer"].mirrors == (
            "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
            "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
        )
        assert by_id["cnn14"].mirrors == (
            "https://hf-mirror.com/JaiDalmotra/Audioldm-mono-finetuned/resolve/main/Cnn14_16k_mAP%3D0.438.pth",
        )
        assert all(
            model.mirrors == ()
            for model in manifest.models
            if model.id not in {"kws-zipformer", "cnn14"}
        )
        assert by_id["kws-zipformer"].public()["mirrors"] == list(
            by_id["kws-zipformer"].mirrors
        )

    def test_wespeaker_uses_public_modelscope_mirror(self):
        manifest = load_manifest()
        by_id = {model.id: model for model in manifest.models}

        assert (
            by_id["wespeaker"].repo == "pyannote/wespeaker-voxceleb-resnet34-LM"
        )
        assert by_id["wespeaker"].source == "modelscope"
        assert by_id["wespeaker"].sha256 is None
        assert "ModelScope" in by_id["wespeaker"].notes
        assert "26,645,418" in by_id["wespeaker"].notes
        assert (
            "366edf44f4c80889a3eb7a9d7bdf02c4aede3127f7dd15e274dcdb826b143c56"
            in by_id["wespeaker"].notes
        )

    def test_sizes_and_totals(self):
        manifest = load_manifest()
        required_total = manifest.total_size(tiers="required")
        all_total = manifest.total_size()

        assert all(model.size_bytes > 0 for model in manifest.models)
        assert required_total == sum(
            model.size_bytes for model in manifest.models if model.tier == "required"
        )
        assert all_total == sum(model.size_bytes for model in manifest.models)
        assert required_total < all_total


class TestValidation:
    @pytest.mark.parametrize(
        ("mutate", "code"),
        [
            (lambda p: p.update(schema=2), "manifest_invalid_schema"),
            (lambda p: p.update(schema=True), "manifest_invalid_schema"),
            (lambda p: p.pop("product"), "manifest_invalid_schema"),
            (lambda p: p.update(default_source="huggingface"), "manifest_invalid_schema"),
            (lambda p: p.update(models=[]), "manifest_invalid_schema"),
            (lambda p: p.update(extra=True), "manifest_invalid_schema"),
            (
                lambda p: p["models"].append(copy.deepcopy(p["models"][0])),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(tier="critical"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(source="huggingface"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(size_bytes=True),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(size_bytes=-1),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(sha256="abc"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "cnn14").update(md5="xyz"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(gated="yes"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(source="huggingface_gated"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(url=None),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(url="http://example.com/x"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(
                    mirrors=["http://mirror.example/x"]
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(
                    mirrors="https://mirror.example/x"
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(mirrors=[123]),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(
                    mirrors=["not-a-url"]
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(
                    mirrors=["https:///no-host"]
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "kws-zipformer").update(
                    mirrors=[
                        "https://mirror.example/x",
                        "https://mirror.example/x",
                    ]
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(
                    mirrors=["https://mirror.example/x"]
                ),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").pop("mirrors"),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "eres2netv2").update(required_files=[]),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "cnn14").update(required_files=["a"]),
                "manifest_invalid_schema",
            ),
            (
                lambda p: _model(p, "sensevoice").update(extra="x"),
                "manifest_invalid_schema",
            ),
        ],
    )
    def test_rejects_invalid_payloads(self, mutate, code):
        payload = _payload()
        mutate(payload)

        with pytest.raises(KernelModelManifestError) as exc:
            parse_manifest(payload)

        assert exc.value.code == code

    @pytest.mark.parametrize(
        "target",
        [
            "<kernel>/../escape",
            "<kernel>../escape",
            "~/../escape",
            "~other/model",
            "../models/x",
            "/tmp/../etc/passwd",
            "C:/models/x",
            "/",
            "",
        ],
    )
    def test_rejects_unsafe_targets(self, target):
        payload = _payload()
        _model(payload, "sensevoice")["target"] = target

        with pytest.raises(KernelModelManifestError) as exc:
            parse_manifest(payload)

        assert exc.value.code in {"manifest_invalid_schema", "manifest_invalid_target"}

    @pytest.mark.parametrize(
        "required",
        ["../secret", "/etc/passwd", "C:/x", "ok/../../secret"],
    )
    def test_rejects_unsafe_required_files(self, required):
        payload = _payload()
        _model(payload, "sensevoice")["required_files"] = [required]

        with pytest.raises(KernelModelManifestError) as exc:
            parse_manifest(payload)

        assert exc.value.code == "manifest_invalid_target"

    def test_accepts_nullable_checksums(self):
        payload = _payload()
        _model(payload, "sensevoice")["sha256"] = None
        _model(payload, "sensevoice")["md5"] = None

        manifest = parse_manifest(payload)

        entry = next(model for model in manifest.models if model.id == "sensevoice")
        assert entry.sha256 is None
        assert entry.md5 is None


class TestTargetResolution:
    def test_kernel_placeholder_uses_project_root(self, tmp_path):
        target = resolve_target(
            "<kernel>/axeuh_kernel/models/x", project_root=tmp_path
        )

        assert target == tmp_path / "kernel" / "axeuh_kernel" / "models" / "x"

    def test_kernel_placeholder_honours_kernel_root(self, tmp_path):
        target = resolve_target("<kernel>/models/x", kernel_root=tmp_path / "k")

        assert target == tmp_path / "k" / "models" / "x"

    def test_home_target_uses_override(self, tmp_path):
        target = resolve_target("~/.cache/models/x", home=tmp_path / "home")

        assert target == tmp_path / "home" / ".cache" / "models" / "x"

    def test_home_target_resolves_under_models_root(self, tmp_path, monkeypatch):
        from config.paths import models_root

        monkeypatch.setenv("AXEUH_MODELS_DIR", str(tmp_path / "models"))
        target = resolve_target(
            "~/.cache/modelscope/hub/models/iic/SenseVoiceSmall",
            home=models_root(),
        )

        assert target == (
            tmp_path
            / "models"
            / ".cache"
            / "modelscope"
            / "hub"
            / "models"
            / "iic"
            / "SenseVoiceSmall"
        )

    def test_kernel_target_ignores_models_home(self, tmp_path, monkeypatch):
        from config.paths import models_root

        monkeypatch.setenv("AXEUH_MODELS_DIR", str(tmp_path / "models"))
        target = resolve_target(
            "<kernel>/models/bundle",
            project_root=tmp_path / "project",
            home=models_root(),
        )

        assert target == tmp_path / "project" / "kernel" / "models" / "bundle"

    def test_relative_target_uses_project_root(self, tmp_path):
        assert resolve_target("models/x", project_root=tmp_path) == tmp_path / "models" / "x"

    def test_absolute_target_is_preserved(self):
        assert resolve_target("/opt/models/x") == Path("/opt/models/x")

    @pytest.mark.parametrize(
        "target",
        ["<kernel>/../x", "~/../x", "../x", "/tmp/../etc/passwd", "C:/x"],
    )
    def test_unsafe_targets_raise(self, target):
        with pytest.raises(KernelModelManifestError):
            resolve_target(target)


class TestSelectionAndStatus:
    def test_select_by_tier_and_id(self):
        manifest = load_manifest()

        assert [model.id for model in manifest.select(tiers="optional")] == ["cnn14"]
        assert [model.id for model in manifest.select(ids=["fsmn-vad"])] == ["fsmn-vad"]
        assert [model.id for model in manifest.select(tiers=("required", "optional"))] == [
            "eres2netv2",
            "sensevoice",
            "fsmn-vad",
            "pyannote-segmentation",
            "pyannote-diarization",
            "wespeaker",
            "cnn14",
        ]

    def test_select_rejects_unknown_tier_and_id(self):
        manifest = load_manifest()

        with pytest.raises(KernelModelManifestError) as exc:
            manifest.select(tiers="critical")
        assert exc.value.code == "invalid_tier"

        with pytest.raises(KernelModelManifestError) as exc:
            manifest.select(ids="no-such-model")
        assert exc.value.code == "unknown_model_id"

    def test_status_present_for_bundled_model(self, tmp_path):
        manifest = load_manifest()
        target = (
            tmp_path
            / "kernel"
            / "axeuh_kernel"
            / "models"
            / "speech_eres2netv2_sv_zh-cn_16k-common"
        )
        target.mkdir(parents=True)
        (target / "pretrained_eres2netv2.ckpt").write_bytes(b"ckpt")
        (target / "configuration.json").write_text("{}", encoding="utf-8")

        rows = manifest.status_for(
            ids="eres2netv2", project_root=tmp_path
        )

        assert rows[0]["present"] is True
        assert rows[0]["error"] is None
        assert rows[0]["target"] == str(target)

    def test_status_reports_missing_required_file(self, tmp_path):
        manifest = load_manifest()
        target = tmp_path / "models"
        target.mkdir()
        (target / "model.pt").write_bytes(b"x")

        rows = manifest.status_for(
            {"fsmn-vad": target}, ids="fsmn-vad"
        )

        assert rows[0]["present"] is False
        assert rows[0]["error"] == "required_files_missing"
        assert "config.yaml" in rows[0]["missing_files"]

    def test_status_supports_hf_snapshot_globs(self, tmp_path):
        manifest = load_manifest()
        target = tmp_path / "models--pyannote--segmentation-3.0"
        snapshot = target / "snapshots" / "abc123"
        snapshot.mkdir(parents=True)
        (snapshot / "config.yaml").write_text("x", encoding="utf-8")
        (snapshot / "pytorch_model.bin").write_bytes(b"weights")

        rows = manifest.status_for(
            {"pyannote-segmentation": target},
            ids="pyannote-segmentation",
        )

        assert rows[0]["present"] is True
        assert rows[0]["missing_files"] == []

    def test_status_file_model(self, tmp_path):
        manifest = load_manifest()
        weight = tmp_path / "Cnn14_16k_mAP=0.438.pth"
        weight.write_bytes(b"weights")

        rows = manifest.status_for({"cnn14": weight}, ids="cnn14")
        assert rows[0]["present"] is True

        rows = manifest.status_for({"cnn14": tmp_path}, ids="cnn14")
        assert rows[0]["present"] is False
        assert rows[0]["error"] == "target_not_file"

    def test_status_missing_target(self, tmp_path):
        manifest = load_manifest()
        missing = tmp_path / "missing"

        rows = manifest.status_for({"sensevoice": missing}, ids="sensevoice")

        assert rows[0]["present"] is False
        assert rows[0]["error"] == "target_missing"

    def test_status_rejects_unknown_override(self):
        manifest = load_manifest()

        with pytest.raises(KernelModelManifestError) as exc:
            manifest.status_for({"no-such-model": Path("/tmp/x")})

        assert exc.value.code == "unknown_model_id"

    def test_status_never_opens_network(self, tmp_path, monkeypatch):
        def _boom(*args, **kwargs):
            raise AssertionError("network is forbidden in status_for")

        monkeypatch.setattr(socket, "create_connection", _boom)
        monkeypatch.setattr(socket, "getaddrinfo", _boom)
        manifest = load_manifest()

        rows = manifest.status_for(
            {"sensevoice": tmp_path / "missing"}, ids="sensevoice"
        )

        assert rows[0]["present"] is False


class TestLoadErrors:
    def test_missing_file(self, tmp_path):
        with pytest.raises(KernelModelManifestError) as exc:
            load_manifest(tmp_path / "nope.json")

        assert exc.value.code == "manifest_missing"

    def test_invalid_json(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("{not json", encoding="utf-8")

        with pytest.raises(KernelModelManifestError) as exc:
            load_manifest(path)

        assert exc.value.code == "manifest_invalid_json"

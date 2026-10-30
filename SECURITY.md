# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository:

- https://github.com/Xehuri/kinship/security/advisories/new

Include:

- affected version or commit
- a minimal reproduction
- impact and any known workaround
- whether the issue involves credentials, personal data, or remote code execution

## Scope

The public repository contains the backend, Android app, web frontend, desktop shell, Loom harness, AI template, and release tooling.

The audio kernel is a separate closed-source distribution. Report kernel-specific issues through the same private advisory channel; do not paste kernel binaries or model files into a public issue.

The audio kernel runs locally and does not upload any data to an external service, including audio, voiceprints, or other user data; it receives audio from the backend over loopback and returns results. Model weights are fetched inbound from ModelScope/HuggingFace, either by onboarding or by an explicit opt-in kernel download; both paths carry no audio or user content. Optional external AI providers, such as MiMo for audio understanding, are separate operator-configured integrations, not part of the kernel. See [the kernel data boundary](docs/kernel/README.md#data-boundary).

## Supported versions

Security fixes are applied to the latest release on `main`. Older release assets are removed when they are superseded, unless a security advisory requires a temporary exception.

## Disclosure

Please allow time for a fix and coordinated disclosure. Do not publish exploit details before a patched release is available.

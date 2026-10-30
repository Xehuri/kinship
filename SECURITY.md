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

## Supported versions

Security fixes are applied to the latest release on `main`. Older release assets are removed when they are superseded, unless a security advisory requires a temporary exception.

## Disclosure

Please allow time for a fix and coordinated disclosure. Do not publish exploit details before a patched release is available.

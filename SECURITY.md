# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or merge request:

- open a **confidential issue** on the project's GitLab, or
- email the address in the project's GitLab profile.

Include what you found, how to reproduce it and what an attacker could do with it. You'll get an
acknowledgement within a week. Please give us a reasonable time to fix the problem before you
disclose it.

For a self-hosted instance, the instance's operator is your contact: their address is on the
instance's privacy and security pages (`OPERATOR_CONTACT`).

## How security is handled here

- The threat model and required controls are in [`docs/spec/08-security.md`](docs/spec/08-security.md).
- Every milestone gets a security review against it before it merges (see [`CLAUDE.md`](CLAUDE.md)).
- Known findings and knowingly accepted risks, each with a review date, are recorded in
  [`docs/security/findings.md`](docs/security/findings.md).
- CI scans for secrets (gitleaks, with a rule for this project's `ym_pat_` API tokens), known
  vulnerabilities in dependencies (OSV-Scanner) and licences on every merge request.

## Supported versions

Only the latest release on `main` is supported. Deploy images by digest (see
[`docs/deploy.md`](docs/deploy.md)).

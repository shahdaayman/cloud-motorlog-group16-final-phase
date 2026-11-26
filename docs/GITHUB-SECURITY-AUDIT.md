# GitHub Security Audit — SEC-09 Supporting Report

Audit date: 19 November 2026  
Project: Motorlog, Group 16  
Audit type: non-destructive secret-exposure review

## 1. Audit objective

The objective was to determine whether the Motorlog Git repository, including its available history, can be submitted to university examiners without exposing credentials, authentication material, private keys, tokens, email-delivery secrets, or other sensitive configuration.

No credential values are reproduced in this report. Raw scanner reports remain outside the repository.

## 2. Repository scope

- Repository root: `E:\Senior year\Year 3\Cloud\Phase 2 Submission\cloud-project-me`
- Application folder: repository root
- Current branch: `main`
- Audited commit: `4f0a378c0f77`
- Available history: 11 commits, full/non-shallow repository
- Local branches: `main`
- Remote-tracking branches: `origin/main`
- Tags: none
- Tracked files at audit start: 125
- Local versus recorded upstream: 0 commits ahead, 0 commits behind
- Remote `main`: reachable and identical to the audited local commit

The scan covered every locally available Git ref. The remote exposes only `main` through the configured Git connection. The private configuration directory at `E:\Motorlog-Private-Config` is outside the repository and is not itself a Git repository.

## 3. Tools and versions

| Tool | Version/use |
|---|---|
| Gitleaks | 8.30.1, official WinGet package binary |
| Git | repository status, refs, history, tracking and ignore inspection |
| Manual pattern review | tracked source, scripts, configuration, tests and documentation |
| Project test suite | `npm run check` |

Gitleaks was installed under WinGet's package directory but was absent from `PATH`, explaining the CMD “not recognized” error. Its absolute executable path worked successfully. Global PATH was not modified and no reinstall was required.

## 4. Git history coverage

The history scan used Gitleaks with full redaction, JSON output and `--all --full-history`. It covered all 11 commits and every locally available ref.

- Historical findings: **0**
- Deleted or renamed sensitive filenames: none found
- Historical SMTP application-password identifier: not found
- Historical private-key header: not found
- Shallow-history limitation: none

Raw report, intentionally outside Git:

`E:\Motorlog-Private-Config\audit\gitleaks-history.json`

## 5. Current-files scan methodology

The repository-root directory scan included tracked, untracked and ignored current files. It used the default Gitleaks rule set with 100% secret redaction. The following generated areas were excluded to avoid dependency and build noise:

- `.git/`
- `node_modules/`
- `dist/`

No tracked ZIP, private-key or credential archive required separate archive scanning. The ignored local `.env` remained within the directory-scan scope.

- Current-file findings: **0**

Raw report, intentionally outside Git:

`E:\Motorlog-Private-Config\audit\gitleaks-files.json`

## 6. Manual review findings

> **Current-state note (24 November 2026):** This section records the historical audit
> environment. The repository now includes the non-secret SMTP bridge source,
> `infra/floci/docker-compose.gmail.yml`, and `smtp.env.example`. Real Gmail credentials
> remain only in ignored `smtp.env` or an external private configuration and are still
> absent from tracked content.

| ID | Classification | Severity | Location | Tracked/history | Remote exposure | Status and remediation |
|---|---|---:|---|---|---|---|
| SEC09-F01 | Safe local test configuration | Informational | `.env` | Untracked and ignored; absent from history | No evidence of exposure | Floci-only test identifiers and local resource IDs. Keep untracked. |
| SEC09-F02 | Safe local private configuration | High if mishandled | `E:\Motorlog-Private-Config\smtp.env` | Outside repository; private folder is not Git | No evidence of exposure | Contains the expected SMTP app credential. Keep private, restrict access, and rotate immediately if it is ever shared. |
| SEC09-F03 | Potential sensitive local data, reviewed | Medium | `E:\Motorlog-Private-Config\floci-backup` | Outside repository; private folder is not Git | No evidence of exposure | Contains local Cognito, SES, DynamoDB and other emulator state. Do not copy into the repository or evidence archive. |
| SEC09-F04 | False positive / safe example | Informational | `.env.example` | Tracked and present in history | Yes, intentionally | Contains placeholders and Floci test values only; retain as the setup template. |
| SEC09-F05 | False positives | Informational | Frontend autocomplete code and authentication/logger tests | Tracked | Yes | Password/token terms are UI metadata or synthetic test fixtures, not credentials. No action required. |
| SEC09-F06 | Defence-in-depth gap | Low | `.gitignore` | Tracked | Yes | `.env*`, `smtp.env`, logs, build output and `.aws/` are covered. Generic `*.pem`, `*.key`, credential JSON and private audit-report patterns are not covered. No such sensitive files are currently tracked; add narrowly scoped rules before future work if desired. |

No finding was classified as a confirmed exposed secret.

## 7. Configuration and code review

The manual review covered:

- Authentication, JWT validation and DynamoDB-backed rate limiting
- Lambda, API Gateway, IAM, S3, CloudFront, ALB and monitoring deployment scripts
- Cognito, SES, SQS and Scheduler configuration references
- Frontend token handling and API configuration
- Request logging and error handling
- Tests containing password, token, OTP and authorization fixtures
- `.env.example`, local `.env`, `.gitignore` and private SMTP configuration
- Docker/Compose email-delivery configuration and private credential handling

Key observations:

- Browser access tokens use session storage and are not embedded in source.
- Request logging deliberately excludes bodies, credentials, tokens and query values.
- Deployment scripts obtain sensitive values from environment configuration or generate them at deployment time.
- The Floci AWS account number and `test` credentials are emulator identifiers, not real AWS credentials.
- The tracked Gmail Compose override references credentials through environment
  substitution; it does not contain credential values. The ignored `smtp.env` supplies
  them at runtime.
- No real OTP, Bearer token, Cognito client secret, JWT signing key, GitHub token, private key, database password or cloud credential was found in tracked content or available history.

## 8. Git ignore verification

Currently protected patterns include:

- `.env` and `.env.*`, with `.env.example` explicitly retained
- `smtp.env`
- `.aws/`
- `node_modules/`, `dist/`, coverage and logs
- ZIP build artifacts

Important constraints:

- Ignore rules do not remove files already tracked or secrets already present in history.
- The private audit reports are safe because they are stored outside the repository, not because of an in-repository ignore rule.
- The private SMTP and Floci-backup directories must remain at their current external location.

## 9. GitHub exposure review

- The configured Git remote contains no embedded authentication material.
- A read-only `git ls-remote` succeeded.
- Remote `main` exactly matched local commit `4f0a378c0f77` at audit time.
- An unauthenticated GitHub API request returned 404, so repository metadata was not publicly exposed through that request.
- GitHub CLI was unavailable. Authenticated settings such as secret-scanning alerts, push protection, collaborators and branch-protection configuration could not be inspected.

The content conclusion is based on the exact commit present both locally and on remote `main`, plus the complete locally available history. It does not assert the state of GitHub account-level security settings.

## 10. Limitations

- Authenticated GitHub security settings and private secret-scanning alerts were unavailable.
- Only refs present locally and the reachable remote `main` were auditable; no additional remote refs were reported by the configured repository.
- Generated dependency and build directories were excluded from the directory scan.
- Gitleaks cannot prove that a secret was never shared through a channel outside Git.
- Local private files require continuing operational protection even though they are not Git-exposed.

## 11. Recommendations

1. Keep `E:\Motorlog-Private-Config` outside the repository and out of submission archives.
2. Restrict access to the private SMTP credential and Floci backup; rotate the SMTP app credential if it is ever disclosed.
3. Consider narrowly adding `*.pem`, `*.key`, credential JSON and audit-report patterns to `.gitignore` as defence in depth.
4. Enable or verify GitHub secret scanning and push protection through an authenticated repository owner session.
5. Run the same redacted history and directory scans before the final submission commit.
6. Never commit raw Gitleaks reports if they later contain finding metadata.

## 12. Conclusion

**Status: SAFE TO SUBMIT AT THE AUDITED COMMIT, subject to keeping private configuration outside Git.**

Gitleaks reported zero current-file findings and zero historical findings. Manual review found no real credential in tracked content or available history. The real SMTP credential and sensitive Floci backup are contained outside the repository and show no evidence of GitHub exposure. The low-priority ignore-rule gap is a future-hardening recommendation, not evidence of current exposure.


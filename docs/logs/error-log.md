# Reusable error and learning log

Record only verified, reusable lessons. Do not paste raw logs, secrets, or transient
noise. Newest entries go first.

| Date       | Area                              | Symptom                                                                                                         | Root cause                                                                                                                                                | Fix                                                                                                                                  | Prevention / test                                                                                                         | Reference                        |
| ---------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 2026-08-27 | Clean-checkout Harness validation | Local `npm run verify` passed, but CI could not find `docs/logs/error-log.md`                                   | The broad `.gitignore` pattern `logs` ignored nested `docs/logs`, while path validation checked only the local filesystem                                 | Scope runtime log ignore to `/logs/` and track the durable error log                                                                 | Harness requires referenced artifacts to have a material Git-index object; untracked and intent-to-add files are rejected | `scripts/harness-check.test.mjs` |
| 2026-08-27 | Harness validation                | Required section keys existed, but `null`/empty values and paths outside the repository still passed validation | The initial validator checked selected references after defaulting invalid shapes to empty values; it had no complete schema or path-containment boundary | Apply a fail-closed JSON Schema before semantic validation; resolve and realpath every declared artifact against the repository root | Negative tests mutate every required section and cover absolute, parent, and escaping-symlink paths                       | `scripts/harness-check.test.mjs` |

## Entry rules

- Add an entry after the root cause is known, not during speculation.
- Generalize the prevention without turning one incident into an unrelated global rule.
- Link the spec, test, issue, or ADR that proves the correction.
- Security incidents belong in a private incident system; this repository log contains
  only sanitized engineering lessons.

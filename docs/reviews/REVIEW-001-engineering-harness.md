# REVIEW-001: Engineering harness and system design

- Spec / plan: `feature.md`, `docs/delivery/roadmap.md`
- Author: Primary Codex agent
- Independent reviewers: `/root/harness_reviewer`, `/root/fast_reviewer`
- Revision reviewed: Initial uncommitted project harness
- Date: 2026-08-26
- Verdict: Approve

## Verification performed

- Both reviewers performed read-only comparison of `feature.md`, `AGENTS.md`, the
  project skill, docs, API/CSV, database design, and quality workflow.
- `/root/fast_reviewer` rechecked the fixes and reported no remaining blocker/high
  finding.
- Final `npm run verify`: documentation validator reported 59 matching unique
  catalog rows and 19 Markdown files; format, ESLint (zero warnings), unit,
  integration, E2E, and build all passed.
- Skill creator's Python validator could not start because host Python lacks
  `PyYAML`; the repository validator and Ruby YAML parser both validated required
  skill frontmatter without adding a project dependency.

## Findings

| ID  | Severity | Evidence (file:line/test)                                       | Impact                                                          | Required fix                                                           | Owner   | Disposition                           | Verification                      |
| --- | -------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------- | ------------------------------------- | --------------------------------- |
| R1  | High     | `docs/architecture/database.md` ERD                             | Bare `nullable` annotations could break Mermaid                 | Quote comments and reject invalid annotations                          | Primary | Fixed                                 | `validate-docs.mjs`; format pass  |
| R2  | High     | `database.md:145-160,199-216`                                   | Outbox could duplicate or strand mail                           | Add event key, delivery uniqueness, lease/claim/recovery contract      | Primary | Fixed                                 | Docs validator; design inspection |
| R3  | High     | `database.md:174-187,201`                                       | HTTP idempotency key had no persistence                         | Add scoped key/fingerprint/result model and transaction semantics      | Primary | Fixed                                 | Docs validator; design inspection |
| R4  | High     | `database.md:197`                                               | Invalid stay could bypass DTO validation                        | Add MySQL `CHECK (check_in < check_out)`                               | Primary | Fixed                                 | Design inspection                 |
| R5  | Medium   | `database.md:52-60,194`                                         | User activation changes lacked audit trail                      | Add append-only status history with actor/reason                       | Primary | Fixed                                 | Design inspection                 |
| R6  | High     | `endpoint-catalog.md:20-21,89-92`; `ADR-0001:37`                | Google/local email collision had no safe completion path        | Add authenticated linking start/callback and stable collision outcome  | Primary | Fixed                                 | Markdown/CSV parity validator     |
| R7  | Medium   | `scripts/verify.sh:3-15`; `package.json:20`                     | Gate omitted integration and docs consistency                   | Add real integration smoke suite and docs/CSV/link/skill/ERD validator | Primary | Fixed                                 | Final `npm run verify` pass       |
| R8  | Medium   | Initial sandbox E2E run                                         | Sandbox socket denial looked like project failure               | Rerun with local-bind permission                                       | Primary | Rejected as stale environment finding | Final E2E pass                    |
| R9  | Medium   | `database.md:223-231`; API `ADMIN-BOOK-06`, `EVT-03`, `CRON-03` | Orphan states/events made reviews and notifications unreachable | Define state machine, admin cancel/change producers, completion cron   | Primary | Fixed                                 | Markdown/CSV parity validator     |
| R10 | Medium   | `database.md:24-26,219-221`                                     | ERD implied a room FK while using polymorphic ownership         | Replace with explicit `room_attachments` relation                      | Primary | Fixed                                 | Design inspection                 |
| R11 | Medium   | `database.md:13,104-113`                                        | Booking history actor integrity was ambiguous                   | Add user relationship, actor type, nullable system actor FK            | Primary | Fixed                                 | Design inspection                 |
| R12 | Medium   | `review-report.md:16`                                           | Findings could not record the required owner                    | Add Owner column                                                       | Primary | Fixed                                 | Format/docs validation            |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests and quality harness
- [x] Logging, health, deploy, and rollback design
- [x] Docs, API catalog, database design, and skill

## Residual risk and follow-up

- Post-review simplification: the one-time sheet CSV and its documentation validator
  were removed after the owner completed the report import. Documentation remains
  reviewed and formatted, but Mermaid is not compiled automatically; add rendering
  in CI only if documentation drift becomes a demonstrated problem.
- Integration currently proves the starter Nest module graph. Phase 1 must add real
  MySQL/Redis/storage integration tests without weakening or silently skipping the
  suite.
- Production providers and limits intentionally remain decisions for their roadmap
  phase.
- Post-review product decision: authentication is now Google-only with JIT account
  provisioning. The previous local/Google collision finding is superseded; local
  credential and provider-linking flows were removed from the current design.
- Post-review mentor decision: attachments now use a typed polymorphic association
  under ADR-0003, superseding the earlier explicit `room_attachments` disposition.

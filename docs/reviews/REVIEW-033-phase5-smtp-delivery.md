# REVIEW-033: Phase 5 SMTP adapter and delivery worker

- Spec / plan: [`SPEC-007`](../specs/SPEC-007-reliable-notifications.md),
  [`PLAN-008`](../plans/PLAN-008-reliable-notifications.md) slice `P5-T05`
- Author: Claude Code
- Independent reviewer: Claude Code sub-agent started with no authoring context,
  given the working tree, `AGENTS.md`, the spec, the plan, `ADR-0006`, and the
  contract note `REVIEW-031` carried forward
- Commit/revision reviewed: working tree on `feat/phase-5-notification-templates`
  above `9c5bde6`, slice `P5-T05`
- Date: 2026-09-15
- Verdict: Approve after fixes — reviewer returned **Request changes** with one
  Blocker; every finding is fixed below and pinned by a test that fails without it

## Verification performed

Reviewer, against live MySQL 8.4, Redis, Mailpit, and three purpose-built SMTP
servers:

- Held a send open while the lease expired and a dispatcher recovered the claim, then
  let the provider answer — twice, once accepting and once rejecting. Both runs are
  quoted in `R33-01`; they are the reason it is a Blocker rather than a Medium.
- Stood up an SMTP server answering Gmail's documented login throttle and read the
  real error object nodemailer produces, which is how `R33-03` was proven rather than
  argued.
- Measured one `sendMail` against a server replying inside every per-phase timeout:
  24 seconds against a 5-second configured bound.
- Ran ten mutations in an out-of-tree copy; five survived, listed in `R33-05`.
- Instrumented a real `WorkerModule` context to check shutdown ordering, and probed
  the lock order of the two transactions until MySQL returned `ER_LOCK_DEADLOCK`.

Author, after the fixes: all five surviving mutations now fail, plus the two the
suite already caught. `MYSQL_PORT=13306 npm run verify` green (recorded in
`PLAN-008`).

## Findings

| ID     | Severity | Evidence                                                      | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                                                                                         | Verification                                                                                                                 |
| ------ | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| R33-01 | Blocker  | `delivery-result.repository.ts`, `delivery-worker.service.ts` | The delivery row was updated with no reference to the claim, and the outbox update's guarded result was discarded. A worker whose lease expired mid-send still resolved the delivery: reproduced as a delivered message whose event stayed `PROCESSING` forever - re-claimed at every lease expiry, `attempts` climbing past the budget, and refused by the redrive CLI - and as an event reading `PROCESSED` beside a delivery reading `FAILED` with the message sitting in Mailpit | Fixed — the outbox row is written first and the delivery only if that held the claim, so a lost claim writes nothing at all. Every result method returns whether it held the claim and the worker reports `claim_lost_after_send` instead of `sent` | Integration test races a recovery against a send and asserts neither row records it; mutation removing the claim guard fails |
| R33-02 | High     | `delivery-worker.service.ts` `delivery_resolved`              | The no-op required by `REVIEW-031` wrote nothing at all, leaving the event `PROCESSING` under a lease — the same leak by a second route                                                                                                                                                                                                                                                                                                                                              | Fixed — a resolved delivery finalizes the event to match it, under the claim this job still holds                                                                                                                                                   | Integration test resolves a delivery behind the worker's back and asserts the event reaches `PROCESSED`                      |
| R33-03 | High     | `smtp-error.ts` `EAUTH` ordering                              | Every authentication rejection was permanent, so Gmail's `454 4.7.0 Too many login attempts` — a throttle that clears in minutes — would durably fail every event in the backlog, each needing an operator redrive                                                                                                                                                                                                                                                                   | Fixed — a 4xx is the provider asking for later whatever phase it came from; only a 5xx or a code-less `EAUTH` is permanent                                                                                                                          | Classifier test covers the throttled login and the code-less credential rejection                                            |
| R33-04 | Medium   | `smtp-email-sender.ts` timeouts                               | Nodemailer's three timeouts bound each phase, and `socketTimeout` resets on every byte, so `MAIL_SEND_TIMEOUT_MS` did not bound a send — measured at 24s against a 5s setting. The lease arithmetic and `notificationLeaseSafetyMarginMs` both assume it does                                                                                                                                                                                                                        | Fixed — the send races the configured bound, which also covers the OAuth2 token fetch nodemailer performs without a timeout of its own                                                                                                              | Unit test holds a send open and asserts it rejects as a timeout; mutation removing the bound fails                           |
| R33-05 | Medium   | five surviving mutations, missing `P5-T05` checks             | Lease renewal, the lease precondition, the claim guard, the delivery status guard, and the SMTP timeouts were all unguarded; "crash-after-accept", "concurrent worker" and the Gmail adapter contract had no test                                                                                                                                                                                                                                                                    | Fixed — five tests added, including one that reads the row from another connection during the provider call, which proves the renewal and that no transaction is held across SMTP at once                                                           | All five mutations now fail                                                                                                  |
| R33-06 | Low      | `smtp-error.ts` bare `550`                                    | A `550` outside the envelope phase — Gmail's `550 5.4.5 Daily sending limit exceeded` is the sender's problem — was recorded as an invalid recipient, and that code is the only clue an operator gets                                                                                                                                                                                                                                                                                | Fixed — only the envelope phase names a recipient                                                                                                                                                                                                   | Classifier test covers both 550 shapes                                                                                       |
| R33-07 | Low      | lock order between the two transactions                       | `claimWork` locked outbox then delivery; the result path locked delivery then outbox, which MySQL resolved as `ER_LOCK_DEADLOCK`. Recovered through the lease, so nothing corrupted, but it cost a lease period                                                                                                                                                                                                                                                                      | Fixed — the `R33-01` reordering makes every path lock outbox before delivery                                                                                                                                                                        | —                                                                                                                            |
| R33-08 | Low      | `delivery-worker.service.ts` consumer                         | The BullMQ `Worker` had no `error` or `failed` listener, and BullMQ swallows an unhandled `error` to the console, so a database outage produced no structured record                                                                                                                                                                                                                                                                                                                 | Fixed — both listeners log opaque identifiers and a stable reason                                                                                                                                                                                   | —                                                                                                                            |
| R33-09 | Low      | `README.md`                                                   | Still said the worker consumes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fixed                                                                                                                                                                                                                                               | —                                                                                                                            |

## Review checklist

- [x] Acceptance criteria and scope
- [x] API compatibility and validation
- [x] Authentication, authorization, secrets, and privacy
- [x] Transactions, constraints, concurrency, and idempotency
- [x] External failure/retry behavior
- [x] Tests would fail before the fix
- [x] Logging, metrics, health, deploy, and rollback
- [x] Docs, OpenAPI, migrations, and locale files

## Residual risk and follow-up

- **The at-least-once window is now visible rather than silent.** A send the provider
  accepted while the claim was recovered is reported as `claim_lost_after_send` and
  leaves both rows to whoever holds the claim. The message is out and the record says
  it is not - that is the ambiguity `ADR-0006` documents, and it is now observable in
  the logs instead of being recorded as a success.
- **Restart behaviour has no test.** `PLAN-008` lists it for `P5-T05`; what exists
  proves the pieces a restart relies on - the lease precondition, the claim guard, and
  rebuilding the queue from MySQL - but not a worker process actually restarting
  mid-flight. `P5-T07`'s end-to-end journey is the right place for it.
- **Gmail is proven by contract, not by connection.** The adapter's Gmail branch is
  asserted without a network call, as the spec requires. Nothing here proves Gmail
  accepts what this builds; the first deployment smoke does.

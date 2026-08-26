# Implementation roadmap

Each phase exits only when its acceptance criteria, tests, docs, and independent
review findings are complete. Avoid one large “copy tutorial” commit; port and prove
one platform capability at a time.

| Phase | Vertical slice          | Exit gate                                                                                                            |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0     | Harness and baseline    | Current docs agreed; `npm run verify` green; repo initialized in Git                                                 |
| 1     | Platform foundation     | Config validation, MySQL migrations, i18n, Swagger, logs/request IDs, health endpoints; Compose dependencies healthy |
| 2     | Auth and RBAC           | Google JIT login issues rotating app sessions; inactive users denied; auth unit/integration/E2E pass                 |
| 3     | Room catalog            | Admin CRUD/windows, typed attachments, public search and cloud adapter; window/query/upload tests pass               |
| 4     | Booking core            | Request/history/cancel/admin approve/reject; price snapshot and concurrent approval E2E proven                       |
| 5     | Reliable notifications  | Transactional outbox, BullMQ worker, Gmail adapter, Mailpit local flow, retry/idempotency tests                      |
| 6     | Worker Thread export    | Async room export, job polling, XLSX worker thread, cloud result, size/timeout/error tests                           |
| 7     | Cron and operations     | Singleton daily cleanup, run ledger, observability; optional month-end email if reporting selected                   |
| 8     | CI/CD                   | PR gate, immutable image, migration/deploy job, health smoke test and documented rollback drill                      |
| 9     | Optional product slices | Profile update, reviews, payment, statistics—each independently specified and reviewed                               |

## First implementation plan

1. Implement validated configuration, database, i18n, application bootstrap, and
   reusable test helpers directly in this repository.
2. Create a fresh baseline users/auth schema matching `database.md`; migrations and
   their history belong exclusively to this repository.
3. Implement app session rotation, JWT guards, role/status authorization, and their
   tests independently of the Google adapter.
4. Add full Google callback verification, identity-collision, and JIT-provisioning
   tests before wiring the real adapter. Add the audited, idempotent first-admin CLI.
5. Add Compose services and E2E database lifecycle.

## Delivery choices to settle before their phase

- Frontend origin/callback URLs and OAuth handoff mechanism before Phase 2.
- Production object storage and file limits before Phase 3.
- Gmail SMTP versus Gmail API and sender identity before Phase 5.
- Maximum export rows/memory/timeout before Phase 6.
- Deployment target, migration runner, secret store, and rollback method before Phase 8.
- Revenue definition and payment provider before optional reporting/payment.

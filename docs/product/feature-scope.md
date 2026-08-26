# Product scope

## Terms and actors

- Use **Guest**, not “Guess”: an unauthenticated visitor.
- **User**: an active authenticated customer.
- **Admin**: an authenticated user with administrative role.
- **System**: scheduled jobs, queue workers, webhooks, and CI/CD automation.
- A room is a physical sellable unit. `check_out` is exclusive.

## Release scope

| Capability                      | Actor            | Priority           | Acceptance summary                                                                |
| ------------------------------- | ---------------- | ------------------ | --------------------------------------------------------------------------------- |
| Register/login with Google      | Guest            | Required           | Authorization Code flow; first verified login provisions user; app session issued |
| Refresh/logout                  | User             | Required           | Rotating refresh cookie; revoked/inactive session denied                          |
| Browse/search room availability | Guest            | Required           | Date range must fit an active room window; only confirmed overlap blocks          |
| View current profile            | User             | Required support   | Return current internal identity, role, status, and Google-derived profile        |
| Update profile                  | User             | Optional           | Current identity only; email, role, and status are not user-editable              |
| Create booking request          | User             | Required           | Price snapshot; initial `PENDING`; valid future date range                        |
| List/view own bookings          | User             | Required           | Cannot access another user's booking                                              |
| Cancel own pending booking      | User             | Required           | Only `PENDING -> CANCELLED_BY_USER`                                               |
| Room review                     | User/Admin       | Optional slice     | One review per completed booking; moderation before public display                |
| Payment                         | User/System      | Optional slice     | Provider checkout plus signed idempotent webhook                                  |
| User administration             | Admin            | Required           | List/detail and activate/deactivate; cannot silently bypass audit                 |
| Room administration             | Admin            | Required           | CRUD, bookable windows, amenities, pricing, status, and typed cloud attachments   |
| Booking administration          | Admin            | Required           | List/detail; approve or reject with mandatory rejection reason                    |
| Room Excel export               | Admin            | Selected optional  | Async job; Worker Thread creates XLSX; result stored in cloud                     |
| Booking/revenue statistics      | Admin            | Optional           | Time/room-type filters; money based on captured payments or agreed fallback       |
| Booking status/change email     | System           | Required           | Async, retryable, idempotent Gmail delivery                                       |
| Month-end revenue email         | System           | Optional           | Timezone-safe cron; exactly one report per period                                 |
| Docker Compose                  | Developer/System | Required technique | App, MySQL, Redis, object-storage emulator and mail test service locally          |
| CI and CD                       | Developer/System | Required technique | PR quality gate; main builds image; controlled deploy with health check/rollback  |
| Cron job                        | System           | Required technique | Daily expired-session/export cleanup; optional month-end report                   |

## Business invariants

1. Valid stay: `check_in < check_out`; overlap is
   `existing.check_in < requested.check_out AND existing.check_out > requested.check_in`.
2. Only `CONFIRMED` blocks availability. Multiple pending requests may exist; admin
   approval rechecks overlap under a database lock.
3. A requested stay must be fully contained in one active `room_times` window for
   the selected room. Active windows of the same room cannot overlap.
4. Booking prices and currency are immutable snapshots, unaffected by later room
   price edits.
5. Reject requires a non-empty reason; status history is append-only.
6. Deactivated users cannot create/refresh sessions or use protected endpoints.
7. Review eligibility derives from a completed confirmed stay owned by the user.
8. Optional features are whole vertical slices. Do not build admin review moderation
   without review creation, or payment reports without a defined revenue source.

## Explicitly deferred until a spec selects them

- Multi-hotel/property support, room inventory quantities, promotions, taxes,
  refunds, check-in/check-out operations, housekeeping, and multi-currency conversion.
- The payment provider, cloud vendor, Gmail transport choice, and production deploy
  target. Their adapters must remain replaceable.

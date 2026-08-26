# ADR-0002: Confirmed bookings block availability

- Status: Accepted
- Date: 2026-08-26

Pending requests do not block public availability. This matches the requested
admin-confirmation workflow and avoids indefinite inventory locks. Several users may
request the same room/date; admin approval serializes on the room row, rechecks
confirmed overlap in the same transaction, and returns a conflict if inventory has
already been taken. The UI must present `PENDING` as a request, not a guarantee.

Each room has explicit `room_times` bookable windows. A requested stay must be fully
contained in one active window, and `bookings.room_time_id` records which window was
resolved by the server. The client continues to submit `roomId`, `checkIn`, and
`checkOut`; accepting a client-selected room-time ID would allow cross-room binding.

Active windows for the same physical room cannot overlap. Window creation/update
locks the room row before checking the canonical overlap predicate. Nested endpoints
also verify the window belongs to the room in the URL. Once any booking or booking-
change history references a window, its dates are immutable and a replacement window
must be created. Deactivation is forbidden while a `PENDING` or `CONFIRMED` booking
references it; hard deletion requires no booking/change-history reference.

Booking creation uses the same serialization boundary as window mutation: lock the
physical room, resolve and lock the active containing window, revalidate, then keep
both locks through booking/history/idempotency commit. This prevents a pending
booking from racing with a window edit or deactivation.

Booking approval locks the physical room and referenced window, verifies that the
window is still active and contains the stay, then queries confirmed overlap across
all `room_times` belonging to that room. Checking only `room_time_id` would permit
double booking if overlapping or legacy windows ever existed.

Booking edits pre-read candidate room IDs, lock old/new physical rooms in ascending
order, then lock and re-read the booking/source window. Source/version drift aborts.
The destination window is resolved, locked, and revalidated only after room locks are
held; then the room-wide overlap check and atomic change history/outbox write run.

If the product later needs instant booking or temporary holds, add a separately
specified hold model with expiry rather than changing `PENDING` semantics silently.

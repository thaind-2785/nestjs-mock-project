# ADR-0004: Room update preconditions and aggregate versioning

- Status: Accepted
- Date: 2026-09-07
- Authority: Owner request to implement valid PR #6 fixes and improvements.

## Context

PR #6 review identified that TypeORM save skips unchanged room columns. An
amenity-only PATCH could change the room aggregate without advancing its version,
allowing another admin with the old version to overwrite that change. Grouping
missing, malformed, and stale If-Match values under 409 also obscured client recovery.

## Decision

Keep the physical-room write lock through reference validation, assignment writes,
and room UPDATE. Every accepted non-empty PATCH advances rooms.version exactly once,
including equal-value patches. Set version with SQL arithmetic in the same UPDATE
as scalar fields; reload persisted version and updatedAt for the response. Equal
amenity sets skip join-table rewrites, but do not skip the version increment.

Only incoming amenity references need shared locks. Existing assignments remain
protected by the room lock, and reference deletion rejects in-use rows. A
status-only update reads existing amenities without taking shared amenity locks.
Keep the room-type shared lock and the deterministic incoming-amenity lock order.

Require one quoted positive decimal version, up to 20 digits. Missing/empty headers
return 428 ROOM_VERSION_REQUIRED, malformed/unsupported values return 400
ROOM_VERSION_MALFORMED, and stale versions return 412 ROOM_VERSION_CONFLICT.
Wildcards, weak tags, and tag lists are outside this API's strict version contract.
Unlike the review suggestion, retain no 409 response for a failed If-Match:
[RFC 9110 section 13.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.2.2)
specifies 412; [RFC 6585 section 3](https://www.rfc-editor.org/rfc/rfc6585.html#section-3)
defines 428 for requiring conditional requests.

## Consequences

The initial PR #6 grouped-409 contract is superseded; clients must distinguish
header construction errors from stale forms. Stable error codes and both locales
remain available, with explicit Swagger responses. No schema migration is needed.
A forward fix is preferred over rollback because reverting restores the lost-update
bug. Tests cover amenity-only concurrent writers, equal-set/no-op/mixed updates,
rollback after assignment changes, response timestamps, and reference contention.

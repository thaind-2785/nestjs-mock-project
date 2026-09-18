# ADR-0007: The export, outbox, and Worker Thread boundary

- Status: Accepted
- Date: 2026-09-17
- Authority: Owner decisions of 2026-09-17 recorded in `SPEC-009`; Phase 6 slice
  `P6-T01`; the XLSX dependency pin confirmed by the owner on 2026-09-17 against the
  benchmark below.

## Context

Phase 5 left one durable asynchronous mechanism in the repository: an outbox table
with a checked lifecycle and an expiring lease, a worker process that is its own Nest
application context, and a BullMQ queue that carries transport but not truth. Phase 6
adds a second kind of asynchronous work to that same machinery — building an XLSX
catalogue snapshot — and it differs from mail in the way that matters. Sending mail is
a bounded network call. Building a workbook is unbounded CPU and heap in the process
that does it.

That difference decides the shape. Generating in the API process would hold an HTTP
request open while a single-threaded event loop serialized tens of thousands of cells,
and would put the resulting heap next to authentication and booking traffic. Doing it
on the worker's main thread moves the blast radius rather than removing it: the
notification consumer shares that event loop.

A second question arrives with the first. Two independent consumers now read one
`outbox_events` table, and the Phase 5 dispatcher currently claims by status and
availability alone. Nothing in it says "mail". The first `room-export.requested` row
would be leased by whichever dispatcher reached it first.

## Decision

**The Worker Thread does XLSX and nothing else.** It receives a serializable row
snapshot and returns one bounded buffer. It opens no MySQL connection, no Redis
client, no storage client, and no socket. Every read and every upload stays in the
queue process, which already owns the claim, the transaction boundaries, and the
credentials. The thread therefore has nothing to leak and nothing to hold open when it
is terminated mid-generation, which is what makes termination a safe response to a
timeout rather than a new failure mode.

**`exceljs@4.4.0` in streaming mode, with styles and shared strings on.** The
alternatives were measured in a real Worker Thread under the accepted
`maxOldGenerationSizeMb: 128`, generating the maximum accepted fixture with every
optional column populated, amenities at what was then taken for a plausible upper bound
— see the amendment below, which is where that assumption broke — and one row in
twenty carrying a dangerous spreadsheet prefix:

| Rows    | exceljs in-memory       | exceljs streaming       | SheetJS (`@e965/xlsx`)    |
| ------- | ----------------------- | ----------------------- | ------------------------- |
| 10,000  | 0.6 MiB, 574 ms, 87 MiB | 0.7 MiB, 156 ms, 30 MiB | 1.8 MiB, 202 ms, 68 MiB   |
| 25,000  | out of memory           | 1.8 MiB, 238 ms, 36 MiB | 4.6 MiB, 465 ms, 69 MiB   |
| 50,000  | out of memory           | passed                  | out of memory             |
| 100,000 | out of memory           | passed                  | **fatal — process abort** |

The last column is the third number in each cell: peak used heap. A main-thread probe
sampling every 20 ms observed a maximum event-loop lag of 1.2 ms throughout, which is
the property the whole Worker Thread design exists to buy.

Streaming wins on the only axis that is scarce, while the in-memory builder is already
at 87 MiB at the accepted row limit and fails outright at 25,000.

**Amended 2026-09-18 after `REVIEW-038`.** The table above under-measures, twice. Its
fixture repeated one amenity string across rows, and shared strings store one copy of a
repeated value, so it measured deduplication rather than input; and it counted the
output chunks and dropped them, where production must retain the whole buffer to
transfer it back. With distinct per-row values and the buffer retained, the same shape
peaks at **70.3 MiB against the 128 MiB cap** with 1.5 MiB of output in 393 ms — still
comfortable headroom, but not the 2.4x originally claimed.

The revision that matters more is what the corrected fixture exposed: **the row cap does
not bound memory.** The accepted room contract permits `ArrayMaxSize(100)` amenities per
room with `code VARCHAR(50)` and `name VARCHAR(100)`, so one legal row can carry about
15,600 characters and 10,000 of them reach roughly 155 million. Measured, that is an
out-of-memory termination of the Worker — on an input no validation rejected. A third
cap is therefore accepted alongside the other two: **20,000,000 characters across every
cell of one snapshot**, refused before generation with `EXPORT_SNAPSHOT_TOO_LARGE`. It
is not a reduction of either accepted cap. A real catalogue of 10,000 rooms with fifteen
ordinary amenities carries about 7 million characters, and every shape measured at the
new bound — from 10,000 narrow rows to 1,290 maximum-width ones — stays between 55 and
70 MiB.

Shared strings are enabled although they cost about 20 MiB, because `useSharedStrings:
false` makes exceljs emit `t="str"`, which OOXML defines as a _cached formula string
result_. `SPEC-009` requires every user-controlled value to be a literal string cell,
and the contract test asserts the cell type; asserting `t="s"` states that requirement
directly instead of asserting a formula-result type and explaining that it holds no
formula. The generated package was verified to contain no formula node, no macro, no
external link, and no embedded file, with a frozen filtered header and dangerous
prefixes escaped to literals.

**`resourceLimits` is a backstop, not the bound.** An ordinary overrun surfaces as a
catchable `ERR_WORKER_OUT_OF_MEMORY` on the parent, which survives; this was confirmed
directly. A large enough allocation does not: at 100,000 rows SheetJS produced
`FATAL ERROR: CALL_AND_RETRY_LAST`, aborting the whole process. A Phase 6 export can
therefore kill the notification consumer sharing that process if it is ever allowed to
start on an unbounded row set.

The protection that actually holds is the one `SPEC-009` already specifies: the reader
detects `limit + 1` and fails the job permanently before any generation begins. This
ADR records that the check is load-bearing rather than defensive. Remove it and the
memory cap does not save the process.

**The worker asserts the limit it was given.** Node accepts an unknown key in
`resourceLimits` silently, so `oldGenerationSizeMb` — the plausible misspelling of
`maxOldGenerationSizeMb` — starts a thread with the default multi-gigabyte heap and no
warning. The first run of the benchmark above did exactly this, and every measurement
in it was meaningless while appearing to pass. The Worker therefore reads
`require('node:worker_threads').resourceLimits` at startup and refuses to generate if
the applied old-generation limit is not the configured one. A cap that can vanish
without failing anything is not a cap.

**Event-type allowlists are a claim invariant, not a consumer check.** Each dispatcher
filters by its own event types inside the claiming SQL, before `LIMIT`, so a
notification consumer cannot lease an export row and vice versa. Filtering after the
claim is not equivalent: the wrong consumer would already hold the lease, and the row
would be unavailable until it expired. Each family also gets its own BullMQ queue and
Redis connections, so a backlog of one cannot consume the concurrency of the other.

**Every upload attempt writes its own key.** A staging key contains the job ID and the
attempt's opaque claim token, and an upload-safeguard cleanup row is inserted before
the provider call. Only a worker still holding the claim may point the job at its key
and delete its safeguard. A job-ID-only key was rejected because a stale attempt that
lost its claim could overwrite the result of the attempt that won.

## Consequences

The worker process gains a failure mode it did not have: a Worker Thread that is
terminated or runs out of memory. Both are recoverable through the lease and the
safeguard, and neither can publish a result, but both are now part of what operators
read in the runbook.

The four accepted caps — 10,000 rows, 128 MiB, 60 seconds, 25 MiB — are confirmed
rather than revised, and a fifth is added: 20,000,000 snapshot characters. None of the
original four moves, so Phase 6 starts without renegotiating a product limit; what
changes is that the row cap is no longer claimed to be sufficient on its own. Raising
either the row cap or the character cap is not a configuration change: shared-string
memory climbs steeply, and the measurement would have to be redone.

`exceljs@4.4.0` carries a transitive `uuid` advisory (GHSA-w5hq-g745-h8pq, moderate:
a missing buffer bounds check in v3/v5/v6 when `buf` is supplied). It is accepted with
the pin. The affected call shape is not the one exceljs makes, CI runs `npm ci` and
`npm run verify` rather than `npm audit`, so the gate is unaffected, and the available
remediation downgrades exceljs to 3.4.0, which loses the streaming writer this
decision depends on. The advisory is recorded here so a future upgrade has a reason
rather than a surprise.

The benchmark that produced this table is evidence, not a one-off measurement. It is a
repeatable check in `npm run test:harness` so a dependency upgrade that quietly changes
the memory profile fails rather than ships. Since `REVIEW-038` it also measures the
input the contracts actually permit, retains the output buffer, and carries a second
case that drives the heap past the character cap and requires the run to fail — because
a cap whose violation was never observed is a number, not a bound.

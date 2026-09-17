# Mentor feedback checklist

This is the durable, pre-PR form of mentor feedback. It covers all 34 inline comments
from PRs #7, #8, #9, #10, #12, and #13 through 2026-09-17. Read it before implementing or
independently reviewing a non-trivial slice; do not wait for a recurrence before
opening `docs/logs/error-log.md`.

The checklist records observed feedback, not guessed preferences. A reviewer may
accept a deliberate exception only with concrete evidence and a disposition in the
review report.

## Declaration placement and named policy values

- Put reusable/exported constants in a concern-specific `*.constants.ts` or token
  module. Do not create one project-wide catch-all constants file.
- Put exported types, interfaces, and enums, and implementation contracts that are
  substantial or shared, in a concern-specific `*.types.ts`, `*.enums.ts`, contract,
  port, or adapter file. Keep controller/service/repository files focused on
  executable behavior.
- Replace unexplained protocol/domain limits with named constants. A literal that is
  intrinsic to a tiny local algorithm may remain local when its meaning is obvious.
- Treat dependencies and fields as immutable (`readonly`) when their identity does
  not change. Lifecycle state that genuinely changes must remain mutable and receive
  an explicit review disposition when a `readonly` suggestion would be incorrect.
- An injectable repository with no owned dependency needs no empty constructor. When
  it receives a caller-owned `EntityManager` to preserve transaction boundaries,
  document that ownership rather than injecting a default manager that can escape the
  transaction.
- Apply one access-modifier convention consistently within the affected module; do
  not introduce a one-file convention that tooling cannot preserve.

Evidence: [PR #7 shared constants](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953699688),
[PR #7 concern constant](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953896206),
[PR #7 separate interface](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953928419),
[PR #7 access modifiers](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953889048),
[PR #8 separate interface](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964538542),
[PR #12 service declarations](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021887940),
[PR #12 named email limit](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021898400),
[PR #12 repository contracts](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021900677),
[PR #12 worker contracts](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021906265),
[PR #12 field immutability](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021907940), and
[PR #12 dispatcher declarations](https://github.com/thaind-2785/nestjs-mock-project/pull/12#discussion_r4021922877),
[PR #13 caller-owned repository manager](https://github.com/thaind-2785/nestjs-mock-project/pull/13#discussion_r4032444897), and
[PR #13 mutable lifecycle state](https://github.com/thaind-2785/nestjs-mock-project/pull/13#discussion_r4032478314).

## Query shape, indexes, and persistence operations

- For every joined/entity read, derive the selected columns from the mapper or
  decision that consumes them. Add explicit `select`/projection and a focused
  query-shape assertion when projection scope has regressed before.
- For realistic high-volume query paths, inspect join/filter indexes and use
  representative `EXPLAIN` evidence. Do not add an index without checking its write
  and locking consequences.
- Prefer a direct `insert`/`update` when entity hydration, listeners, cascades, and
  returned generated state are not required. Use `save` deliberately when they are.
- For aggregates over a monotonically growing table, separate the two bounds before
  answering. When the metric contract requires lifetime counts, a `WHERE` cannot be
  the bound - it would change the number an operator alerts on - so bound the scan
  with an index whose leading columns are the `GROUP BY` in its own order and which
  carries no column the query does not select, and bound the rows with retention.
  State the write cost of that index rather than implying it is free.
- Keep database/session time in UTC; driver-side serialization alone does not set the
  database server or session timezone.

Evidence: [PR #7 catalog projections/indexes/decomposition](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953745244),
[PR #7 detail projection](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953748419),
[PR #7 lock projection](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953925500),
[PR #7 database UTC](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953920217),
[PR #8 metadata projection](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964512415),
[PR #8 cleanup projection](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964516626),
[PR #8 explicit insert](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964531241),
[PR #9 booking projection](https://github.com/thaind-2785/nestjs-mock-project/pull/9#discussion_r3976914986), and
[PR #9 direct update](https://github.com/thaind-2785/nestjs-mock-project/pull/9#discussion_r3976927318), and
[PR #13 growing aggregate](https://github.com/thaind-2785/nestjs-mock-project/pull/13#discussion_r4032467201).

## Batching and external work

- Never issue database or provider calls in an unbounded/sequential per-row loop.
  Fetch or mutate in bulk when the adapter supports it; otherwise use explicitly
  bounded concurrency with per-item failure handling.
- Batch presigning and other network preparation for a collection. Avoid fetching a
  collection and then creating each URL separately.
- Use `Promise.allSettled` only when independent failures should be collected and the
  service defines how partial success is reported or compensated. It is not a blanket
  replacement for transactions or fail-fast behavior.
- Add a focused query/provider-call-count assertion for code that fixes N+1 behavior.

Evidence: [PR #8 batch room URLs](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964476849),
[PR #8 batch thumbnails](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964479973),
[PR #8 N+1 updates](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964484513), and
[PR #8 independent failure handling](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964492888).

## Responsibility, decomposition, and reuse

- Controllers translate HTTP only. Put authorization policy, persistence, storage,
  ordering, and domain decisions in services or focused collaborators.
- Split long methods by named responsibility when doing so exposes policy, transaction
  stages, query construction, or mapping. Do not extract trivial one-line wrappers
  solely to reduce line count.
- Move a non-trivial classifier/mapper out of a service when it is an independently
  named concern; import it from a focused helper/error module so the service remains
  lifecycle/orchestration code.
- Before adding a second implementation, search for an existing query builder,
  mapper, history loader, or policy helper. Reuse a narrower base and extend it without
  mixing authorization boundaries.
- Simplify deeply nested conditionals into explicit policy/state functions and cover
  the meaningful branches.

Evidence: [PR #7 service decomposition](https://github.com/thaind-2785/nestjs-mock-project/pull/7#discussion_r3953745244),
[PR #8 simplify branching](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964549135),
[PR #8 thin controller](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964553145),
[PR #9 transaction decomposition](https://github.com/thaind-2785/nestjs-mock-project/pull/9#discussion_r3976826770),
[PR #10 history-query reuse](https://github.com/thaind-2785/nestjs-mock-project/pull/10#discussion_r4002211773), and
[PR #10 summary-query reuse](https://github.com/thaind-2785/nestjs-mock-project/pull/10#discussion_r4002215961), and
[PR #13 helper extraction](https://github.com/thaind-2785/nestjs-mock-project/pull/13#discussion_r4032473909).

## Concurrency and observability

- For every multi-row mutation, document and test lock acquisition order, keep the
  locked set narrow, and examine concurrent calls for inversion/deadlock. A long
  transaction method deserves decomposition around its lock/side-effect stages.
- Important state changes and recoverable external failures emit structured,
  sanitized events with stable event/error identifiers. Never log tokens, provider
  bodies, object keys, raw email content, or other sensitive payloads.

Evidence: [PR #9 deadlock and transaction scope](https://github.com/thaind-2785/nestjs-mock-project/pull/9#discussion_r3976826770) and
[PR #8 operational logging](https://github.com/thaind-2785/nestjs-mock-project/pull/8#discussion_r3964541813).

## Required sweep before handoff

For every changed concern, record evidence in the plan or review report for the
applicable items below:

- [ ] Constants/contracts are in concern-specific files; domain/protocol limits are
      named; mutable fields have a reason.
- [ ] Entity/join reads project only consumed columns; high-volume queries have an
      index/`EXPLAIN` disposition where relevant.
- [ ] Loops do not hide N+1 database/provider calls; concurrency is bounded and
      partial failure behavior is defined.
- [ ] Controllers contain transport only; long flows are split by responsibility;
      existing helpers were considered before duplication.
- [ ] Multi-row mutations have consistent lock order and concurrency evidence.
- [ ] Important operations and failures emit safe, structured logs.
- [ ] Every applicable earlier mentor thread has a concrete disposition; automated
      checks are supporting evidence, not a substitute for this sweep.

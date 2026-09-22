import { retentionDuePredicate, retentionDuePredicates } from './retention-due';
import { retentionTaskNames } from './retention.constants';

describe('retention due predicates', () => {
  it('covers every task exactly once', () => {
    expect(retentionDuePredicates.map((p) => p.taskName).sort()).toEqual(
      [...retentionTaskNames].sort(),
    );
  });

  it.each(retentionDuePredicates.map((p) => [p.taskName]))(
    '%s reports age from a column it also filters on',
    (taskName) => {
      const predicate = retentionDuePredicate(taskName);
      // `MIN(anchor)` over rows selected by `where` only describes the backlog when the
      // two are the same column. Anchoring elsewhere reports a real number about the
      // wrong thing - and `EXPLAIN` cannot see it, because the anchor appears in the
      // projection rather than in the predicate.
      expect(predicate.where).toContain(predicate.anchorColumn);
    },
  );

  it('refuses a task it has no predicate for', () => {
    expect(() =>
      retentionDuePredicate('nonsense' as (typeof retentionTaskNames)[number]),
    ).toThrow();
  });
});

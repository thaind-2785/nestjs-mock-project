export const readinessDependencies = ['mysql', 'redis', 'storage'] as const;

/** Long enough to be visible while debugging, short enough to leave no residue. */
export const readinessKeyTtlSeconds = 30;

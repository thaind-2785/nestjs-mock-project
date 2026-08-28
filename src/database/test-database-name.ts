const disposableDatabasePattern = /^p1_t04_[a-z0-9][a-z0-9_$-]*$/i;

export function isP1T04DisposableDatabaseName(value: string): boolean {
  return disposableDatabasePattern.test(value);
}

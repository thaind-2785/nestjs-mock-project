/**
 * Which build of the application is answering.
 *
 * Baked as `ENV GIT_SHA` by the Dockerfile and read once here. `unknown` outside a built
 * image - a developer running from source has no commit to claim, and saying so is more
 * useful than reporting the working tree's HEAD, which may not be what is running.
 *
 * This exists because a deploy cannot otherwise tell one revision from another. Railway
 * keeps the outgoing container serving until the incoming one is healthy, so a readiness
 * check made straight after a deploy is answered by the revision being replaced - and
 * answered `200`. `REVIEW-045` recorded that the deploy passed on that answer whether or
 * not the new image ever started.
 */
export const unknownRevision = 'unknown';

export function currentRevision(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment.GIT_SHA?.trim();
  return value && value.length > 0 ? value : unknownRevision;
}

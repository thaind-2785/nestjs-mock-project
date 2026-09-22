import { INestApplication } from '@nestjs/common';

/**
 * Starts an application under test and binds its own listening socket.
 *
 * Named for HTTP rather than for e2e because the scope was read too narrowly: the one
 * integration suite that drives requests skipped it and kept the defect described
 * below, and the e2e-only name is why nobody looked.
 *
 * Every suite must use this rather than `app.init()` alone. Supertest's
 * `serverAddress` calls `app.listen(0)` whenever it finds the server unbound, and its
 * `end` closes that server again once the response arrives - so an `init()`-only suite
 * hands the socket's lifetime to whichever request happens to be first, on a new
 * ephemeral port each time.
 *
 * Two `Test` objects created while the server is up share a port but only one owns it;
 * when that one's response lands it closes the socket the others are still addressing.
 * Across a `--runInBand` run of eight suites cycling ephemeral ports, the port is
 * quickly reused, so the stranded request gets a real answer from a different
 * application against a different database. That produced a rare `404` carrying a body
 * this project never emits, about one run in five, independent of suite order.
 *
 * Binding here removes the ambiguity: `address()` is non-null before the first request,
 * so supertest neither opens nor closes anything, and `app.close()` remains the single
 * owner of teardown.
 */
export async function startE2eServer(
  app: INestApplication,
): Promise<INestApplication> {
  // `listen` initialises the application if `init` has not already run, so a suite that
  // configures and then calls this is correct either way.
  await app.listen(0, '127.0.0.1');
  return app;
}

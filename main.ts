// mini-forge entrypoint: what this file wires together.
//
//   createApp() (app.ts) builds the whole forge — REST v3, GraphQL, MCP, and git
//   smart HTTP — on top of one in-memory Store (store.ts). This file owns only
//   the process lifecycle around that server: it binds an ephemeral port, prints
//   a startup banner, registers the port with the trial env, waits until the env
//   reports the trial is done, and then closes the server and exits. It also
//   handles SIGINT/SIGTERM so a stop request shuts the HTTP server down cleanly
//   instead of killing the process mid-request. Nothing in here implements forge
//   behaviour; every request is answered by the app the entrypoint starts.
//
// The lifecycle below (register, then poll /done) is the harness's contract,
// so the shape of main() stays the same even as the banner and shutdown grow.


// port it bound, then poll until the env says the trial is over and exit 0. Keep this file as it is:
// the suite scores the server app.ts builds, and the lifecycle is the harness's, not the contest's.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** The name and version the startup banner prints; bump the version with package.json. */
const FORGE_NAME = 'mini-forge';
const FORGE_VERSION = '0.1.0';

/**
 * Print one startup banner line: what is running, which port it bound, and how
 * many repositories already live in the store. On a fresh boot the count is
 * zero — the suite creates repositories through the API after this line — but
 * printing it here makes a warm restart's state visible at a glance.
 */
function printBanner(port: number, repoCount: number): void {
  const noun = repoCount === 1 ? 'repository' : 'repositories';
  process.stdout.write(`[entry] ${FORGE_NAME} v${FORGE_VERSION} listening on port ${port} (${repoCount} ${noun} in store)\n`);
}

/** True once a shutdown signal has been handled, so a second signal exits at once. */
let shuttingDown = false;

/**
 * Close the HTTP server, then leave with status 0. The close callback waits for
 * in-flight requests to finish, so a stop does not cut a response short; a
 * second signal while the first close is still in flight skips the wait and
 * exits immediately instead of hanging on a stuck connection.
 */
function shutdown(server: Server, signal: NodeJS.Signals): void {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  process.stdout.write(`[entry] ${signal} received: closing the server\n`);
  server.close(() => {
    process.stdout.write('[entry] server closed\n');
    process.exit(0);
  });
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const store = new Store();
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  printBanner(address.port, store.repos.size);
  process.once('SIGINT', () => shutdown(server, 'SIGINT'));
  process.once('SIGTERM', () => shutdown(server, 'SIGTERM'));

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

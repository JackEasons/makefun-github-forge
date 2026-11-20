// Entry point: the trial harness lifecycle for this forge.
//
// The harness runs an environment (env) that owns the trial. Its address is
// MAKEFUN_ENV_URL. This process has one job: bring the forge server up,
// hand the env the port it listens on, and stay alive until the env says
// the trial is over. The forge itself lives in app.ts; nothing about git,
// REST, GraphQL or MCP is decided here.
//
// The exchange with the env, in order:
//   1. listen on an ephemeral port (never 8080: that port belongs to the env),
//   2. POST /register {"port": N} so the env can dial the server,
//   3. poll GET /done until it answers {"done": true},
//   4. close the server and exit 0.
// A missing MAKEFUN_ENV_URL means there is no env to talk to, so the
// process exits 1 right away instead of starting a server nobody can reach.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

/** Longest a single request to the env may run before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First pause between retries, and the cap it grows to. */
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause before retry number `n`: exponential growth from RETRY_FIRST_MS, capped. */
function pauseBeforeRetry(n: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(n, 8));
}

/**
 * Run `step` until it reports finished, pausing longer after each failure.
 * A step finishes by returning true, asks for another try by returning
 * false, and aborts the whole process by throwing.
 */
async function repeatUntilDone(step: () => Promise<boolean>): Promise<void> {
  for (let n = 0; ; n += 1) {
    if (await step()) return;
    await pause(pauseBeforeRetry(n));
  }
}

/** Tell the env which port the server listens on. */
async function registerPort(port: number): Promise<void> {
  await repeatUntilDone(async () => {
    let res: Response;
    try {
      res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return false;
    }
    if (res.status === 200 || res.status === 409) return true;
    if (res.status === 400 || res.status === 405) {
      throw new Error(`env refused the registration (HTTP ${res.status}): ${await res.text()}`);
    }
    return false;
  });
}

/** Ask the env, over and over, whether the trial has finished. */
async function waitForTrialEnd(): Promise<void> {
  await repeatUntilDone(async () => {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return false;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true;
    } catch {
      return false;
    }
  });
}

/** Start the server, register it, wait for the env, then shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('[entry] registered with the env; waiting for the trial to end\n');

  await waitForTrialEnd();
  server.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

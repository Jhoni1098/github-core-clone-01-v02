// The entrypoint: one server process, the agent/v1 lifecycle.
//
//   * Bind an ephemeral port (never a fixed one).
//   * Register the port at $MAKEFUN_ENV_URL/register.
//   * Serve until GET $MAKEFUN_ENV_URL/done reports {"done": true}, then exit 0.
//   * Without $MAKEFUN_ENV_URL the process exits 1 — unless --port is given, in which case it
//     serves standalone on that port (local development and the sdk/ runner only; the trial
//     always sets MAKEFUN_ENV_URL).
//
// Usage: node --experimental-strip-types main.ts [--port N] [--data-dir DIR]

import { createApp } from './src/server.ts';
import { Store } from './src/store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]): { port?: number; dataDir?: string } {
  const out: { port?: number; dataDir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1] !== undefined) out.port = Number.parseInt(argv[i + 1] as string, 10);
    if (argv[i] === '--data-dir' && argv[i + 1] !== undefined) out.dataDir = argv[i + 1];
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl && args.port === undefined) {
    console.error('MAKEFUN_ENV_URL is not set and no --port was given; exiting.');
    return 1;
  }

  const store = new Store(args.dataDir ?? process.env.FORGE_DATA_DIR);
  const server = createApp(store);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`github-forge-v02 listening on 127.0.0.1:${port}`);

  if (args.port !== undefined && !envUrl) {
    // Standalone mode: serve until killed. Used by the local sdk/ runner.
    console.log('standalone mode: serving until terminated');
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });
    server.close();
    return 0;
  }

  const base = (envUrl as string).replace(/\/$/, '');
  // Register this process with the grader's environment service.
  const register = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!register.ok) {
    console.error(`register failed: HTTP ${register.status}`);
    server.close();
    return 1;
  }

  // Long-poll /done until the trial ends, then exit 0.
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) break;
      }
    } catch {
      // A transient environment-service error must not kill the trial; retry.
    }
    await sleep(500);
  }
  server.close();
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

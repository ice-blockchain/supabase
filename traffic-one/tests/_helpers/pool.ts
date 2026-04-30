// ─────────────────────────────────────────────────────────────────────────────
// Retrying "pool" wrapper for the integration suites.
//
// Why this exists (quick recap):
//
//   Every services suite previously opened ONE module-level
//   `new Pool(TRAFFIC_DB_URL, 1, true)` that lived for the whole file.
//   Supavisor (the pooler we run on port 5432) drops idle sessions after
//   a short timeout, and `postgres-deno@v0.17.0` had no auto-reconnect —
//   the second use of the same client bubbled up
//   `ConnectionError: session was terminated unexpectedly` and bricked
//   the rest of the file.
//
// Why NOT a real Pool under the hood:
//
//   Under `postgres-deno@v0.19.3` a module-level `Pool` trips Deno's
//   test-runner TCP resource sanitizer on the FIRST test that borrows a
//   client: the pool opens a socket lazily inside that test's scope, and
//   releasing only returns the client to the pool — the TCP socket stays
//   open past the test boundary and the sanitizer flags it as a leak.
//   (The old v0.17.0 pool had the same behavior at the socket level but
//   an older Deno didn't detect it.)
//
//   The test suites don't actually need connection pooling: Deno runs
//   the tests serially and each one finishes with a clean `end()` anyway,
//   so the cost of "new Client per call" is one TCP handshake per test.
//   That's it. In exchange we get: no leaked sockets, no stale-session
//   recovery logic, and a retry path that is a single try/catch.
//
// External shape:
//
//   - `createRetryingPool(dsn)` returns something that passes as `Pool`
//     (extends the upstream class) so it can be handed to service
//     functions whose signature says `pool: Pool`.
//   - `pool.withConnection(fn)` opens a fresh `Client`, runs `fn`,
//     `await client.end()` in `finally`. Retries once on a retryable
//     `ConnectionError` / broken-pipe / connection-reset.
//   - `pool.withTransaction(name, fn)` layers `createTransaction/begin/
//     commit/rollback` on top.
//   - `pool.connect()` (the `Pool` override) returns a one-shot object
//     whose `release()` closes the underlying `Client`. This keeps the
//     service functions that call `pool.connect() … connection.release()`
//     working without any change, and without leaking sockets past the
//     test.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Client,
  ConnectionError,
  Pool,
  type PoolClient,
  type Transaction,
  type TransactionOptions,
} from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

// Patterns that indicate the TCP socket has gone away and the next op
// needs a freshly opened client. Anything else is a real query bug or a
// Postgres-level error and must propagate.
const RETRYABLE_RE =
  /session (was )?terminated|broken[\s_]?pipe|connection[\s_]?reset|EOF|ECONNRESET/i

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof ConnectionError) return true
  return RETRYABLE_RE.test(err.message)
}

async function openClient(dsn: string): Promise<Client> {
  const client = new Client(dsn)
  await client.connect()
  return client
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.end()
  } catch {
    // The connection may already be half-torn-down — that's exactly why
    // we're closing it. Swallow so we don't mask the original failure.
  }
}

export class RetryingPool extends Pool {
  #dsn: string

  constructor(dsn: string, size = 1) {
    // Parent `Pool` does its own bookkeeping, but we never actually
    // borrow from it: every path goes through a freshly opened `Client`.
    // `lazy=true` ensures `super(...)` doesn't open any sockets.
    super(dsn, size, true)
    this.#dsn = dsn
  }

  /** Borrow a client, run `fn`, close in `finally`. Retries once on `ConnectionError`. */
  async withConnection<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const run = async () => {
      const client = await openClient(this.#dsn)
      try {
        return await fn(client)
      } finally {
        await closeClient(client)
      }
    }
    try {
      return await run()
    } catch (err) {
      if (!isRetryableError(err)) throw err
      return await run()
    }
  }

  /** Open a tx, run `fn`, commit on success / rollback on throw. Retries once on `ConnectionError`. */
  async withTransaction<T>(
    name: string,
    fn: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const run = async () => {
      const client = await openClient(this.#dsn)
      const tx = client.createTransaction(name, options)
      await tx.begin()
      try {
        const result = await fn(tx)
        await tx.commit()
        return result
      } catch (err) {
        try {
          await tx.rollback()
        } catch {
          // The connection may already be terminated; let the original
          // error propagate.
        }
        throw err
      } finally {
        await closeClient(client)
      }
    }
    try {
      return await run()
    } catch (err) {
      if (!isRetryableError(err)) throw err
      return await run()
    }
  }

  // ── Pool surface overrides ─────────────────────────────────────────────
  // Service functions under test call `pool.connect()` internally and
  // later `connection.release()`. Upstream `PoolClient.release()` just
  // returns the client to the pool's free stack, which is what keeps a
  // socket open past the test. Our version hands the caller a one-shot
  // `Client` wearing a `release()` that actually closes the socket.

  override async connect(): Promise<PoolClient> {
    const client = await openClient(this.#dsn)
    // Monkey-patch `release()` onto the Client. `release` isn't on the
    // `Client` type, but service code calls it through `PoolClient` —
    // attaching a compatible method means the service function can treat
    // this like any other pooled client without knowing we closed the
    // socket underneath.
    const asPoolClient = client as Client & { release: () => void }
    asPoolClient.release = () => {
      void closeClient(client)
    }
    return asPoolClient as unknown as PoolClient
  }

  override async end(): Promise<void> {
    // Nothing to tear down — every `withConnection` / `connect` result
    // already closes its own socket.
  }
}

export function createRetryingPool(dsn: string, size = 1): RetryingPool {
  return new RetryingPool(dsn, size)
}

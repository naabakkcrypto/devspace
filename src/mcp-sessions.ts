export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface ManagedMcpSession<TTransport extends ClosableMcpTransport>
  extends ClosableMcpTransport {
  transport: TTransport;
}

export function createMcpSessionResource<
  TTransport extends ClosableMcpTransport,
  TServer extends ClosableMcpTransport,
>(transport: TTransport, server: TServer): ManagedMcpSession<TTransport> {
  let closePromise: Promise<void> | undefined;
  return {
    transport,
    close() {
      closePromise ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled([server.close(), transport.close()]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      });
      return closePromise;
    },
  };
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  register(sessionId: string, transport: TTransport): void {
    this.sessions.set(sessionId, {
      transport,
      lastActivityAt: this.now(),
    });
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];

    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastActivityAt > cutoff) continue;

      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }

    return closeSessions(idleSessions);
  }

  async closeOverflow(maxRetained: number): Promise<McpSessionCloseResult[]> {
    if (!Number.isInteger(maxRetained) || maxRetained < 0) {
      throw new Error("MCP session retention limit must be a non-negative integer");
    }
    const overflow = Math.max(0, this.sessions.size - maxRetained);
    if (overflow === 0) return [];
    const oldest = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
      lastActivityAt: entry.lastActivityAt,
    }))
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
      .slice(0, overflow);
    for (const { sessionId } of oldest) this.sessions.delete(sessionId);
    return closeSessions(oldest);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
      sessionId,
      transport: entry.transport,
    }));
    this.sessions.clear();
    return closeSessions(sessions);
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(
    sessions.map(async ({ sessionId, transport }) => {
      try {
        await transport.close();
        return { sessionId };
      } catch (error) {
        return { sessionId, error };
      }
    }),
  );
}

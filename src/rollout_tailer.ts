import { expandHome } from "./config.ts";
import { CodexEventObserver } from "./codex_events.ts";
import type { ProxyLogger } from "./logger.ts";

const ROLLOUT_SCAN_INTERVAL_MS = 250;
const ROLLOUT_SESSION_META_BYTES = 65_536;
const ROLLOUT_CANDIDATE_LIMIT = 8;

type RolloutFileSnapshot = {
  path: string;
  size: number;
  mtimeMs: number;
};

type RolloutSessionMeta = {
  line: string;
  sessionId: string;
  cwd: string | null;
  originator: string | null;
};

export type RolloutTailer = {
  stop(): Promise<void>;
};

export async function startInteractiveRolloutTailer(options: {
  cwd: string;
  observer: CodexEventObserver;
  logger: ProxyLogger;
  sessionsDir?: string;
}): Promise<RolloutTailer> {
  const sessionsDir = options.sessionsDir ?? resolveCodexSessionsDir();
  const initialSnapshots = await snapshotRolloutFiles(sessionsDir).catch(() => []);
  const initialSizes = new Map(initialSnapshots.map((snapshot) => [snapshot.path, snapshot.size]));
  const state = {
    activePath: null as string | null,
    offset: 0,
    buffer: "",
    stopped: false,
  };

  const task = (async () => {
    await options.logger.log("interactive_rollout_tail_start", {
      sessionsDir,
      cwd: options.cwd,
      knownRolloutFileCount: initialSnapshots.length,
    });

    while (!state.stopped) {
      try {
        if (!state.activePath) {
          const attached = await maybeAttachActiveRolloutFile(
            sessionsDir,
            options.cwd,
            initialSizes,
            options.observer,
            options.logger,
          );
          if (attached) {
            state.activePath = attached.path;
            state.offset = attached.offset;
          }
        }

        if (state.activePath) {
          const next = await consumeRolloutAppend(
            state.activePath,
            state.offset,
            state.buffer,
            options.observer,
          );
          state.offset = next.offset;
          state.buffer = next.buffer;
        }
      } catch (error) {
        await options.logger.log("interactive_rollout_tail_error", {
          message: error instanceof Error ? error.message : String(error),
          activePath: state.activePath,
        });
      }

      await delay(ROLLOUT_SCAN_INTERVAL_MS);
    }

    if (state.activePath) {
      const next = await consumeRolloutAppend(
        state.activePath,
        state.offset,
        state.buffer,
        options.observer,
      );
      if (next.buffer.trim()) {
        await options.observer.observeExecJsonLine(next.buffer);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      state.stopped = true;
      await task.catch(() => undefined);
    },
  };
}

export function resolveCodexSessionsDir(): string {
  const codexHome = Deno.env.get("CODEX_HOME");
  if (codexHome && codexHome.trim()) {
    return expandHome(`${codexHome}/sessions`);
  }
  return expandHome("~/.codex/sessions");
}

async function maybeAttachActiveRolloutFile(
  sessionsDir: string,
  cwd: string,
  initialSizes: Map<string, number>,
  observer: CodexEventObserver,
  logger: ProxyLogger,
): Promise<{ path: string; offset: number } | null> {
  const candidates = await newestRolloutCandidates(sessionsDir, ROLLOUT_CANDIDATE_LIMIT);
  const ordered = [
    ...candidates.filter((candidate) => !initialSizes.has(candidate.path)),
    ...candidates.filter((candidate) => initialSizes.has(candidate.path)),
  ];

  for (const candidate of ordered) {
    const initialSize = initialSizes.get(candidate.path);
    const isNewFile = initialSize === undefined;
    if (!isNewFile && candidate.size <= initialSize) {
      continue;
    }

    const sessionMeta = await readRolloutSessionMeta(candidate.path);
    if (!sessionMeta) {
      continue;
    }
    if (sessionMeta.originator && sessionMeta.originator !== "codex-tui") {
      continue;
    }
    if (sessionMeta.cwd && sessionMeta.cwd !== cwd) {
      continue;
    }

    if (!isNewFile) {
      await observer.observeExecJsonLine(sessionMeta.line);
    }

    const offset = isNewFile ? 0 : initialSize;
    await logger.log("interactive_rollout_file_attached", {
      path: candidate.path,
      sessionId: sessionMeta.sessionId,
      mode: isNewFile ? "new_file" : "existing_file",
      initialOffset: offset,
    });
    return { path: candidate.path, offset };
  }

  return null;
}

async function consumeRolloutAppend(
  path: string,
  offset: number,
  buffer: string,
  observer: CodexEventObserver,
): Promise<{ offset: number; buffer: string }> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { offset, buffer };
    }
    throw error;
  }

  let nextOffset = offset;
  let nextBuffer = buffer;
  if (stat.size < nextOffset) {
    nextOffset = 0;
    nextBuffer = "";
  }
  if (stat.size <= nextOffset) {
    return { offset: nextOffset, buffer: nextBuffer };
  }

  const chunk = await readTextRange(path, nextOffset, stat.size - nextOffset);
  nextOffset = stat.size;
  nextBuffer += chunk;

  let newlineIndex = nextBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = nextBuffer.slice(0, newlineIndex);
    await observer.observeExecJsonLine(line);
    nextBuffer = nextBuffer.slice(newlineIndex + 1);
    newlineIndex = nextBuffer.indexOf("\n");
  }

  return { offset: nextOffset, buffer: nextBuffer };
}

async function newestRolloutCandidates(
  sessionsDir: string,
  limit: number,
): Promise<RolloutFileSnapshot[]> {
  const snapshots = await snapshotRolloutFiles(sessionsDir);
  snapshots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return snapshots.slice(0, limit);
}

async function snapshotRolloutFiles(sessionsDir: string): Promise<RolloutFileSnapshot[]> {
  const out: RolloutFileSnapshot[] = [];
  await walkRolloutFiles(sessionsDir, out);
  return out;
}

async function walkRolloutFiles(path: string, out: RolloutFileSnapshot[]): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(path)) {
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const childPath = `${path}/${entry.name}`;
    if (entry.isDirectory) {
      await walkRolloutFiles(childPath, out);
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const stat = await Deno.stat(childPath);
    out.push({
      path: childPath,
      size: stat.size,
      mtimeMs: stat.mtime?.getTime() ?? 0,
    });
  }
}

async function readRolloutSessionMeta(path: string): Promise<RolloutSessionMeta | null> {
  const prefix = await readTextRange(path, 0, ROLLOUT_SESSION_META_BYTES);
  const newlineIndex = prefix.indexOf("\n");
  const line = (newlineIndex >= 0 ? prefix.slice(0, newlineIndex) : prefix).trim();
  if (!line) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.type !== "session_meta" || !envelope.payload || typeof envelope.payload !== "object"
  ) {
    return null;
  }

  const payload = envelope.payload as Record<string, unknown>;
  const sessionId = typeof payload.id === "string" ? payload.id : null;
  if (!sessionId) {
    return null;
  }

  return {
    line,
    sessionId,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    originator: typeof payload.originator === "string" ? payload.originator : null,
  };
}

async function readTextRange(path: string, offset: number, length: number): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(offset, Deno.SeekMode.Start);
    const buffer = new Uint8Array(length);
    let readOffset = 0;
    while (readOffset < buffer.length) {
      const read = await file.read(buffer.subarray(readOffset));
      if (read === null) {
        break;
      }
      readOffset += read;
    }
    return new TextDecoder().decode(buffer.subarray(0, readOffset));
  } finally {
    file.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { expandHome } from "./config.ts";
import { shortHash } from "./hash.ts";
import {
  assertMemoryInvariant,
  emptyMemoryState,
  emptySessionRecord,
  isRecord,
  MemoryState,
  SessionRecord,
} from "./memory_state.ts";

export class SessionStore {
  #root: string;
  #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.#root = expandHome(root);
  }

  async load(sessionKey: string): Promise<SessionRecord> {
    const dir = await this.#sessionDir(sessionKey);
    const memory = await this.#loadLatestMemory(`${dir}/memory.snapshots.jsonl`);
    const handledInputIds = await this.#loadHandledInputs(`${dir}/handled-inputs.json`);
    return { memory, handledInputIds };
  }

  async save(sessionKey: string, record: SessionRecord): Promise<void> {
    assertMemoryInvariant(record.memory);
    const dir = await this.#sessionDir(sessionKey);
    await Deno.mkdir(dir, { recursive: true });
    const snapshot = {
      type: "context_memory_snapshot",
      createdAt: new Date().toISOString(),
      payload: record.memory,
    };
    await Deno.writeTextFile(`${dir}/memory.snapshots.jsonl`, `${JSON.stringify(snapshot)}\n`, {
      append: true,
      create: true,
    });
    await atomicWriteJson(`${dir}/handled-inputs.json`, {
      handledInputIds: [...new Set(record.handledInputIds)].sort(),
    });
  }

  async withLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => next);
    this.#locks.set(sessionKey, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(sessionKey) === chained) {
        this.#locks.delete(sessionKey);
      }
    }
  }

  async #sessionDir(sessionKey: string): Promise<string> {
    const sanitized = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 72) || "default";
    const suffix = await shortHash(sessionKey, 10);
    return `${this.#root}/sessions/${sanitized}_${suffix}`;
  }

  async #loadLatestMemory(path: string): Promise<MemoryState> {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return emptyMemoryState();
      }
      throw error;
    }

    let latest: MemoryState | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (
          isRecord(parsed) && parsed.type === "context_memory_snapshot" && isRecord(parsed.payload)
        ) {
          latest = parsed.payload as MemoryState;
        }
      } catch {
        continue;
      }
    }
    if (!latest) {
      return emptyMemoryState();
    }
    assertMemoryInvariant(latest);
    return latest;
  }

  async #loadHandledInputs(path: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      if (isRecord(parsed) && Array.isArray(parsed.handledInputIds)) {
        return parsed.handledInputIds.map(String);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return emptySessionRecord().handledInputIds;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temp, path);
}

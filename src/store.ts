import { expandHome } from "./config.ts";
import { shortHash } from "./hash.ts";
import {
  assertMemoryInvariant,
  emptySessionRecord,
  isRecord,
  type ChunkRecord,
  type SessionRecord,
} from "./memory_state.ts";

export type ExactChunk = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  selector: ChunkRecord["selector"];
  payload: unknown;
};

export class SessionStore {
  #root: string;
  #locks = new Map<string, Promise<void>>();

  constructor(root: string, _inlinePieceByteLimit = Number.POSITIVE_INFINITY) {
    this.#root = expandHome(root);
  }

  async load(sessionKey: string): Promise<SessionRecord> {
    const dir = await this.#sessionDir(sessionKey);
    const path = `${dir}/state.json`;
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      if (!isRecord(parsed) || !isRecord(parsed.memory)) {
        return emptySessionRecord();
      }
      const record = parsed as SessionRecord;
      assertMemoryInvariant(record.memory);
      return record;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return emptySessionRecord();
      }
      throw error;
    }
  }

  async save(sessionKey: string, record: SessionRecord): Promise<void> {
    assertMemoryInvariant(record.memory);
    const dir = await this.#sessionDir(sessionKey);
    await atomicWriteText(`${dir}/state.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  async getExactChunks(sessionKey: string, chunkIds: string[]): Promise<ExactChunk[]> {
    const record = await this.load(sessionKey);
    const byId = new Map(record.memory.chunks.map((chunk) => [chunk.id, chunk] as const));
    const out: ExactChunk[] = [];
    for (const chunkId of chunkIds) {
      const chunk = byId.get(chunkId);
      if (!chunk) {
        continue;
      }
      out.push({
        id: chunk.id,
        sourceKind: chunk.sourceKind,
        sourceId: chunk.sourceId,
        ...(chunk.toolName ? { toolName: chunk.toolName } : {}),
        selector: chunk.selector,
        payload: chunk.payload,
      });
    }
    return out;
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
}

async function atomicWriteText(path: string, text: string): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(temp, text);
  await Deno.rename(temp, path);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

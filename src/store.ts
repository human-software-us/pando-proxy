import { expandHome } from "./config.ts";
import { shortHash } from "./hash.ts";
import {
  assertMemoryInvariant,
  emptySessionRecord,
  isRecord,
  type MemoryPiece,
  pruneMemoryState,
  type SessionRecord,
} from "./memory_state.ts";
import type { RoundSource } from "./tool_results.ts";

export type ExactPiece = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  selector: MemoryPiece["selector"];
  payload: unknown;
};

export type ArchivedSource = RoundSource;

export class SessionStore {
  #root: string;
  #inlinePieceByteLimit: number;
  #locks = new Map<string, Promise<void>>();

  constructor(root: string, inlinePieceByteLimit = Number.POSITIVE_INFINITY) {
    this.#root = expandHome(root);
    this.#inlinePieceByteLimit = inlinePieceByteLimit;
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
      record.memory = pruneMemoryState(record.memory);
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
    const dir = await this.#sessionDir(sessionKey);
    const payloadDir = `${dir}/payloads`;
    const memory = pruneMemoryState(structuredClone(record.memory));

    for (const piece of memory.pieces) {
      if (piece.payloadInline === undefined || piece.byteSize <= this.#inlinePieceByteLimit) {
        continue;
      }
      const payloadRef = piece.payloadRef ?? await this.#payloadRefForPiece(piece.id);
      await Deno.mkdir(payloadDir, { recursive: true });
      await atomicWriteText(`${dir}/${payloadRef}`, `${JSON.stringify(piece.payloadInline)}\n`);
      delete piece.payloadInline;
      piece.payloadRef = payloadRef;
    }

    assertMemoryInvariant(memory);
    await atomicWriteText(`${dir}/state.json`, `${JSON.stringify({ memory }, null, 2)}\n`);
  }

  async getExactPieces(sessionKey: string, pieceIds: string[]): Promise<ExactPiece[]> {
    const dir = await this.#sessionDir(sessionKey);
    const record = await this.load(sessionKey);
    const byId = new Map(record.memory.pieces.map((piece) => [piece.id, piece] as const));
    const out: ExactPiece[] = [];
    for (const pieceId of pieceIds) {
      const piece = byId.get(pieceId);
      if (!piece) {
        continue;
      }
      out.push({
        id: piece.id,
        sourceKind: piece.sourceKind,
        sourceId: piece.sourceId,
        ...(piece.toolName ? { toolName: piece.toolName } : {}),
        selector: piece.selector,
        payload: await this.#readPiecePayload(dir, piece),
      });
    }
    return out;
  }

  async materializeMemory(sessionKey: string, memory: SessionRecord["memory"]): Promise<SessionRecord["memory"]> {
    const dir = await this.#sessionDir(sessionKey);
    return {
      ...memory,
      pieces: await Promise.all(memory.pieces.map(async (piece) => ({
        ...piece,
        payloadInline: piece.payloadInline !== undefined
          ? piece.payloadInline
          : piece.payloadRef
          ? await this.#readPiecePayload(dir, piece)
          : undefined,
      }))),
    };
  }

  async archiveSources(sessionKey: string, sources: RoundSource[]): Promise<void> {
    const dir = await this.#sessionDir(sessionKey);
    const archiveDir = `${dir}/archive`;
    await Deno.mkdir(archiveDir, { recursive: true });
    for (const source of sources) {
      const path = `${dir}/${await this.#archiveRefForSource(source.sourceId)}`;
      try {
        await Deno.stat(path);
        continue;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
      await atomicWriteText(path, `${JSON.stringify(source)}\n`);
    }
  }

  async getArchivedSources(sessionKey: string, sourceIds: string[]): Promise<ArchivedSource[]> {
    const dir = await this.#sessionDir(sessionKey);
    const out: ArchivedSource[] = [];
    for (const sourceId of sourceIds) {
      try {
        const path = `${dir}/${await this.#archiveRefForSource(sourceId)}`;
        const parsed = JSON.parse(await Deno.readTextFile(path));
        if (
          parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          typeof parsed.sourceId === "string" && parsed.sourceId === sourceId
        ) {
          out.push(parsed as ArchivedSource);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
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

  async #readPiecePayload(dir: string, piece: MemoryPiece): Promise<unknown> {
    if (piece.payloadInline !== undefined) {
      return piece.payloadInline;
    }
    if (!piece.payloadRef) {
      return null;
    }
    return JSON.parse(await Deno.readTextFile(`${dir}/${piece.payloadRef}`));
  }

  async #payloadRefForPiece(pieceId: string): Promise<string> {
    return `payloads/${await shortHash(pieceId, 16)}.json`;
  }

  async #archiveRefForSource(sourceId: string): Promise<string> {
    return `archive/${await shortHash(sourceId, 16)}.json`;
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

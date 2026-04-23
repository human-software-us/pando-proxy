import { expandHome } from "./config.ts";
import { shortHash } from "./hash.ts";
import { stableJson } from "./json.ts";
import {
  assertMemoryInvariant,
  emptySessionRecord,
  isRecord,
  type PieceRecord,
  type SessionRecord,
} from "./memory_state.ts";

export type ExactPiece = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  toolName?: string;
  taskIds: string[];
  pointer?: Record<string, unknown>;
  selector: PieceRecord["selector"];
  payload: unknown;
};

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
    const piecesDir = `${dir}/pieces`;
    await Deno.mkdir(piecesDir, { recursive: true });
    const state = structuredClone(record);
    const referencedRefs = new Set<string>();

    for (const piece of state.memory.pieces) {
      const payload = piece.payloadInline;
      if (payload === undefined) {
        if (piece.payloadRef) {
          referencedRefs.add(piece.payloadRef);
        }
        continue;
      }
      if (piece.byteSize <= this.#inlinePieceByteLimit) {
        piece.payloadRef = undefined;
        continue;
      }

      const ref = piece.payloadRef ?? `pieces/${encodeURIComponent(piece.id)}.json`;
      await atomicWriteText(`${dir}/${ref}`, `${stableJson(payload)}\n`);
      piece.payloadRef = ref;
      piece.payloadInline = undefined;
      referencedRefs.add(ref);
    }

    await atomicWriteText(`${dir}/state.json`, `${JSON.stringify(state, null, 2)}\n`);
    await this.#deleteUnreferencedPieceBlobs(piecesDir, referencedRefs);
  }

  async getExactPieces(sessionKey: string, pieceIds: string[]): Promise<ExactPiece[]> {
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
        ...(piece.toolName ? { toolName: piece.toolName } : {}),
        taskIds: [...piece.taskIds],
        ...(piece.pointer ? { pointer: piece.pointer } : {}),
        selector: piece.selector,
        payload: await this.#piecePayload(sessionKey, piece),
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

  async #piecePayload(sessionKey: string, piece: PieceRecord): Promise<unknown> {
    if (piece.payloadInline !== undefined) {
      return piece.payloadInline;
    }
    if (!piece.payloadRef) {
      return undefined;
    }
    const dir = await this.#sessionDir(sessionKey);
    return JSON.parse(await Deno.readTextFile(`${dir}/${piece.payloadRef}`));
  }

  async #deleteUnreferencedPieceBlobs(piecesDir: string, referencedRefs: Set<string>): Promise<void> {
    try {
      for await (const entry of Deno.readDir(piecesDir)) {
        if (!entry.isFile) {
          continue;
        }
        const ref = `pieces/${entry.name}`;
        if (!referencedRefs.has(ref)) {
          await Deno.remove(`${piecesDir}/${entry.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
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

import { expandHome } from "./config.ts";
import { materializeSelector } from "./chunking.ts";
import { shortHash } from "./hash.ts";
import {
  assertMemoryInvariant,
  emptySessionRecord,
  isRecord,
  type MaterializedMemoryPiece,
  type MaterializedMemoryState,
  pruneMemoryState,
  type SessionRecord,
} from "./memory_state.ts";
import { renderTextSelection, type TextSpanSelection } from "./source_selectors.ts";
import type { RoundSource } from "./tool_results.ts";

export type ArchivedSource = RoundSource;

export function materializeMemoryFromArchivedSources(
  memory: SessionRecord["memory"],
  archivedSourcesById: ReadonlyMap<string, ArchivedSource>,
): MaterializedMemoryState {
  return {
    ...memory,
    pieces: memory.pieces.flatMap((piece) => {
      const source = archivedSourcesById.get(piece.sourceId);
      if (!source) {
        return [];
      }
      const materialized = materializeSelector(source, piece.selector);
      if (!materialized) {
        return [];
      }
      return [
        {
          ...piece,
          renderText: renderMaterializedContent(materialized.content),
        } satisfies MaterializedMemoryPiece,
      ];
    }),
  };
}

export class SessionStore {
  #root: string;
  #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
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
    const memory = pruneMemoryState(structuredClone(record.memory));
    assertMemoryInvariant(memory);
    await atomicWriteText(`${dir}/state.json`, `${JSON.stringify({ memory }, null, 2)}\n`);
  }

  async materializeMemory(
    sessionKey: string,
    memory: SessionRecord["memory"],
  ): Promise<MaterializedMemoryState> {
    const bySourceId = await this.#archivedSourcesById(
      sessionKey,
      memory.pieces.map((piece) => piece.sourceId),
    );
    return materializeMemoryFromArchivedSources(memory, bySourceId);
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

  async #archivedSourcesById(
    sessionKey: string,
    sourceIds: string[],
  ): Promise<Map<string, ArchivedSource>> {
    const archived = await this.getArchivedSources(sessionKey, [...new Set(sourceIds)]);
    return new Map(archived.map((source) => [source.sourceId, source] as const));
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

function renderMaterializedContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (isTextSpanSelection(content)) {
    return renderTextSelection(content);
  }
  return JSON.stringify(content, null, 2);
}

function isTextSpanSelection(value: unknown): value is TextSpanSelection {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "text_spans";
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

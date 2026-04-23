import {
  type ChunkDraft,
  type ChunkRecord,
  dedupeChunks,
  normalizeObjective,
  type MemoryState,
  unique,
} from "./memory_state.ts";

export type WorkingMemoryUpdateRequest = {
  objective: string | null;
  chunks: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
  newChunks: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};

export type WorkingMemoryUpdateResponse = {
  objectiveAfter: string | null;
  keepOldChunkIds: string[];
  keepNewChunkIds: string[];
};

export type WorkingMemoryUpdateClient = (request: WorkingMemoryUpdateRequest) => Promise<unknown>;

export type AppliedRoundUpdate = {
  memory: MemoryState;
  response: WorkingMemoryUpdateResponse;
  keptOldChunkIds: string[];
  droppedOldChunkIds: string[];
  keptNewChunkIds: string[];
  droppedNewChunkIds: string[];
};

export async function applyRoundUpdate(
  state: MemoryState,
  newChunks: ChunkDraft[],
  client: WorkingMemoryUpdateClient,
): Promise<AppliedRoundUpdate> {
  if (newChunks.length === 0) {
    return {
      memory: state,
      response: {
        objectiveAfter: state.objective,
        keepOldChunkIds: state.chunks.map((chunk) => chunk.id),
        keepNewChunkIds: [],
      },
      keptOldChunkIds: state.chunks.map((chunk) => chunk.id),
      droppedOldChunkIds: [],
      keptNewChunkIds: [],
      droppedNewChunkIds: [],
    };
  }

  const request: WorkingMemoryUpdateRequest = {
    objective: state.objective,
    chunks: state.chunks.map((chunk) => ({
      id: chunk.id,
      sourceKind: chunk.sourceKind,
      ...(chunk.toolName ? { toolName: chunk.toolName } : {}),
      content: chunk.payload,
      ...(chunk.pointer ? { pointer: chunk.pointer } : {}),
    })),
    newChunks: newChunks.map((chunk) => ({
      id: chunk.id,
      sourceKind: chunk.sourceKind,
      ...(chunk.toolName ? { toolName: chunk.toolName } : {}),
      content: chunk.payload,
      ...(chunk.pointer ? { pointer: chunk.pointer } : {}),
    })),
  };

  let parsed:
    | { ok: true; response: WorkingMemoryUpdateResponse }
    | { ok: false; errors: string[] }
    | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await client(request);
    parsed = parseAndValidateRoundUpdate(value, state, newChunks);
    if (parsed.ok) {
      break;
    }
  }

  if (!parsed || !parsed.ok) {
    const fallback = buildFallbackRoundUpdate(state, newChunks);
    if (fallback) {
      parsed = { ok: true, response: fallback };
    } else {
      throw new Error(`working_memory_update validation failed: ${(parsed?.errors ?? []).join("; ")}`);
    }
  }

  const nextSeq = state.roundSeq + 1;
  const keptOldSet = new Set(parsed.response.keepOldChunkIds);
  const keptNewSet = new Set(parsed.response.keepNewChunkIds);
  const keptOldChunks = state.chunks.filter((chunk) => keptOldSet.has(chunk.id));
  const keptNewChunks: ChunkRecord[] = newChunks
    .filter((chunk) => keptNewSet.has(chunk.id))
    .map((chunk) => ({
      ...chunk,
      createdSeq: nextSeq,
    }));

  const objectiveAfter = normalizeObjective(parsed.response.objectiveAfter);
  const combinedKeptChunks = pruneRedundantUserChunks(dedupeChunks([...keptOldChunks, ...keptNewChunks]));
  const memory = {
    roundSeq: nextSeq,
    objective: objectiveAfter,
    chunks: objectiveAfter ? combinedKeptChunks : [],
    processedSourceIds: unique([
      ...state.processedSourceIds,
      ...newChunks.map((chunk) => chunk.sourceId),
    ]),
  } satisfies MemoryState;

  return {
    memory,
    response: {
      ...parsed.response,
      objectiveAfter,
    },
    keptOldChunkIds: [...keptOldSet],
    droppedOldChunkIds: state.chunks.map((chunk) => chunk.id).filter((id) => !keptOldSet.has(id)),
    keptNewChunkIds: [...keptNewSet],
    droppedNewChunkIds: newChunks.map((chunk) => chunk.id).filter((id) => !keptNewSet.has(id)),
  };
}

export function parseAndValidateRoundUpdate(
  value: unknown,
  previous: MemoryState,
  newChunks: ChunkDraft[],
): { ok: true; response: WorkingMemoryUpdateResponse } | { ok: false; errors: string[] } {
  const response = coerceWorkingMemoryUpdate(value);
  if (!response) {
    return { ok: false, errors: ["working_memory_update response must be an object"] };
  }
  const errors = validateRoundUpdate(response, previous, newChunks);
  return errors.length === 0 ? { ok: true, response } : { ok: false, errors };
}

export function validateRoundUpdate(
  response: WorkingMemoryUpdateResponse,
  previous: MemoryState,
  newChunks: ChunkDraft[],
): string[] {
  const errors: string[] = [];
  const previousIds = previous.chunks.map((chunk) => chunk.id);
  const newIds = newChunks.map((chunk) => chunk.id);
  const previousIdSet = new Set(previousIds);
  const newIdSet = new Set(newIds);
  const signals = detectRoundIntentSignals(newChunks);

  validateChunkIdList("keepOldChunkIds", response.keepOldChunkIds, previousIdSet, errors);
  validateChunkIdList("keepNewChunkIds", response.keepNewChunkIds, newIdSet, errors);

  for (const chunk of newChunks) {
    if (previous.processedSourceIds.includes(chunk.sourceId)) {
      errors.push(`Source ${chunk.sourceId} was already processed`);
    }
  }

  const objectiveAfter = normalizeObjective(response.objectiveAfter);
  const keptCount = response.keepOldChunkIds.length + response.keepNewChunkIds.length;
  validateObjectiveAbstraction(objectiveAfter, errors);

  if (signals.explicitCarryForward && !objectiveAfter) {
    errors.push("Explicit future-recall cues require a live objective");
  }
  if (signals.explicitCarryForward && keptCount === 0) {
    errors.push("Explicit future-recall cues require at least one kept chunk");
  }
  if (signals.explicitClose && objectiveAfter) {
    errors.push("Explicit close cues require clearing the objective");
  }
  if (signals.explicitClose && keptCount > 0) {
    errors.push("Explicit close cues require dropping all kept chunks");
  }
  if (previous.objective && !signals.explicitClose && !objectiveAfter) {
    errors.push("Existing live objective requires an explicit close cue before clearing memory");
  }
  if (!objectiveAfter && keptCount > 0) {
    errors.push("Cleared objective cannot keep chunks");
  }

  const keptChunks = [
    ...previous.chunks.filter((chunk) => response.keepOldChunkIds.includes(chunk.id)),
    ...newChunks.filter((chunk) => response.keepNewChunkIds.includes(chunk.id)),
  ];
  const keptFactRecords = keptChunks.flatMap((chunk) => extractConcreteFactRecords(textFromPayload(chunk.payload)));
  const keptFacts = new Set(keptFactRecords.map((fact) => fact.fact));
  const keptFactKeys = new Set(keptFactRecords.map((fact) => fact.key));

  for (const chunk of previous.chunks) {
    if (response.keepOldChunkIds.includes(chunk.id)) {
      validateRetainedChunk(chunk, errors);
    } else if (objectiveAfter) {
      validateDroppedKeptFactChunk(chunk, keptFacts, keptFactKeys, errors);
    }
  }
  for (const chunk of newChunks) {
    if (response.keepNewChunkIds.includes(chunk.id)) {
      validateRetainedChunk(chunk, errors);
    } else if (objectiveAfter) {
      validateDroppedUserFactChunk(chunk, keptFacts, errors);
    }
  }

  return errors;
}

function validateChunkIdList(
  field: string,
  ids: string[],
  validIds: Set<string>,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!validIds.has(id)) {
      errors.push(`${field} references unknown chunk ${id}`);
    }
    if (seen.has(id)) {
      errors.push(`${field} references duplicate chunk ${id}`);
    }
    seen.add(id);
  }
}

function coerceWorkingMemoryUpdate(value: unknown): WorkingMemoryUpdateResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    objectiveAfter: typeof record.objectiveAfter === "string" || record.objectiveAfter === null
      ? normalizeObjective(record.objectiveAfter as string | null)
      : null,
    keepOldChunkIds: Array.isArray(record.keepOldChunkIds) ? record.keepOldChunkIds.map(String) : [],
    keepNewChunkIds: Array.isArray(record.keepNewChunkIds) ? record.keepNewChunkIds.map(String) : [],
  };
}

type RoundIntentSignals = {
  explicitCarryForward: boolean;
  explicitClose: boolean;
};

function buildFallbackRoundUpdate(
  previous: MemoryState,
  newChunks: ChunkDraft[],
): WorkingMemoryUpdateResponse | null {
  const signals = detectRoundIntentSignals(newChunks);
  if (signals.explicitClose) {
    return {
      objectiveAfter: null,
      keepOldChunkIds: [],
      keepNewChunkIds: [],
    };
  }

  const objectiveAfter = previous.objective ?? deriveFallbackObjective(newChunks);
  if (!objectiveAfter) {
    return null;
  }

  return {
    objectiveAfter,
    keepOldChunkIds: previous.chunks.map((chunk) => chunk.id),
    keepNewChunkIds: newChunks.map((chunk) => chunk.id),
  };
}

function deriveFallbackObjective(newChunks: ChunkDraft[]): string | null {
  const signals = detectRoundIntentSignals(newChunks);
  if (signals.explicitCarryForward) {
    return "Preserve the exact evidence needed for later recall.";
  }
  if (newChunks.some((chunk) => chunk.sourceKind === "tool")) {
    return "Continue the current work using the retained exact evidence.";
  }
  if (newChunks.some((chunk) => chunk.sourceKind === "user")) {
    return "Continue the current user request.";
  }
  return null;
}

function validateObjectiveAbstraction(objective: string | null, errors: string[]): void {
  if (!objective) {
    return;
  }
  if (objective.length > 160) {
    errors.push("objectiveAfter must stay compact");
  }
  if (objective.includes("\n")) {
    errors.push("objectiveAfter must be a single line");
  }
  if (/[`'"]/.test(objective)) {
    errors.push("objectiveAfter must not quote exact content");
  }
  if (/\b[A-Za-z_][A-Za-z0-9_]*=/.test(objective)) {
    errors.push("objectiveAfter must not embed exact key/value content");
  }
  if (/\b(?:printf|echo|cat|grep|rg|ls|find|curl|deno|node|python|bash|zsh|exec_command)\b/i.test(objective)) {
    errors.push("objectiveAfter must not restate tool commands");
  }
}

function validateRetainedChunk(
  chunk: { sourceKind: "user" | "assistant" | "tool"; payload: unknown },
  errors: string[],
): void {
  if (chunk.sourceKind !== "user") {
    return;
  }
  const text = textFromPayload(chunk.payload).trim();
  if (!text) {
    return;
  }
  if (isOperationalUserQuery(text) && !containsDurableFact(text)) {
    errors.push("Operational user query chunks should not be retained as memory");
  }
}

function validateDroppedUserFactChunk(
  chunk: { sourceKind: "user" | "assistant" | "tool"; payload: unknown },
  keptFacts: Set<string>,
  errors: string[],
): void {
  if (chunk.sourceKind !== "user") {
    return;
  }
  const facts = extractConcreteFacts(textFromPayload(chunk.payload));
  if (facts.length === 0) {
    return;
  }
  if (facts.some((fact) => !keptFacts.has(fact))) {
    errors.push("Dropping a user fact chunk would lose exact facts not preserved elsewhere");
  }
}

function validateDroppedKeptFactChunk(
  chunk: { sourceKind: "user" | "assistant" | "tool"; payload: unknown },
  keptFacts: Set<string>,
  keptFactKeys: Set<string>,
  errors: string[],
): void {
  const facts = extractConcreteFactRecords(textFromPayload(chunk.payload));
  if (facts.length === 0) {
    return;
  }
  if (facts.some((fact) => !keptFacts.has(fact.fact) && !keptFactKeys.has(fact.key))) {
    errors.push("Dropping a retained fact chunk would lose exact facts without preservation or replacement");
  }
}

function pruneRedundantUserChunks(chunks: ChunkRecord[]): ChunkRecord[] {
  return chunks.filter((chunk, index) => {
    if (chunk.sourceKind !== "user") {
      return true;
    }
    const text = textFromPayload(chunk.payload).trim();
    if (!text) {
      return false;
    }
    const facts = extractConcreteFactRecords(text);
    const otherFacts = new Set(
      chunks
        .filter((_, otherIndex) => otherIndex !== index)
        .flatMap((otherChunk) => extractConcreteFactRecords(textFromPayload(otherChunk.payload)))
        .map((fact) => fact.fact),
    );
    const factsPreservedElsewhere = facts.every((fact) => otherFacts.has(fact.fact));

    if (isOperationalUserQuery(text) && (facts.length === 0 || factsPreservedElsewhere)) {
      return false;
    }
    if (looksLikeUserScaffolding(text) && facts.length > 0 && factsPreservedElsewhere) {
      return false;
    }
    return true;
  });
}

function detectRoundIntentSignals(newChunks: ChunkDraft[]): RoundIntentSignals {
  const texts = newChunks
    .filter((chunk) => chunk.sourceKind === "user")
    .map((chunk) => textFromPayload(chunk.payload))
    .filter((text) => text.length > 0)
    .map((text) => text.toLowerCase());

  return {
    explicitCarryForward: texts.some((text) => EXPLICIT_CARRY_FORWARD_PATTERNS.some((pattern) => pattern.test(text))),
    explicitClose: texts.some((text) => EXPLICIT_CLOSE_PATTERNS.some((pattern) => pattern.test(text))),
  };
}

function textFromPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (!entry || typeof entry !== "object") {
      return "";
    }
    const contentEntry = entry as Record<string, unknown>;
    if (typeof contentEntry.text === "string") {
      return contentEntry.text;
    }
    if (typeof contentEntry.input_text === "string") {
      return contentEntry.input_text;
    }
    return "";
  }).join("\n");
}

function isOperationalUserQuery(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("?")) {
    return true;
  }
  return /^(?:what|which|who|where|when|why|how|tell|remind|show|give|list|restate|repeat|print|reply|say|return|summarize|explain|can you|could you|would you|please)\b/i
    .test(normalized);
}

function looksLikeUserScaffolding(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\b(?:use|run|print|reply exactly|remember exactly|remember this|store this|without running any tool|call memory)\b/i
    .test(normalized);
}

function containsDurableFact(text: string): boolean {
  if (extractConcreteFacts(text).length > 0) {
    return true;
  }
  if (/\b(?:remember|keep|preserve)\b.*\b(?:for later|for future|for recall|exactly this)\b/i.test(text)) {
    return true;
  }
  return false;
}

function extractConcreteFacts(text: string): string[] {
  return extractConcreteFactRecords(text).map((fact) => fact.fact);
}

function extractConcreteFactRecords(text: string): Array<{ key: string; fact: string }> {
  const matches = [...text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s,.;]+)/g)];
  return matches
    .map((match) => ({ key: match[1], fact: `${match[1]}=${match[2]}` }))
    .filter((record) => {
      const value = record.fact.split("=")[1] ?? "";
      return /[A-Za-z0-9]/.test(value) && value !== "...";
    });
}

const EXPLICIT_CARRY_FORWARD_PATTERNS = [
  /\bwe(?:'ll| will)\b.*\bneed\b.*\b(later|again|next turn|future)\b/i,
  /\bneed\b.*\b(exact|word for word)\b.*\b(later|again|next turn|future)\b/i,
  /\bremember\b.*\b(later|future|next turn|next round)\b/i,
  /\bkeep\b.*\b(available|for recall|for later|for future)\b/i,
  /\brecall\b.*\b(exact|later|future)\b/i,
  /\bword for word\b.*\b(later|again|future)?/i,
];

const EXPLICIT_CLOSE_PATTERNS = [
  /\bforget all of (?:that|this|it|these(?:\s+\w+)*)\b/i,
  /\bforget (?:everything|those|this|that|it)\b/i,
  /\byou can forget\b/i,
  /\bwe(?:'re| are) done(?: with this task)?\b/i,
  /\bwe(?:'re| are) done with this task\b/i,
  /\bdone with this task\b/i,
  /\btask (?:is )?(?:fully )?done\b/i,
  /\btask complete\b/i,
  /\bsession done\b/i,
  /\bend this task\b/i,
  /\bno longer need\b/i,
  /\bclear (?:that|this|it)\b/i,
  /\bclear (?:all )?(?:retained )?memory\b/i,
  /\bdrop (?:all )?(?:retained )?memory\b/i,
  /\bdrop all retained memory\b/i,
  /\bdelete (?:all )?(?:retained )?memory\b/i,
  /\bremove (?:all )?(?:retained )?memory\b/i,
  /\bend (?:this )?session\b/i,
  /\bclose (?:this )?session\b/i,
  /\btask is over\b/i,
];

#!/usr/bin/env -S deno run --allow-read --allow-env

import { SessionStore } from "../src/store.ts";

type CheckResult = {
  candidate: string;
  matched: boolean;
  matchingSourceIds: string[];
};

type ParsedArgs = {
  stateDir: string;
  sessionKey: string;
  texts: string[];
  json?: string;
  fields: string[];
  includeAssistant: boolean;
};

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const texts = [
    ...args.texts,
    ...extractJsonFieldTexts(args.json, args.fields),
  ];
  if (texts.length === 0) {
    throw new Error("Provide at least one --text or --json with --field.");
  }

  const store = new SessionStore(args.stateDir);
  const results = await checkTextsAgainstArchivedSources(
    store,
    args.sessionKey,
    texts,
    args.includeAssistant,
  );
  const ok = results.every((result) => result.matched);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) {
    Deno.exit(1);
  }
}

export async function checkTextsAgainstArchivedSources(
  store: SessionStore,
  sessionKey: string,
  texts: string[],
  includeAssistant = false,
): Promise<CheckResult[]> {
  const record = await store.load(sessionKey);
  const archivedSources = await store.getArchivedSources(
    sessionKey,
    record.memory.processedSourceIds,
  );
  const searchableSources = archivedSources.filter((source) =>
    includeAssistant || source.sourceKind !== "assistant"
  );
  return texts.map((candidate) => {
    const matchingSourceIds = searchableSources
      .filter((source) => sourceContainsText(source.payload, candidate))
      .map((source) => source.sourceId);
    return {
      candidate,
      matched: matchingSourceIds.length > 0,
      matchingSourceIds,
    };
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const texts: string[] = [];
  const fields: string[] = [];
  let stateDir = "";
  let sessionKey = "";
  let json: string | undefined;
  let includeAssistant = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--state-dir" && next) {
      stateDir = next;
      index += 1;
      continue;
    }
    if (arg === "--session" && next) {
      sessionKey = next;
      index += 1;
      continue;
    }
    if (arg === "--text" && next) {
      texts.push(next);
      index += 1;
      continue;
    }
    if (arg === "--json" && next) {
      json = next;
      index += 1;
      continue;
    }
    if (arg === "--field" && next) {
      fields.push(next);
      index += 1;
      continue;
    }
    if (arg === "--include-assistant") {
      includeAssistant = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!stateDir) {
    throw new Error("Missing --state-dir");
  }
  if (!sessionKey) {
    throw new Error("Missing --session");
  }

  return { stateDir, sessionKey, texts, json, fields, includeAssistant };
}

function extractJsonFieldTexts(json: string | undefined, fields: string[]): string[] {
  if (!json) {
    return [];
  }
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return fields.flatMap((field) => {
    const value = parsed[field];
    return typeof value === "string" ? [value] : [];
  });
}

function sourceContainsText(payload: unknown, candidate: string): boolean {
  if (!candidate) {
    return false;
  }
  for (const text of collectLeafStrings(payload)) {
    if (text.includes(candidate)) {
      return true;
    }
  }
  try {
    return JSON.stringify(payload).includes(candidate);
  } catch {
    return false;
  }
}

function collectLeafStrings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      out.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) {
        visit(entry);
      }
      return;
    }
    if (current && typeof current === "object") {
      for (const entry of Object.values(current as Record<string, unknown>)) {
        visit(entry);
      }
    }
  };
  visit(value);
  return out;
}

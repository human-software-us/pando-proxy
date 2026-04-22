import { shortHash } from "./hash.ts";
import { isRecord } from "./memory_state.ts";

export function authHeaderFor(request: Request, apiKey: string | null): string | null {
  return request.headers.get("authorization") ?? (apiKey ? `Bearer ${apiKey}` : null);
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (!isRecord(value)) {
    throw new Error("Expected JSON object request body");
  }
  return value;
}

export async function sessionKeyFor(
  request: Request,
  body: Record<string, unknown>,
): Promise<string> {
  for (
    const header of [
      "x-pando-session-id",
      "x-codex-session-id",
      "x-openai-conversation-id",
      "openai-conversation-id",
    ]
  ) {
    const value = request.headers.get(header);
    if (value) {
      return value;
    }
  }

  for (const key of ["conversation_id", "session_id", "conversation", "prompt_cache_key"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const metadata = body.metadata;
  if (isRecord(metadata)) {
    for (const key of ["session_id", "conversation_id", "cwd"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }

  return `default_${await shortHash(JSON.stringify({
    model: body.model,
    prompt_cache_key: body.prompt_cache_key,
  }))}`;
}

export function requestModel(body: Record<string, unknown>): string | null {
  return typeof body.model === "string" ? body.model : null;
}

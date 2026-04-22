export type ProxyLogger = {
  log(event: string, fields?: Record<string, unknown>): Promise<void>;
};

export function createLogger(path: string | null): ProxyLogger {
  if (!path) {
    return { log: async () => {} };
  }
  return new JsonlLogger(path);
}

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = key.toLowerCase() === "authorization" ? "[redacted]" : value;
  }
  return out;
}

export function loggableBody(body: unknown): unknown {
  return redactCredentialFields(body);
}

class JsonlLogger implements ProxyLogger {
  #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async log(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...(redactCredentialFields(fields) as Record<string, unknown>),
    });
    await Deno.mkdir(dirname(this.#path), { recursive: true });
    await Deno.writeTextFile(this.#path, `${line}\n`, { append: true, create: true });
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCredentialFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isCredentialField(key) ? "[redacted]" : redactCredentialFields(child);
  }
  return out;
}

function isCredentialField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "access_token" ||
    lower === "refresh_token" ||
    lower === "id_token" ||
    lower === "api_key" ||
    lower === "openai_api_key" ||
    lower === "x-api-key";
}

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
  return redactSecrets(body);
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
      ...(redactSecrets(fields) as Record<string, unknown>),
    });
    await Deno.writeTextFile(this.#path, `${line}\n`, { append: true, create: true });
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redactSecrets(child);
  }
  return out;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "authorization" ||
    lower === "access_token" ||
    lower === "refresh_token" ||
    lower === "id_token" ||
    lower.includes("api_key") ||
    lower.includes("token");
}

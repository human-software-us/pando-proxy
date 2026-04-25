export type ProxyConfig = {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  apiKey: string | null;
  smallStructuredModel: string;
  overflowStructuredModel: string;
  smallStructuredContextWindow: number;
  overflowStructuredContextWindow: number;
  modelTimeoutMs: number;
  stateDir: string;
  memoryEnabled: boolean;
  logFile: string | null;
  codexAutoCompactTokenLimit: number;
};

export type CliOptions = {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  smallStructuredModel?: string;
  overflowStructuredModel?: string;
  stateDir?: string;
  memoryEnabled?: boolean;
  logFile?: string | null;
  codexAutoCompactTokenLimit?: number;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const AUTO_UPSTREAM_BASE_URL = "auto";
export const OPENAI_API_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
export const CHATGPT_CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_UPSTREAM_BASE_URL = AUTO_UPSTREAM_BASE_URL;
export const DEFAULT_SMALL_STRUCTURED_MODEL = "gpt-5.4-mini";
export const DEFAULT_OVERFLOW_STRUCTURED_MODEL = "gpt-5.4";
export const DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW = 272_000;
export const DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT = 280_000;

export function loadConfig(options: CliOptions = {}): ProxyConfig {
  return {
    host: options.host ?? Deno.env.get("PANDO_PROXY_HOST") ?? DEFAULT_HOST,
    port: options.port ?? parsePort(Deno.env.get("PANDO_PROXY_PORT")) ?? DEFAULT_PORT,
    upstreamBaseUrl: trimTrailingSlash(
      options.upstreamBaseUrl ??
        Deno.env.get("PANDO_PROXY_UPSTREAM_BASE_URL") ??
        DEFAULT_UPSTREAM_BASE_URL,
    ),
    apiKey: Deno.env.get("OPENAI_API_KEY") ?? null,
    smallStructuredModel: options.smallStructuredModel ??
      Deno.env.get("PANDO_PROXY_SMALL_STRUCTURED_MODEL") ??
      Deno.env.get("PANDO_PROXY_MAINTENANCE_MODEL") ??
      DEFAULT_SMALL_STRUCTURED_MODEL,
    overflowStructuredModel: options.overflowStructuredModel ??
      Deno.env.get("PANDO_PROXY_OVERFLOW_STRUCTURED_MODEL") ??
      DEFAULT_OVERFLOW_STRUCTURED_MODEL,
    smallStructuredContextWindow: parsePositiveInt(
      Deno.env.get("PANDO_PROXY_SMALL_STRUCTURED_CONTEXT_WINDOW"),
      DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
    ),
    overflowStructuredContextWindow: parsePositiveInt(
      Deno.env.get("PANDO_PROXY_OVERFLOW_STRUCTURED_CONTEXT_WINDOW"),
      DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
    ),
    modelTimeoutMs: parsePositiveInt(
      Deno.env.get("PANDO_PROXY_MODEL_TIMEOUT_MS") ??
        Deno.env.get("PANDO_PROXY_MAINTENANCE_TIMEOUT_MS"),
      DEFAULT_MODEL_TIMEOUT_MS,
    ),
    stateDir: expandHome(
      options.stateDir ?? Deno.env.get("PANDO_PROXY_STATE_DIR") ?? "~/.pando-proxy",
    ),
    memoryEnabled: options.memoryEnabled ??
      !parseBoolean(Deno.env.get("PANDO_PROXY_DISABLE_MEMORY")),
    logFile: options.logFile ?? Deno.env.get("PANDO_PROXY_LOG_FILE") ?? null,
    codexAutoCompactTokenLimit: parsePositiveInt(
      options.codexAutoCompactTokenLimit !== undefined
        ? String(options.codexAutoCompactTokenLimit)
        : Deno.env.get("PANDO_PROXY_CODEX_AUTO_COMPACT_TOKEN_LIMIT"),
      DEFAULT_CODEX_AUTO_COMPACT_TOKEN_LIMIT,
    ),
  };
}

export function parseCliOptions(args: string[]): { command: string | null; options: CliOptions } {
  const options: CliOptions = {};
  let command: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") && command === null) {
      command = arg;
      continue;
    }

    if (arg === "--host") {
      options.host = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--port") {
      options.port = parseRequiredPort(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--upstream-base-url") {
      options.upstreamBaseUrl = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--small-structured-model" || arg === "--maintenance-model") {
      options.smallStructuredModel = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--overflow-structured-model") {
      options.overflowStructuredModel = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--state-dir") {
      options.stateDir = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--no-memory") {
      options.memoryEnabled = false;
      continue;
    }
    if (arg === "--log-file") {
      options.logFile = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--codex-auto-compact-token-limit") {
      options.codexAutoCompactTokenLimit = parseRequiredPositiveInt(
        requireValue(args, ++index, arg),
        arg,
      );
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      command = "help";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, options };
}

export function expandHome(path: string): string {
  if (path === "~") {
    return Deno.env.get("HOME") ?? path;
  }
  if (path.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    return home ? `${home}/${path.slice(2)}` : path;
  }
  return path;
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function responsesUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/responses`;
}

export function modelsUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/models`;
}

export function resolveUpstreamBaseUrl(baseUrl: string, authHeader: string | null): string {
  if (baseUrl !== AUTO_UPSTREAM_BASE_URL) {
    return trimTrailingSlash(baseUrl);
  }
  return isLikelyOpenAiApiKey(authHeader)
    ? OPENAI_API_UPSTREAM_BASE_URL
    : CHATGPT_CODEX_UPSTREAM_BASE_URL;
}

export function isLikelyOpenAiApiKey(authHeader: string | null): boolean {
  if (!authHeader) {
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token.startsWith("sk-");
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return parseRequiredPort(value);
}

function parseRequiredPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parsePositiveInt(value: string | undefined | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRequiredPositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

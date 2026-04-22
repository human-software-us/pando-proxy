export type ProxyConfig = {
  host: string;
  port: number;
  upstreamBaseUrl: string;
  apiKey: string | null;
  maintenanceModel: string | null;
  stateDir: string;
  syntheticCharBudget: number;
  maintenanceTimeoutMs: number;
  memoryEnabled: boolean;
  logFile: string | null;
};

export type CliOptions = {
  host?: string;
  port?: number;
  upstreamBaseUrl?: string;
  maintenanceModel?: string;
  stateDir?: string;
  memoryEnabled?: boolean;
  logFile?: string | null;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const AUTO_UPSTREAM_BASE_URL = "auto";
export const OPENAI_API_UPSTREAM_BASE_URL = "https://api.openai.com/v1";
export const CHATGPT_CODEX_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_UPSTREAM_BASE_URL = AUTO_UPSTREAM_BASE_URL;
export const DEFAULT_SYNTHETIC_CHAR_BUDGET = 12_000;
export const DEFAULT_MAINTENANCE_TIMEOUT_MS = 60_000;

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
    maintenanceModel: options.maintenanceModel ??
      Deno.env.get("PANDO_PROXY_MAINTENANCE_MODEL") ??
      null,
    stateDir: expandHome(
      options.stateDir ?? Deno.env.get("PANDO_PROXY_STATE_DIR") ?? "~/.pando-proxy",
    ),
    syntheticCharBudget: parsePositiveInt(
      Deno.env.get("PANDO_PROXY_SYNTHETIC_CHAR_BUDGET"),
      DEFAULT_SYNTHETIC_CHAR_BUDGET,
    ),
    maintenanceTimeoutMs: parsePositiveInt(
      Deno.env.get("PANDO_PROXY_MAINTENANCE_TIMEOUT_MS"),
      DEFAULT_MAINTENANCE_TIMEOUT_MS,
    ),
    memoryEnabled: options.memoryEnabled ??
      !parseBoolean(Deno.env.get("PANDO_PROXY_DISABLE_MEMORY")),
    logFile: options.logFile ?? Deno.env.get("PANDO_PROXY_LOG_FILE") ?? null,
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
    if (arg === "--maintenance-model") {
      options.maintenanceModel = requireValue(args, ++index, arg);
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

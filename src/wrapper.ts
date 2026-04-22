import { CliOptions, expandHome, loadConfig, ProxyConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startServer } from "./server.ts";

export const DEFAULT_WRAPPER_PORT_START = 40123;
export const PANDO_PROVIDER_ID = "pando-proxy";

export type WrapperOptions = CliOptions & {
  portStart?: number;
  logEnabled?: boolean;
};

export type ParsedWrapperArgs = {
  codexArgs: string[];
  options: WrapperOptions;
  help: boolean;
};

export type StartedProxy = {
  config: ProxyConfig;
  server: Deno.HttpServer;
};

export function parseWrapperArgs(args: string[]): ParsedWrapperArgs {
  const options: WrapperOptions = {};
  const codexArgs: string[] = [];
  let help = false;
  let passthrough = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (passthrough) {
      codexArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      codexArgs.push(...args.slice(index + 1));
      break;
    }
    if (arg === "--proxy-help" || arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--proxy-host") {
      options.host = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-port-start") {
      options.portStart = parsePort(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--proxy-upstream-base-url") {
      options.upstreamBaseUrl = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-maintenance-model") {
      options.maintenanceModel = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-state-dir") {
      options.stateDir = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-no-memory") {
      options.memoryEnabled = false;
      continue;
    }
    if (arg === "--proxy-log") {
      options.logEnabled = true;
      continue;
    }
    if (arg === "--proxy-log-file") {
      options.logFile = requireValue(args, ++index, arg);
      options.logEnabled = true;
      continue;
    }

    passthrough = true;
    codexArgs.push(arg);
  }

  return { codexArgs, options, help };
}

export async function runCodexWrapper(args: string[]): Promise<number> {
  const parsed = parseWrapperArgs(args);
  if (parsed.help) {
    printWrapperHelp();
    return 0;
  }

  const baseConfig = loadConfig(parsed.options);
  const logFile = await resolveWrapperLogFile(parsed.options, baseConfig.stateDir);
  const portStart = parsed.options.portStart ?? DEFAULT_WRAPPER_PORT_START;
  const started = startProxyOnAvailablePort({ ...baseConfig, logFile }, portStart);
  const codexArgs = buildCodexArgs(parsed.codexArgs, started.config);
  const logger = createLogger(logFile);

  if (logFile) {
    console.error(`Pando Proxy log: ${logFile}`);
  }
  console.error(`Pando Proxy URL: http://${started.config.host}:${started.config.port}/v1`);

  await logger.log("wrapper_start", {
    proxyUrl: `http://${started.config.host}:${started.config.port}/v1`,
    codexArgs,
    memoryEnabled: started.config.memoryEnabled,
  });

  try {
    const command = new Deno.Command("codex", {
      args: codexArgs,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const child = command.spawn();
    const status = await child.status;
    await logger.log("wrapper_exit", {
      success: status.success,
      code: status.code,
      signal: status.signal,
    });
    return status.code;
  } catch (error) {
    await logger.log("wrapper_error", { message: messageFor(error) });
    if (error instanceof Deno.errors.NotFound) {
      console.error("codex was not found on PATH.");
      return 127;
    }
    throw error;
  } finally {
    await started.server.shutdown();
  }
}

export function startProxyOnAvailablePort(
  baseConfig: ProxyConfig,
  portStart = DEFAULT_WRAPPER_PORT_START,
): StartedProxy {
  for (let port = portStart; port <= 65_535; port += 1) {
    const config = { ...baseConfig, port };
    try {
      return { config, server: startServer(config) };
    } catch (error) {
      if (isAddressInUse(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No available port found at or above ${portStart}`);
}

export async function resolveWrapperLogFile(
  options: Pick<WrapperOptions, "logEnabled" | "logFile">,
  stateDir: string,
): Promise<string | null> {
  if (options.logFile) {
    return options.logFile;
  }
  if (options.logEnabled) {
    return await createUniqueLogFile(stateDir);
  }
  return null;
}

export function buildCodexArgs(codexArgs: string[], config: ProxyConfig): string[] {
  return [
    "-c",
    `model_provider="${PANDO_PROVIDER_ID}"`,
    "-c",
    codexProviderConfigArg(config),
    ...codexArgs,
  ];
}

export function codexProviderConfigArg(config: Pick<ProxyConfig, "host" | "port">): string {
  return [
    `model_providers.${PANDO_PROVIDER_ID}={`,
    'name = "Pando Memory Proxy",',
    `base_url = "http://${config.host}:${config.port}/v1",`,
    'wire_api = "responses",',
    "requires_openai_auth = true",
    "}",
  ].join(" ");
}

export async function createUniqueLogFile(stateDir: string): Promise<string> {
  const directory = expandHome(`${stateDir}/logs`);
  await Deno.mkdir(directory, { recursive: true });

  for (let attempts = 0; attempts < 10; attempts += 1) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${directory}/pando-proxy-${timestamp}-${crypto.randomUUID()}.jsonl`;
    try {
      await Deno.writeTextFile(path, "", { createNew: true });
      return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        throw error;
      }
    }
  }

  throw new Error("Could not create a unique pando-proxy log file");
}

export function printWrapperHelp(): void {
  console.log(`pando-proxy

Usage:
  pando-proxy [proxy options] [codex args...]
  pando-proxy serve [serve options]
  pando-proxy doctor

Default mode starts a per-instance proxy, then runs codex with provider overrides
pointing at that proxy.

Proxy wrapper options:
  --proxy-host <host>                Default: 127.0.0.1
  --proxy-port-start <port>          Default: ${DEFAULT_WRAPPER_PORT_START}
  --proxy-upstream-base-url <url>    Default: auto
  --proxy-maintenance-model <model>  Default: incoming request model
  --proxy-state-dir <path>           Default: ~/.pando-proxy
  --proxy-no-memory                  Bypass memory maintenance/injection
  --proxy-log                        Enable full JSONL logging to ~/.pando-proxy/logs
  --proxy-log-file <path>            Enable full JSONL logging to this file
  --proxy-help, --help, -h           Show this help

Everything after -- is passed to codex unchanged.
`);
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse ||
    (error instanceof Error && /address already in use|addrinuse/i.test(error.message));
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

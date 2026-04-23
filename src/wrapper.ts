import { CodexEventObserver } from "./codex_events.ts";
import {
  buildRemoteCodexArgs,
  classifyCodexRunMode,
  ensureExecJsonArg,
  hasCodexRemoteArg,
} from "./codex_modes.ts";
import { CliOptions, expandHome, loadConfig, ProxyConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startServer } from "./server.ts";
import { startWebSocketRelayOnAvailablePort } from "./websocket_relay.ts";

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

type StartedCodexAppServer = {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
  url: string;
  port: number;
  isExited: () => boolean;
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
  const logger = createLogger(logFile);
  const observer = new CodexEventObserver(logger);
  const mode = classifyCodexRunMode(parsed.codexArgs);

  if (logFile) {
    console.error(`Pando Proxy log: ${logFile}`);
  }
  console.error(`Pando Proxy URL: http://${started.config.host}:${started.config.port}/v1`);

  await logger.log("wrapper_start", {
    proxyUrl: `http://${started.config.host}:${started.config.port}/v1`,
    requestedCodexArgs: parsed.codexArgs,
    mode,
    memoryEnabled: started.config.memoryEnabled,
  });

  try {
    if (mode === "exec-json") {
      return await runCodexExecJson(parsed.codexArgs, started.config, logger, observer);
    }
    if (mode === "interactive-remote") {
      return await runCodexInteractiveRemote(
        parsed.codexArgs,
        started.config,
        logger,
        observer,
        portStart,
      );
    }

    return await runCodexPassthrough(parsed.codexArgs, started.config, logger);
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

async function runCodexPassthrough(
  codexArgs: string[],
  config: ProxyConfig,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  return await runCodexForeground({
    args: buildCodexArgs(codexArgs, config),
    mode: "passthrough",
    logger,
  });
}

async function runCodexExecJson(
  codexArgs: string[],
  config: ProxyConfig,
  logger: ReturnType<typeof createLogger>,
  observer: CodexEventObserver,
): Promise<number> {
  const args = buildCodexArgs(ensureExecJsonArg(codexArgs), config);
  await logger.log("wrapper_codex_start", { mode: "exec-json", codexArgs: args });

  try {
    const command = new Deno.Command("codex", {
      args,
      stdin: "inherit",
      stdout: "piped",
      stderr: "inherit",
    });
    const child = command.spawn();
    const stdout = pipeAndObserveExecStdout(child.stdout, observer);
    const status = await child.status;
    await stdout;
    await logger.log("wrapper_exit", {
      mode: "exec-json",
      success: status.success,
      code: status.code,
      signal: status.signal,
    });
    return status.code;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw error;
    }
    throw error;
  }
}

async function runCodexInteractiveRemote(
  codexArgs: string[],
  config: ProxyConfig,
  logger: ReturnType<typeof createLogger>,
  observer: CodexEventObserver,
  portStart: number,
): Promise<number> {
  if (hasCodexRemoteArg(codexArgs)) {
    throw new Error("pando-proxy: --remote is managed by pando-proxy in interactive mode");
  }

  const appServer = await startCodexAppServerOnAvailablePort({
    config,
    logger,
    portStart: Math.max(config.port + 1, portStart),
  });
  let relay: Deno.HttpServer | null = null;

  try {
    const startedRelay = startWebSocketRelayOnAvailablePort({
      host: config.host,
      portStart: appServer.port + 1,
      upstreamUrl: appServer.url,
      observer,
    });
    relay = startedRelay.server;

    const remoteArgs = buildRemoteCodexArgs(codexArgs, startedRelay.url);
    await logger.log("wrapper_relay_start", {
      relayUrl: startedRelay.url,
      appServerUrl: appServer.url,
    });

    return await runCodexForeground({
      args: remoteArgs,
      mode: "interactive-remote",
      logger,
    });
  } finally {
    if (relay) {
      await relay.shutdown();
    }
    await stopChild(appServer.child, appServer.status, appServer.isExited);
  }
}

async function startCodexAppServerOnAvailablePort(options: {
  config: ProxyConfig;
  logger: ReturnType<typeof createLogger>;
  portStart: number;
}): Promise<StartedCodexAppServer> {
  let nextPort = options.portStart;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 20 && nextPort <= 65_535; attempt += 1) {
    const port = findAvailablePort(options.config.host, nextPort);
    nextPort = port + 1;
    const url = `ws://${options.config.host}:${port}`;
    const args = buildCodexArgs(["app-server", "--listen", url], options.config);

    await options.logger.log("wrapper_app_server_start", {
      appServerUrl: url,
      codexArgs: args,
      attempt,
    });

    const child = new Deno.Command("codex", {
      args,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    let exited = false;
    const status = child.status.finally(() => {
      exited = true;
    });

    try {
      await waitForTcpOrExit(options.config.host, port, status, 5_000);
      return {
        child,
        status,
        url,
        port,
        isExited: () => exited,
      };
    } catch (error) {
      lastError = error;
      await options.logger.log("wrapper_app_server_start_failed", {
        appServerUrl: url,
        attempt,
        message: messageFor(error),
        retry: isRetryableAppServerStartError(error),
      });
      await stopChild(child, status, () => exited);

      if (!isRetryableAppServerStartError(error)) {
        throw error;
      }
    }
  }

  throw new Error(`codex app-server failed to start: ${messageFor(lastError)}`);
}

async function runCodexForeground(options: {
  args: string[];
  mode: string;
  logger: ReturnType<typeof createLogger>;
}): Promise<number> {
  await options.logger.log("wrapper_codex_start", {
    mode: options.mode,
    codexArgs: options.args,
  });

  const command = new Deno.Command("codex", {
    args: options.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = command.spawn();
  const status = await child.status;
  await options.logger.log("wrapper_exit", {
    mode: options.mode,
    success: status.success,
    code: status.code,
    signal: status.signal,
  });
  return status.code;
}

async function pipeAndObserveExecStdout(
  stdout: ReadableStream<Uint8Array>,
  observer: CodexEventObserver,
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    await Deno.stdout.write(value);
    buffer += decoder.decode(value, { stream: true });
    buffer = await observeCompleteJsonLines(buffer, observer);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await observer.observeExecJsonLine(buffer);
  }
}

async function observeCompleteJsonLines(
  buffer: string,
  observer: CodexEventObserver,
): Promise<string> {
  let nextNewline = buffer.indexOf("\n");
  while (nextNewline >= 0) {
    const line = buffer.slice(0, nextNewline);
    await observer.observeExecJsonLine(line);
    buffer = buffer.slice(nextNewline + 1);
    nextNewline = buffer.indexOf("\n");
  }
  return buffer;
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

export function findAvailablePort(host: string, portStart: number): number {
  for (let port = portStart; port <= 65_535; port += 1) {
    try {
      const listener = Deno.listen({ hostname: host, port });
      listener.close();
      return port;
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
pointing at that proxy. The first non-proxy argument starts Codex passthrough,
so commands like exec, resume, help, and app-server are passed to codex.
Exec mode is observed through Codex JSONL. Interactive mode is observed through
a local Codex app-server and websocket relay.

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

Examples:
  pando-proxy exec "Help me with this repo"
  pando-proxy resume --last
  pando-proxy help exec

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

function isRetryableAppServerStartError(error: unknown): boolean {
  return error instanceof Error &&
    /app-server exited before listening|app-server did not start listening|address already in use|addrinuse/i
      .test(error.message);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForTcpOrExit(
  host: string,
  port: number,
  status: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const exited = await Promise.race([
      status.then((commandStatus) => ({ exited: true as const, status: commandStatus })),
      delay(50).then(() => ({ exited: false as const })),
    ]);
    if (exited.exited) {
      throw new Error(`codex app-server exited before listening with code ${exited.status.code}`);
    }

    try {
      const connection = await Deno.connect({ hostname: host, port });
      connection.close();
      return;
    } catch (error) {
      if (!isConnectionRefused(error)) {
        throw error;
      }
    }
  }

  throw new Error(`codex app-server did not start listening on ${host}:${port}`);
}

async function stopChild(
  child: Deno.ChildProcess,
  status: Promise<Deno.CommandStatus>,
  isExited: () => boolean,
): Promise<void> {
  if (!isExited()) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may have exited between the state check and signal.
    }
  }

  await Promise.race([
    status.catch(() => undefined),
    delay(1_000),
  ]);

  if (!isExited()) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Process may have exited after the grace period.
    }
    await status.catch(() => undefined);
  }
}

function isConnectionRefused(error: unknown): boolean {
  return error instanceof Deno.errors.ConnectionRefused ||
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.NotConnected ||
    (error instanceof Error && /connection refused|connection reset|not connected/i.test(
      error.message,
    ));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

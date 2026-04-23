import { CodexEventObserver } from "./codex_events.ts";
import {
  buildRemoteCodexArgs,
  classifyCodexRunMode,
  ensureExecJsonArg,
  findCodexCommand,
  hasCodexRemoteArg,
} from "./codex_modes.ts";
import { CliOptions, expandHome, loadConfig, ProxyConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { startServer } from "./server.ts";
import type { RoundSource } from "./tool_results.ts";
import { startWebSocketRelayOnAvailablePort } from "./websocket_relay.ts";

export const DEFAULT_WRAPPER_PORT_START = 40123;
export const PANDO_PROVIDER_ID = "pando-proxy";
export const CODEX_ALIAS_COMMAND = "npx -y pando-proxy";
export const WRAPPER_PREFERENCES_RELATIVE_PATH = ".pando-proxy/wrapper-preferences.json";
export const WRAPPER_LAST_THREAD_RELATIVE_PATH = "wrapper-last-thread.json";
const SIGNAL_PROXY_SHUTDOWN_TIMEOUT_MS = 1_500;

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
  awaitIdle: (timeoutMs?: number) => Promise<void>;
};

type StartedCodexAppServer = {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
  url: string;
  port: number;
  isExited: () => boolean;
};

export type WrapperPreferences = {
  runCount: number;
  firstRunAt?: string;
  lastRunAt?: string;
  codexAliasPrompt?: {
    response: "yes" | "no";
    respondedAt: string;
    install?: CodexAliasInstallResult;
  };
};

export type CodexAliasInstallResult = {
  status: "installed" | "already_present" | "failed";
  path?: string;
  shell?: string;
  message?: string;
};

export type CodexAliasTarget = {
  path: string;
  shell: string;
  snippet: string;
};

export type CodexAliasPromptOptions = {
  homeDir?: string | null;
  shell?: string | null;
  isInteractive?: boolean;
  confirmAlias?: (message: string) => boolean;
  now?: () => Date;
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
    if (arg === "--proxy-small-structured-model" || arg === "--proxy-maintenance-model") {
      options.smallStructuredModel = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-overflow-structured-model") {
      options.overflowStructuredModel = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-state-dir") {
      options.stateDir = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--proxy-codex-auto-compact-token-limit") {
      options.codexAutoCompactTokenLimit = Number(requireValue(args, ++index, arg));
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

  await maybeOfferCodexAlias();

  const baseConfig = loadConfig(parsed.options);
  const effectiveCodexArgs = await rewriteResumeLastArgs(parsed.codexArgs, baseConfig.stateDir);
  const mode = classifyCodexRunMode(effectiveCodexArgs);
  const logFile = await resolveWrapperLogFile(parsed.options, baseConfig.stateDir);
  const logger = createLogger(logFile);
  const observer = new CodexEventObserver(logger);
  const portStart = parsed.options.portStart ?? DEFAULT_WRAPPER_PORT_START;
  const started = startProxyOnAvailablePort(
    { ...baseConfig, logFile },
    portStart,
    () => observer.latestExecThreadId(),
    mode === "exec-json" ? (sessionKey, timeoutMs) => observer.waitForExecTurn(sessionKey, timeoutMs) : undefined,
  );
  const cleanup = installProxyCleanup(started.server, logger);

  if (logFile) {
    console.error(`Pando Proxy log: ${logFile}`);
  }
  console.error(`Pando Proxy URL: http://${started.config.host}:${started.config.port}/v1`);

  await logger.log("wrapper_start", {
    proxyUrl: `http://${started.config.host}:${started.config.port}/v1`,
    requestedCodexArgs: parsed.codexArgs,
    effectiveCodexArgs,
    mode,
    memoryEnabled: started.config.memoryEnabled,
    codexAutoCompactTokenLimit: started.config.codexAutoCompactTokenLimit,
  });

  try {
    let exitCode: number;
    if (mode === "exec-json") {
      exitCode = await runCodexExecJson(effectiveCodexArgs, started.config, logger, observer);
    } else if (mode === "interactive-remote") {
      exitCode = await runCodexInteractiveRemote(
        effectiveCodexArgs,
        started.config,
        logger,
        observer,
        portStart,
      );
    } else {
      exitCode = await runCodexPassthrough(effectiveCodexArgs, started.config, logger);
    }
    await saveLatestWrapperThreadId(baseConfig.stateDir, observer.latestExecThreadId());
    return exitCode;
  } catch (error) {
    await logger.log("wrapper_error", { message: messageFor(error) });
    if (error instanceof Deno.errors.NotFound) {
      console.error("codex was not found on PATH.");
      return 127;
    }
    throw error;
  } finally {
    await started.awaitIdle().catch(async (error) => {
      await logger.log("wrapper_pending_finalization_timeout", {
        message: messageFor(error),
      });
    });
    await cleanup.shutdown("wrapper_exit");
    cleanup.dispose();
  }
}

async function rewriteResumeLastArgs(codexArgs: string[], stateDir: string): Promise<string[]> {
  const savedThreadId = await loadLatestWrapperThreadId(stateDir);
  if (!savedThreadId) {
    return [...codexArgs];
  }

  const rewritten = [...codexArgs];
  for (let index = 0; index < rewritten.length - 1; index += 1) {
    if (rewritten[index] !== "resume" || rewritten[index + 1] !== "--last") {
      continue;
    }
    rewritten.splice(index + 1, 1, savedThreadId);
    break;
  }
  return rewritten;
}

async function loadLatestWrapperThreadId(stateDir: string): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(wrapperLastThreadPath(stateDir));
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const threadId = (parsed as Record<string, unknown>).threadId;
    return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function saveLatestWrapperThreadId(stateDir: string, threadId: string | null): Promise<void> {
  if (!threadId) {
    return;
  }
  const path = wrapperLastThreadPath(stateDir);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify({ threadId }, null, 2)}\n`);
}

function wrapperLastThreadPath(stateDir: string): string {
  return expandHome(`${stateDir}/${WRAPPER_LAST_THREAD_RELATIVE_PATH}`);
}

export async function maybeOfferCodexAlias(
  options: CodexAliasPromptOptions = {},
): Promise<void> {
  const homeDir = options.homeDir ?? userHomeDir();
  if (!homeDir) {
    return;
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const preferencesPath = wrapperPreferencesPath(homeDir);
  const preferences = await loadWrapperPreferences(preferencesPath);
  const previousRunCount = preferences.runCount;

  preferences.runCount += 1;
  preferences.firstRunAt ??= now;
  preferences.lastRunAt = now;

  if (preferences.codexAliasPrompt?.response || previousRunCount < 1) {
    await saveWrapperPreferences(preferencesPath, preferences);
    return;
  }

  if (!(options.isInteractive ?? isInteractiveTerminal())) {
    await saveWrapperPreferences(preferencesPath, preferences);
    return;
  }

  const confirmAlias = options.confirmAlias ?? ((message: string) => confirm(message));
  const accepted = confirmAlias(
    `pando-proxy: alias "codex" to "${CODEX_ALIAS_COMMAND}" for this user?`,
  );

  if (!accepted) {
    preferences.codexAliasPrompt = { response: "no", respondedAt: now };
    await saveWrapperPreferences(preferencesPath, preferences);
    return;
  }

  let install: CodexAliasInstallResult;
  try {
    install = await installCodexAlias(homeDir, options.shell ?? Deno.env.get("SHELL") ?? null);
    if (install.status === "installed") {
      console.error(
        `pando-proxy: added codex alias to ${install.path}. Restart your shell or source that file to use it.`,
      );
    } else if (install.status === "already_present") {
      console.error(`pando-proxy: codex alias already exists in ${install.path}.`);
    }
  } catch (error) {
    install = {
      status: "failed",
      message: messageFor(error),
    };
    console.error(`pando-proxy: failed to add codex alias: ${install.message}`);
  }

  preferences.codexAliasPrompt = {
    response: "yes",
    respondedAt: now,
    install,
  };
  await saveWrapperPreferences(preferencesPath, preferences);
}

export async function installCodexAlias(
  homeDir: string,
  shell: string | null,
  os = Deno.build.os,
): Promise<CodexAliasInstallResult> {
  const target = codexAliasTarget(homeDir, shell, os);
  await Deno.mkdir(dirname(target.path), { recursive: true });

  let existing = "";
  try {
    existing = await Deno.readTextFile(target.path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  if (codexAliasAlreadyPresent(existing)) {
    return { status: "already_present", path: target.path, shell: target.shell };
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await Deno.writeTextFile(target.path, `${separator}${target.snippet}`, {
    append: true,
    create: true,
  });

  return { status: "installed", path: target.path, shell: target.shell };
}

export function codexAliasTarget(
  homeDir: string,
  shell: string | null,
  os = Deno.build.os,
): CodexAliasTarget {
  if (os === "windows") {
    return {
      path: joinPath(homeDir, "Documents/PowerShell/Microsoft.PowerShell_profile.ps1"),
      shell: "powershell",
      snippet: aliasSnippet(`function codex { npx -y pando-proxy @args }`),
    };
  }

  const shellName = basename(shell ?? "").toLowerCase();
  if (shellName === "fish") {
    return {
      path: joinPath(homeDir, ".config/fish/config.fish"),
      shell: "fish",
      snippet: aliasSnippet(`alias codex "${CODEX_ALIAS_COMMAND}"`),
    };
  }

  if (shellName === "bash") {
    return {
      path: joinPath(homeDir, os === "darwin" ? ".bash_profile" : ".bashrc"),
      shell: "bash",
      snippet: aliasSnippet(`alias codex='${CODEX_ALIAS_COMMAND}'`),
    };
  }

  if (shellName === "zsh" || shellName === "") {
    return {
      path: joinPath(homeDir, ".zshrc"),
      shell: "zsh",
      snippet: aliasSnippet(`alias codex='${CODEX_ALIAS_COMMAND}'`),
    };
  }

  return {
    path: joinPath(homeDir, ".profile"),
    shell: shellName,
    snippet: aliasSnippet(`alias codex='${CODEX_ALIAS_COMMAND}'`),
  };
}

export function wrapperPreferencesPath(homeDir: string): string {
  return joinPath(homeDir, WRAPPER_PREFERENCES_RELATIVE_PATH);
}

async function loadWrapperPreferences(path: string): Promise<WrapperPreferences> {
  try {
    return parseWrapperPreferences(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { runCount: 0 };
    }
    throw error;
  }
}

function parseWrapperPreferences(text: string): WrapperPreferences {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return { runCount: 0 };
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...record,
      runCount: typeof record.runCount === "number" && record.runCount >= 0
        ? Math.floor(record.runCount)
        : 0,
    } as WrapperPreferences;
  } catch {
    return { runCount: 0 };
  }
}

async function saveWrapperPreferences(
  path: string,
  preferences: WrapperPreferences,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(preferences, null, 2)}\n`);
}

function codexAliasAlreadyPresent(text: string): boolean {
  return text.includes(">>> pando-proxy codex alias >>>") ||
    /alias\s+codex=.*pando-proxy/.test(text) ||
    /function\s+codex\s*\{[^}]*pando-proxy/s.test(text);
}

function aliasSnippet(aliasLine: string): string {
  return [
    "# >>> pando-proxy codex alias >>>",
    aliasLine,
    "# <<< pando-proxy codex alias <<<",
    "",
  ].join("\n");
}

function userHomeDir(): string | null {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? null;
}

function isInteractiveTerminal(): boolean {
  try {
    return Deno.stdin.isTerminal() && Deno.stderr.isTerminal();
  } catch {
    return false;
  }
}

function installProxyCleanup(
  server: Deno.HttpServer,
  logger: ReturnType<typeof createLogger>,
): {
  shutdown: (reason: string, timeoutMs?: number) => Promise<void>;
  dispose: () => void;
} {
  let shutdown: Promise<void> | null = null;
  let signalExitStarted = false;
  const signalHandlers: Array<{ signal: Deno.Signal; handler: () => void }> = [];

  const shutdownOnce = (reason: string, timeoutMs?: number): Promise<void> => {
    shutdown ??= shutdownProxyServer(server, logger, reason, timeoutMs);
    return shutdown;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (signalExitStarted) {
        Deno.exit(exitCodeForSignal(signal));
      }
      signalExitStarted = true;
      void (async () => {
        await logger.log("wrapper_signal", { signal }).catch(() => {});
        await shutdownOnce(`signal:${signal}`, SIGNAL_PROXY_SHUTDOWN_TIMEOUT_MS);
        Deno.exit(exitCodeForSignal(signal));
      })();
    };

    try {
      Deno.addSignalListener(signal, handler);
      signalHandlers.push({ signal, handler });
    } catch {
      // Some platforms do not support every signal. Normal finally cleanup still applies.
    }
  }

  return {
    shutdown: shutdownOnce,
    dispose: () => {
      for (const { signal, handler } of signalHandlers) {
        try {
          Deno.removeSignalListener(signal, handler);
        } catch {
          // Listener may already have been removed during process teardown.
        }
      }
    },
  };
}

async function shutdownProxyServer(
  server: Deno.HttpServer,
  logger: ReturnType<typeof createLogger>,
  reason: string,
  timeoutMs?: number,
): Promise<void> {
  try {
    const shutdown = server.shutdown().then(() => "shutdown" as const);
    const result = timeoutMs === undefined ? await shutdown : await withTimeout(
      shutdown,
      timeoutMs,
      "timeout" as const,
    );
    await logger.log("wrapper_proxy_shutdown", {
      reason,
      completed: result === "shutdown",
    }).catch(() => {});
  } catch (error) {
    await logger.log("wrapper_proxy_shutdown_error", {
      reason,
      message: messageFor(error),
    }).catch(() => {});
  }
}

function exitCodeForSignal(signal: Deno.Signal): number {
  return signal === "SIGINT" ? 130 : 143;
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
  const args = buildCodexExecArgs(ensureExecJsonArg(codexArgs), config);
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
  fallbackSessionKeyForRequest?: () => string | null | undefined,
  observedRoundSourcesForSession?: (sessionKey: string, timeoutMs: number) => Promise<RoundSource[]>,
): StartedProxy {
  for (let port = portStart; port <= 65_535; port += 1) {
    const config = { ...baseConfig, port };
    try {
      const started = startServer(config, fallbackSessionKeyForRequest, observedRoundSourcesForSession);
      return { config, server: started.server, awaitIdle: started.awaitIdle };
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
  return [...codexProviderOverrideArgs(config), ...codexArgs];
}

export function buildCodexExecArgs(codexArgs: string[], config: ProxyConfig): string[] {
  const command = findCodexCommand(codexArgs);
  if (!command || (command.name !== "exec" && command.name !== "e")) {
    return buildCodexArgs(codexArgs, config);
  }

  return [
    ...codexArgs.slice(0, command.index + 1),
    ...codexProviderOverrideArgs(config),
    ...codexArgs.slice(command.index + 1),
  ];
}

export function codexProviderOverrideArgs(
  config: Pick<ProxyConfig, "host" | "port" | "codexAutoCompactTokenLimit">,
): string[] {
  return [
    "-c",
    `model_provider="${PANDO_PROVIDER_ID}"`,
    "-c",
    `model_auto_compact_token_limit=${config.codexAutoCompactTokenLimit}`,
    ...codexProviderConfigArgs(config),
  ];
}

export function codexProviderConfigArgs(config: Pick<ProxyConfig, "host" | "port">): string[] {
  const prefix = `model_providers.${PANDO_PROVIDER_ID}`;
  return [
    "-c",
    `${prefix}.name="Pando Memory Proxy"`,
    "-c",
    `${prefix}.base_url="http://${config.host}:${config.port}/v1"`,
    "-c",
    `${prefix}.wire_api="responses"`,
    "-c",
    `${prefix}.transport="responses_http"`,
    "-c",
    `${prefix}.requires_openai_auth=true`,
  ];
}

export function codexProviderConfigArg(config: Pick<ProxyConfig, "host" | "port">): string {
  return codexProviderConfigArgs(config).join(" ");
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
  --proxy-host <host>                      Default: 127.0.0.1
  --proxy-port-start <port>                Default: ${DEFAULT_WRAPPER_PORT_START}
  --proxy-upstream-base-url <url>          Default: auto
  --proxy-small-structured-model <model>   Default: cheap structured model
  --proxy-overflow-structured-model <model> Default: smallest larger-window model
  --proxy-state-dir <path>                 Default: ~/.pando-proxy
  --proxy-codex-auto-compact-token-limit <n> Default: 200000
  --proxy-no-memory                        Bypass task/piece memory rewrite
  --proxy-log                              Enable full JSONL logging to ~/.pando-proxy/logs
  --proxy-log-file <path>                  Enable full JSONL logging to this file
  --proxy-help, --help, -h                 Show this help

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
    const exited = await withTimeout(
      status.then((commandStatus) => ({ exited: true as const, status: commandStatus })),
      50,
      { exited: false as const },
    );
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

  await withTimeout(status.catch(() => undefined), 1_000, undefined);

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

function withTimeout<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: number | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\\/]+$/, "")}/${relative.replace(/^[\\\/]+/, "")}`;
}

function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : ".";
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/[\/]+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

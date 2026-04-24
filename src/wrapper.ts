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
import type { ContextWindowComparisonStats, ContextWindowStats } from "./server.ts";
import { startServer } from "./server.ts";
import type { RoundSource } from "./tool_results.ts";
import {
  startWebSocketRelayOnAvailablePort,
  type WebSocketRelayEvent,
} from "./websocket_relay.ts";

export const DEFAULT_WRAPPER_PORT_START = 40123;
export const PANDO_PROVIDER_ID = "pando-proxy";
export const CODEX_ALIAS_COMMAND = "npx -y pando-proxy";
export const WRAPPER_PREFERENCES_RELATIVE_PATH = ".pando-proxy/wrapper-preferences.json";
export const WRAPPER_LAST_THREAD_RELATIVE_PATH = "wrapper-last-thread.json";
const SIGNAL_PROXY_SHUTDOWN_TIMEOUT_MS = 1_500;
const INTERACTIVE_RESTART_LIMIT = 1;
const APP_SERVER_OUTPUT_TAIL_CHARS = 12_000;

export type WrapperOptions = CliOptions & {
  portStart?: number;
  logEnabled?: boolean;
};

export type ParsedWrapperArgs = {
  codexArgs: string[];
  options: WrapperOptions;
  directCodex: boolean;
  uninstallCodexAlias: boolean;
  help: boolean;
};

export type StartedProxy = {
  config: ProxyConfig;
  server: Deno.HttpServer;
  awaitIdle: (timeoutMs?: number) => Promise<void>;
  contextStats: {
    latest: () => ContextWindowComparisonStats | null;
    forSession: (sessionKey: string) => ContextWindowComparisonStats | null;
  };
};

type StartedCodexAppServer = {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
  url: string;
  port: number;
  isExited: () => boolean;
  stdoutTail: () => string;
  stderrTail: () => string;
  outputDone: Promise<void>;
};

type InteractiveAttemptDiagnostics = {
  relayEvents: WebSocketRelayEvent[];
  upstreamOpened: boolean;
  appServerExit: Deno.CommandStatus | null;
  appServerExitUnexpected: boolean;
  appServerStdoutTail: string;
  appServerStderrTail: string;
};

type InteractiveAttemptResult = {
  exitCode: number;
  status: Deno.CommandStatus;
  diagnostics: InteractiveAttemptDiagnostics;
  shouldRestart: boolean;
  restartReason: string | null;
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

export type CodexAliasUninstallResult = {
  status: "removed" | "not_present" | "failed";
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
  let directCodex = false;
  let uninstallCodexAlias = false;
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
    if (arg === "--uninstall-codex-alias") {
      uninstallCodexAlias = true;
      continue;
    }
    if (arg === "--proxy-run-codex-direct") {
      directCodex = true;
      passthrough = true;
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

  return { codexArgs, options, directCodex, uninstallCodexAlias, help };
}

export async function runCodexWrapper(args: string[]): Promise<number> {
  const parsed = parseWrapperArgs(args);
  if (parsed.help) {
    printWrapperHelp();
    return 0;
  }
  if (parsed.uninstallCodexAlias) {
    return await runCodexAliasUninstall();
  }
  if (parsed.directCodex) {
    return await runCodexDirect(parsed.codexArgs);
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
    const threadId = observer.latestExecThreadId();
    await saveLatestWrapperThreadId(baseConfig.stateDir, threadId);
    printContextWindowSummary(
      threadId,
      threadId ? started.contextStats.forSession(threadId) ?? started.contextStats.latest() : started.contextStats.latest(),
    );
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

// Flags accepted by `codex exec` but NOT by `codex exec resume`. If a user
// writes `exec resume --last --sandbox read-only -C /repo "prompt"`, Codex
// rejects the trailing flags because the resume subcommand parser doesn't
// know them. We hoist them to before `resume` so the user doesn't have to
// remember the distinction.
//
// Kept intentionally narrow to known-divergent flags; anything shared
// between `exec` and `exec resume` is left in place.
const EXEC_ONLY_FLAGS_WITH_VALUE = new Set([
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "--local-provider",
  "-p",
  "--profile",
  "--output-schema",
  "--color",
]);
const EXEC_ONLY_FLAGS_WITHOUT_VALUE = new Set([
  "--oss",
]);

async function rewriteResumeLastArgs(codexArgs: string[], stateDir: string): Promise<string[]> {
  const savedThreadId = await loadLatestWrapperThreadId(stateDir);
  const rewritten = [...codexArgs];

  for (let index = 0; index < rewritten.length; index += 1) {
    if (rewritten[index] !== "resume") {
      continue;
    }
    // Substitute --last with the saved session id when available. If the user
    // passed a concrete id already, leave it alone.
    if (savedThreadId && rewritten[index + 1] === "--last") {
      rewritten.splice(index + 1, 1, savedThreadId);
    }
    const tailStart = rewritten[index + 1] !== undefined && !rewritten[index + 1].startsWith("-")
      ? index + 2
      : index + 1;
    const { hoisted, remaining } = splitExecOnlyFlags(rewritten.slice(tailStart));
    if (hoisted.length === 0) {
      return rewritten;
    }
    return [
      ...rewritten.slice(0, index),
      ...hoisted,
      ...rewritten.slice(index, tailStart),
      ...remaining,
    ];
  }

  return rewritten;
}

function splitExecOnlyFlags(
  tail: string[],
): { hoisted: string[]; remaining: string[] } {
  const hoisted: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (arg === "--") {
      remaining.push(...tail.slice(i));
      break;
    }
    const [name] = arg.split("=", 2);
    const hasInlineValue = arg.includes("=");
    if (EXEC_ONLY_FLAGS_WITH_VALUE.has(name)) {
      hoisted.push(arg);
      if (!hasInlineValue && i + 1 < tail.length) {
        i += 1;
        hoisted.push(tail[i]);
      }
      continue;
    }
    if (EXEC_ONLY_FLAGS_WITHOUT_VALUE.has(name)) {
      hoisted.push(arg);
      continue;
    }
    remaining.push(arg);
  }
  return { hoisted, remaining };
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

export async function uninstallCodexAlias(
  homeDir: string,
  shell: string | null,
  os = Deno.build.os,
): Promise<CodexAliasUninstallResult> {
  const target = codexAliasTarget(homeDir, shell, os);
  let existing = "";
  try {
    existing = await Deno.readTextFile(target.path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { status: "not_present", path: target.path, shell: target.shell };
    }
    throw error;
  }

  const updated = removeCodexAliasSnippet(existing);
  if (updated === existing) {
    return { status: "not_present", path: target.path, shell: target.shell };
  }

  await Deno.writeTextFile(target.path, updated);
  return { status: "removed", path: target.path, shell: target.shell };
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

function removeCodexAliasSnippet(text: string): string {
  let updated = text.replace(
    /(?:^|\n)# >>> pando-proxy codex alias >>>\n[\s\S]*?\n# <<< pando-proxy codex alias <<<\n?/g,
    "\n",
  );
  updated = updated.replace(/^alias\s+codex=.*pando-proxy.*\n?/gm, "");
  updated = updated.replace(/^function\s+codex\s*\{[^}]*pando-proxy[^}]*\}\n?/gms, "");
  updated = updated.replace(/\n{3,}/g, "\n\n");
  return updated.trim().length === 0 ? "" : `${updated.replace(/^\n+/, "")}`;
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

async function runCodexAliasUninstall(): Promise<number> {
  const homeDir = userHomeDir();
  if (!homeDir) {
    console.error("pando-proxy: could not determine the user home directory.");
    return 1;
  }

  try {
    const result = await uninstallCodexAlias(homeDir, Deno.env.get("SHELL") ?? null);
    if (result.status === "removed") {
      console.error(`pando-proxy: removed codex alias from ${result.path}.`);
      await clearCodexAliasPromptPreference(homeDir);
      return 0;
    }
    if (result.status === "not_present") {
      console.error(`pando-proxy: no pando-proxy codex alias found in ${result.path}.`);
      return 0;
    }
    console.error(`pando-proxy: failed to remove codex alias: ${result.message ?? "unknown error"}`);
    return 1;
  } catch (error) {
    console.error(`pando-proxy: failed to remove codex alias: ${messageFor(error)}`);
    return 1;
  }
}

async function clearCodexAliasPromptPreference(homeDir: string): Promise<void> {
  const path = wrapperPreferencesPath(homeDir);
  const preferences = await loadWrapperPreferences(path);
  delete preferences.codexAliasPrompt;
  await saveWrapperPreferences(path, preferences);
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

async function runCodexDirect(codexArgs: string[]): Promise<number> {
  const child = new Deno.Command("codex", {
    args: codexArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.code;
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

  let restartCount = 0;
  let nextCodexArgs = [...codexArgs];

  while (true) {
    const result = await runCodexInteractiveRemoteAttempt(
      nextCodexArgs,
      config,
      logger,
      observer,
      portStart,
    );
    if (!result.shouldRestart || restartCount >= INTERACTIVE_RESTART_LIMIT) {
      if (result.restartReason !== null) {
        printInteractiveFailureDetails(result.diagnostics, observer.latestExecThreadId(), result.restartReason, false);
      }
      return result.exitCode;
    }

    restartCount += 1;
    const threadId = observer.latestExecThreadId();
    printInteractiveFailureDetails(result.diagnostics, threadId, result.restartReason ?? "interactive session failed", true);
    nextCodexArgs = buildInteractiveRestartArgs(codexArgs, threadId);
    await logger.log("wrapper_interactive_restart", {
      attempt: restartCount,
      reason: result.restartReason,
      resumeThreadId: threadId,
      restartCodexArgs: nextCodexArgs,
    });
    const restartMessage = threadId
      ? `pando-proxy: restarting Codex with resume ${threadId}`
      : "pando-proxy: restarting Codex with a fresh interactive session";
    console.error(restartMessage);
  }
}

async function runCodexInteractiveRemoteAttempt(
  codexArgs: string[],
  config: ProxyConfig,
  logger: ReturnType<typeof createLogger>,
  observer: CodexEventObserver,
  portStart: number,
): Promise<InteractiveAttemptResult> {
  const appServer = await startCodexAppServerOnAvailablePort({
    config,
    logger,
    portStart: Math.max(config.port + 1, portStart),
  });
  let relay: Deno.HttpServer | null = null;
  let appServerShutdownIntentional = false;
  let appServerExit: Deno.CommandStatus | null = null;
  let appServerExitUnexpected = false;
  const relayEvents: WebSocketRelayEvent[] = [];
  let upstreamOpened = false;

  const appServerStatusWatcher = appServer.status.then(async (status) => {
    appServerExit = status;
    if (!appServerShutdownIntentional) {
      appServerExitUnexpected = true;
    }
    await logger.log("wrapper_app_server_exit", {
      success: status.success,
      code: status.code,
      signal: status.signal,
      intentional: appServerShutdownIntentional,
      stdoutTail: appServer.stdoutTail(),
      stderrTail: appServer.stderrTail(),
    });
  }).catch(async (error) => {
    appServerExitUnexpected = !appServerShutdownIntentional;
    await logger.log("wrapper_app_server_exit_error", {
      intentional: appServerShutdownIntentional,
      message: messageFor(error),
      stdoutTail: appServer.stdoutTail(),
      stderrTail: appServer.stderrTail(),
    });
  });

  try {
    const startedRelay = startWebSocketRelayOnAvailablePort({
      host: config.host,
      portStart: appServer.port + 1,
      upstreamUrl: appServer.url,
      observer,
      onEvent: (event) => {
        relayEvents.push(event);
        if (event.type === "upstream_open") {
          upstreamOpened = true;
        }
        void logger.log("wrapper_relay_event", event).catch(() => {});
      },
    });
    relay = startedRelay.server;

    const remoteArgs = buildRemoteCodexArgs(codexArgs, startedRelay.url);
    await logger.log("wrapper_relay_start", {
      relayUrl: startedRelay.url,
      appServerUrl: appServer.url,
    });

    const status = await runCodexForegroundDetailed({
      args: remoteArgs,
      mode: "interactive-remote",
      logger,
    });
    appServerShutdownIntentional = true;

    const diagnostics = {
      relayEvents: [...relayEvents],
      upstreamOpened,
      appServerExit,
      appServerExitUnexpected,
      appServerStdoutTail: appServer.stdoutTail(),
      appServerStderrTail: appServer.stderrTail(),
    };
    const restartReason = interactiveRestartReason(status, diagnostics);
    return {
      exitCode: status.code,
      status,
      diagnostics,
      shouldRestart: restartReason !== null,
      restartReason,
    };
  } finally {
    if (relay) {
      await relay.shutdown();
    }
    appServerShutdownIntentional = true;
    await stopChild(appServer.child, appServer.status, appServer.isExited);
    await Promise.allSettled([appServer.outputDone, appServerStatusWatcher]);
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
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stdoutTail = createTailCapture(APP_SERVER_OUTPUT_TAIL_CHARS);
    const stderrTail = createTailCapture(APP_SERVER_OUTPUT_TAIL_CHARS);
    const outputDone = Promise.all([
      mirrorChildOutput(child.stdout, Deno.stdout, stdoutTail.push),
      mirrorChildOutput(child.stderr, Deno.stderr, stderrTail.push),
    ]).then(() => {});
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
        stdoutTail: stdoutTail.read,
        stderrTail: stderrTail.read,
        outputDone,
      };
    } catch (error) {
      lastError = error;
      await options.logger.log("wrapper_app_server_start_failed", {
        appServerUrl: url,
        attempt,
        message: messageFor(error),
        stdoutTail: stdoutTail.read(),
        stderrTail: stderrTail.read(),
        retry: isRetryableAppServerStartError(error),
      });
      await stopChild(child, status, () => exited);
      await Promise.allSettled([outputDone]);

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
  const status = await runCodexForegroundDetailed(options);
  return status.code;
}

async function runCodexForegroundDetailed(options: {
  args: string[];
  mode: string;
  logger: ReturnType<typeof createLogger>;
}): Promise<Deno.CommandStatus> {
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
  return status;
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
      return {
        config,
        server: started.server,
        awaitIdle: started.awaitIdle,
        contextStats: started.contextStats,
      };
    } catch (error) {
      if (isAddressInUse(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`No available port found at or above ${portStart}`);
}

function printContextWindowSummary(threadId: string | null, stats: ContextWindowComparisonStats | null): void {
  if (!stats) {
    return;
  }
  const sessionLabel = threadId ? ` (${threadId})` : "";
  const withoutProxy = formatContextWindowSeries(stats.withoutProxy);
  const withProxy = formatContextWindowSeries(stats.withProxy);
  if (withoutProxy) {
    console.error(`Pando Proxy context bytes without proxy${sessionLabel}: ${withoutProxy}`);
  }
  if (withProxy) {
    console.error(`Pando Proxy context bytes with proxy${sessionLabel}: ${withProxy}`);
  }
}

function formatContextWindowSeries(stats: ContextWindowStats | null): string | null {
  if (!stats) {
    return null;
  }
  return `min ${formatCount(stats.minBytes)}, avg ${formatCount(stats.avgBytes)}, max ${formatCount(stats.maxBytes)}`;
}

function printInteractiveFailureDetails(
  diagnostics: InteractiveAttemptDiagnostics,
  threadId: string | null,
  reason: string,
  willRestart: boolean,
): void {
  console.error(
    `pando-proxy: interactive Codex session failed: ${reason}${willRestart ? " (will restart once)" : ""}`,
  );
  if (threadId) {
    console.error(`pando-proxy: last Codex session id: ${threadId}`);
    console.error(`pando-proxy: resume with: codex resume ${threadId}`);
  }
  if (diagnostics.appServerExitUnexpected && diagnostics.appServerExit) {
    console.error(`pando-proxy: codex app-server exited ${formatCommandStatus(diagnostics.appServerExit)}`);
  }
  if (diagnostics.relayEvents.length > 0) {
    for (const line of summarizeRelayEvents(diagnostics.relayEvents)) {
      console.error(`pando-proxy: ${line}`);
    }
  }
  if (diagnostics.appServerStderrTail) {
    console.error("pando-proxy: recent codex app-server stderr:");
    console.error(diagnostics.appServerStderrTail.trimEnd());
  }
  if (diagnostics.appServerStdoutTail) {
    console.error("pando-proxy: recent codex app-server stdout:");
    console.error(diagnostics.appServerStdoutTail.trimEnd());
  }
}

function interactiveRestartReason(
  status: Deno.CommandStatus,
  diagnostics: InteractiveAttemptDiagnostics,
): string | null {
  if (isUserInterruptStatus(status) || status.success) {
    if (diagnostics.appServerExitUnexpected) {
      return "the codex app-server died unexpectedly";
    }
    const firstTerminal = firstTerminalRelayEvent(diagnostics.relayEvents);
    if (firstTerminal?.type === "upstream_error") {
      return "the upstream app-server websocket hit an error";
    }
    if (firstTerminal?.type === "upstream_close") {
      return `the upstream app-server websocket closed (${formatCloseSummary(firstTerminal)})`;
    }
    return null;
  }

  if (diagnostics.appServerExitUnexpected) {
    return "the codex app-server died unexpectedly";
  }
  const firstTerminal = firstTerminalRelayEvent(diagnostics.relayEvents);
  if (firstTerminal?.type === "upstream_error") {
    return "the upstream app-server websocket hit an error";
  }
  if (firstTerminal?.type === "upstream_close") {
    return `the upstream app-server websocket closed (${formatCloseSummary(firstTerminal)})`;
  }
  if (firstTerminal?.type === "client_error") {
    return "the local Codex TUI websocket client hit an error";
  }
  return `Codex exited ${formatCommandStatus(status)}`;
}

function buildInteractiveRestartArgs(originalArgs: string[], threadId: string | null): string[] {
  if (!threadId) {
    return [...originalArgs];
  }
  const command = findCodexCommand(originalArgs);
  if (!command) {
    return [...originalArgs, "resume", threadId];
  }
  return [...originalArgs.slice(0, command.index), "resume", threadId];
}

function summarizeRelayEvents(events: WebSocketRelayEvent[]): string[] {
  return events.filter((event) => event.type !== "upstream_open").map((event) => {
    if (event.type === "client_error" || event.type === "upstream_error") {
      return `${event.type.replaceAll("_", " ")}${event.hadOpened ? " after open" : " before open"}`;
    }
    if (event.type === "client_close" || event.type === "upstream_close") {
      return `${event.type.replaceAll("_", " ")}: ${formatCloseSummary(event)}`;
    }
    return event.type;
  });
}

function firstTerminalRelayEvent(events: WebSocketRelayEvent[]): WebSocketRelayEvent | null {
  for (const event of events) {
    if (event.type !== "upstream_open") {
      return event;
    }
  }
  return null;
}

function formatCommandStatus(status: Deno.CommandStatus): string {
  const signalText = status.signal ? `, signal ${status.signal}` : "";
  return `with code ${status.code}${signalText}${status.success ? "" : ", success false"}`;
}

function formatCloseSummary(event: Extract<WebSocketRelayEvent, { type: "client_close" | "upstream_close" }>): string {
  const reason = event.reason ? `, reason "${event.reason}"` : "";
  return `code ${event.code}, clean ${event.wasClean}, opened ${event.hadOpened}${reason}`;
}

function isUserInterruptStatus(status: Deno.CommandStatus): boolean {
  return status.signal === "SIGINT" || status.code === 130;
}

function createTailCapture(maxChars: number): { push: (chunk: string) => void; read: () => string } {
  let value = "";
  return {
    push: (chunk: string) => {
      value += chunk;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read: () => value,
  };
}

async function mirrorChildOutput(
  stream: ReadableStream<Uint8Array> | null,
  writer: { write(chunk: Uint8Array): Promise<number> },
  onText: (chunk: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await writer.write(value);
      onText(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) {
      onText(tail);
    }
  } finally {
    reader.releaseLock();
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
  --proxy-codex-auto-compact-token-limit <n> Default: 280000
  --proxy-no-memory                        Bypass task/piece memory rewrite
  --proxy-log                              Enable full JSONL logging to ~/.pando-proxy/logs
  --proxy-log-file <path>                  Enable full JSONL logging to this file
  --proxy-run-codex-direct                 Run codex directly with no proxy/wrapper
  --uninstall-codex-alias                  Remove the pando-proxy codex shell alias and exit
  --proxy-help, --help, -h                 Show this help

Examples:
  pando-proxy exec "Help me with this repo"
  pando-proxy resume --last
  pando-proxy --proxy-run-codex-direct
  pando-proxy --proxy-run-codex-direct --help
  pando-proxy --uninstall-codex-alias
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

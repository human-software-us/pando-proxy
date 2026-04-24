export type CodexRunMode = "exec-json" | "interactive-direct" | "passthrough";

export type CodexCommand = {
  name: string;
  index: number;
};

const CODEX_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
]);

const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "app",
  "completion",
  "sandbox",
  "debug",
  "apply",
  "a",
  "resume",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

const INTERACTIVE_COMMANDS = new Set(["resume", "fork"]);
const EXEC_COMMANDS = new Set(["exec", "e"]);

export function classifyCodexRunMode(args: string[]): CodexRunMode {
  if (hasTopLevelHelpOrVersion(args)) {
    return "passthrough";
  }

  const command = findCodexCommand(args);
  if (!command) {
    return "interactive-direct";
  }

  if (EXEC_COMMANDS.has(command.name)) {
    return "exec-json";
  }
  if (INTERACTIVE_COMMANDS.has(command.name)) {
    return "interactive-direct";
  }
  if (CODEX_TOP_LEVEL_COMMANDS.has(command.name)) {
    return "passthrough";
  }

  return "interactive-direct";
}

export function ensureExecJsonArg(args: string[]): string[] {
  const command = findCodexCommand(args);
  if (!command || !EXEC_COMMANDS.has(command.name) || args.includes("--json")) {
    return [...args];
  }

  return [
    ...args.slice(0, command.index + 1),
    "--json",
    ...args.slice(command.index + 1),
  ];
}

export function findCodexCommand(args: string[]): CodexCommand | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      return null;
    }
    if (isOptionWithInlineValue(arg)) {
      continue;
    }
    if (CODEX_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }

    return { name: arg, index };
  }

  return null;
}

function hasTopLevelHelpOrVersion(args: string[]): boolean {
  const command = findCodexCommand(args);
  if (command) {
    return command.name === "help";
  }
  return args.some((arg) =>
    arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V"
  );
}

function isOptionWithInlineValue(arg: string): boolean {
  const [name, value] = arg.split("=", 2);
  return value !== undefined && CODEX_GLOBAL_OPTIONS_WITH_VALUE.has(name);
}

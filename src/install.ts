import { DEFAULT_HOST, DEFAULT_PORT, expandHome } from "./config.ts";
import { isRecord } from "./memory_state.ts";

export type InstallOptions = {
  host?: string;
  port?: number;
  print?: boolean;
  yes?: boolean;
};

export type InstallResult = {
  configPath: string;
  changedDefaultProvider: boolean;
  previousDefaultProvider: string | null;
};

export type UninstallResult = {
  configPath: string;
  restoredDefaultProvider: string | null;
};

type DefaultProviderState = {
  active: boolean;
  installedAt: string;
  configPath: string;
  previousDefaultProvider: string | null;
};

const PANDO_PROVIDER_ID = "pando-proxy";

export function codexConfigPath(): string {
  return expandHome("~/.codex/config.toml");
}

export function defaultProviderStatePath(): string {
  return expandHome("~/.pando-proxy/default-provider-state.json");
}

export function codexConfigSnippet(options: InstallOptions = {}): string {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  return [
    "# BEGIN PANDO-PROXY",
    "[model_providers.pando-proxy]",
    'name = "Pando Memory Proxy"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "# END PANDO-PROXY",
    "",
  ].join("\n");
}

export function currentDefaultProvider(configText: string): string | null {
  for (const line of topLevelLines(configText)) {
    const match = line.match(/^\s*model_provider\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    if (match) {
      return match[1];
    }
    const bareMatch = line.match(/^\s*model_provider\s*=\s*([A-Za-z0-9_.-]+)\s*(?:#.*)?$/);
    if (bareMatch) {
      return bareMatch[1];
    }
  }
  return null;
}

export function isPandoDefaultProvider(configText: string): boolean {
  return currentDefaultProvider(configText) === PANDO_PROVIDER_ID;
}

export function setDefaultProvider(configText: string, provider: string): string {
  const lines = configText.split(/\r?\n/);
  const firstTable = firstTableLineIndex(lines);
  const assignment = `model_provider = "${provider}"`;

  for (let index = 0; index < firstTable; index += 1) {
    if (/^\s*model_provider\s*=/.test(lines[index])) {
      lines[index] = assignment;
      return lines.join("\n").trimEnd() + "\n";
    }
  }

  const insertAt = firstTable;
  lines.splice(insertAt, 0, assignment);
  return lines.join("\n").trimEnd() + "\n";
}

export function restoreDefaultProvider(
  configText: string,
  previousDefaultProvider: string | null,
): string {
  if (previousDefaultProvider) {
    return setDefaultProvider(configText, previousDefaultProvider);
  }

  const lines = configText.split(/\r?\n/);
  const firstTable = firstTableLineIndex(lines);
  const kept = lines.filter((line, index) =>
    index >= firstTable || !/^\s*model_provider\s*=/.test(line)
  );
  return kept.join("\n").trimEnd() + "\n";
}

export async function installCodexConfig(options: InstallOptions = {}): Promise<InstallResult> {
  const path = codexConfigPath();
  const snippet = codexConfigSnippet(options);
  if (options.print) {
    return {
      configPath: path,
      changedDefaultProvider: false,
      previousDefaultProvider: null,
    };
  }

  const existing = await readIfExists(path);
  const previousDefaultProvider = currentDefaultProvider(existing);
  const defaultAlreadySet = previousDefaultProvider === PANDO_PROVIDER_ID;
  if (!defaultAlreadySet && !options.yes) {
    if (!Deno.stdin.isTerminal()) {
      throw new Error(
        "pando-proxy is not the default Codex provider. Re-run with --yes to set it.",
      );
    }
    const label = previousDefaultProvider
      ? `current default: ${previousDefaultProvider}`
      : "no current default";
    if (!confirm(`Set pando-proxy as the default Codex model provider? (${label})`)) {
      throw new Error("Install cancelled; pando-proxy was not set as the default provider.");
    }
  }
  const state = await readDefaultProviderState();
  const stateToWrite: DefaultProviderState = state?.active ? state : {
    active: true,
    installedAt: new Date().toISOString(),
    configPath: path,
    previousDefaultProvider,
  };
  const next = setDefaultProvider(
    appendOwnedSnippet(removeOwnedConfig(existing), snippet),
    PANDO_PROVIDER_ID,
  );
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.mkdir(dirname(defaultProviderStatePath()), { recursive: true });
  if (existing.length > 0) {
    await Deno.writeTextFile(`${path}.bak.${timestamp()}`, existing);
  }
  await atomicWriteJson(defaultProviderStatePath(), stateToWrite);
  await Deno.writeTextFile(path, next);
  return {
    configPath: path,
    changedDefaultProvider: !defaultAlreadySet,
    previousDefaultProvider,
  };
}

export async function uninstallCodexConfig(): Promise<UninstallResult> {
  const path = codexConfigPath();
  const existing = await readIfExists(path);
  const state = await readDefaultProviderState();
  const withoutOwnedConfig = removeOwnedConfig(existing).trimEnd() + "\n";
  const next = isPandoDefaultProvider(withoutOwnedConfig)
    ? restoreDefaultProvider(withoutOwnedConfig, state?.previousDefaultProvider ?? null)
    : withoutOwnedConfig;
  if (existing.length > 0) {
    await Deno.writeTextFile(`${path}.bak.${timestamp()}`, existing);
  }
  if (state) {
    await atomicWriteJson(defaultProviderStatePath(), {
      ...state,
      active: false,
      uninstalledAt: new Date().toISOString(),
    });
  }
  await Deno.writeTextFile(path, next);
  return {
    configPath: path,
    restoredDefaultProvider: state?.previousDefaultProvider ?? null,
  };
}

export async function isCodexConfigInstalled(): Promise<boolean> {
  const text = await readIfExists(codexConfigPath());
  return isPandoDefaultProvider(text) &&
    text.includes("[model_providers.pando-proxy]") &&
    text.includes("Pando Memory Proxy");
}

function removeOwnedConfig(text: string): string {
  const withoutMarkers = text.replace(
    /(?:^|\n)# BEGIN PANDO-PROXY\n[\s\S]*?# END PANDO-PROXY\n?/g,
    "\n",
  );
  return removeTomlTables(
    withoutMarkers,
    new Set([
      "[model_providers.pando-proxy]",
    ]),
  );
}

function removeTomlTables(text: string, tables: Set<string>): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      skipping = tables.has(trimmed);
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trimEnd();
}

function appendOwnedSnippet(existing: string, snippet: string): string {
  const trimmed = existing.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${snippet}` : snippet;
}

function topLevelLines(configText: string): string[] {
  const lines = configText.split(/\r?\n/);
  return lines.slice(0, firstTableLineIndex(lines));
}

function firstTableLineIndex(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return "";
    }
    throw error;
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function readDefaultProviderState(): Promise<DefaultProviderState | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(defaultProviderStatePath()));
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      active: parsed.active === true,
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      configPath: typeof parsed.configPath === "string" ? parsed.configPath : codexConfigPath(),
      previousDefaultProvider: typeof parsed.previousDefaultProvider === "string"
        ? parsed.previousDefaultProvider
        : null,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(temp, path);
}

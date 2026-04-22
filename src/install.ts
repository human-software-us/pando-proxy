import { DEFAULT_HOST, DEFAULT_PORT, expandHome } from "./config.ts";

export type InstallOptions = {
  host?: string;
  port?: number;
  print?: boolean;
  yes?: boolean;
};

export function codexConfigPath(): string {
  return expandHome("~/.codex/config.toml");
}

export function codexConfigSnippet(options: InstallOptions = {}): string {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  return [
    "# BEGIN PANDO-PROXY",
    "[profiles.pando-memory]",
    'model_provider = "pando-proxy"',
    "",
    "[model_providers.pando-proxy]",
    'name = "Pando Memory Proxy"',
    `base_url = "http://${host}:${port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "# END PANDO-PROXY",
    "",
  ].join("\n");
}

export async function installCodexConfig(options: InstallOptions = {}): Promise<string> {
  const path = codexConfigPath();
  const snippet = codexConfigSnippet(options);
  if (options.print) {
    return snippet;
  }

  const existing = await readIfExists(path);
  const next = appendOwnedSnippet(removeOwnedConfig(existing), snippet);
  await Deno.mkdir(dirname(path), { recursive: true });
  if (existing.length > 0) {
    await Deno.writeTextFile(`${path}.bak.${timestamp()}`, existing);
  }
  await Deno.writeTextFile(path, next);
  return path;
}

export async function uninstallCodexConfig(): Promise<string> {
  const path = codexConfigPath();
  const existing = await readIfExists(path);
  const next = removeOwnedConfig(existing).trimEnd() + "\n";
  if (existing.length > 0) {
    await Deno.writeTextFile(`${path}.bak.${timestamp()}`, existing);
  }
  await Deno.writeTextFile(path, next);
  return path;
}

export async function isCodexConfigInstalled(): Promise<boolean> {
  const text = await readIfExists(codexConfigPath());
  return text.includes("[profiles.pando-memory]") &&
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
      "[profiles.pando-memory]",
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

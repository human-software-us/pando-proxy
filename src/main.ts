#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

import { loadConfig, parseCliOptions } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import {
  codexConfigSnippet,
  installCodexConfig,
  isCodexConfigInstalled,
  uninstallCodexConfig,
} from "./install.ts";
import { serve } from "./server.ts";

async function main(): Promise<void> {
  const { command, options } = parseCliOptions(Deno.args);
  const config = loadConfig(options);

  switch (command ?? "first-run") {
    case "first-run":
      await runFirstRun(config, options.yes ?? false);
      break;
    case "serve":
      await serve(config);
      break;
    case "install":
      if (options.print) {
        console.log(codexConfigSnippet(options));
      } else {
        const path = await installCodexConfig(options);
        console.log(`Installed pando-memory Codex profile in ${path}`);
        console.log("Use Codex with:");
        console.log("  codex --profile pando-memory");
      }
      break;
    case "uninstall": {
      const path = await uninstallCodexConfig();
      console.log(`Removed pando-proxy owned config from ${path}`);
      break;
    }
    case "doctor": {
      const result = await runDoctor(config);
      console.log(result.lines.join("\n"));
      if (!result.ok) {
        Deno.exitCode = 1;
      }
      break;
    }
    case "status": {
      const installed = await isCodexConfigInstalled();
      console.log(`proxy_url: http://${config.host}:${config.port}/v1`);
      console.log(`codex_profile_installed: ${installed ? "yes" : "no"}`);
      console.log(`state_dir: ${config.stateDir}`);
      console.log(`memory_enabled: ${config.memoryEnabled ? "yes" : "no"}`);
      console.log(`log_file: ${config.logFile ?? "(none)"}`);
      break;
    }
    case "help":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runFirstRun(config: ReturnType<typeof loadConfig>, yes: boolean): Promise<void> {
  if (!(await isCodexConfigInstalled())) {
    console.log("Pando Proxy can install a named Codex profile: pando-memory.");
    console.log(
      "It will add only pando-proxy owned provider/profile entries and create a backup first.",
    );
    if (yes || shouldPromptYes("Install Codex profile now?")) {
      const path = await installCodexConfig({ host: config.host, port: config.port });
      console.log(`Installed pando-memory Codex profile in ${path}`);
    } else {
      console.log("Skipping Codex config install.");
    }
  }

  const doctor = await runDoctor(config);
  console.log(doctor.lines.join("\n"));
  console.log("");
  console.log("Use Codex with:");
  console.log("  codex --profile pando-memory");
  console.log("");
  await serve(config);
}

function shouldPromptYes(question: string): boolean {
  if (!Deno.stdin.isTerminal()) {
    return false;
  }
  return confirm(question);
}

function printHelp(): void {
  console.log(`pando-proxy

Commands:
  serve       Start the local OpenAI-compatible proxy
  install     Install/update the Codex pando-memory profile
  uninstall   Remove only pando-proxy owned Codex config
  doctor      Check port, credentials, upstream, and Codex config
  status      Print local proxy/config status

Options:
  --host <host>                   Default: 127.0.0.1
  --port <port>                   Default: 8787
  --upstream-base-url <url>       Default: https://api.openai.com/v1
  --maintenance-model <model>     Default: incoming request model
  --state-dir <path>              Default: ~/.pando-proxy
  --no-memory                     Bypass memory maintenance/injection
  --log-file <path>               Write redacted proxy events as JSONL
  --print                         Print install snippet instead of writing
  --yes, -y                       Accept first-run install prompt
`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}

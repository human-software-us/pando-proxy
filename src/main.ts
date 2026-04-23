import { loadConfig, parseCliOptions } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { serve } from "./server.ts";
import { printWrapperHelp, runCodexWrapper } from "./wrapper.ts";

const PROXY_COMMANDS = new Set(["serve", "doctor", "help"]);

async function main(): Promise<void> {
  const first = Deno.args[0];
  if (!first || !PROXY_COMMANDS.has(first)) {
    Deno.exitCode = await runCodexWrapper(Deno.args);
    return;
  }

  const { command, options } = parseCliOptions(Deno.args);
  const config = loadConfig(options);

  switch (command) {
    case "serve":
      await serve(config);
      break;
    case "doctor": {
      const result = await runDoctor(config);
      console.log(result.lines.join("\n"));
      if (!result.ok) {
        Deno.exitCode = 1;
      }
      break;
    }
    case "help":
    case null:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp(): void {
  printWrapperHelp();
  console.log(`pando-proxy

Commands:
  serve      Start only the local OpenAI-compatible proxy
  doctor     Check port, credentials, and upstream reachability

Serve/doctor options:
  --host <host>                      Default: 127.0.0.1
  --port <port>                      Default: 8787
  --upstream-base-url <url>          Default: auto
  --small-structured-model <model>   Default: cheap structured model
  --overflow-structured-model <model> Default: smallest larger-window model
  --state-dir <path>                 Default: ~/.pando-proxy
  --codex-auto-compact-token-limit <n> Default: 200000
  --no-memory                        Bypass task/piece memory rewrite
  --log-file <path>                  Write redacted proxy events as JSONL
`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  });
}

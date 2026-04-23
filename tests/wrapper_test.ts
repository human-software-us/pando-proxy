import {
  buildRemoteCodexArgs,
  classifyCodexRunMode,
  ensureExecJsonArg,
  hasCodexRemoteArg,
} from "../src/codex_modes.ts";
import {
  buildCodexArgs,
  codexProviderConfigArg,
  createUniqueLogFile,
  parseWrapperArgs,
  resolveWrapperLogFile,
  startProxyOnAvailablePort,
} from "../src/wrapper.ts";

Deno.test("wrapper parses proxy flags and leaves codex args untouched", () => {
  const parsed = parseWrapperArgs([
    "--proxy-no-memory",
    "--proxy-port-start",
    "40130",
    "exec",
    "--sandbox",
    "read-only",
    "say hi",
  ]);

  assertEquals(parsed.options.memoryEnabled, false);
  assertEquals(parsed.options.portStart, 40130);
  assertEquals(parsed.options.logEnabled, undefined);
  assertEquals(parsed.codexArgs, ["exec", "--sandbox", "read-only", "say hi"]);
});

Deno.test("wrapper logging is disabled by default", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveWrapperLogFile({}, tempDir), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper --proxy-log enables unique per-instance log file", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const parsed = parseWrapperArgs(["--proxy-log", "exec", "hello"]);
    const path = await resolveWrapperLogFile(parsed.options, tempDir);

    assert(path !== null);
    assert(path.startsWith(`${tempDir}/logs/pando-proxy-`));
    assert(path.endsWith(".jsonl"));
    assertEquals(await Deno.readTextFile(path), "");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper --proxy-log-file enables explicit log file", async () => {
  const parsed = parseWrapperArgs(["--proxy-log-file", "/tmp/pando-explicit.jsonl", "exec"]);

  assertEquals(parsed.options.logEnabled, true);
  assertEquals(
    await resolveWrapperLogFile(parsed.options, "/tmp/pando-state"),
    "/tmp/pando-explicit.jsonl",
  );
});

Deno.test("wrapper stops parsing proxy flags after separator", () => {
  const parsed = parseWrapperArgs(["--proxy-no-memory", "--", "--proxy-no-memory"]);

  assertEquals(parsed.options.memoryEnabled, false);
  assertEquals(parsed.codexArgs, ["--proxy-no-memory"]);
});

Deno.test("wrapper leaves flags after first codex arg untouched", () => {
  const parsed = parseWrapperArgs(["exec", "--help", "--proxy-no-memory"]);

  assertEquals(parsed.help, false);
  assertEquals(parsed.options.memoryEnabled, undefined);
  assertEquals(parsed.codexArgs, ["exec", "--help", "--proxy-no-memory"]);
});

Deno.test("wrapper allows exec as the first codex argument", () => {
  const parsed = parseWrapperArgs(["exec", "--json", "--", "say hi"]);

  assertEquals(parsed.help, false);
  assertEquals(parsed.options, {});
  assertEquals(parsed.codexArgs, ["exec", "--json", "--", "say hi"]);
});

Deno.test("wrapper passes resume command forms through unchanged", () => {
  const parsed = parseWrapperArgs(["resume", "--last", "continue with the next task"]);

  assertEquals(parsed.help, false);
  assertEquals(parsed.options, {});
  assertEquals(parsed.codexArgs, ["resume", "--last", "continue with the next task"]);
});

Deno.test("wrapper passes codex help command through unchanged", () => {
  const parsed = parseWrapperArgs(["help", "exec"]);

  assertEquals(parsed.help, false);
  assertEquals(parsed.options, {});
  assertEquals(parsed.codexArgs, ["help", "exec"]);
});

Deno.test("wrapper passes app-server command forms through unchanged", () => {
  const parsed = parseWrapperArgs(["app-server", "--listen", "ws://127.0.0.1:45123"]);

  assertEquals(parsed.help, false);
  assertEquals(parsed.options, {});
  assertEquals(parsed.codexArgs, ["app-server", "--listen", "ws://127.0.0.1:45123"]);
});

Deno.test("codex args inject pando provider overrides before user args", () => {
  const args = buildCodexArgs(["exec", "hello"], {
    host: "127.0.0.1",
    port: 40123,
    upstreamBaseUrl: "auto",
    apiKey: null,
    maintenanceModel: null,
    stateDir: "/tmp/pando",
    syntheticCharBudget: 12_000,
    maintenanceTimeoutMs: 60_000,
    memoryEnabled: true,
    logFile: "/tmp/pando/log.jsonl",
  });

  assertEquals(args[0], "-c");
  assertEquals(args[1], 'model_provider="pando-proxy"');
  assertEquals(args[2], "-c");
  assert(args[3].includes("model_providers.pando-proxy"));
  assert(args[3].includes('base_url = "http://127.0.0.1:40123/v1"'));
  assert(args[3].includes('wire_api = "responses"'));
  assert(args[3].includes("requires_openai_auth = true"));
  assertEquals(args.slice(4), ["exec", "hello"]);
});

Deno.test("codex mode classifier detects exec with leading global options", () => {
  assertEquals(classifyCodexRunMode(["-m", "gpt-5.1-codex", "exec", "hello"]), "exec-json");
  assertEquals(
    ensureExecJsonArg(["-m", "gpt-5.1-codex", "exec", "hello"]),
    ["-m", "gpt-5.1-codex", "exec", "--json", "hello"],
  );
});

Deno.test("exec-json mode covers command aliases and inline global options", () => {
  assertEquals(classifyCodexRunMode(["exec", "hello"]), "exec-json");
  assertEquals(classifyCodexRunMode(["e", "hello"]), "exec-json");
  assertEquals(classifyCodexRunMode(["--model=gpt-5.4", "exec", "hello"]), "exec-json");
  assertEquals(classifyCodexRunMode(["-c", "model=gpt-5.4", "e", "hello"]), "exec-json");
});

Deno.test("exec-json mode injects json exactly after exec command", () => {
  assertEquals(ensureExecJsonArg(["exec", "--sandbox", "read-only", "hello"]), [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "hello",
  ]);
  assertEquals(ensureExecJsonArg(["--model=gpt-5.4", "e", "hello"]), [
    "--model=gpt-5.4",
    "e",
    "--json",
    "hello",
  ]);
});

Deno.test("codex mode classifier keeps explicit exec json unchanged", () => {
  assertEquals(ensureExecJsonArg(["exec", "--json", "hello"]), ["exec", "--json", "hello"]);
});

Deno.test("codex mode classifier detects interactive and passthrough forms", () => {
  assertEquals(classifyCodexRunMode([]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["resume", "--last"]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["fork", "--last"]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["help", "exec"]), "passthrough");
  assertEquals(classifyCodexRunMode(["app-server", "--listen", "stdio://"]), "passthrough");
  assertEquals(classifyCodexRunMode(["Help me with this repo"]), "interactive-remote");
});

Deno.test("interactive-remote mode covers prompts, empty args, and session commands", () => {
  assertEquals(classifyCodexRunMode([]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["Help me with this repo"]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["--model", "gpt-5.4", "Help me"]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["resume", "--last"]), "interactive-remote");
  assertEquals(classifyCodexRunMode(["fork", "019abc"]), "interactive-remote");
});

Deno.test("interactive-remote mode prepends wrapper-managed remote endpoint", () => {
  assertEquals(buildRemoteCodexArgs([], "ws://127.0.0.1:40125"), [
    "--remote",
    "ws://127.0.0.1:40125",
  ]);
  assertEquals(
    buildRemoteCodexArgs(["--model", "gpt-5.4", "resume", "--last"], "ws://127.0.0.1:40125"),
    ["--remote", "ws://127.0.0.1:40125", "--model", "gpt-5.4", "resume", "--last"],
  );
});

Deno.test("interactive-remote mode detects user-provided remote args", () => {
  assertEquals(hasCodexRemoteArg(["--remote", "ws://127.0.0.1:1"]), true);
  assertEquals(hasCodexRemoteArg(["--remote=ws://127.0.0.1:1"]), true);
  assertEquals(hasCodexRemoteArg(["--model", "gpt-5.4", "resume", "--last"]), false);
});

Deno.test("passthrough mode covers utility commands and top-level flags", () => {
  assertEquals(classifyCodexRunMode(["help", "exec"]), "passthrough");
  assertEquals(classifyCodexRunMode(["--help"]), "passthrough");
  assertEquals(classifyCodexRunMode(["--version"]), "passthrough");
  assertEquals(classifyCodexRunMode(["login"]), "passthrough");
  assertEquals(classifyCodexRunMode(["logout"]), "passthrough");
  assertEquals(classifyCodexRunMode(["app-server", "--listen", "ws://127.0.0.1:1"]), "passthrough");
  assertEquals(classifyCodexRunMode(["mcp", "list"]), "passthrough");
});

Deno.test("passthrough mode does not add exec json to non-exec commands", () => {
  assertEquals(ensureExecJsonArg(["help", "exec"]), ["help", "exec"]);
  assertEquals(ensureExecJsonArg(["app-server", "--listen", "stdio://"]), [
    "app-server",
    "--listen",
    "stdio://",
  ]);
});

Deno.test("remote codex args prepend wrapper-managed relay", () => {
  assertEquals(
    buildRemoteCodexArgs(["resume", "--last"], "ws://127.0.0.1:40125"),
    ["--remote", "ws://127.0.0.1:40125", "resume", "--last"],
  );
  assertEquals(hasCodexRemoteArg(["--remote", "ws://127.0.0.1:1"]), true);
  assertEquals(hasCodexRemoteArg(["--remote=ws://127.0.0.1:1"]), true);
  assertEquals(hasCodexRemoteArg(["resume", "--last"]), false);
});

Deno.test("provider config arg points codex at the selected proxy port", () => {
  assertEquals(
    codexProviderConfigArg({ host: "127.0.0.1", port: 40124 }),
    'model_providers.pando-proxy={ name = "Pando Memory Proxy", base_url = "http://127.0.0.1:40124/v1", wire_api = "responses", requires_openai_auth = true }',
  );
});

Deno.test("auto log files are unique per wrapper instance", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const first = await createUniqueLogFile(tempDir);
    const second = await createUniqueLogFile(tempDir);

    assert(first !== second);
    assert(first.endsWith(".jsonl"));
    assert(second.endsWith(".jsonl"));
    assertEquals(await Deno.readTextFile(first), "");
    assertEquals(await Deno.readTextFile(second), "");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("proxy port allocation skips busy start port", async () => {
  const tempDir = await Deno.makeTempDir();
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const startPort = (listener.addr as Deno.NetAddr).port;

  try {
    if (startPort >= 65_535) {
      return;
    }
    const started = startProxyOnAvailablePort({
      host: "127.0.0.1",
      port: startPort,
      upstreamBaseUrl: "auto",
      apiKey: null,
      maintenanceModel: null,
      stateDir: tempDir,
      syntheticCharBudget: 12_000,
      maintenanceTimeoutMs: 60_000,
      memoryEnabled: false,
      logFile: null,
    }, startPort);

    try {
      assert(started.config.port > startPort);
    } finally {
      await started.server.shutdown();
    }
  } finally {
    listener.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

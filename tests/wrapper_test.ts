import {
  buildCodexArgs,
  codexProviderConfigArg,
  createUniqueLogFile,
  parseWrapperArgs,
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
  assertEquals(parsed.codexArgs, ["exec", "--sandbox", "read-only", "say hi"]);
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

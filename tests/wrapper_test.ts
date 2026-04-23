import {
  buildRemoteCodexArgs,
  classifyCodexRunMode,
  ensureExecJsonArg,
  hasCodexRemoteArg,
} from "../src/codex_modes.ts";
import {
  buildCodexArgs,
  buildCodexExecArgs,
  codexAliasTarget,
  codexProviderConfigArg,
  createUniqueLogFile,
  installCodexAlias,
  maybeOfferCodexAlias,
  parseWrapperArgs,
  resolveWrapperLogFile,
  runCodexWrapper,
  startProxyOnAvailablePort,
  wrapperPreferencesPath,
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

Deno.test("wrapper alias prompt records first run without asking", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    let prompted = false;
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => {
        prompted = true;
        return true;
      },
      now: fixedNow,
    });

    assertEquals(prompted, false);
    const preferences = await readJson(wrapperPreferencesPath(tempDir));
    assertEquals(preferences.runCount, 1);
    assertEquals(preferences.codexAliasPrompt, undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper alias prompt installs zsh alias on second accepted run", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => true,
      shell: "/bin/zsh",
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => true,
      shell: "/bin/zsh",
      now: fixedNow,
    });

    const zshrc = await Deno.readTextFile(`${tempDir}/.zshrc`);
    assert(zshrc.includes("alias codex='npx -y pando-proxy'"));
    const preferences = await readJson(wrapperPreferencesPath(tempDir));
    assertEquals(preferences.runCount, 2);
    assertEquals(preferences.codexAliasPrompt.response, "yes");
    assertEquals(preferences.codexAliasPrompt.install.status, "installed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper alias prompt remembers declined second run", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => true,
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => false,
      shell: "/bin/zsh",
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => {
        throw new Error("should not prompt after recorded answer");
      },
      shell: "/bin/zsh",
      now: fixedNow,
    });

    const preferences = await readJson(wrapperPreferencesPath(tempDir));
    assertEquals(preferences.runCount, 3);
    assertEquals(preferences.codexAliasPrompt.response, "no");
    await assertNotFound(`${tempDir}/.zshrc`);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper alias prompt skips noninteractive second run and asks later", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: false,
      confirmAlias: () => {
        throw new Error("should not prompt on first run");
      },
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: false,
      confirmAlias: () => {
        throw new Error("should not prompt without terminal");
      },
      shell: "/bin/zsh",
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => true,
      shell: "/bin/zsh",
      now: fixedNow,
    });

    const preferences = await readJson(wrapperPreferencesPath(tempDir));
    assertEquals(preferences.runCount, 3);
    assertEquals(preferences.codexAliasPrompt.response, "yes");
    assert((await Deno.readTextFile(`${tempDir}/.zshrc`)).includes("pando-proxy"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper alias installer selects shell rc formats and avoids duplicates", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(
      codexAliasTarget(tempDir, "/opt/homebrew/bin/fish", "darwin").path,
      `${tempDir}/.config/fish/config.fish`,
    );
    assertEquals(
      codexAliasTarget(tempDir, "/bin/bash", "darwin").path,
      `${tempDir}/.bash_profile`,
    );

    const first = await installCodexAlias(tempDir, "/opt/homebrew/bin/fish", "darwin");
    const second = await installCodexAlias(tempDir, "/opt/homebrew/bin/fish", "darwin");
    assertEquals(first.status, "installed");
    assertEquals(second.status, "already_present");

    const fishConfig = await Deno.readTextFile(`${tempDir}/.config/fish/config.fish`);
    assertEquals((fishConfig.match(/pando-proxy/g) ?? []).length, 3);
    assert(fishConfig.includes('alias codex "npx -y pando-proxy"'));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("wrapper alias prompt stores failed install answer and does not ask again", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => {
        throw new Error("should not prompt on first run");
      },
      now: fixedNow,
    });
    await Deno.mkdir(`${tempDir}/.zshrc`);
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => true,
      shell: "/bin/zsh",
      now: fixedNow,
    });
    await maybeOfferCodexAlias({
      homeDir: tempDir,
      isInteractive: true,
      confirmAlias: () => {
        throw new Error("should not prompt after failed accepted install");
      },
      shell: "/bin/zsh",
      now: fixedNow,
    });

    const preferences = await readJson(wrapperPreferencesPath(tempDir));
    assertEquals(preferences.runCount, 3);
    assertEquals(preferences.codexAliasPrompt.response, "yes");
    assertEquals(preferences.codexAliasPrompt.install.status, "failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
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
  assertEquals(args[3], 'model_providers.pando-proxy.name="Pando Memory Proxy"');
  assertEquals(args[4], "-c");
  assertEquals(args[5], 'model_providers.pando-proxy.base_url="http://127.0.0.1:40123/v1"');
  assertEquals(args[6], "-c");
  assertEquals(args[7], 'model_providers.pando-proxy.wire_api="responses"');
  assertEquals(args[8], "-c");
  assertEquals(args[9], "model_providers.pando-proxy.requires_openai_auth=true");
  assertEquals(args.slice(10), ["exec", "hello"]);
});

Deno.test("exec args inject pando provider overrides inside exec command", () => {
  const args = buildCodexExecArgs(["-m", "gpt-5.4", "exec", "--json", "-c", "x=1", "hello"], {
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

  assertEquals(args.slice(0, 3), ["-m", "gpt-5.4", "exec"]);
  assertHasProviderArgsAt(args, 3);
  assertEquals(args.slice(13), ["--json", "-c", "x=1", "hello"]);
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
    '-c model_providers.pando-proxy.name="Pando Memory Proxy" -c model_providers.pando-proxy.base_url="http://127.0.0.1:40124/v1" -c model_providers.pando-proxy.wire_api="responses" -c model_providers.pando-proxy.requires_openai_auth=true',
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

Deno.test("wrapper exec forwards mixed leading globals and injects json", async () => {
  await withFakeCodex(async ({ logPath, tempDir }) => {
    const exitCode = await runCodexWrapper([
      ...wrapperTestProxyArgs(tempDir),
      "-m",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="medium"',
      "exec",
      "--sandbox",
      "read-only",
      "say hi",
    ]);

    assertEquals(exitCode, 0);
    const [invoke] = await readFakeCodexInvocations(logPath);
    assertEquals(invoke.args.slice(0, 5), [
      "-m",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="medium"',
      "exec",
    ]);
    assertHasProviderArgsAt(invoke.args, 5);
    assertEquals(invoke.args.slice(15), ["--json", "--sandbox", "read-only", "say hi"]);
  });
});

Deno.test("wrapper exec preserves explicit json and inline global option forms", async () => {
  await withFakeCodex(async ({ logPath, tempDir }) => {
    const exitCode = await runCodexWrapper([
      ...wrapperTestProxyArgs(tempDir),
      "--model=gpt-5.4",
      "e",
      "--json",
      "--",
      "literal prompt --proxy-no-memory",
    ]);

    assertEquals(exitCode, 0);
    const [invoke] = await readFakeCodexInvocations(logPath);
    assertEquals(invoke.args.slice(0, 2), ["--model=gpt-5.4", "e"]);
    assertHasProviderArgsAt(invoke.args, 2);
    assertEquals(invoke.args.slice(12), ["--json", "--", "literal prompt --proxy-no-memory"]);
  });
});

Deno.test("wrapper passthrough utility command forwards args without exec json", async () => {
  await withFakeCodex(async ({ logPath, tempDir }) => {
    const exitCode = await runCodexWrapper([
      ...wrapperTestProxyArgs(tempDir),
      "help",
      "exec",
    ]);

    assertEquals(exitCode, 0);
    const [invoke] = await readFakeCodexInvocations(logPath);
    assertHasProviderPrefix(invoke.args);
    assertEquals(invoke.args.slice(10), ["help", "exec"]);
    assertEquals(invoke.args.includes("--json"), false);
  });
});

Deno.test("wrapper interactive mode starts app-server then UI with managed remote", async () => {
  await withFakeCodex(async ({ logPath, tempDir }) => {
    const exitCode = await runCodexWrapper([
      ...wrapperTestProxyArgs(tempDir),
      "--model",
      "gpt-5.4",
      "resume",
      "--last",
      "continue",
    ]);

    assertEquals(exitCode, 0);
    const invocations = await readFakeCodexInvocations(logPath);
    assertEquals(invocations.length, 2);

    const [appServer, ui] = invocations;
    assertHasProviderPrefix(appServer.args);
    assertEquals(appServer.args.slice(10, 12), ["app-server", "--listen"]);
    assert(appServer.args[12].startsWith("ws://127.0.0.1:"));

    assertEquals(ui.args.slice(0, 2), ["--remote", ui.args[1]]);
    assert(ui.args[1].startsWith("ws://127.0.0.1:"));
    assertEquals(ui.args.slice(2), ["--model", "gpt-5.4", "resume", "--last", "continue"]);
  });
});

Deno.test("wrapper returns codex nonzero exit code unchanged", async () => {
  await withFakeCodex(async ({ logPath, tempDir }) => {
    Deno.env.set("PANDO_FAKE_CODEX_EXIT_CODE", "37");
    Deno.env.set("PANDO_FAKE_CODEX_STDERR", "codex synthetic failure");

    const exitCode = await runCodexWrapper([
      ...wrapperTestProxyArgs(tempDir),
      "exec",
      "fail please",
    ]);

    assertEquals(exitCode, 37);
    const [invoke] = await readFakeCodexInvocations(logPath);
    assertEquals(invoke.args[0], "exec");
    assertHasProviderArgsAt(invoke.args, 1);
    assertEquals(invoke.args.slice(11), ["--json", "fail please"]);

    const proxyLog = await readJsonl(`${tempDir}/proxy.jsonl`);
    const wrapperExit = proxyLog.find((event) => event.event === "wrapper_exit");
    assertEquals(wrapperExit?.code, 37);
    assertEquals(wrapperExit?.success, false);
  });
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

type FakeCodexInvocation = {
  event: "invoke";
  args: string[];
};

async function withFakeCodex(
  callback: (context: { tempDir: string; logPath: string }) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const binDir = `${tempDir}/bin`;
  const logPath = `${tempDir}/codex-invocations.jsonl`;
  const oldPath = Deno.env.get("PATH");
  const oldHome = Deno.env.get("HOME");
  const oldUserProfile = Deno.env.get("USERPROFILE");
  const oldFakeLog = Deno.env.get("PANDO_FAKE_CODEX_LOG");
  const oldFakeExitCode = Deno.env.get("PANDO_FAKE_CODEX_EXIT_CODE");
  const oldFakeStdout = Deno.env.get("PANDO_FAKE_CODEX_STDOUT");
  const oldFakeStderr = Deno.env.get("PANDO_FAKE_CODEX_STDERR");

  await Deno.mkdir(binDir, { recursive: true });
  await writeFakeCodexExecutable(binDir);
  Deno.env.set("PATH", `${binDir}${pathDelimiter()}${oldPath ?? ""}`);
  Deno.env.set("HOME", tempDir);
  Deno.env.set("USERPROFILE", tempDir);
  Deno.env.set("PANDO_FAKE_CODEX_LOG", logPath);
  Deno.env.delete("PANDO_FAKE_CODEX_EXIT_CODE");
  Deno.env.delete("PANDO_FAKE_CODEX_STDOUT");
  Deno.env.delete("PANDO_FAKE_CODEX_STDERR");

  try {
    await callback({ tempDir, logPath });
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("HOME", oldHome);
    restoreEnv("USERPROFILE", oldUserProfile);
    restoreEnv("PANDO_FAKE_CODEX_LOG", oldFakeLog);
    restoreEnv("PANDO_FAKE_CODEX_EXIT_CODE", oldFakeExitCode);
    restoreEnv("PANDO_FAKE_CODEX_STDOUT", oldFakeStdout);
    restoreEnv("PANDO_FAKE_CODEX_STDERR", oldFakeStderr);
    await Deno.remove(tempDir, { recursive: true });
  }
}

function wrapperTestProxyArgs(tempDir: string): string[] {
  return [
    "--proxy-host",
    "127.0.0.1",
    "--proxy-port-start",
    String(findFreePort()),
    "--proxy-state-dir",
    `${tempDir}/state`,
    "--proxy-no-memory",
    "--proxy-log-file",
    `${tempDir}/proxy.jsonl`,
  ];
}

async function writeFakeCodexExecutable(binDir: string): Promise<void> {
  const scriptPath = `${binDir}/fake_codex.ts`;
  await Deno.writeTextFile(scriptPath, fakeCodexScript());

  if (Deno.build.os === "windows") {
    await Deno.writeTextFile(
      `${binDir}/codex.cmd`,
      `@echo off\r\n"${Deno.execPath()}" run --allow-env --allow-write --allow-net "${scriptPath}" %*\r\n`,
    );
    return;
  }

  const codexPath = `${binDir}/codex`;
  await Deno.writeTextFile(
    codexPath,
    `#!/bin/sh\nexec '${shellEscape(Deno.execPath())}' run --allow-env --allow-write --allow-net '${
      shellEscape(scriptPath)
    }' "$@"\n`,
  );
  await Deno.chmod(codexPath, 0o755);
}

function fakeCodexScript(): string {
  return `
const logPath = Deno.env.get("PANDO_FAKE_CODEX_LOG");
if (!logPath) {
  throw new Error("PANDO_FAKE_CODEX_LOG is required");
}

await Deno.writeTextFile(
  logPath,
  JSON.stringify({ event: "invoke", args: Deno.args }) + "\\n",
  { append: true, create: true },
);

if (Deno.args.includes("app-server")) {
  const listenIndex = Deno.args.indexOf("--listen");
  const listen = listenIndex >= 0 ? Deno.args[listenIndex + 1] : "";
  const url = new URL(listen);
  const listener = Deno.listen({
    hostname: url.hostname || "127.0.0.1",
    port: Number(url.port),
  });
  await Deno.writeTextFile(
    logPath,
    JSON.stringify({ event: "app-server-listening", addr: listener.addr }) + "\\n",
    { append: true, create: true },
  );
  for await (const connection of listener) {
    connection.close();
  }
}

const stderr = Deno.env.get("PANDO_FAKE_CODEX_STDERR");
if (stderr) {
  console.error(stderr);
}
const stdout = Deno.env.get("PANDO_FAKE_CODEX_STDOUT");
if (stdout) {
  console.log(stdout);
}
Deno.exit(Number(Deno.env.get("PANDO_FAKE_CODEX_EXIT_CODE") ?? "0"));
`;
}

async function readFakeCodexInvocations(logPath: string): Promise<FakeCodexInvocation[]> {
  return (await readJsonl(logPath)).filter((event): event is FakeCodexInvocation =>
    event.event === "invoke"
  );
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function assertNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected ${path} not to exist`);
}

function assertHasProviderPrefix(args: string[]): void {
  assertHasProviderArgsAt(args, 0);
}

function assertHasProviderArgsAt(args: string[], index: number): void {
  assertEquals(args[index], "-c");
  assertEquals(args[index + 1], 'model_provider="pando-proxy"');
  assertEquals(args[index + 2], "-c");
  assertEquals(args[index + 3], 'model_providers.pando-proxy.name="Pando Memory Proxy"');
  assertEquals(args[index + 4], "-c");
  assert(args[index + 5].startsWith('model_providers.pando-proxy.base_url="http://127.0.0.1:'));
  assertEquals(args[index + 6], "-c");
  assertEquals(args[index + 7], 'model_providers.pando-proxy.wire_api="responses"');
  assertEquals(args[index + 8], "-c");
  assertEquals(args[index + 9], "model_providers.pando-proxy.requires_openai_auth=true");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}

function findFreePort(): number {
  for (let port = 41_000; port < 60_000; port += 1) {
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port });
      listener.close();
      return port;
    } catch {
      continue;
    }
  }

  throw new Error("Could not find a free wrapper test port");
}

function pathDelimiter(): string {
  return Deno.build.os === "windows" ? ";" : ":";
}

function shellEscape(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function fixedNow(): Date {
  return new Date("2026-04-23T00:00:00.000Z");
}

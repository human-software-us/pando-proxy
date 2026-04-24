import { assert, assertEquals } from "jsr:@std/assert";

import { classifyCodexRunMode } from "../src/codex_modes.ts";
import {
  createInteractiveStateSyncer,
  installCodexAlias,
  parseWrapperArgs,
  resolveInteractiveSessionKeyHint,
  rewriteResumeLastArgs,
  syncInteractiveSessionsToSourceHome,
  uninstallCodexAlias,
  WRAPPER_LAST_THREAD_RELATIVE_PATH,
} from "../src/wrapper.ts";

Deno.test("parseWrapperArgs accepts structured model wrapper flags", () => {
  const parsed = parseWrapperArgs([
    "--proxy-small-structured-model",
    "gpt-4.1-mini",
    "--proxy-overflow-structured-model",
    "gpt-5-mini",
    "exec",
    "hi",
  ]);

  assertEquals(parsed.options.smallStructuredModel, "gpt-4.1-mini");
  assertEquals(parsed.options.overflowStructuredModel, "gpt-5-mini");
  assertEquals(parsed.codexArgs, ["exec", "hi"]);
});

Deno.test("parseWrapperArgs accepts uninstall-codex-alias", () => {
  const parsed = parseWrapperArgs(["--uninstall-codex-alias"]);
  assertEquals(parsed.uninstallCodexAlias, true);
  assertEquals(parsed.codexArgs, []);
});

Deno.test("interactive commands default to direct mode", () => {
  assertEquals(classifyCodexRunMode([]), "interactive-direct");
  assertEquals(classifyCodexRunMode(["resume", "--last"]), "interactive-direct");
  assertEquals(classifyCodexRunMode(["fork", "thread_123"]), "interactive-direct");
});

Deno.test("rewriteResumeLastArgs only rewrites exec resume --last", async () => {
  const stateDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${stateDir}`, { recursive: true });
    await Deno.writeTextFile(
      `${stateDir}/${WRAPPER_LAST_THREAD_RELATIVE_PATH}`,
      `${JSON.stringify({ threadId: "thread_saved" }, null, 2)}\n`,
    );

    assertEquals(
      await rewriteResumeLastArgs(
        ["exec", "resume", "--last", "--sandbox", "read-only", "continue"],
        stateDir,
        "exec-json",
      ),
      ["exec", "--sandbox", "read-only", "resume", "thread_saved", "continue"],
    );
    assertEquals(
      await rewriteResumeLastArgs(["resume", "--last"], stateDir, "interactive-direct"),
      ["resume", "--last"],
    );
  } finally {
    await Deno.remove(stateDir, { recursive: true });
  }
});

Deno.test("syncInteractiveSessionsToSourceHome copies private sessions into the source home", async () => {
  const sourceHome = await Deno.makeTempDir();
  const privateHome = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${privateHome}/sessions/2026/04/24`, { recursive: true });
    await Deno.writeTextFile(
      `${privateHome}/sessions/2026/04/24/session.jsonl`,
      '{"type":"session_meta","payload":{"id":"thread_123"}}\n',
    );

    await syncInteractiveSessionsToSourceHome(privateHome, sourceHome, { log: async () => {} });

    assertEquals(
      await Deno.readTextFile(`${sourceHome}/sessions/2026/04/24/session.jsonl`),
      '{"type":"session_meta","payload":{"id":"thread_123"}}\n',
    );
  } finally {
    await Deno.remove(sourceHome, { recursive: true });
    await Deno.remove(privateHome, { recursive: true });
  }
});

Deno.test("syncInteractiveSessionsToSourceHome updates older source files and preserves newer ones", async () => {
  const sourceHome = await Deno.makeTempDir();
  const privateHome = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${sourceHome}/sessions/nested`, { recursive: true });
    await Deno.mkdir(`${privateHome}/sessions/nested`, { recursive: true });

    const sharedTarget = `${sourceHome}/sessions/nested/shared.jsonl`;
    const sharedSource = `${privateHome}/sessions/nested/shared.jsonl`;
    const newerTarget = `${sourceHome}/sessions/nested/newer.jsonl`;
    const olderSource = `${privateHome}/sessions/nested/newer.jsonl`;

    await Deno.writeTextFile(sharedTarget, "old\n");
    await Deno.writeTextFile(sharedSource, "new\n");
    await Deno.writeTextFile(newerTarget, "keep\n");
    await Deno.writeTextFile(olderSource, "stale\n");

    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await Deno.utime(sharedTarget, past, past);
    await Deno.utime(sharedSource, future, future);
    await Deno.utime(newerTarget, future, future);
    await Deno.utime(olderSource, past, past);

    await syncInteractiveSessionsToSourceHome(privateHome, sourceHome, { log: async () => {} });

    assertEquals(await Deno.readTextFile(sharedTarget), "new\n");
    assertEquals(await Deno.readTextFile(newerTarget), "keep\n");
  } finally {
    await Deno.remove(sourceHome, { recursive: true });
    await Deno.remove(privateHome, { recursive: true });
  }
});

Deno.test("resolveInteractiveSessionKeyHint uses the newest private CODEX_HOME session file", async () => {
  const stateDir = await Deno.makeTempDir();
  const privateHome = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${privateHome}/sessions/2026/04/24`, { recursive: true });
    await Deno.writeTextFile(
      `${privateHome}/sessions/2026/04/24/session.jsonl`,
      '{"type":"session_meta","payload":{"id":"thread_private"}}\n',
    );

    const sessionId = await resolveInteractiveSessionKeyHint(
      ["resume", "--last"],
      stateDir,
      privateHome,
      { log: async () => {} },
    );

    assertEquals(sessionId, "thread_private");
  } finally {
    await Deno.remove(stateDir, { recursive: true });
    await Deno.remove(privateHome, { recursive: true });
  }
});

Deno.test("createInteractiveStateSyncer skips repeated sync after success", async () => {
  const sourceHome = await Deno.makeTempDir();
  const privateHome = await Deno.makeTempDir();
  const events: Array<{ event: string; payload: unknown }> = [];
  try {
    await Deno.mkdir(`${privateHome}/sessions/2026/04/24`, { recursive: true });
    await Deno.writeTextFile(
      `${privateHome}/sessions/2026/04/24/session.jsonl`,
      '{"type":"session_meta","payload":{"id":"thread_123"}}\n',
    );

    const sync = createInteractiveStateSyncer(
      { privateCodexHome: privateHome, sourceCodexHome: sourceHome },
      {
        log: async (event: string, payload: unknown) => {
          events.push({ event, payload });
        },
      } as { log: (event: string, payload: unknown) => Promise<void> },
    );

    await sync("interactive_child_exit");
    await sync("proxy_shutdown:wrapper_exit");

    assertEquals(
      events.filter(({ event }) => event === "interactive_sessions_synced_to_source_home").length,
      1,
    );
  } finally {
    await Deno.remove(sourceHome, { recursive: true });
    await Deno.remove(privateHome, { recursive: true });
  }
});

Deno.test("uninstallCodexAlias removes installed zsh alias block", async () => {
  const homeDir = await Deno.makeTempDir();
  try {
    const install = await installCodexAlias(homeDir, "/bin/zsh", "darwin");
    assertEquals(install.status, "installed");

    const uninstall = await uninstallCodexAlias(homeDir, "/bin/zsh", "darwin");
    assertEquals(uninstall.status, "removed");

    const zshrc = await Deno.readTextFile(`${homeDir}/.zshrc`);
    assert(!zshrc.includes("pando-proxy codex alias"));
    assert(!zshrc.includes("alias codex='npx -y pando-proxy'"));
  } finally {
    await Deno.remove(homeDir, { recursive: true });
  }
});

Deno.test("uninstallCodexAlias reports not_present when alias is absent", async () => {
  const homeDir = await Deno.makeTempDir();
  try {
    const uninstall = await uninstallCodexAlias(homeDir, "/bin/zsh", "darwin");
    assertEquals(uninstall.status, "not_present");
  } finally {
    await Deno.remove(homeDir, { recursive: true });
  }
});

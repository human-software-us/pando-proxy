import { assert, assertEquals } from "jsr:@std/assert";

import {
  installCodexAlias,
  parseWrapperArgs,
  uninstallCodexAlias,
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

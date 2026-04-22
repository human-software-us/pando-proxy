#!/usr/bin/env node

const path = require("node:path");
const process = require("node:process");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const bundledEntrypoint = path.resolve(__dirname, "..", "dist", "main.js");
const sourceEntrypoint = path.resolve(__dirname, "..", "src", "main.ts");
const entrypoint = fs.existsSync(bundledEntrypoint) ? bundledEntrypoint : sourceEntrypoint;
const args = [
  "run",
  "--allow-net",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  entrypoint,
  ...process.argv.slice(2),
];

const child = spawn("deno", args, { stdio: "inherit" });

child.on("error", (error) => {
  if (error && error.code === "ENOENT") {
    console.error("deno was not found on PATH. Install Deno to run pando-proxy from npm.");
    process.exitCode = 127;
    return;
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

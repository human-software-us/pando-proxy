import { modelsUrl, ProxyConfig, resolveUpstreamBaseUrl } from "./config.ts";
import { isCodexConfigInstalled } from "./install.ts";

export type DoctorResult = {
  ok: boolean;
  lines: string[];
};

export async function runDoctor(config: ProxyConfig): Promise<DoctorResult> {
  const checks = await Promise.all([
    checkDenoVersion(),
    Promise.resolve(checkPort(config)),
    checkApiKey(config),
    checkUpstream(config),
    checkCodexConfig(),
  ]);

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    lines: checks.map((check) => `${check.ok ? "ok" : "fail"}  ${check.message}`),
  };
}

type Check = {
  ok: boolean;
  message: string;
};

function checkDenoVersion(): Check {
  return { ok: true, message: `Deno ${Deno.version.deno}` };
}

function checkPort(config: ProxyConfig): Check {
  try {
    const listener = Deno.listen({ hostname: config.host, port: config.port });
    listener.close();
    return { ok: true, message: `port ${config.host}:${config.port} is available` };
  } catch {
    return { ok: false, message: `port ${config.host}:${config.port} is busy` };
  }
}

function checkApiKey(config: ProxyConfig): Check {
  return config.apiKey ? { ok: true, message: "OPENAI_API_KEY fallback is present" } : {
    ok: true,
    message: "OPENAI_API_KEY fallback is absent; proxy will use Codex-sent Authorization",
  };
}

async function checkUpstream(config: ProxyConfig): Promise<Check> {
  if (!config.apiKey) {
    return {
      ok: true,
      message: "upstream reachability skipped until Codex sends Authorization",
    };
  }
  try {
    const authHeader = `Bearer ${config.apiKey}`;
    const response = await fetch(
      modelsUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader)),
      {
        headers: { authorization: authHeader },
        signal: AbortSignal.timeout(5_000),
      },
    );
    return response.ok
      ? { ok: true, message: `upstream reachable at ${config.upstreamBaseUrl}` }
      : {
        ok: false,
        message: `upstream returned ${response.status} at ${config.upstreamBaseUrl}`,
      };
  } catch (error) {
    return {
      ok: false,
      message: `upstream check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkCodexConfig(): Promise<Check> {
  return await isCodexConfigInstalled()
    ? { ok: true, message: "Codex pando-memory profile is installed" }
    : { ok: false, message: "Codex pando-memory profile is not installed" };
}

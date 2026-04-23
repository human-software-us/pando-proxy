import { CodexEventObserver } from "../src/codex_events.ts";
import { findAvailablePort } from "../src/wrapper.ts";
import { startWebSocketRelayOnAvailablePort } from "../src/websocket_relay.ts";

Deno.test("websocket relay forwards frames and observes both directions", async () => {
  const logger = new RecordingLogger();
  const observer = new CodexEventObserver(logger);
  const host = "127.0.0.1";
  const upstreamPort = findAvailablePort(host, 45_120);
  const upstream = startEchoWebSocketServer(host, upstreamPort);
  const relay = startWebSocketRelayOnAvailablePort({
    host,
    portStart: upstreamPort + 1,
    upstreamUrl: `ws://${host}:${upstreamPort}`,
    observer,
  });

  try {
    const client = new WebSocket(relay.url);
    await waitForOpen(client);

    const response = waitForMessage(client);
    client.send(JSON.stringify({ method: "thread/start", id: 1 }));
    assertEquals(await response, JSON.stringify({ method: "thread/started", id: 1 }));

    await waitFor(() =>
      logger.entries.some((entry) => entry.fields.direction === "client_to_server") &&
      logger.entries.some((entry) => entry.fields.direction === "server_to_client")
    );

    const directions = logger.entries.map((entry) => entry.fields.direction);
    assert(directions.includes("client_to_server"));
    assert(directions.includes("server_to_client"));
    client.close();
  } finally {
    await relay.server.shutdown();
    await upstream.shutdown();
  }
});

function startEchoWebSocketServer(host: string, port: number): Deno.HttpServer {
  return Deno.serve({
    hostname: host,
    port,
    onListen: () => {},
  }, (request) => {
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data));
      socket.send(JSON.stringify({ method: "thread/started", id: payload.id }));
    };
    return response;
  });
}

class RecordingLogger {
  entries: Array<{ event: string; fields: Record<string, unknown> }> = [];

  log(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    this.entries.push({ event, fields });
    return Promise.resolve();
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("websocket failed to open"));
  });
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => resolve(String(event.data));
    socket.onerror = () => reject(new Error("websocket failed while waiting for message"));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

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

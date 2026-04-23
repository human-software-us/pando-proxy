import { CodexEventObserver } from "./codex_events.ts";

export type StartedWebSocketRelay = {
  server: Deno.HttpServer;
  url: string;
  port: number;
};

export function startWebSocketRelayOnAvailablePort(options: {
  host: string;
  portStart: number;
  upstreamUrl: string;
  observer: CodexEventObserver;
}): StartedWebSocketRelay {
  for (let port = options.portStart; port <= 65_535; port += 1) {
    try {
      const server = startWebSocketRelay({ ...options, port });
      return {
        server,
        port,
        url: `ws://${options.host}:${port}`,
      };
    } catch (error) {
      if (isAddressInUse(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`No available websocket relay port found at or above ${options.portStart}`);
}

function startWebSocketRelay(options: {
  host: string;
  port: number;
  upstreamUrl: string;
  observer: CodexEventObserver;
}): Deno.HttpServer {
  return Deno.serve({
    hostname: options.host,
    port: options.port,
    onListen: () => {},
  }, (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const { socket: client, response } = Deno.upgradeWebSocket(request);
    connectRelay(client, options.upstreamUrl, options.observer);
    return response;
  });
}

function connectRelay(
  client: WebSocket,
  upstreamUrl: string,
  observer: CodexEventObserver,
): void {
  const upstream = new WebSocket(upstreamUrl);
  const pendingClientFrames: unknown[] = [];
  let upstreamOpen = false;

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const frame of pendingClientFrames.splice(0)) {
      sendFrame(upstream, frame);
    }
  };

  client.onmessage = (event) => {
    void observer.observeAppServerFrame("client_to_server", event.data);
    if (upstreamOpen) {
      sendFrame(upstream, event.data);
    } else {
      pendingClientFrames.push(event.data);
    }
  };

  upstream.onmessage = (event) => {
    void observer.observeAppServerFrame("server_to_client", event.data);
    sendFrame(client, event.data);
  };

  client.onclose = () => closeSocket(upstream);
  upstream.onclose = () => closeSocket(client);

  client.onerror = () => closeSocket(upstream);
  upstream.onerror = () => closeSocket(client);
}

function sendFrame(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  if (typeof frame === "string" || frame instanceof ArrayBuffer || frame instanceof Blob) {
    socket.send(frame);
    return;
  }

  socket.send(String(frame));
}

function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse ||
    (error instanceof Error && /address already in use|addrinuse/i.test(error.message));
}

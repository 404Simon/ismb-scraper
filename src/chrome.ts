/** Make Bun's Chrome backend open tabs instead of separate windows. */
export function startChromeTabProxy(browserUrl: string): string {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("Expected a WebSocket", { status: 426 });
    },
    websocket: {
      open(client: any) {
        const chrome = new WebSocket(browserUrl);
        client.chrome = chrome;
        client.queue = [];
        chrome.onopen = () => {
          for (const message of client.queue) chrome.send(message);
          client.queue = [];
        };
        chrome.onmessage = (event) => client.send(event.data);
        chrome.onclose = () => client.close();
        chrome.onerror = () => client.close();
      },
      message(client: any, message) {
        let text = String(message);
        try {
          const command = JSON.parse(text);
          if (command.method === "Target.createTarget") {
            const params = { ...(command.params ?? {}), newWindow: false };
            delete params.left;
            delete params.top;
            delete params.width;
            delete params.height;
            text = JSON.stringify({ ...command, params });
          }
        } catch {}
        if (client.chrome.readyState === WebSocket.OPEN) client.chrome.send(text);
        else client.queue.push(text);
      },
      close(client: any) {
        client.chrome?.close();
      }
    }
  });

  return `ws://127.0.0.1:${server.port}/`;
}

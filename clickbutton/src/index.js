$utf8 = New-Object System.Text.UTF8Encoding $false
$text = @'
import { DurableObject } from "cloudflare:workers";

// The Worker is the "front door". It sends /ws requests to ONE shared
// Durable Object, so every visitor talks to the same server-side state.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const id = env.BUTTON.idFromName("main"); // same name = same object for everyone
      return env.BUTTON.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request); // everything else = your HTML/CSS/JS files
  },
};

export class Button extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket connection", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // keep this connection open
    await this.broadcast();           // tell everyone (including the newcomer)
    return new Response(null, { status: 101, webSocket: client });
  }

  // A browser sent us a message.
  async webSocketMessage(ws, message) {
    if (message === "toggle") {
      const green = (await this.ctx.storage.get("green")) || false;
      await this.ctx.storage.put("green", !green); // save the new state on the server
      await this.broadcast();                      // push it to EVERY browser
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
    await this.broadcast(ws);
  }

  async webSocketError(ws) {
    await this.broadcast(ws);
  }

  // Send the current state to everyone connected.
  async broadcast(leaving) {
    const green = (await this.ctx.storage.get("green")) || false;
    const sockets = this.ctx.getWebSockets().filter((s) => s !== leaving);
    const msg = JSON.stringify({ green, users: sockets.length });
    for (const s of sockets) {
      try { s.send(msg); } catch {}
    }
  }
}
'@
[System.IO.File]::WriteAllText("$PWD\src\index.js", $text, $utf8)
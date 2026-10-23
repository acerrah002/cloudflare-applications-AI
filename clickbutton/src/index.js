import { DurableObject } from "cloudflare:workers";

// The Worker is the front door. /api/* goes to the shared server object.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return env.BUTTON.get(env.BUTTON.idFromName("main")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// The SERVER: it remembers the color and answers requests.
export class Button extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    let green = (await this.ctx.storage.get("green")) || false;

    // POST /api/press = "someone pressed the button"
    if (url.pathname === "/api/press" && request.method === "POST") {
      green = !green;
      await this.ctx.storage.put("green", green);
    }

    // Every request gets the current color back
    return Response.json({ green });
  }
}
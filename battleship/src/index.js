// Battleship - Cloudflare Worker + Durable Object (one Room per code)
const N = 10;
const FLEET = [["Carrier", 5], ["Battleship", 4], ["Cruiser", 3], ["Submarine", 3], ["Destroyer", 2]];
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GRACE = 15000;

function pos(i) {
  return String.fromCharCode(65 + Math.floor(i / N)) + ((i % N) + 1);
}

function validFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) return null;
  const used = new Set();
  const out = [];
  for (let k = 0; k < FLEET.length; k++) {
    const cells = ships[k] && ships[k].cells;
    if (!Array.isArray(cells) || cells.length !== FLEET[k][1]) return null;
    if (!cells.every((c) => Number.isInteger(c) && c >= 0 && c < 100)) return null;
    const s = cells.slice().sort((a, b) => a - b);
    const row = Math.floor(s[0] / N);
    const horiz = s.every((c, j) => Math.floor(c / N) === row && c === s[0] + j);
    const vert = s.every((c, j) => c === s[0] + j * N);
    if (!horiz && !vert) return null;
    for (const c of s) {
      if (used.has(c)) return null;
      used.add(c);
    }
    out.push({ name: FLEET[k][0], len: s.length, hits: 0, cells: s });
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/code") {
      const a = new Uint8Array(5);
      crypto.getRandomValues(a);
      const code = [...a].map((n) => ALPHA[n % ALPHA.length]).join("");
      return new Response(JSON.stringify({ code }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const code = url.pathname.slice(4).toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response("Bad code", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.reset();
  }

  reset() {
    this.created = false;
    this.code = "";
    this.phase = "lobby";
    this.players = [null, null];
    this.turn = 0;
    this.winner = null;
    this.msg = "";
  }

  newPlayer(pid, name, ws) {
    return { pid, name, ws, connected: true, ships: null, cells: null, inc: new Array(100).fill(0), ready: false, rematch: false, timer: null };
  }

  clearBoard(p) {
    p.ships = null;
    p.cells = null;
    p.inc = new Array(100).fill(0);
    p.ready = false;
    p.rematch = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.slice(4).toUpperCase();
    const pid = (url.searchParams.get("pid") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
    const create = url.searchParams.get("create") === "1";
    const name = (url.searchParams.get("name") || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 14) || "Captain";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.join(server, pid, name, code, create);
    return new Response(null, { status: 101, webSocket: client });
  }

  fail(ws, message) {
    try {
      ws.send(JSON.stringify({ type: "fatal", message }));
      ws.close(1000, "closed");
    } catch (e) {}
  }

  join(ws, pid, name, code, create) {
    if (!pid) return this.fail(ws, "Missing player id.");
    if (!this.created) {
      if (!create) return this.fail(ws, "Room not found. Check the code and try again.");
      this.created = true;
      this.code = code;
    }
    let p = this.players.find((x) => x && x.pid === pid);
    if (p) {
      clearTimeout(p.timer);
      if (p.ws && p.ws !== ws) {
        try { p.ws.close(1000, "Replaced"); } catch (e) {}
      }
      p.ws = ws;
      p.connected = true;
      if (this.phase === "battle") this.msg = p.name + " is back.";
    } else {
      if (this.phase !== "lobby" || (this.players[0] && this.players[1])) {
        return this.fail(ws, "That room already has two players.");
      }
      p = this.newPlayer(pid, name, ws);
      this.players[this.players[0] ? 1 : 0] = p;
      if (this.players[0] && this.players[1]) {
        this.phase = "placing";
        this.msg = name + " joined. Place your ships!";
      } else {
        this.msg = "";
      }
    }

    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        this.onMessage(p, m);
        this.broadcast();
      } catch (e) {
        this.send(p, { type: "error", message: e && e.message ? e.message : "Something went wrong." });
      }
    });
    ws.addEventListener("close", () => this.onClose(p, ws));
    ws.addEventListener("error", () => this.onClose(p, ws));
    this.broadcast();
  }

  onClose(p, ws) {
    if (p.ws !== ws) return;
    p.ws = null;
    p.connected = false;
    if (!this.players.includes(p)) return;
    if (this.phase === "battle") {
      this.msg = p.name + " disconnected.";
      this.broadcast();
      return;
    }
    p.timer = setTimeout(() => {
      if (!p.connected && this.players.includes(p)) {
        this.removePlayer(p);
        this.broadcast();
      }
    }, GRACE);
    this.broadcast();
  }

  removePlayer(p) {
    const i = this.players.indexOf(p);
    if (i < 0) return;
    this.players[i] = null;
    if (!this.players[0] && this.players[1]) {
      this.players[0] = this.players[1];
      this.players[1] = null;
    }
    const rest = this.players[0];
    if (!rest) {
      this.reset();
      return;
    }
    this.clearBoard(rest);
    this.phase = "lobby";
    this.winner = null;
    this.msg = p.name + " left the room.";
  }

  send(p, obj) {
    if (p && p.ws && p.connected) {
      try { p.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  broadcast() {
    this.players.forEach((p, seat) => {
      if (p) this.send(p, this.stateFor(seat));
    });
  }

  stateFor(seat) {
    const me = this.players[seat];
    const op = this.players[1 - seat];
    const sunk = op && op.ships ? op.ships.filter((s) => s.hits === s.len).map((s) => ({ name: s.name, cells: s.cells })) : [];
    let reveal = [];
    if (this.phase === "over" && op && op.cells) {
      op.cells.forEach((v, i) => { if (v >= 0) reveal.push(i); });
    }
    return {
      type: "state",
      code: this.code,
      phase: this.phase,
      you: seat,
      turn: this.turn,
      winner: this.winner,
      msg: this.msg,
      names: this.players.map((x) => (x ? x.name : null)),
      connected: this.players.map((x) => !!(x && x.connected)),
      ready: this.players.map((x) => !!(x && x.ready)),
      rematch: this.players.map((x) => !!(x && x.rematch)),
      mine: me.inc,
      theirs: op ? op.inc : new Array(100).fill(0),
      sunk,
      reveal,
      fleet: me.ships ? me.ships.map((s) => ({ name: s.name, cells: s.cells })) : null,
    };
  }

  onMessage(p, m) {
    const seat = this.players.indexOf(p);
    if (seat < 0) throw new Error("You are not in this room.");
    switch (m.type) {
      case "ready": return this.ready(p, seat, m);
      case "fire": return this.fire(p, seat, m);
      case "rematch": return this.rematch(p);
      case "leave": return this.leave(p, seat);
      default: throw new Error("Unknown action.");
    }
  }

  ready(p, seat, m) {
    if (this.phase !== "placing") throw new Error("You can't place ships right now.");
    if (p.ready) throw new Error("Your fleet is already placed.");
    const ships = validFleet(m.ships);
    if (!ships) throw new Error("That fleet layout isn't valid.");
    p.ships = ships;
    p.cells = new Array(100).fill(-1);
    ships.forEach((s, k) => s.cells.forEach((c) => { p.cells[c] = k; }));
    p.ready = true;
    const o = this.players[1 - seat];
    if (o && o.ready) {
      this.phase = "battle";
      this.turn = Math.floor(Math.random() * 2);
      this.msg = "Battle begins! " + this.players[this.turn].name + " fires first.";
    } else {
      this.msg = p.name + " is ready.";
    }
  }

  fire(p, seat, m) {
    if (this.phase !== "battle") throw new Error("The battle hasn't started.");
    if (this.turn !== seat) throw new Error("It's not your turn.");
    const i = m.i;
    if (!Number.isInteger(i) || i < 0 || i >= 100) throw new Error("Bad target.");
    const o = this.players[1 - seat];
    if (o.inc[i]) throw new Error("You already fired there.");
    const si = o.cells[i];
    if (si < 0) {
      o.inc[i] = 1;
      this.msg = p.name + " fired at " + pos(i) + ": miss.";
    } else {
      o.inc[i] = 2;
      const s = o.ships[si];
      s.hits++;
      if (s.hits === s.len) this.msg = p.name + " sank " + o.name + "'s " + s.name + "!";
      else this.msg = p.name + " fired at " + pos(i) + ": hit!";
      if (o.ships.every((x) => x.hits === x.len)) {
        this.phase = "over";
        this.winner = seat;
        this.msg = p.name + " sank the whole fleet!";
        return;
      }
    }
    this.turn = 1 - seat;
  }

  rematch(p) {
    if (this.phase !== "over") throw new Error("The game isn't over yet.");
    p.rematch = true;
    const o = this.players.find((x) => x && x !== p);
    if (o && o.rematch && o.connected && p.connected) {
      this.players.forEach((x) => { if (x) this.clearBoard(x); });
      this.phase = "placing";
      this.winner = null;
      this.msg = "New game. Place your ships!";
    } else {
      this.msg = p.name + " wants a rematch.";
    }
  }

  leave(p, seat) {
    if (this.phase === "battle") {
      this.phase = "over";
      this.winner = 1 - seat;
      this.msg = p.name + " left the battle.";
    } else {
      this.removePlayer(p);
    }
  }
}
// end of file
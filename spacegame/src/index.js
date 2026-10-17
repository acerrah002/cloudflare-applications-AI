// Space Duel - Cloudflare Worker + Durable Object (one Room per code)
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_HP = 100;
const DMG = 10;
const WINS_NEEDED = 3;
const COUNTDOWN_MS = 3000;
const BETWEEN_MS = 3500;
const GRACE_MS = 20000;

function nums(a, n) {
  return Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Number.isFinite(x));
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
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
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
    clearTimeout(this.timer);
    this.created = false;
    this.code = "";
    this.phase = "lobby";
    this.players = [null, null];
    this.round = 0;
    this.wins = [0, 0];
    this.hp = [MAX_HP, MAX_HP];
    this.seed = 1;
    this.loser = -1;
    this.winner = -1;
    this.msg = "";
    this.lasers = new Set();
    this.lastFire = [0, 0];
    this.timer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.slice(4).toUpperCase();
    const pid = (url.searchParams.get("pid") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
    const create = url.searchParams.get("create") === "1";
    const name = (url.searchParams.get("name") || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 14) || "Pilot";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.join(server, pid, name, code, create);
    return new Response(null, { status: 101, webSocket: client });
  }

  fail(ws, message) {
    try {
      ws.send(JSON.stringify({ t: "fatal", message }));
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
    let starting = false;
    if (p) {
      clearTimeout(p.grace);
      if (p.ws && p.ws !== ws) {
        try { p.ws.close(1000, "Replaced"); } catch (e) {}
      }
      p.ws = ws;
      p.connected = true;
    } else {
      if (this.phase !== "lobby" || (this.players[0] && this.players[1])) return this.fail(ws, "That room is full.");
      const other = this.players[0];
      if (other && other.name === name) name = name.slice(0, 12) + " 2";
      p = { pid, name, ws, connected: true, rematch: false, grace: null };
      this.players[other ? 1 : 0] = p;
      starting = !!(this.players[0] && this.players[1]);
    }

    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === "ping") {
          ws.send(JSON.stringify({ t: "pong" }));
          return;
        }
        this.onMessage(p, m);
      } catch (e) {}
    });
    ws.addEventListener("close", () => this.onClose(p, ws));
    ws.addEventListener("error", () => this.onClose(p, ws));

    if (starting) this.startMatch();
    else this.broadcast();
  }

  onClose(p, ws) {
    if (p.ws !== ws) return;
    p.ws = null;
    p.connected = false;
    if (!this.players.includes(p)) return;
    p.grace = setTimeout(() => {
      if (p.connected || !this.players.includes(p)) return;
      if (this.phase === "lobby") {
        this.removePlayer(p);
        this.broadcast();
      } else {
        this.forfeit(this.players.indexOf(p), p.name + " left the match.");
      }
    }, GRACE_MS);
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
    if (!this.players[0]) this.reset();
  }

  forfeit(seat, msg) {
    if (seat < 0 || this.phase === "lobby" || this.phase === "matchover") return;
    clearTimeout(this.timer);
    this.winner = 1 - seat;
    this.loser = -1;
    this.phase = "matchover";
    this.msg = msg;
    this.broadcast();
  }

  send(p, obj) {
    if (p && p.ws && p.connected) {
      try { p.ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  sendAll(obj) {
    this.players.forEach((p) => this.send(p, obj));
  }

  broadcast() {
    this.players.forEach((p, seat) => {
      if (p) this.send(p, this.stateFor(seat));
    });
  }

  stateFor(seat) {
    return {
      t: "st",
      code: this.code,
      phase: this.phase,
      you: seat,
      round: this.round,
      wins: this.wins,
      hp: this.hp,
      seed: this.seed,
      loser: this.loser,
      winner: this.winner,
      msg: this.msg,
      names: this.players.map((x) => (x ? x.name : null)),
      connected: this.players.map((x) => !!(x && x.connected)),
      rematch: this.players.map((x) => !!(x && x.rematch)),
    };
  }

  startMatch() {
    this.wins = [0, 0];
    this.round = 0;
    this.winner = -1;
    this.msg = "";
    this.players.forEach((p) => { if (p) p.rematch = false; });
    this.nextRound();
  }

  nextRound() {
    clearTimeout(this.timer);
    this.round++;
    this.hp = [MAX_HP, MAX_HP];
    this.seed = 1 + Math.floor(Math.random() * 1000000000);
    this.lasers.clear();
    this.loser = -1;
    this.phase = "countdown";
    this.broadcast();
    this.timer = setTimeout(() => {
      if (this.phase === "countdown") {
        this.phase = "playing";
        this.broadcast();
      }
    }, COUNTDOWN_MS);
  }

  endRound(winSeat, loseSeat) {
    clearTimeout(this.timer);
    this.wins[winSeat]++;
    this.loser = loseSeat;
    if (this.wins[winSeat] >= WINS_NEEDED) {
      this.phase = "matchover";
      this.winner = winSeat;
    } else {
      this.phase = "roundover";
      this.timer = setTimeout(() => {
        if (this.phase === "roundover") this.nextRound();
      }, BETWEEN_MS);
    }
    this.broadcast();
  }

  onMessage(p, m) {
    const seat = this.players.indexOf(p);
    if (seat < 0 || !m) return;
    const o = this.players[1 - seat];
    switch (m.t) {
      case "s":
        if (o && nums(m.p, 3) && nums(m.r, 3) && Number.isFinite(m.v)) {
          this.send(o, { t: "o", p: m.p, r: m.r, v: m.v, b: m.b ? 1 : 0 });
        }
        break;
      case "f": {
        if (this.phase !== "playing" || !o || !nums(m.o, 3) || !nums(m.d, 3)) break;
        const now = Date.now();
        if (now - this.lastFire[seat] < 120) break;
        this.lastFire[seat] = now;
        const id = String(m.id).slice(0, 12);
        if (this.lasers.size > 600) this.lasers.clear();
        this.lasers.add(seat + ":" + id);
        this.send(o, { t: "f", id, o: m.o, d: m.d });
        break;
      }
      case "h": {
        if (this.phase !== "playing") break;
        const key = (1 - seat) + ":" + String(m.id).slice(0, 12);
        if (!this.lasers.has(key)) break;
        this.lasers.delete(key);
        this.hp[seat] = Math.max(0, this.hp[seat] - DMG);
        if (this.hp[seat] <= 0) this.endRound(1 - seat, seat);
        else this.sendAll({ t: "hp", hp: this.hp });
        break;
      }
      case "rematch":
        if (this.phase === "matchover") {
          p.rematch = true;
          if (o && o.rematch && o.connected) this.startMatch();
          else this.broadcast();
        }
        break;
      case "leave":
        if (this.phase === "lobby") {
          this.removePlayer(p);
          this.broadcast();
        } else {
          this.forfeit(seat, p.name + " left the match.");
        }
        break;
    }
  }
}
// end of file
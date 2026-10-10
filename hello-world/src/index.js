// UNO Online - Cloudflare Worker
// REST API + WebSocket lobbies (Durable Object) + D1 database

const enc = new TextEncoder();
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["red", "yellow", "green", "blue"];
const MAX_PLAYERS = 8;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

function randomCode(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 },
    key,
    256
  );
  return toHex(bits);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getUser(env, token) {
  if (!token) return null;
  return await env.DB.prepare(
    "SELECT u.id, u.username, u.games_played, u.wins FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at > ?"
  )
    .bind(token, Date.now() - SESSION_MAX_AGE)
    .first();
}

function bearer(request) {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

async function createSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
    .bind(token, userId, Date.now())
    .run();
  return token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/ws/")) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected WebSocket", { status: 426 });
        }
        const code = path.slice(4).toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response("Bad code", { status: 400 });

        const user = await getUser(env, url.searchParams.get("token"));
        if (!user) return new Response("Unauthorized", { status: 401 });

        const headers = new Headers(request.headers);
        headers.set("X-User-Id", String(user.id));
        headers.set("X-Username", user.username);
        headers.set("X-Code", code);
        headers.set("X-Create", url.searchParams.get("create") === "1" ? "1" : "0");

        const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
        return stub.fetch(new Request(request, { headers }));
      }

      if (path.startsWith("/api/")) {
        if (path === "/api/register" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const username = String(body.username || "").trim();
          const password = String(body.password || "");
          if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
            return json({ error: "Username must be 3-16 letters, numbers or underscores." }, 400);
          }
          if (password.length < 6 || password.length > 100) {
            return json({ error: "Password must be 6-100 characters." }, 400);
          }
          const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
          if (existing) return json({ error: "That username is already taken." }, 409);

          const salt = randomHex(16);
          const hash = await hashPassword(password, salt);
          const res = await env.DB.prepare(
            "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)"
          )
            .bind(username, hash, salt, Date.now())
            .run();
          const userId = res.meta.last_row_id;
          const token = await createSession(env, userId);
          return json({ token, user: { username, games_played: 0, wins: 0 } });
        }

        if (path === "/api/login" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const username = String(body.username || "").trim();
          const password = String(body.password || "");
          const row = await env.DB.prepare(
            "SELECT id, username, password_hash, salt, games_played, wins FROM users WHERE username = ?"
          )
            .bind(username)
            .first();
          if (!row) return json({ error: "Wrong username or password." }, 401);
          const hash = await hashPassword(password, row.salt);
          if (!safeEqual(hash, row.password_hash)) return json({ error: "Wrong username or password." }, 401);

          await env.DB.prepare("DELETE FROM sessions WHERE created_at < ?")
            .bind(Date.now() - SESSION_MAX_AGE)
            .run();
          const token = await createSession(env, row.id);
          return json({
            token,
            user: { username: row.username, games_played: row.games_played, wins: row.wins },
          });
        }

        if (path === "/api/logout" && request.method === "POST") {
          const token = bearer(request);
          if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
          return json({ ok: true });
        }

        if (path === "/api/me" && request.method === "GET") {
          const user = await getUser(env, bearer(request));
          if (!user) return json({ error: "Not logged in." }, 401);
          return json({ user: { username: user.username, games_played: user.games_played, wins: user.wins } });
        }

        if (path === "/api/leaderboard" && request.method === "GET") {
          const { results } = await env.DB.prepare(
            "SELECT username, wins, games_played FROM users WHERE games_played > 0 ORDER BY wins DESC, games_played ASC LIMIT 10"
          ).all();
          return json({ players: results });
        }

        if (path === "/api/create" && request.method === "POST") {
          const user = await getUser(env, bearer(request));
          if (!user) return json({ error: "Not logged in." }, 401);
          return json({ code: randomCode(5) });
        }

        return json({ error: "Not found." }, 404);
      }
    } catch (err) {
      return json({ error: "Server error. Please try again." }, 500);
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------------- Lobby Durable Object ----------------

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({ id: id++, color, value: "0" });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, color, value: String(n) });
      deck.push({ id: id++, color, value: String(n) });
    }
    for (const v of ["skip", "reverse", "draw2"]) {
      deck.push({ id: id++, color, value: v });
      deck.push({ id: id++, color, value: v });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: "wild", value: "wild" });
    deck.push({ id: id++, color: "wild", value: "wild4" });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardName(c) {
  if (c.value === "wild") return "Wild";
  if (c.value === "wild4") return "Wild Draw 4";
  const names = { skip: "Skip", reverse: "Reverse", draw2: "Draw 2" };
  return c.color + " " + (names[c.value] || c.value);
}

export class Lobby {
  constructor(state, env) {
    this.env = env;
    this.reset();
  }

  reset() {
    this.created = false;
    this.code = "";
    this.hostId = null;
    this.status = "lobby";
    this.players = [];
    this.deck = [];
    this.discard = [];
    this.color = null;
    this.turn = 0;
    this.dir = 1;
    this.drawn = null;
    this.winner = null;
    this.logs = [];
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const userId = Number(request.headers.get("X-User-Id"));
    const username = request.headers.get("X-Username");
    const code = request.headers.get("X-Code");
    const create = request.headers.get("X-Create") === "1";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.handleJoin(server, userId, username, code, create);
    return new Response(null, { status: 101, webSocket: client });
  }

  fail(ws, message) {
    try {
      ws.send(JSON.stringify({ type: "fatal", message }));
      ws.close(1000, "closed");
    } catch (e) {}
  }

  handleJoin(ws, userId, username, code, create) {
    if (!this.created) {
      if (!create) return this.fail(ws, "Lobby not found. Check the code and try again.");
      this.created = true;
      this.code = code;
      this.hostId = userId;
    }

    let p = this.players.find((x) => x.userId === userId);
    if (p) {
      if (p.ws && p.ws !== ws) {
        try {
          p.ws.close(1000, "Replaced by a new connection");
        } catch (e) {}
      }
      p.ws = ws;
      p.connected = true;
      if (this.status !== "lobby") this.log(username + " is back");
    } else {
      if (this.status !== "lobby") return this.fail(ws, "That game has already started.");
      if (this.players.length >= MAX_PLAYERS) return this.fail(ws, "That lobby is full.");
      p = { userId, username, ws, connected: true, hand: [], inGame: false };
      this.players.push(p);
      this.log(username + " joined the lobby");
    }

    ws.addEventListener("message", async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        await this.onMessage(p, msg);
        this.broadcast();
      } catch (e) {
        this.sendTo(p, { type: "error", message: e && e.message ? e.message : "Something went wrong." });
      }
    });
    ws.addEventListener("close", () => this.onClose(p, ws));
    ws.addEventListener("error", () => this.onClose(p, ws));

    this.broadcast();
  }

  onClose(p, ws) {
    if (p.ws !== ws) return;
    p.connected = false;
    p.ws = null;

    if (this.status === "playing") {
      this.log(p.username + " disconnected");
      const cur = this.players[this.turn];
      if (cur === p) this.autoSkip();
      this.broadcast();
      return;
    }

    this.players = this.players.filter((x) => x !== p);
    this.log(p.username + " left");
    if (this.players.length === 0) {
      this.reset();
      return;
    }
    if (this.hostId === p.userId) {
      const next = this.players.find((x) => x.connected) || this.players[0];
      this.hostId = next.userId;
      this.log(next.username + " is now the host");
    }
    this.broadcast();
  }

  sendTo(p, obj) {
    if (p.ws && p.connected) {
      try {
        p.ws.send(JSON.stringify(obj));
      } catch (e) {}
    }
  }

  broadcast() {
    for (const p of this.players) this.sendTo(p, this.stateFor(p));
  }

  log(text) {
    this.logs.push(text);
    if (this.logs.length > 30) this.logs.shift();
  }

  stateFor(p) {
    const playing = this.status === "playing";
    return {
      type: "state",
      code: this.code,
      status: this.status,
      youId: p.userId,
      hostId: this.hostId,
      players: this.players.map((x) => ({
        id: x.userId,
        username: x.username,
        cards: x.hand.length,
        uno: !!x.unoCalled && x.hand.length === 1,
        connected: x.connected,
      })),
      hand: p.hand,
      turnId: playing && this.players[this.turn] ? this.players[this.turn].userId : null,
      top: this.discard.length ? this.discard[this.discard.length - 1] : null,
      color: this.color,
      dir: this.dir,
      drawn: this.drawn,
      mustCall: playing && p.hand.length === 1 && !p.unoCalled,
      catchIds: playing
        ? this.players.filter((x) => x !== p && x.hand.length === 1 && !x.unoCalled).map((x) => x.userId)
        : [],
      deckCount: this.deck.length,
      winner: this.winner,
      log: this.logs.slice(-6),
    };
  }

  async onMessage(p, msg) {
    switch (msg.type) {
      case "start":
        return this.startGame(p);
      case "play":
        return await this.play(p, msg);
      case "draw":
        return this.draw(p);
      case "pass":
        return this.pass(p);
      case "rematch":
        return this.rematch(p);
      case "uno":
        return this.callUno(p);
      default:
        throw new Error("Unknown action.");
    }
  }

  startGame(p) {
    if (p.userId !== this.hostId) throw new Error("Only the host can start the game.");
    if (this.status !== "lobby") throw new Error("The game has already started.");
    if (this.players.length < 2) throw new Error("You need at least 2 players.");

    this.status = "playing";
    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.dir = 1;
    this.drawn = null;
    this.winner = null;

    for (const pl of this.players) {
      pl.hand = [];
      pl.inGame = true;
      pl.unoCalled = false;
      for (let i = 0; i < 7; i++) pl.hand.push(this.deck.pop());
    }

    let first;
    while (true) {
      first = this.deck.pop();
      if (/^[0-9]$/.test(first.value)) break;
      this.deck.unshift(first);
    }
    this.discard.push(first);
    this.color = first.color;
    this.turn = Math.floor(Math.random() * this.players.length);
    this.log("Game started. " + this.players[this.turn].username + " goes first.");
    this.autoSkip();
  }

  isPlayable(card) {
    const top = this.discard[this.discard.length - 1];
    return card.color === "wild" || card.color === this.color || card.value === top.value;
  }

  requireTurn(p) {
    if (this.status !== "playing") throw new Error("The game isn't running.");
    if (this.players[this.turn] !== p) throw new Error("It's not your turn.");
  }

  step(n) {
    const len = this.players.length;
    this.turn = (((this.turn + this.dir * n) % len) + len) % len;
  }

  indexAfter(k) {
    const len = this.players.length;
    return (((this.turn + this.dir * k) % len) + len) % len;
  }

  endTurn(n) {
    this.drawn = null;
    this.step(n);
    this.autoSkip();
  }

  autoSkip() {
    let guard = 0;
    while (this.status === "playing" && guard++ < this.players.length) {
      const cur = this.players[this.turn];
      if (cur.connected) break;
      if (!this.players.some((x) => x.connected)) break;
      this.drawCards(cur, 1);
      this.log(cur.username + " is away and drew a card");
      this.drawn = null;
      this.step(1);
    }
  }

  drawCards(p, n) {
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length > 1) {
          const top = this.discard.pop();
          this.deck = shuffle(this.discard);
          this.discard = [top];
        } else {
          break;
        }
      }
      p.hand.push(this.deck.pop());
      p.unoCalled = false;
      got++;
    }
    return got;
  }

  async play(p, msg) {
    this.requireTurn(p);
    const idx = p.hand.findIndex((c) => c.id === msg.cardId);
    if (idx === -1) throw new Error("You don't have that card.");
    const card = p.hand[idx];
    if (this.drawn !== null && this.drawn !== card.id) {
      throw new Error("You can only play the card you just drew, or pass.");
    }
    if (!this.isPlayable(card)) throw new Error("That card can't be played right now.");
    if (p.hand.length === 1 && !p.unoCalled) throw new Error("Press UNO before you play your last card!");

    let chosen = card.color;
    if (card.color === "wild") {
      if (!COLORS.includes(msg.color)) throw new Error("Choose a color.");
      chosen = msg.color;
    }

    p.hand.splice(idx, 1);
    this.discard.push(card);
    this.color = chosen;
    this.drawn = null;

    let text = p.username + " played " + cardName(card);
    if (card.color === "wild") text += " and chose " + chosen;
    this.log(text);

    if (p.hand.length === 0) {
      await this.finish(p);
      return;
    }
    if (p.hand.length === 1) this.log(p.username + " is down to one card! Call UNO!");

    const n = this.players.length;
    switch (card.value) {
      case "skip":
        this.log(this.players[this.indexAfter(1)].username + " is skipped");
        this.endTurn(2);
        break;
      case "reverse":
        this.dir = -this.dir;
        this.log("Direction reversed");
        this.endTurn(n === 2 ? 2 : 1);
        break;
      case "draw2": {
        const victim = this.players[this.indexAfter(1)];
        this.drawCards(victim, 2);
        this.log(victim.username + " draws 2 and is skipped");
        this.endTurn(2);
        break;
      }
      case "wild4": {
        const victim = this.players[this.indexAfter(1)];
        this.drawCards(victim, 4);
        this.log(victim.username + " draws 4 and is skipped");
        this.endTurn(2);
        break;
      }
      default:
        this.endTurn(1);
    }
  }

  draw(p) {
    this.requireTurn(p);
    if (this.drawn !== null) throw new Error("You already drew. Play that card or pass.");
    const before = p.hand.length;
    this.drawCards(p, 1);
    if (p.hand.length === before) {
      this.log("No cards left to draw. " + p.username + " passes");
      this.endTurn(1);
      return;
    }
    const card = p.hand[p.hand.length - 1];
    this.log(p.username + " drew a card");
    if (this.isPlayable(card)) {
      this.drawn = card.id;
    } else {
      this.endTurn(1);
    }
  }

  pass(p) {
    this.requireTurn(p);
    if (this.drawn === null) throw new Error("Draw a card first.");
    this.log(p.username + " passes");
    this.endTurn(1);
  }

  callUno(p) {
    if (this.status !== "playing") throw new Error("The game isn't running.");
    if (p.inGame && p.hand.length === 1 && !p.unoCalled) {
      p.unoCalled = true;
      this.log(p.username + " called UNO!");
      return;
    }
    const target = this.players.find(
      (x) => x !== p && x.inGame && x.hand.length === 1 && !x.unoCalled
    );
    if (!target) throw new Error("Nobody needs a UNO call right now.");
    this.drawCards(target, 2);
    this.log(p.username + " caught " + target.username + " without UNO! " + target.username + " draws 2");
  }

  async finish(winner) {
    this.status = "finished";
    this.winner = winner.username;
    this.drawn = null;
    this.log(winner.username + " wins the game!");

    const stmts = this.players
      .filter((x) => x.inGame)
      .map((x) =>
        this.env.DB.prepare("UPDATE users SET games_played = games_played + 1, wins = wins + ? WHERE id = ?").bind(
          x.userId === winner.userId ? 1 : 0,
          x.userId
        )
      );
    try {
      if (stmts.length) await this.env.DB.batch(stmts);
    } catch (e) {
      this.log("Could not save stats for this game.");
    }
  }

  rematch(p) {
    if (p.userId !== this.hostId) throw new Error("Only the host can start a rematch.");
    if (this.status !== "finished") throw new Error("The game isn't finished yet.");
    this.players = this.players.filter((x) => x.connected);
    for (const pl of this.players) {
      pl.hand = [];
      pl.inGame = false;
    }
    this.status = "lobby";
    this.deck = [];
    this.discard = [];
    this.winner = null;
    this.drawn = null;
    this.log("Back in the lobby for a rematch");
  }
}
(function () {
  "use strict";

  var token = localStorage.getItem("uno_token");
  var me = null;
  var ws = null;
  var state = null;
  var pingTimer = null;
  var intentionalClose = false;
  var reconnectTries = 0;
  var lastStatus = null;
  var pendingWildId = null;
  var toastTimer = null;

  var VERSION = "1.1.0";
  (function () {
    var v = document.getElementById("version");
    if (v) v.textContent = "v" + VERSION;
  })();

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function show(view) {
    ["auth", "menu", "lobby", "game"].forEach(function (v) {
      $("view-" + v).classList.toggle("hidden", v !== view);
    });
  }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add("hidden"); }, 3200);
  }

  async function api(path, method, body) {
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    var res = await fetch(path, {
      method: method || "GET",
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(data.error || "Request failed.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function authenticate(kind) {
    $("auth-error").textContent = "";
    try {
      var data = await api("/api/" + kind, "POST", {
        username: $("username").value.trim(),
        password: $("password").value
      });
      token = data.token;
      localStorage.setItem("uno_token", token);
      me = data.user;
      $("password").value = "";
      enterMenu();
    } catch (e) {
      $("auth-error").textContent = e.message;
    }
  }

  async function logout() {
    try { await api("/api/logout", "POST"); } catch (e) {}
    token = null;
    me = null;
    localStorage.removeItem("uno_token");
    localStorage.removeItem("uno_last_code");
    show("auth");
  }

  function renderStats() {
    if (!me) return;
    $("menu-name").textContent = me.username;
    $("stat-games").textContent = me.games_played;
    $("stat-wins").textContent = me.wins;
    $("stat-rate").textContent = me.games_played > 0
      ? Math.round((me.wins / me.games_played) * 100) + "%"
      : "-";
  }

  async function loadLeaderboard() {
    var body = $("leaderboard").querySelector("tbody");
    body.innerHTML = "";
    try {
      var data = await api("/api/leaderboard");
      if (!data.players.length) {
        var tr = el("tr");
        var td = el("td", "empty", "No games played yet. Host a lobby to get on the board.");
        td.colSpan = 4;
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      data.players.forEach(function (p) {
        var tr = el("tr");
        tr.appendChild(el("td", "", p.username));
        tr.appendChild(el("td", "", String(p.wins)));
        tr.appendChild(el("td", "", String(p.games_played)));
        tr.appendChild(el("td", "", Math.round((p.wins / p.games_played) * 100) + "%"));
        body.appendChild(tr);
      });
    } catch (e) {}
  }

  async function enterMenu() {
    show("menu");
    renderStats();
    var last = localStorage.getItem("uno_last_code");
    var rejoin = $("btn-rejoin");
    if (last) {
      rejoin.textContent = "Rejoin lobby " + last;
      rejoin.classList.remove("hidden");
    } else {
      rejoin.classList.add("hidden");
    }
    loadLeaderboard();
    try {
      var data = await api("/api/me");
      me = data.user;
      renderStats();
    } catch (e) {
      if (e.status === 401) logout();
    }
  }

  async function hostLobby() {
    try {
      var data = await api("/api/create", "POST");
      connect(data.code, true);
    } catch (e) {
      toast(e.message);
    }
  }

  function joinLobby() {
    var code = $("join-code").value.trim().toUpperCase();
    if (code.length < 4) { toast("Enter the lobby code your host shared."); return; }
    connect(code, false);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function closeSocket() {
    clearInterval(pingTimer);
    if (ws) {
      var old = ws;
      ws = null;
      try { old.close(); } catch (e) {}
    }
  }

  function connect(code, create) {
    intentionalClose = false;
    closeSocket();
    state = null;
    lastStatus = null;

    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var url = proto + location.host + "/ws/" + code + "?token=" + encodeURIComponent(token) + (create ? "&create=1" : "");
    var socket = new WebSocket(url);
    ws = socket;

    socket.onopen = function () {
      reconnectTries = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { send({ type: "ping" }); }, 25000);
    };

    socket.onmessage = function (ev) {
      if (socket !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "state") {
        state = m;
        localStorage.setItem("uno_last_code", m.code);
        render();
      } else if (m.type === "error") {
        toast(m.message);
      } else if (m.type === "fatal") {
        intentionalClose = true;
        localStorage.removeItem("uno_last_code");
        toast(m.message);
        leave(true);
      }
    };

    socket.onclose = function () {
      if (socket !== ws || intentionalClose) return;
      clearInterval(pingTimer);
      if (state && reconnectTries < 5) {
        reconnectTries++;
        toast("Connection lost. Reconnecting...");
        var code2 = state.code;
        setTimeout(function () {
          if (!intentionalClose) connect(code2, false);
        }, 2000);
        return;
      }
      toast("Couldn't connect to the lobby. Try logging in again.");
      leave(true);
    };
  }

  function leave(keepToast) {
    intentionalClose = true;
    closeSocket();
    state = null;
    lastStatus = null;
    localStorage.removeItem("uno_last_code");
    $("end-modal").classList.add("hidden");
    $("color-modal").classList.add("hidden");
    enterMenu();
  }

  function render() {
    if (!state) return;
    if (state.status === "lobby") {
      show("lobby");
      $("end-modal").classList.add("hidden");
      renderLobby();
    } else {
      show("game");
      renderGame();
    }
    if (state.status === "finished" && lastStatus !== "finished") refreshMe();
    lastStatus = state.status;
  }

  async function refreshMe() {
    try {
      var data = await api("/api/me");
      me = data.user;
      if (state && state.status === "finished") renderGame();
    } catch (e) {}
  }

  function renderLobby() {
    $("lobby-code").textContent = state.code;
    var list = $("lobby-players");
    list.innerHTML = "";
    state.players.forEach(function (p) {
      var li = el("li");
      li.appendChild(el("span", "", p.username + (p.id === state.youId ? " (you)" : "")));
      if (p.id === state.hostId) li.appendChild(el("span", "tag", "host"));
      list.appendChild(li);
    });
    var isHost = state.hostId === state.youId;
    var start = $("btn-start");
    start.classList.toggle("hidden", !isHost);
    start.disabled = state.players.length < 2;
    $("lobby-hint").textContent = isHost
      ? (state.players.length < 2 ? "Share the code. You need at least 2 players to start." : "Everyone here? Start when you're ready.")
      : "Waiting for the host to start the game.";
  }

  function cardFace(card) {
    var map = { skip: "\u2298", reverse: "\u21C4", draw2: "+2", wild: "\u2605", wild4: "+4" };
    return map[card.value] || card.value;
  }

  function cardEl(card, asButton) {
    var c = el(asButton ? "button" : "div", "card " + card.color);
    var face = cardFace(card);
    if (face.length > 1) c.classList.add("small-text");
    c.appendChild(el("span", "corner tl", face));
    var oval = el("div", "oval");
    oval.appendChild(el("span", "mid", face));
    c.appendChild(oval);
    c.appendChild(el("span", "corner br", face));
    var names = { skip: "Skip", reverse: "Reverse", draw2: "Draw 2", wild: "Wild", wild4: "Wild Draw 4" };
    c.setAttribute("aria-label", (card.color === "wild" ? "" : card.color + " ") + (names[card.value] || card.value));
    return c;
  }

  function isPlayable(card) {
    if (!state.top) return false;
    if (state.drawn !== null && card.id !== state.drawn) return false;
    return card.color === "wild" || card.color === state.color || card.value === state.top.value;
  }

  var COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };

  function renderGame() {
    var myTurn = state.status === "playing" && state.turnId === state.youId;

    $("game-code").textContent = state.code;

    var opp = $("opponents");
    opp.innerHTML = "";
    state.players.forEach(function (p) {
      if (p.id === state.youId) return;
      var d = el("div", "opp" + (p.id === state.turnId ? " turn" : "") + (p.connected ? "" : " away"));
      d.appendChild(el("b", "", p.username));
      d.appendChild(el("small", "", p.cards + (p.cards === 1 ? " card" : " cards") + (p.connected ? "" : " (away)")));
      if (p.uno) d.appendChild(el("span", "uno-tag", "UNO!"));
      opp.appendChild(d);
    });

    var discard = $("discard");
    discard.innerHTML = "";
    if (state.top) discard.appendChild(cardEl(state.top, false));
    $("color-indicator").className = "color-indicator " + (state.color || "");
    $("deck-count").textContent = state.deckCount + " left";

    var canDraw = myTurn && state.drawn === null;
    var pile = $("draw-pile");
    pile.disabled = !canDraw;
    pile.classList.toggle("can-draw", canDraw);

    $("btn-pass").classList.toggle("hidden", !(myTurn && state.drawn !== null));

    var catchIds = state.catchIds || [];
    var unoBtn = $("btn-uno");
    var showUno = state.status === "playing" && (state.mustCall || catchIds.length > 0);
    unoBtn.classList.toggle("hidden", !showUno);
    unoBtn.classList.toggle("catch", !state.mustCall);
    unoBtn.classList.toggle("urgent", showUno);
    if (showUno) {
      if (state.mustCall) {
        unoBtn.textContent = "UNO!";
      } else {
        var target = state.players.filter(function (p) { return catchIds.indexOf(p.id) !== -1; })[0];
        unoBtn.textContent = "Catch " + (target ? target.username : "them") + "!";
      }
    }

    var banner = $("turn-banner");
    if (state.status === "finished") {
      banner.textContent = state.winner + " won the game";
      banner.className = "turn-banner";
    } else if (myTurn) {
      banner.textContent = state.drawn !== null ? "Play the card you drew, or pass" : "Your turn";
      banner.className = "turn-banner mine";
    } else {
      var cur = state.players.filter(function (p) { return p.id === state.turnId; })[0];
      banner.textContent = cur ? cur.username + "'s turn" : "";
      banner.className = "turn-banner";
    }

    var hand = $("hand");
    hand.innerHTML = "";
    var sorted = state.hand.slice().sort(function (a, b) {
      if (COLOR_ORDER[a.color] !== COLOR_ORDER[b.color]) return COLOR_ORDER[a.color] - COLOR_ORDER[b.color];
      return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    });
    sorted.forEach(function (card) {
      var c = cardEl(card, true);
      var ok = myTurn && isPlayable(card);
      if (ok) c.classList.add("playable");
      else if (myTurn) c.classList.add("dim");
      c.addEventListener("click", function () { onCardClick(card); });
      hand.appendChild(c);
    });

    var log = $("log");
    log.innerHTML = "";
    state.log.forEach(function (line) { log.appendChild(el("li", "", line)); });

    var end = $("end-modal");
    if (state.status === "finished") {
      var won = state.winner === (me && me.username);
      $("end-title").textContent = won ? "You won!" : state.winner + " won";
      var rate = me && me.games_played > 0 ? Math.round((me.wins / me.games_played) * 100) + "%" : "-";
      $("end-sub").textContent = me ? "Your record: " + me.wins + " wins in " + me.games_played + " games (" + rate + ")" : "";
      $("btn-rematch").classList.toggle("hidden", state.hostId !== state.youId);
      end.classList.remove("hidden");
    } else {
      end.classList.add("hidden");
    }
  }

  function onCardClick(card) {
    if (!state || state.status !== "playing" || state.turnId !== state.youId) return;
    if (!isPlayable(card)) {
      toast(state.drawn !== null ? "Play the card you just drew, or pass." : "That card doesn't match.");
      return;
    }
    if (card.color === "wild") {
      pendingWildId = card.id;
      $("color-modal").classList.remove("hidden");
      return;
    }
    send({ type: "play", cardId: card.id });
  }

  $("btn-login").addEventListener("click", function () { authenticate("login"); });
  $("btn-register").addEventListener("click", function () { authenticate("register"); });
  $("password").addEventListener("keydown", function (e) { if (e.key === "Enter") authenticate("login"); });
  $("username").addEventListener("keydown", function (e) { if (e.key === "Enter") $("password").focus(); });
  $("btn-logout").addEventListener("click", logout);

  $("btn-host").addEventListener("click", hostLobby);
  $("btn-join").addEventListener("click", joinLobby);
  $("join-code").addEventListener("keydown", function (e) { if (e.key === "Enter") joinLobby(); });
  $("btn-rejoin").addEventListener("click", function () {
    var last = localStorage.getItem("uno_last_code");
    if (last) connect(last, false);
  });

  $("btn-copy").addEventListener("click", function () {
    var code = state ? state.code : "";
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).then(function () { toast("Code copied: " + code); }, function () { toast("Code: " + code); });
    } else {
      toast("Code: " + code);
    }
  });
  $("btn-start").addEventListener("click", function () { send({ type: "start" }); });
  $("btn-leave-lobby").addEventListener("click", function () { leave(); });
  $("btn-leave-game").addEventListener("click", function () {
    if (confirm("Leave this game? You'll lose if it's still running.")) leave();
  });

  $("draw-pile").addEventListener("click", function () { send({ type: "draw" }); });
  $("btn-pass").addEventListener("click", function () { send({ type: "pass" }); });
  $("btn-uno").addEventListener("click", function () { send({ type: "uno" }); });

  document.querySelectorAll(".swatch").forEach(function (b) {
    b.addEventListener("click", function () {
      $("color-modal").classList.add("hidden");
      if (pendingWildId !== null) send({ type: "play", cardId: pendingWildId, color: b.getAttribute("data-color") });
      pendingWildId = null;
    });
  });
  $("btn-color-cancel").addEventListener("click", function () {
    pendingWildId = null;
    $("color-modal").classList.add("hidden");
  });

  $("btn-rematch").addEventListener("click", function () { send({ type: "rematch" }); });
  $("btn-end-leave").addEventListener("click", function () { leave(); });

  (async function init() {
    if (!token) { show("auth"); return; }
    try {
      var data = await api("/api/me");
      me = data.user;
      enterMenu();
    } catch (e) {
      token = null;
      localStorage.removeItem("uno_token");
      show("auth");
    }
  })();
})();
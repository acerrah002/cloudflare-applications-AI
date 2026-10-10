(function () {
  "use strict";
  var VERSION = "2.0.0", N = 10;
  var FLEET = [["Carrier", 5], ["Battleship", 4], ["Cruiser", 3], ["Submarine", 3], ["Destroyer", 2]];
  var $ = function (id) { return document.getElementById(id); };
  var pid = null;
  try { pid = sessionStorage.getItem("bs_pid"); } catch (e) {}
  if (!pid) {
    pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem("bs_pid", pid); } catch (e) {}
  }
  var ws = null, state = null, lastPhase = null, me = null, placed = 0, horiz = true, hover = null;
  var retries = 0, intentional = false, pingT = null, toastT = null;
  $("version").textContent = "v" + VERSION;

  function board() { return { cells: new Array(100).fill(-1), ships: [] }; }
  function span(r, c, len, h) {
    var out = [];
    for (var k = 0; k < len; k++) {
      var rr = h ? r : r + k, cc = h ? c + k : c;
      if (rr >= N || cc >= N) return null;
      out.push(rr * N + cc);
    }
    return out;
  }
  function fits(b, r, c, len, h) {
    var s = span(r, c, len, h);
    return !!s && s.every(function (i) { return b.cells[i] < 0; });
  }
  function put(b, f, r, c, h) {
    var s = span(r, c, f[1], h), idx = b.ships.length;
    b.ships.push({ name: f[0], len: f[1], cells: s });
    s.forEach(function (i) { b.cells[i] = idx; });
  }
  function randomize(b) {
    FLEET.forEach(function (f) {
      for (;;) {
        var h = Math.random() < 0.5, r = Math.floor(Math.random() * N), c = Math.floor(Math.random() * N);
        if (fits(b, r, c, f[1], h)) { put(b, f, r, c, h); break; }
      }
    });
  }
  function resetPlacement() { me = board(); placed = 0; horiz = true; hover = null; }
  function rebuild(fleet) {
    me = board();
    fleet.forEach(function (f, k) {
      me.ships.push({ name: f.name, len: f.cells.length, cells: f.cells });
      f.cells.forEach(function (i) { me.cells[i] = k; });
    });
    placed = FLEET.length;
  }
  resetPlacement();

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function myName() { return $("name").value.trim() || "Captain"; }
  function saveName() { try { localStorage.setItem("bs_name", myName()); } catch (e) {} }

  function record(win) {
    try {
      var r = JSON.parse(localStorage.getItem("bs_record") || '{"w":0,"l":0}');
      if (win === true) r.w++;
      if (win === false) r.l++;
      if (win !== undefined) localStorage.setItem("bs_record", JSON.stringify(r));
      $("record").textContent = "Wins " + r.w + "   Losses " + r.l;
    } catch (e) {}
  }

  function show(v) { $("home").hidden = v !== "home"; $("room").hidden = v !== "room"; }
  function closeSocket() {
    clearInterval(pingT);
    if (ws) { var o = ws; ws = null; try { o.close(); } catch (e) {} }
  }
  function goHome(msg) {
    intentional = true;
    closeSocket();
    state = null; lastPhase = null;
    resetPlacement();
    try { sessionStorage.removeItem("bs_room"); } catch (e) {}
    show("home");
    $("home-msg").textContent = msg || "";
  }

  function onState(m) {
    var prev = lastPhase;
    state = m;
    if (m.fleet) rebuild(m.fleet);
    else if (m.phase === "lobby" || (m.phase === "placing" && prev !== "placing")) resetPlacement();
    if (m.phase === "over" && prev && prev !== "over") record(m.winner === m.you);
    lastPhase = m.phase;
    try { sessionStorage.setItem("bs_room", m.code); } catch (e) {}
    show("room");
    render();
  }

  function connect(code, create, retry) {
    intentional = false;
    closeSocket();
    if (!retry) { state = null; lastPhase = null; resetPlacement(); }
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var url = proto + location.host + "/ws/" + code + "?pid=" + encodeURIComponent(pid) +
      "&name=" + encodeURIComponent(myName()) + (create ? "&create=1" : "");
    var sock = new WebSocket(url);
    ws = sock;
    sock.onopen = function () {
      retries = 0;
      clearInterval(pingT);
      pingT = setInterval(function () { send({ type: "ping" }); }, 25000);
    };
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "state") onState(m);
      else if (m.type === "error") toast(m.message);
      else if (m.type === "fatal") goHome(m.message);
    };
    sock.onclose = function () {
      if (sock !== ws || intentional) return;
      clearInterval(pingT);
      if (state && retries < 6) {
        retries++;
        toast("Connection lost. Reconnecting...");
        setTimeout(function () { if (!intentional) connect(code, false, true); }, 2000);
        return;
      }
      goHome("Couldn't connect to that room.");
    };
  }

  function render() {
    var s = state, you = s.you, opp = 1 - you, ph = s.phase;
    var oppName = s.names[opp] || "Opponent";
    var placing = ph === "placing" && !s.ready[you];
    $("room-code").textContent = s.code;
    $("big-code").textContent = s.code;
    $("who").textContent = s.names[you] + " vs " + (s.names[opp] || "waiting...");
    $("wait").hidden = ph !== "lobby";
    $("boards").hidden = ph === "lobby";
    $("fleetbox").hidden = ph === "lobby";
    $("setup").hidden = !placing;
    $("again").hidden = ph !== "over";
    $("ready").disabled = placed < FLEET.length;
    $("rotate").textContent = "Rotate (R): " + (horiz ? "across" : "down");

    var a = "", b = s.msg || "";
    if (ph === "lobby") {
      a = "Waiting for an opponent to join.";
      b = "Share the room code. You can place ships once they arrive.";
    } else if (ph === "placing") {
      if (placing) a = placed < FLEET.length ? "Place your " + FLEET[placed][0] + " (" + FLEET[placed][1] + " cells)." : "Fleet ready. Press Ready, or randomize again.";
      else a = "Fleet locked in. Waiting for " + oppName + " to finish placing.";
    } else if (ph === "battle") {
      a = s.turn === you ? "Your turn. Fire on enemy waters!" : oppName + " is aiming...";
      if (!s.connected[opp]) b = oppName + " disconnected. Waiting for them to come back...";
    } else {
      a = s.winner === you ? "Victory! You sank the enemy fleet." : "Defeat. " + oppName + " won this one.";
    }
    $("status").textContent = a;
    $("status2").textContent = b;

    var rb = $("rematch");
    rb.disabled = s.rematch[you];
    rb.textContent = s.rematch[you] ? "Waiting for " + oppName + "..." : (s.rematch[opp] ? oppName + " wants a rematch. Accept" : "Play again");

    var m = $("mine").children, f = $("foe").children, i, k, cls;
    var sunkMine = {}, sunkFoe = {}, rev = {}, ghost = {};
    me.ships.forEach(function (sh) {
      if (sh.cells.every(function (c) { return s.mine[c] === 2; })) sh.cells.forEach(function (c) { sunkMine[c] = 1; });
    });
    s.sunk.forEach(function (sh) { sh.cells.forEach(function (c) { sunkFoe[c] = 1; }); });
    s.reveal.forEach(function (c) { rev[c] = 1; });
    if (placing && hover !== null && placed < FLEET.length) {
      var len = FLEET[placed][1], r = Math.floor(hover / N), c0 = hover % N, ok = fits(me, r, c0, len, horiz);
      for (k = 0; k < len; k++) {
        var rr = horiz ? r : r + k, cc = horiz ? c0 + k : c0;
        if (rr < N && cc < N) ghost[rr * N + cc] = ok ? " ghost" : " bad";
      }
    }
    for (i = 0; i < 100; i++) {
      cls = "cell" + (me.cells[i] >= 0 ? " ship" : "");
      if (s.mine[i] === 1) cls += " miss";
      else if (s.mine[i] === 2) cls += sunkMine[i] ? " sunk" : " hit";
      m[i].className = cls + (ghost[i] || "");
      cls = "cell";
      if (s.theirs[i] === 1) cls += " miss";
      else if (s.theirs[i] === 2) cls += sunkFoe[i] ? " sunk" : " hit";
      else if (rev[i]) cls += " reveal";
      else if (ph === "battle" && s.turn === you) cls += " target";
      f[i].className = cls;
    }

    var ul = $("fleet");
    ul.innerHTML = "";
    var names = s.sunk.map(function (x) { return x.name; });
    FLEET.forEach(function (fl, n) {
      var li = document.createElement("li");
      li.textContent = fl[0] + " (" + fl[1] + ")";
      var done = ph === "placing" ? n < placed : names.indexOf(fl[0]) >= 0;
      li.className = done ? "done" : (placing && n === placed ? "now" : "");
      ul.appendChild(li);
    });
    $("fleet-title").textContent = ph === "placing" ? "Your fleet" : "Enemy fleet";
  }
  ["mine", "foe"].forEach(function (id) {
    for (var i = 0; i < 100; i++) {
      var d = document.createElement("div");
      d.className = "cell";
      d.setAttribute("data-i", i);
      $(id).appendChild(d);
    }
  });
  function idx(e) {
    var t = e.target.getAttribute ? e.target.getAttribute("data-i") : null;
    return t === null ? -1 : +t;
  }
  function canPlace() { return state && state.phase === "placing" && !state.ready[state.you] && placed < FLEET.length; }

  $("mine").addEventListener("mouseover", function (e) {
    if (!state) return;
    var i = idx(e);
    hover = i < 0 ? null : i;
    render();
  });
  $("mine").addEventListener("mouseleave", function () { if (state) { hover = null; render(); } });
  $("mine").addEventListener("click", function (e) {
    var i = idx(e);
    if (!canPlace() || i < 0) return;
    var r = Math.floor(i / N), c = i % N;
    if (!fits(me, r, c, FLEET[placed][1], horiz)) { toast("That ship doesn't fit there."); return; }
    put(me, FLEET[placed], r, c, horiz);
    placed++;
    render();
  });
  $("foe").addEventListener("click", function (e) {
    var i = idx(e);
    if (!state || state.phase !== "battle" || state.turn !== state.you || i < 0 || state.theirs[i]) return;
    send({ type: "fire", i: i });
  });

  function rotate() { horiz = !horiz; if (state) render(); }
  $("rotate").addEventListener("click", rotate);
  document.addEventListener("keydown", function (e) {
    if ((e.key === "r" || e.key === "R") && state && state.phase === "placing" && document.activeElement.tagName !== "INPUT") rotate();
  });
  $("random").addEventListener("click", function () {
    if (!state || state.phase !== "placing" || state.ready[state.you]) return;
    me = board(); randomize(me); placed = FLEET.length;
    render();
  });
  $("clear").addEventListener("click", function () { resetPlacement(); if (state) render(); });
  $("ready").addEventListener("click", function () {
    if (placed < FLEET.length) return;
    send({ type: "ready", ships: me.ships.map(function (s) { return { cells: s.cells }; }) });
  });
  $("rematch").addEventListener("click", function () { send({ type: "rematch" }); });
  $("leave").addEventListener("click", function () { send({ type: "leave" }); goHome(""); });
  $("copy").addEventListener("click", function () {
    var c = state ? state.code : "";
    if (navigator.clipboard) navigator.clipboard.writeText(c).then(function () { toast("Code copied: " + c); }, function () { toast("Code: " + c); });
    else toast("Code: " + c);
  });

  $("host").addEventListener("click", function () {
    saveName();
    $("home-msg").textContent = "";
    fetch("/api/code").then(function (r) { return r.json(); }).then(function (d) {
      connect(d.code, true);
    }).catch(function () { $("home-msg").textContent = "Couldn't create a room. Try again."; });
  });
  function joinRoom() {
    var c = $("code").value.trim().toUpperCase();
    if (c.length < 4) { $("home-msg").textContent = "Enter the room code your host shared."; return; }
    saveName();
    $("home-msg").textContent = "";
    connect(c, false);
  }
  $("join").addEventListener("click", joinRoom);
  $("code").addEventListener("keydown", function (e) { if (e.key === "Enter") joinRoom(); });

  try { $("name").value = localStorage.getItem("bs_name") || ""; } catch (e) {}
  record();
  show("home");
  var saved = null;
  try { saved = sessionStorage.getItem("bs_room"); } catch (e) {}
  if (saved) connect(saved, false);
})();
// end of file
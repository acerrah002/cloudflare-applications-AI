import * as THREE from "three";
import { World, COLORS } from "./world.js";
import { createControls } from "./controls.js";

const VERSION = "1.0.0";
const BASE = 34, BOOST = 62, BRAKE = 16, ARENA_R = 130;
const FIRE_CD = 0.2, SHIP_R = 2.6;
const YAW_RATE = 1.9, PITCH_RATE = 1.5, MOUSE_SENS = 0.0022;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---------- tiny sound effects ----------
const sfx = (() => {
  let actx = null, muted = false;
  function ctx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (actx && actx.state === "suspended") actx.resume();
    return actx;
  }
  function tone(type, f0, f1, dur, vol) {
    if (muted) return;
    const a = ctx();
    if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), a.currentTime + dur);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  }
  function noise(dur, vol) {
    if (muted) return;
    const a = ctx();
    if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = a.createBufferSource(), g = a.createGain();
    s.buffer = buf; g.gain.value = vol;
    s.connect(g); g.connect(a.destination);
    s.start();
  }
  return {
    unlock: ctx,
    mute() { muted = !muted; return muted; },
    laser: () => tone("sawtooth", 880, 180, 0.14, 0.05),
    enemy: () => tone("sawtooth", 600, 150, 0.12, 0.025),
    hit: () => tone("square", 200, 60, 0.12, 0.08),
    boom: () => noise(0.7, 0.25),
  };
})();

$("version").textContent = "v" + VERSION;
const world = new World($("view"));
const controls = createControls($("view"), $("touch"), (m) => toast(m));
controls.onMute = () => toast(sfx.mute() ? "Sound off" : "Sound on");

let pid = null;
try { pid = sessionStorage.getItem("sd_pid"); } catch (e) {}
if (!pid) {
  pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { sessionStorage.setItem("sd_pid", pid); } catch (e) {}
}

let ws = null, st = null, view = "home", retries = 0, intentional = false, pingT = null, toastT = null;
let myShip = null, foeShip = null, laserSeq = 0, lastSend = 0, goUntil = 0, flashUntil = 0, snapCam = false;
const local = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, speed: BASE, energy: 100, fireT: 0, alive: false, inited: false, boosting: false };
const foe = { base: new THREE.Vector3(), pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, tyaw: 0, tpitch: 0, troll: 0, speed: BASE, recv: 0, alive: false, seen: false, boost: false };

world.ready.then(() => {
  myShip = world.makeShip(COLORS.me);
  foeShip = world.makeShip(COLORS.foe);
  myShip.root.visible = local.inited && local.alive;
  foeShip.root.visible = foe.seen && foe.alive;
});

function spawnFor(seat) {
  return seat === 0
    ? { pos: new THREE.Vector3(0, 0, 70), yaw: 0 }
    : { pos: new THREE.Vector3(0, 0, -70), yaw: Math.PI };
}
function forwardOf(yaw, pitch) {
  return new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
}
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _cp = new THREE.Vector3();
function segHit(a, b, c, r) {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  const len2 = _ab.lengthSq();
  const t = len2 > 0 ? clamp(_ac.dot(_ab) / len2, 0, 1) : 0;
  _cp.copy(a).addScaledVector(_ab, t);
  return _cp.distanceToSquared(c) <= r * r;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2800);
}

function showView(v) {
  view = v;
  $("home").hidden = v !== "home";
  $("lobby").hidden = v !== "lobby";
  $("hud").hidden = v !== "game";
  controls.setEnabled(v === "game");
}

function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function closeSocket() {
  clearInterval(pingT);
  if (ws) { const o = ws; ws = null; try { o.close(); } catch (e) {} }
}
function getName() { return $("name").value.trim() || "Pilot"; }

function goHome(msg) {
  intentional = true;
  closeSocket();
  st = null;
  local.inited = false; local.alive = false;
  foe.seen = false; foe.alive = false;
  if (myShip) myShip.root.visible = false;
  if (foeShip) foeShip.root.visible = false;
  world.clearLasers();
  try { sessionStorage.removeItem("sd_room"); } catch (e) {}
  $("end").hidden = true;
  showView("home");
  $("home-msg").textContent = msg || "";
}

function connect(code, create, retry) {
  intentional = false;
  closeSocket();
  if (!retry) { st = null; local.inited = false; }
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const url = proto + location.host + "/ws/" + code + "?pid=" + encodeURIComponent(pid) +
    "&name=" + encodeURIComponent(getName()) + (create ? "&create=1" : "");
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retries = 0;
    clearInterval(pingT);
    pingT = setInterval(() => send({ t: "ping" }), 25000);
  };
  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === "st") onState(m);
    else if (m.t === "o") onFoe(m);
    else if (m.t === "f") onFoeLaser(m);
    else if (m.t === "hp") onHp(m);
    else if (m.t === "fatal") goHome(m.message);
  };
  sock.onclose = () => {
    if (sock !== ws || intentional) return;
    clearInterval(pingT);
    if (st && retries < 6) {
      retries++;
      toast("Connection lost. Reconnecting...");
      setTimeout(() => { if (!intentional) connect(code, false, true); }, 2000);
      return;
    }
    goHome("Couldn't connect to that room.");
  };
}

function startRound(m) {
  const a = spawnFor(m.you), b = spawnFor(1 - m.you);
  world.setAsteroids(m.seed, [a.pos, b.pos]);
  world.clearLasers();
  local.pos.copy(a.pos); local.yaw = a.yaw; local.pitch = 0; local.roll = 0;
  local.speed = BASE; local.energy = 100; local.fireT = 0; local.alive = true; local.inited = true;
  foe.base.copy(b.pos); foe.pos.copy(b.pos);
  foe.yaw = foe.tyaw = b.yaw; foe.pitch = foe.tpitch = 0; foe.roll = foe.troll = 0;
  foe.speed = BASE; foe.recv = performance.now(); foe.alive = true; foe.seen = true;
  if (myShip) myShip.root.visible = true;
  if (foeShip) foeShip.root.visible = true;
  goUntil = performance.now() + 3000;
  snapCam = true;
}

function onState(m) {
  const prev = st;
  st = m;
  try { sessionStorage.setItem("sd_room", m.code); } catch (e) {}
  if (m.phase === "lobby") {
    showView("lobby");
    $("lobby-code").textContent = m.code;
    return;
  }
  showView("game");
  const fresh = m.phase === "countdown" && (!prev || prev.phase !== "countdown" || prev.round !== m.round);
  if (fresh) {
    startRound(m);
  } else if (!local.inited) {
    startRound(m);
    goUntil = 0;
    if (m.hp[m.you] <= 0) { local.alive = false; if (myShip) myShip.root.visible = false; }
    if (m.hp[1 - m.you] <= 0) { foe.alive = false; if (foeShip) foeShip.root.visible = false; }
  }
  if (m.phase === "playing" && (!prev || prev.phase !== "playing")) flashUntil = performance.now() + 900;
  if ((m.phase === "roundover" || m.phase === "matchover") && prev && prev.phase === "playing" && m.loser >= 0) {
    if (m.loser === m.you) {
      world.explode(local.pos, "me");
      local.alive = false;
      if (myShip) myShip.root.visible = false;
    } else {
      world.explode(foe.pos, "foe");
      foe.alive = false;
      if (foeShip) foeShip.root.visible = false;
    }
    sfx.boom();
  }
  syncHud();
  const over = m.phase === "matchover";
  $("end").hidden = !over;
  if (over) {
    const won = m.winner === m.you;
    $("end-title").textContent = won ? "VICTORY" : "DEFEAT";
    $("end-sub").textContent = m.wins[m.you] + " - " + m.wins[1 - m.you] + (m.msg ? "   " + m.msg : "");
    const rb = $("rematch");
    const oppName = m.names[1 - m.you] || "Opponent";
    rb.disabled = !!m.rematch[m.you];
    rb.textContent = m.rematch[m.you] ? "Waiting for " + oppName + "..." : (m.rematch[1 - m.you] ? oppName + " wants a rematch. Accept" : "Rematch");
  }
}

function setPips(id, n) {
  const kids = $(id).children;
  for (let i = 0; i < kids.length; i++) kids[i].className = i < n ? "on" : "";
}
function syncHud() {
  const me = st.you, op = 1 - me;
  $("name-me").textContent = st.names[me] || "You";
  $("name-foe").textContent = st.names[op] || "Opponent";
  $("hp-me").style.width = clamp(st.hp[me], 0, 100) + "%";
  $("hp-foe").style.width = clamp(st.hp[op], 0, 100) + "%";
  setPips("pips-me", st.wins[me]);
  setPips("pips-foe", st.wins[op]);
  $("round").textContent = "ROUND " + st.round;
  $("note").textContent = !st.connected[op] ? "Opponent disconnected. Waiting..." : "";
}

// ---------- menu buttons ----------
$("host").addEventListener("click", () => {
  sfx.unlock();
  try { localStorage.setItem("sd_name", getName()); } catch (e) {}
  $("home-msg").textContent = "";
  fetch("/api/code").then((r) => r.json()).then((d) => connect(d.code, true))
    .catch(() => { $("home-msg").textContent = "Couldn't create a room. Try again."; });
});
function joinRoom() {
  sfx.unlock();
  const c = $("code").value.trim().toUpperCase();
  if (c.length < 4) { $("home-msg").textContent = "Enter the room code your host shared."; return; }
  try { localStorage.setItem("sd_name", getName()); } catch (e) {}
  $("home-msg").textContent = "";
  connect(c, false);
}
$("join").addEventListener("click", joinRoom);
$("code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
$("copy").addEventListener("click", () => {
  const c = st ? st.code : "";
  if (navigator.clipboard) navigator.clipboard.writeText(c).then(() => toast("Code copied: " + c), () => toast("Code: " + c));
  else toast("Code: " + c);
});
$("leave-lobby").addEventListener("click", () => { send({ t: "leave" }); goHome(""); });
$("end-leave").addEventListener("click", () => { send({ t: "leave" }); goHome(""); });
$("quit").addEventListener("click", () => { send({ t: "leave" }); goHome(""); });
$("rematch").addEventListener("click", () => send({ t: "rematch" }));
// ---------- network events ----------
function onFoe(m) {
  foe.base.set(m.p[0], m.p[1], m.p[2]);
  foe.tyaw = m.r[0]; foe.tpitch = m.r[1]; foe.troll = m.r[2];
  foe.speed = m.v;
  foe.boost = !!m.b;
  foe.recv = performance.now();
}
function onFoeLaser(m) {
  if (!st || st.phase !== "playing") return;
  world.spawnLaser(new THREE.Vector3(m.o[0], m.o[1], m.o[2]), new THREE.Vector3(m.d[0], m.d[1], m.d[2]), "foe", m.id);
  sfx.enemy();
}
function onHp(m) {
  if (!st) return;
  const was = st.hp[st.you];
  st.hp = m.hp;
  if (m.hp[st.you] < was) { world.shake = Math.max(world.shake, 0.6); sfx.hit(); }
  syncHud();
}

// ---------- shooting ----------
function fireLaser() {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(local.pitch, local.yaw, 0, "YXZ"));
  const id = String(++laserSeq);
  const side = laserSeq % 2 === 0 ? -1.1 : 1.1;
  const origin = new THREE.Vector3(side, -0.1, -2.6).applyQuaternion(q).add(local.pos);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  if (foe.alive) {
    const to = foe.pos.clone().sub(origin);
    const dist = to.length();
    to.normalize();
    if (dist < 220 && dir.angleTo(to) < 0.14) dir.lerp(to, 0.6).normalize();
  }
  world.spawnLaser(origin, dir, "me", id);
  send({ t: "f", id, o: [r2(origin.x), r2(origin.y), r2(origin.z)], d: [r3(dir.x), r3(dir.y), r3(dir.z)] });
  local.fireT = FIRE_CD;
  sfx.laser();
}

// ---------- per-frame simulation ----------
function step(dt, now) {
  const playing = st.phase === "playing";
  if (local.alive && myShip) {
    const mouse = controls.consumeMouse();
    if (playing) {
      const ax = controls.axes();
      const dyaw = ax.yaw * YAW_RATE * dt - mouse[0] * MOUSE_SENS;
      local.yaw += dyaw;
      local.pitch = clamp(local.pitch + ax.pitch * PITCH_RATE * dt - mouse[1] * MOUSE_SENS, -1.4, 1.4);
      const rate = dyaw / Math.max(dt, 0.001);
      local.roll += (clamp(rate * 0.28, -0.8, 0.8) - local.roll) * Math.min(1, dt * 6);

      const wantBoost = controls.isBoost() && local.energy > 4;
      local.boosting = wantBoost;
      const target = wantBoost ? BOOST : (controls.isBrake() ? BRAKE : BASE);
      local.speed += (target - local.speed) * Math.min(1, dt * 3);
      local.energy = clamp(local.energy + (wantBoost ? -32 : 16) * dt, 0, 100);

      local.pos.addScaledVector(forwardOf(local.yaw, local.pitch), local.speed * dt);
      world.asteroids.forEach((a) => {
        _cp.copy(local.pos).sub(a.p);
        const d = _cp.length(), min = a.r * 0.92 + SHIP_R;
        if (d < min && d > 0.0001) {
          local.pos.copy(a.p).addScaledVector(_cp.divideScalar(d), min);
          local.speed *= 0.6;
        }
      });
      if (local.pos.length() > ARENA_R) local.pos.setLength(ARENA_R);

      local.fireT -= dt;
      if (controls.isFire() && local.fireT <= 0) fireLaser();
    } else {
      local.boosting = false;
    }
    world.place(myShip, local.pos, local.yaw, local.pitch, local.roll);
    world.setFlame(myShip, local.boosting ? 1 : local.speed / BOOST + 0.25);
  }

  if (foe.seen && foeShip && foe.alive) {
    const t = Math.min(0.15, (now - foe.recv) / 1000);
    const f = forwardOf(foe.tyaw, foe.tpitch);
    const want = foe.base.clone().addScaledVector(f, foe.speed * t);
    const k = 1 - Math.exp(-dt * 16);
    foe.pos.lerp(want, k);
    foe.yaw += angDiff(foe.tyaw, foe.yaw) * k;
    foe.pitch += (foe.tpitch - foe.pitch) * k;
    foe.roll += (foe.troll - foe.roll) * k;
    world.place(foeShip, foe.pos, foe.yaw, foe.pitch, foe.roll);
    world.setFlame(foeShip, foe.boost ? 1 : foe.speed / BOOST + 0.25);
  }
}

function laserHits() {
  const live = st.phase === "playing";
  for (let i = world.lasers.length - 1; i >= 0; i--) {
    const L = world.lasers[i];
    if (L.owner === "foe") {
      if (live && local.alive && segHit(L.prev, L.pos, local.pos, SHIP_R + 0.5)) {
        world.spark(L.pos, "foe", 10);
        world.removeLaser(L);
        send({ t: "h", id: L.id });
        world.shake = Math.max(world.shake, 0.5);
        sfx.hit();
      }
    } else if (foe.alive && segHit(L.prev, L.pos, foe.pos, SHIP_R + 0.5)) {
      world.spark(L.pos, "me", 10);
      world.removeLaser(L);
    }
  }
}

function updateMarker() {
  const mk = $("marker");
  if (!foe.alive || !foe.seen || st.phase === "matchover") { mk.hidden = true; return; }
  const s = world.toScreen(foe.pos);
  let x = s.x, y = s.y;
  const off = s.behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.85;
  if (off) {
    const m = Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.8, 0.0001);
    x /= m; y /= m;
  }
  const px = (x * 0.5 + 0.5) * window.innerWidth;
  const py = (1 - (y * 0.5 + 0.5)) * window.innerHeight;
  mk.hidden = false;
  mk.style.transform = "translate(" + px + "px," + py + "px)";
  mk.classList.toggle("off", off);
  $("mk-arrow").style.transform = "rotate(" + Math.atan2(-y, x) + "rad)";
  $("mk-dist").textContent = Math.round(foe.pos.distanceTo(local.pos)) + " m";
}

function updateBanner(now) {
  const b1 = $("b1"), b2 = $("b2");
  let show = true;
  if (st.phase === "countdown") {
    const left = Math.ceil((goUntil - now) / 1000);
    b1.textContent = left > 0 ? String(left) : "GO!";
    b2.textContent = "Round " + st.round + "  -  first to 3 wins";
  } else if (st.phase === "playing" && now < flashUntil) {
    b1.textContent = "GO!";
    b2.textContent = "";
  } else if (st.phase === "roundover") {
    const w = st.loser >= 0 ? 1 - st.loser : -1;
    b1.textContent = st.loser === st.you ? "You were destroyed" : "Enemy destroyed";
    b2.textContent = (w >= 0 ? st.names[w] : "") + " wins round " + st.round;
  } else {
    show = false;
  }
  $("banner").hidden = !show;
}

function updateHud2() {
  $("boost").style.width = local.energy + "%";
  $("warn").hidden = !(st.phase === "playing" && local.alive && local.pos.length() > ARENA_R - 14);
  $("lockhint").hidden = !(view === "game" && !controls.touch && !controls.locked && st.phase !== "matchover");
}

function sendState(now) {
  if (!ws || ws.readyState !== 1 || !local.inited || !local.alive || now - lastSend < 50) return;
  lastSend = now;
  ws.send(JSON.stringify({
    t: "s",
    p: [r2(local.pos.x), r2(local.pos.y), r2(local.pos.z)],
    r: [r3(local.yaw), r3(local.pitch), r3(local.roll)],
    v: r1(local.speed),
    b: local.boosting ? 1 : 0,
  }));
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!st || st.phase === "lobby") {
    world.idleCamera(dt);
    world.update(dt);
    world.render();
    return;
  }
  step(dt, now);
  world.update(dt);
  laserHits();
  if (local.alive) {
    world.follow(local.pos, local.yaw, local.pitch, dt, snapCam);
    snapCam = false;
  }
  updateMarker();
  updateBanner(now);
  updateHud2();
  sendState(now);
  world.render();
}

// ---------- start ----------
try { $("name").value = localStorage.getItem("sd_name") || ""; } catch (e) {}
showView("home");
let saved = null;
try { saved = sessionStorage.getItem("sd_room"); } catch (e) {}
if (saved) connect(saved, false);
requestAnimationFrame(frame);
// end of file
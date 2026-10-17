// Keyboard + mouse (pointer lock) + touch controls
export function createControls(canvas, touchRoot, notify) {
  const keys = {};
  const c = { touch: false, locked: false, enabled: false, invert: false, mouseFire: false, mouseBoost: false, tFire: false, tBoost: false, tBrake: false, sx: 0, sy: 0, dx: 0, dy: 0, onMute: null };
  const cl = (v) => Math.max(-1, Math.min(1, v));
  try { c.touch = window.matchMedia("(pointer: coarse)").matches; } catch (e) {}
  try { c.invert = localStorage.getItem("sd_invert") === "1"; } catch (e) {}

  const typing = (e) => e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");

  window.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    keys[e.code] = true;
    if (c.enabled && (e.code === "Space" || e.code.indexOf("Arrow") === 0)) e.preventDefault();
    if (e.code === "KeyI" && !e.repeat) {
      c.invert = !c.invert;
      try { localStorage.setItem("sd_invert", c.invert ? "1" : "0"); } catch (x) {}
      if (notify) notify("Invert Y: " + (c.invert ? "on" : "off"));
    }
    if (e.code === "KeyM" && !e.repeat && c.onMute) c.onMute();
  });
  window.addEventListener("keyup", (e) => { keys[e.code] = false; });
  window.addEventListener("blur", () => {
    for (const k in keys) keys[k] = false;
    c.mouseFire = false;
    c.mouseBoost = false;
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mousedown", (e) => {
    if (!c.enabled || c.touch) return;
    if (!c.locked) {
      if (canvas.requestPointerLock) canvas.requestPointerLock();
      return;
    }
    if (e.button === 0) c.mouseFire = true;
    if (e.button === 2) c.mouseBoost = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) c.mouseFire = false;
    if (e.button === 2) c.mouseBoost = false;
  });
  document.addEventListener("pointerlockchange", () => {
    c.locked = document.pointerLockElement === canvas;
    if (!c.locked) { c.mouseFire = false; c.mouseBoost = false; }
  });
  document.addEventListener("mousemove", (e) => {
    if (c.locked) { c.dx += e.movementX; c.dy += e.movementY; }
  });
  document.addEventListener("touchmove", (e) => { if (c.enabled) e.preventDefault(); }, { passive: false });

  // ---- virtual stick ----
  const stick = document.getElementById("stick");
  const knob = document.getElementById("knob");
  let stickId = null;
  function find(list, id) {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  }
  function stickMove(t) {
    const r = stick.getBoundingClientRect();
    const rad = r.width / 2;
    let x = (t.clientX - (r.left + rad)) / rad;
    let y = (t.clientY - (r.top + rad)) / rad;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    c.sx = Math.abs(x) < 0.1 ? 0 : x;
    c.sy = Math.abs(y) < 0.1 ? 0 : y;
    knob.style.transform = "translate(" + (x * rad * 0.55) + "px," + (y * rad * 0.55) + "px)";
  }
  stick.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (stickId !== null) return;
    const t = e.changedTouches[0];
    stickId = t.identifier;
    stickMove(t);
  }, { passive: false });
  stick.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const t = find(e.changedTouches, stickId);
    if (t) stickMove(t);
  }, { passive: false });
  const stickEnd = (e) => {
    const t = find(e.changedTouches, stickId);
    if (!t) return;
    stickId = null;
    c.sx = 0;
    c.sy = 0;
    knob.style.transform = "translate(0,0)";
  };
  stick.addEventListener("touchend", stickEnd);
  stick.addEventListener("touchcancel", stickEnd);

  function hold(id, key) {
    const el = document.getElementById(id);
    const on = (e) => { e.preventDefault(); c[key] = true; el.classList.add("down"); };
    const off = (e) => { e.preventDefault(); c[key] = false; el.classList.remove("down"); };
    el.addEventListener("touchstart", on, { passive: false });
    el.addEventListener("touchend", off, { passive: false });
    el.addEventListener("touchcancel", off, { passive: false });
  }
  hold("t-fire", "tFire");
  hold("t-boost", "tBoost");
  hold("t-brake", "tBrake");

  c.axes = () => {
    const inv = c.invert ? -1 : 1;
    const yaw = ((keys.ArrowLeft || keys.KeyA) ? 1 : 0) - ((keys.ArrowRight || keys.KeyD) ? 1 : 0) - c.sx;
    const pitch = (((keys.ArrowUp || keys.KeyW) ? 1 : 0) - ((keys.ArrowDown || keys.KeyS) ? 1 : 0) - c.sy) * inv;
    return { yaw: cl(yaw), pitch: cl(pitch) };
  };
  c.consumeMouse = () => {
    const r = [c.dx, c.invert ? -c.dy : c.dy];
    c.dx = 0;
    c.dy = 0;
    return r;
  };
  c.isFire = () => !!(keys.Space || c.mouseFire || c.tFire);
  c.isBoost = () => !!(keys.ShiftLeft || keys.ShiftRight || c.mouseBoost || c.tBoost);
  c.isBrake = () => !!(keys.KeyX || keys.ControlLeft || c.tBrake);
  c.setEnabled = (v) => {
    if (c.enabled === v) return;
    c.enabled = v;
    touchRoot.hidden = !(v && c.touch);
    if (!v) {
      if (document.pointerLockElement) document.exitPointerLock();
      c.mouseFire = false; c.mouseBoost = false;
      c.tFire = false; c.tBoost = false; c.tBrake = false;
      c.sx = 0; c.sy = 0;
    }
  };
  return c;
}
// end of file
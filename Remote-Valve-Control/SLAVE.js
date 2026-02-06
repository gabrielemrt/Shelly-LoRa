/*
 * SLAVE – Shelly 2 Gen3 + LoRa
 * Remote Valve Controller
 * FIX: no timer leak, no reboot
 */

let CFG = {
  COVER_ID: 0,

  POLL_MS: 500,
  DONE_TIMEOUT_MS: 30000,

  ACK_RETRIES: 3,
  DONE_RETRIES: 3,
  SPACING_MS: 700,

  START: "~",
  END: "#",
  MAX_DECODE_LEN: 512,

  DEBUG: true,
};

function log() { if (CFG.DEBUG) print.apply(null, arguments); }

/* ===== FRAMING ===== */

function xorChecksumHex(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  let h = c.toString(16).toUpperCase();
  while (h.length < 4) h = "0" + h;
  return h.slice(-4);
}

function encodePayload(o) {
  let p = [];
  p.push("t=" + o.t);
  if (o.cmd) p.push("cmd=" + o.cmd);
  p.push("req=" + o.req);
  if (o.state) p.push("state=" + o.state);
  if (o.ok !== undefined) p.push("ok=" + (o.ok ? "1" : "0"));
  return p.join(";");
}

function decodePayload(s) {
  let o = {};
  s.split(";").forEach(kv => {
    let p = kv.split("=");
    if (p.length >= 2) o[p[0]] = p.slice(1).join("=");
  });
  if (o.ok !== undefined) o.ok = (o.ok === "1");
  return o;
}

function makeFrame(payload) {
  return CFG.START + payload.length + ":" + payload + "|" +
         xorChecksumHex(payload) + CFG.END;
}

function extractFrames(s) {
  let out = [];
  if (!s) return out;
  if (s.length > CFG.MAX_DECODE_LEN) s = s.slice(0, CFG.MAX_DECODE_LEN);

  let i = 0;
  while (true) {
    let a = s.indexOf(CFG.START, i);
    if (a < 0) break;
    let b = s.indexOf(CFG.END, a);
    if (b < 0) break;

    let c = s.slice(a + 1, b);
    let p1 = c.indexOf(":");
    let p2 = c.lastIndexOf("|");
    if (p1 < 0 || p2 < 0) { i = b + 1; continue; }

    let len = parseInt(c.slice(0, p1), 10);
    let payload = c.slice(p1 + 1, p2);
    let chk = c.slice(p2 + 1);

    if (payload.length === len && xorChecksumHex(payload) === chk)
      out.push(payload);

    i = b + 1;
  }
  return out;
}

function loraSend(dest, obj) {
  Shelly.call("Lora.SendBytes", {
    id: dest,
    data: btoa(makeFrame(encodePayload(obj)))
  });
}

/* ===== SAFE BURST ===== */

let burstBusy = false;

function burst(dest, obj, count) {
  if (burstBusy) return;
  burstBusy = true;

  let sent = 0;
  function step() {
    if (sent >= count) {
      burstBusy = false;
      return;
    }
    loraSend(dest, obj);
    sent++;
    Timer.set(CFG.SPACING_MS, false, step);
  }
  step();
}

/* ===== VALVE ===== */

let seen = {};

function waitForState(dest, req, target) {
  let start = Date.now();

  function poll() {
    Shelly.call("Cover.GetStatus", { id: CFG.COVER_ID }, st => {
      if (st.state === target) {
        burst(dest, { t: "DONE", req, ok: true, state: target }, CFG.DONE_RETRIES);
        return;
      }
      if (Date.now() - start > CFG.DONE_TIMEOUT_MS) {
        burst(dest, { t: "DONE", req, ok: false, state: st.state }, CFG.DONE_RETRIES);
        return;
      }
      Timer.set(CFG.POLL_MS, false, poll);
    });
  }
  poll();
}

/* ===== RX ===== */

Shelly.addEventHandler(function (e) {
  if (!e?.info?.data) return;

  let decoded;
  try { decoded = atob(e.info.data); } catch { return; }

  extractFrames(decoded).forEach(p => {
    let m = decodePayload(p);

    if (m.t === "PING") {
      loraSend(e.id, { t: "PONG", req: m.req });
      return;
    }

    if (m.t === "CMD" && m.cmd && m.req) {
      if (seen[m.req]) {
        burst(e.id, { t: "ACK", req: m.req }, CFG.ACK_RETRIES);
        return;
      }
      seen[m.req] = true;

      burst(e.id, { t: "ACK", req: m.req }, CFG.ACK_RETRIES);

      if (m.cmd === "CO-OP") {
        Shelly.call("Cover.Open", { id: CFG.COVER_ID });
        waitForState(e.id, m.req, "open");
      }

      if (m.cmd === "CO-CL") {
        Shelly.call("Cover.Close", { id: CFG.COVER_ID });
        waitForState(e.id, m.req, "closed");
      }
    }
  });
});

log("🚀 SLAVE pronto – FIX TIMER LEAK");

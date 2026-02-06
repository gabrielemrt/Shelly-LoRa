/*
 * MASTER – Shelly 2 Gen3 + LoRa
 * Remote Valve Control
 * Health check = Keep-alive (PING/PONG ogni 15 min)
 */

let CFG = {
  LORA_SLAVE_ID: 102,

  TIMEOUT_MS: 60000,
  RESEND_IF_NO_ACK_MS: 7000,
  MAX_RESENDS: 2,
  IGNORE_WHILE_PENDING: true,

  VC_OPEN_BTN_ID: 200,
  VC_CLOSE_BTN_ID: 201,
  VC_VALVE_BOOL_ID: 200,
  VC_LINK_BOOL_ID: 201,

  START: "~",
  END: "#",
  MAX_DECODE_LEN: 512,

  DEBUG: true,
};

let HB = {
  INTERVAL_MS: 15 * 60 * 1000,
  TIMEOUT_MS: 60 * 1000,
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

function loraSend(obj) {
  Shelly.call("Lora.SendBytes", {
    id: CFG.LORA_SLAVE_ID,
    data: btoa(makeFrame(encodePayload(obj)))
  });
}

/* ===== VIRTUAL ===== */

function setValve(v) {
  Shelly.call("Boolean.Set", { id: CFG.VC_VALVE_BOOL_ID, value: !!v });
}

function setLink(v) {
  Shelly.call("Boolean.Set", { id: CFG.VC_LINK_BOOL_ID, value: !!v });
}

/* ===== VALVE ===== */

let pending = null;

function clearPending() {
  if (!pending) return;
  if (pending.timeout) Timer.clear(pending.timeout);
  if (pending.resend) Timer.clear(pending.resend);
  pending = null;
}

function sendCommand(cmd) {
  if (CFG.IGNORE_WHILE_PENDING && pending) return;

  let req = Math.random().toString(16).slice(2);
  pending = { req, ack: false };

  loraSend({ t: "CMD", cmd, req });

  pending.timeout = Timer.set(CFG.TIMEOUT_MS, false, () => clearPending());

  pending.resend = Timer.set(CFG.RESEND_IF_NO_ACK_MS, false, function resend() {
    if (!pending || pending.ack) return;
    loraSend({ t: "CMD", cmd, req });
    pending.resend = Timer.set(CFG.RESEND_IF_NO_ACK_MS, false, resend);
  });
}

/* ===== HEARTBEAT ===== */

let hb = null;

function sendHealthPing() {
  if (hb || pending) return;

  let req = "hb-" + Math.random().toString(16).slice(2);
  hb = { req };

  setLink(false);
  loraSend({ t: "PING", req });

  hb.timer = Timer.set(HB.TIMEOUT_MS, false, () => {
    if (hb && hb.req === req) {
      hb = null;
      setLink(false);
    }
  });
}

Timer.set(30 * 1000, false, function () {
  sendHealthPing();
  Timer.set(HB.INTERVAL_MS, true, sendHealthPing);
});

/* ===== RX ===== */

Shelly.addEventHandler(function (e) {
  if (!e?.info?.data) return;

  let decoded;
  try { decoded = atob(e.info.data); } catch { return; }

  extractFrames(decoded).forEach(p => {
    let m = decodePayload(p);

    if (m.t === "PONG" && hb && m.req === hb.req) {
      Timer.clear(hb.timer);
      hb = null;
      setLink(true);
    }

    if (m.t === "ACK" && pending && m.req === pending.req)
      pending.ack = true;

    if (m.t === "DONE" && pending && m.req === pending.req) {
      setValve(m.state === "open");
      clearPending();
    }
  });
});

Shelly.addEventHandler(e => {
  if (e.name !== "button") return;
  if (e.id === CFG.VC_OPEN_BTN_ID) sendCommand("CO-OP");
  if (e.id === CFG.VC_CLOSE_BTN_ID) sendCommand("CO-CL");
});

log("🚀 MASTER pronto");

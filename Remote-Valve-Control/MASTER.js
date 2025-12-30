/*
 * MASTER - Shelly Gen3 + LoRa (ROBUST)
 * - Virtual Buttons: button:200 OPEN, button:201 CLOSE
 * - Virtual Boolean: boolean:200 state (true=open, false=closed)
 * - Robust framing: ~LEN:PAYLOAD|CHK#
 * - RX decoder extracts valid frames even if concatenated/corrupted
 * - FIX: no crash timers (closure req/t0), lock while pending
 * - FIX: resend if no ACK within X ms (same req)
 */

let CFG = {
  LORA_SLAVE_ID: 102,

  // command lifecycle
  TIMEOUT_MS: 60000,               // total time window
  RESEND_IF_NO_ACK_MS: 7000,       // if no ACK after 7s -> resend
  MAX_RESENDS: 2,                  // total sends = 1 + MAX_RESENDS
  IGNORE_WHILE_PENDING: true,      // avoid concurrent requests

  DEBUG: true,

  // Virtual Components
  VC_OPEN_BTN_ID: 200,
  VC_CLOSE_BTN_ID: 201,
  VC_STATE_BOOL_ID: 200,

  // Framing
  START: "~",
  END: "#",
  MAX_DECODE_LEN: 512,
};

function log() { if (CFG.DEBUG) print.apply(null, arguments); }
function nowMs() { return Date.now(); }

// ===== Checksum (XOR) =====
function xorChecksumHex(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  let h = c.toString(16).toUpperCase();
  while (h.length < 4) h = "0" + h;
  return h.slice(-4);
}

// ===== Payload (key=value;...) =====
function encodePayload(obj) {
  let parts = [];
  parts.push("t=" + obj.t);
  if (obj.cmd !== undefined) parts.push("cmd=" + obj.cmd);
  parts.push("req=" + obj.req);
  if (obj.ok !== undefined) parts.push("ok=" + (obj.ok ? "1" : "0"));
  if (obj.state !== undefined) parts.push("state=" + obj.state);
  if (obj.err !== undefined) parts.push("err=" + obj.err);
  return parts.join(";");
}

function decodePayload(payload) {
  let o = {};
  let parts = payload.split(";");
  for (let i = 0; i < parts.length; i++) {
    let kv = parts[i].split("=");
    if (kv.length < 2) continue;
    let k = kv[0];
    let v = kv.slice(1).join("=");
    o[k] = v;
  }
  if (o.ok !== undefined) o.ok = (o.ok === "1" || o.ok === "true");
  return o;
}

// ===== Framing =====
// frame: ~<LEN>:<PAYLOAD>|<CHK>#
function makeFrame(payload) {
  let len = payload.length;
  let chk = xorChecksumHex(payload);
  return CFG.START + len + ":" + payload + "|" + chk + CFG.END;
}

function extractFrames(decoded) {
  let frames = [];
  if (!decoded) return frames;
  if (decoded.length > CFG.MAX_DECODE_LEN) decoded = decoded.slice(0, CFG.MAX_DECODE_LEN);

  let s = decoded;
  let idx = 0;

  while (true) {
    let a = s.indexOf(CFG.START, idx);
    if (a < 0) break;
    let b = s.indexOf(CFG.END, a + 1);
    if (b < 0) break;

    let candidate = s.slice(a + 1, b); // LEN:PAYLOAD|CHK
    let colon = candidate.indexOf(":");
    let pipe = candidate.lastIndexOf("|");
    if (colon < 0 || pipe < 0 || pipe < colon) { idx = b + 1; continue; }

    let lenStr = candidate.slice(0, colon);
    let payload = candidate.slice(colon + 1, pipe);
    let chk = candidate.slice(pipe + 1);

    let len = parseInt(lenStr, 10);
    if (!isFinite(len) || len < 1 || len > 400) { idx = b + 1; continue; }
    if (payload.length !== len) { idx = b + 1; continue; }

    let expected = xorChecksumHex(payload);
    if (chk !== expected) { idx = b + 1; continue; }

    frames.push(payload);
    idx = b + 1;
  }

  return frames;
}

// ===== LoRa TX =====
function loraSend(destId, obj) {
  let payload = encodePayload(obj);
  let frame = makeFrame(payload);

  Shelly.call("Lora.SendBytes", { id: destId, data: btoa(frame) }, function (_, ec, em) {
    if (ec !== 0) log("❌ TX FAIL dest=", destId, "ec=", ec, "em=", em);
    else log("✅ TX OK ->", destId, "t=", obj.t, "cmd=", obj.cmd || "", "req=", obj.req);
  });
}

// ===== Virtual Boolean setter =====
function setValveStateBool(isOpen) {
  Shelly.call("Boolean.Set", { id: CFG.VC_STATE_BOOL_ID, value: !!isOpen }, function (_, ec, em) {
    if (ec !== 0) log("❌ Boolean.Set failed:", ec, em);
    else log("🟢 boolean:200 =", isOpen ? "true (open)" : "false (closed)");
  });
}

// ===== Pending (single-flight) =====
let pending = null;
// pending = {
//   req, cmd, label, t0,
//   ackReceived: bool,
//   sendCount: int,
//   timeoutTimer, resendTimer
// }

function cmdLabel(cmd) {
  if (cmd === "CO-OP") return "APERTURA";
  if (cmd === "CO-CL") return "CHIUSURA";
  return cmd;
}

function clearPending(reason) {
  if (!pending) return;
  if (pending.timeoutTimer) Timer.clear(pending.timeoutTimer);
  if (pending.resendTimer) Timer.clear(pending.resendTimer);
  log("🧹 Clear pending req=", pending.req, "reason=", reason);
  pending = null;
}

function scheduleResend(req) {
  // use closure req, never read pending blindly
  let localReq = req;

  // if no pending or different req -> ignore
  if (!pending || pending.req !== localReq) return;

  // already have ACK -> do not resend
  if (pending.ackReceived) return;

  // reached max resends
  if (pending.sendCount > CFG.MAX_RESENDS) return;

  pending.resendTimer = Timer.set(CFG.RESEND_IF_NO_ACK_MS, false, function () {
    if (!pending || pending.req !== localReq) return;
    if (pending.ackReceived) return;

    pending.sendCount++;
    log("🔁 Nessun ACK, ritrasmetto comando", pending.label,
        "(resend", pending.sendCount, "di", (CFG.MAX_RESENDS + 1) + ")", "req=", pending.req);

    loraSend(CFG.LORA_SLAVE_ID, { t: "CMD", cmd: pending.cmd, req: pending.req });

    // schedule next resend if needed
    scheduleResend(localReq);
  });
}

function sendCommand(cmd) {
  if (CFG.IGNORE_WHILE_PENDING && pending) {
    log("⛔ Comando ignorato: operazione già in corso:", pending.label, "req=", pending.req);
    return;
  }

  let req = (Math.floor(Math.random() * 1e9)).toString(16);
  let label = cmdLabel(cmd);
  let t0 = nowMs();

  pending = {
    req: req,
    cmd: cmd,
    label: label,
    t0: t0,
    ackReceived: false,
    sendCount: 0,
    timeoutTimer: null,
    resendTimer: null,
  };

  log("🚩 START", label, "req=", req, "TIMEOUT_MS=", CFG.TIMEOUT_MS);

  // timeout totale (closure: req + t0)
  let localReq = req;
  let localT0 = t0;

  pending.timeoutTimer = Timer.set(CFG.TIMEOUT_MS, false, function () {
    // if req changed or cleared, ignore
    if (!pending || pending.req !== localReq) return;
    log("⏱️ TIMEOUT", label, "req=", localReq, "elapsed(ms)=", (nowMs() - localT0));
    clearPending("timeout");
  });

  // initial send
  pending.sendCount = 1;
  log("➡️  Inviato comando", label, "(send 1)", "req=", req);
  loraSend(CFG.LORA_SLAVE_ID, { t: "CMD", cmd: cmd, req: req });

  // schedule resend if no ACK arrives
  scheduleResend(req);
}

// Optional debug RPC
function valveOpen()  { sendCommand("CO-OP"); }
function valveClose() { sendCommand("CO-CL"); }

// ===== Virtual Buttons listener =====
Shelly.addEventHandler(function (event) {
  if (!event || !event.info) return;
  if (event.name !== "button") return;
  if (event.id !== CFG.VC_OPEN_BTN_ID && event.id !== CFG.VC_CLOSE_BTN_ID) return;

  // Many firmwares use: single_push / pressed / on. Keep permissive.
  if (event.id === CFG.VC_OPEN_BTN_ID) {
    log("🟦 VC button:200 -> OPEN");
    sendCommand("CO-OP");
  } else {
    log("🟧 VC button:201 -> CLOSE");
    sendCommand("CO-CL");
  }
});

// ===== LoRa RX: decode base64 -> extract frames -> handle messages =====
Shelly.addEventHandler(function (event) {
  if (!event || !event.info || !event.info.data) return;

  let decoded;
  try { decoded = atob(event.info.data); } catch (e) { return; }

  let payloads = extractFrames(decoded);
  if (payloads.length === 0) return;

  for (let i = 0; i < payloads.length; i++) {
    let msg = decodePayload(payloads[i]);
    if (!msg || !msg.t || !msg.req) continue;

    // Always log minimal RX
    log("📡 RX t=", msg.t, "req=", msg.req, "fromId=", event.id);

    if (!pending) continue;
    if (msg.req !== pending.req) continue;

    let elapsed = nowMs() - pending.t0;

    if (msg.t === "ACK") {
      pending.ackReceived = true;
      log("📩 ACK ricevuto:", pending.label, "elapsed(ms)=", elapsed);
      continue;
    }

    if (msg.t === "DONE") {
      log("✅ DONE:", pending.label, "ok=", msg.ok, "state=", msg.state, "elapsed(ms)=", elapsed);

      if (msg.state === "open") setValveStateBool(true);
      if (msg.state === "closed") setValveStateBool(false);

      clearPending("done");
      continue;
    }

    if (msg.t === "ERR") {
      log("💥 ERR:", pending.label, msg.err || "", "elapsed(ms)=", elapsed);
      clearPending("err");
      continue;
    }
  }
});

log("🚀 MASTER pronto. Usa Virtual Buttons 200/201 oppure valveOpen()/valveClose().");

/*
 * SLAVE - Shelly 2 Gen3 + LoRa
 * - Robust framing: ~LEN:PAYLOAD|CHK#
 * - Dedup on req (idempotent)
 * - ACK + DONE burst (anti loss)
 */

let CFG = {
  COVER_ID: 0,
  DONE_TIMEOUT_MS: 25000,
  POLL_MS: 500,
  DEBUG: true,

  ACK_RETRIES: 3,
  ACK_SPACING_MS: 700,

  DONE_RETRIES: 3,
  DONE_SPACING_MS: 700,

  START: "~",
  END: "#",
  MAX_DECODE_LEN: 512,
};

let seen = {};
let SEEN_TTL_MS = 60000;

function log() { if (CFG.DEBUG) print.apply(null, arguments); }

function xorChecksumHex(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  let h = c.toString(16).toUpperCase();
  while (h.length < 4) h = "0" + h;
  return h.slice(-4);
}

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

function loraSend(destId, obj) {
  let payload = encodePayload(obj);
  let frame = makeFrame(payload);

  Shelly.call("Lora.SendBytes", { id: destId, data: btoa(frame) }, function (_, ec, em) {
    if (ec !== 0) log("❌ LoRa TX FAIL destId=", destId, "t=", obj.t, "req=", obj.req, "ec=", ec, "em=", em);
    else log("✅ LoRa TX OK  destId=", destId, "t=", obj.t, "req=", obj.req);
  });
}

function burstSend(destId, obj, count, spacingMs) {
  for (let i = 0; i < count; i++) {
    (function (k) {
      Timer.set(k * spacingMs, false, function () { loraSend(destId, obj); });
    })(i);
  }
}

function ack(destId, req) { burstSend(destId, { t: "ACK", req: req }, CFG.ACK_RETRIES, CFG.ACK_SPACING_MS); }
function done(destId, req, ok, state) { burstSend(destId, { t: "DONE", req: req, ok: !!ok, state: state || "" }, CFG.DONE_RETRIES, CFG.DONE_SPACING_MS); }
function err(destId, req, msg) { burstSend(destId, { t: "ERR", req: req, err: msg || "unknown" }, CFG.DONE_RETRIES, CFG.DONE_SPACING_MS); }

function cleanupSeen() {
  let now = Date.now();
  for (let k in seen) if (now - seen[k] > SEEN_TTL_MS) delete seen[k];
}

function cmdLabel(cmd) {
  if (cmd === "CO-OP") return "APERTURA";
  if (cmd === "CO-CL") return "CHIUSURA";
  return cmd;
}

function waitCoverState(destId, req, targetState, label) {
  let t0 = Date.now();

  function poll() {
    Shelly.call("Cover.GetStatus", { id: CFG.COVER_ID }, function (st, ec, em) {
      if (ec !== 0) { err(destId, req, "Cover.GetStatus failed: " + em); return; }

      let state = (st && st.state) ? st.state : "unknown";

      if (state === targetState) {
        log("✅ Elettrovalvola:", label, "COMPLETATA (state=", state + ")", "req=", req);
        done(destId, req, true, state);
        return;
      }

      if (Date.now() - t0 > CFG.DONE_TIMEOUT_MS) {
        log("⏱️ Timeout completamento:", label, "(state attuale=", state + ")", "req=", req);
        done(destId, req, false, state);
        return;
      }

      Timer.set(CFG.POLL_MS, false, poll);
    });
  }

  poll();
}

function handleCmd(senderId, cmd, req) {
  cleanupSeen();

  if (seen[req] && (Date.now() - seen[req] < SEEN_TTL_MS)) {
    log("↩️ Duplicate req:", req, "| cmd=", cmdLabel(cmd), "— ritrasmetto ACK");
    ack(senderId, req);
    return;
  }
  seen[req] = Date.now();

  let label = cmdLabel(cmd);
  log("📩 Ricevuto comando", label, "req=", req, "| senderId=", senderId, "— invio ACK burst");
  ack(senderId, req);

  if (cmd === "CO-OP") {
    Shelly.call("Cover.Open", { id: CFG.COVER_ID }, function (_, ec, em) {
      if (ec !== 0) { err(senderId, req, "Cover.Open failed: " + em); return; }
      log("▶️  Avviata APERTURA, attendo stato open… req=", req);
      waitCoverState(senderId, req, "open", "APERTURA");
    });
    return;
  }

  if (cmd === "CO-CL") {
    Shelly.call("Cover.Close", { id: CFG.COVER_ID }, function (_, ec, em) {
      if (ec !== 0) { err(senderId, req, "Cover.Close failed: " + em); return; }
      log("▶️  Avviata CHIUSURA, attendo stato closed… req=", req);
      waitCoverState(senderId, req, "closed", "CHIUSURA");
    });
    return;
  }

  err(senderId, req, "Unknown cmd: " + cmd);
}

Shelly.addEventHandler(function (event) {
  if (!event || !event.info || !event.info.data) return;

  let decoded;
  try { decoded = atob(event.info.data); } catch (e) { return; }

  let payloads = extractFrames(decoded);
  if (payloads.length === 0) return;

  for (let i = 0; i < payloads.length; i++) {
    let msg = decodePayload(payloads[i]);
    if (!msg || msg.t !== "CMD" || !msg.cmd || !msg.req) continue;
    handleCmd(event.id, msg.cmd, msg.req);
  }
});

log("🚀 SLAVE pronto.");

/*
 * SLAVE - Shelly 2 Gen3 + LoRa
 * - Riceve CO-OP/CO-CL
 * - ACK burst + DONE burst
 * - DEDUP su req
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
};

let seen = {};
let SEEN_TTL_MS = 60000;

function log() { if (CFG.DEBUG) print.apply(null, arguments); }

function checksumHex(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  let h = c.toString(16).toUpperCase();
  while (h.length < 4) h = "0" + h;
  return h.slice(-4);
}

function pack(obj) {
  let body = JSON.stringify(obj);
  return JSON.stringify({ body: body, chk: checksumHex(body) });
}

function unpack(str) {
  let outer = JSON.parse(str);
  if (!outer || !outer.body || !outer.chk) throw "outer missing fields";
  if (checksumHex(outer.body) !== outer.chk) throw "checksum mismatch";
  return JSON.parse(outer.body);
}

function cmdLabel(cmd) {
  if (cmd === "CO-OP") return "APERTURA";
  if (cmd === "CO-CL") return "CHIUSURA";
  return cmd;
}

function loraSend(destId, msgObj) {
  let payload = pack(msgObj);
  Shelly.call("Lora.SendBytes", { id: destId, data: btoa(payload) }, function (_, ec, em) {
    if (ec !== 0) log("❌ LoRa TX FAIL destId=", destId, "type=", msgObj.t, "req=", msgObj.req, "ec=", ec, "em=", em);
    else log("✅ LoRa TX OK  destId=", destId, "type=", msgObj.t, "req=", msgObj.req);
  });
}

function burstSend(destId, msgObj, count, spacingMs) {
  for (let i = 0; i < count; i++) {
    (function (k) {
      Timer.set(k * spacingMs, false, function () { loraSend(destId, msgObj); });
    })(i);
  }
}

function ack(destId, req) {
  burstSend(destId, { t: "ACK", req: req }, CFG.ACK_RETRIES, CFG.ACK_SPACING_MS);
}

function done(destId, req, ok, state) {
  burstSend(destId, { t: "DONE", req: req, ok: !!ok, state: state || "" }, CFG.DONE_RETRIES, CFG.DONE_SPACING_MS);
}

function err(destId, req, msg) {
  burstSend(destId, { t: "ERR", req: req, err: msg || "unknown" }, CFG.DONE_RETRIES, CFG.DONE_SPACING_MS);
}

function cleanupSeen() {
  let now = Date.now();
  for (let k in seen) if (now - seen[k] > SEEN_TTL_MS) delete seen[k];
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

  let raw;
  try { raw = atob(event.info.data); }
  catch (e) { log("❌ atob failed:", e); return; }

  let msg;
  try { msg = unpack(raw); }
  catch (e) { log("❌ unpack failed:", e, "raw=", raw.slice(0, 160)); return; }

  if (!msg || msg.t !== "CMD" || !msg.cmd || !msg.req) return;

  handleCmd(event.id, msg.cmd, msg.req);
});

log("🚀 SLAVE pronto.");
/*
 * MASTER - Shelly Gen3 + LoRa + Virtual Components
 * button:200 -> OPEN
 * button:201 -> CLOSE
 * boolean:200 -> Stato (true=open, false=closed)
 */

let CFG = {
  LORA_SLAVE_ID: 102,
  TIMEOUT_MS: 60000,
  DEBUG: true,

  VC_OPEN_BTN_ID: 200,
  VC_CLOSE_BTN_ID: 201,
  VC_STATE_BOOL_ID: 200,
};

function log() { if (CFG.DEBUG) print.apply(null, arguments); }
function nowMs() { return Date.now(); }

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
  if (!outer || !outer.body || !outer.chk) return null;
  if (checksumHex(outer.body) !== outer.chk) return null;
  return JSON.parse(outer.body);
}

function cmdLabel(cmd) {
  if (cmd === "CO-OP") return "APERTURA";
  if (cmd === "CO-CL") return "CHIUSURA";
  return cmd;
}

function loraSendOnce(destId, msgObj) {
  let payload = pack(msgObj);
  Shelly.call("Lora.SendBytes", { id: destId, data: btoa(payload) }, function (_, ec, em) {
    if (ec !== 0) log("❌ TX FAIL dest=", destId, "ec=", ec, "em=", em);
    else log("✅ TX OK ->", destId, "cmd=", msgObj.cmd, "req=", msgObj.req);
  });
}

// === Virtual Boolean setter ===
function setValveStateBool(isOpen) {
  // boolean:200 => true=open, false=closed
  Shelly.call("Boolean.Set", { id: CFG.VC_STATE_BOOL_ID, value: !!isOpen }, function (_, ec, em) {
    if (ec !== 0) log("❌ Boolean.Set failed:", ec, em);
    else log("🟢 Stato elettrovalvola aggiornato ->", isOpen ? "APERTO (true)" : "CHIUSO (false)");
  });
}

let pending = null; // { req, cmd, t0, timer }

function clearPending(reason) {
  if (!pending) return;
  if (pending.timer) Timer.clear(pending.timer);
  log("🧹 Clear pending req=", pending.req, "reason=", reason);
  pending = null;
}

function sendCommand(cmd) {
  let req = (Math.floor(Math.random() * 1e9)).toString(16);
  let label = cmdLabel(cmd);
  let t0 = nowMs();

  pending = { req: req, cmd: cmd, t0: t0, timer: null };

  log("🚩 START", label, "req=", req, "TIMEOUT_MS=", CFG.TIMEOUT_MS);
  pending.timer = Timer.set(CFG.TIMEOUT_MS, false, function () {
    log("⏱️ TIMEOUT", label, "req=", req, "elapsed(ms)=", (nowMs() - t0));
    clearPending("timeout");
  });

  log("➡️  Inviato comando", label, "(singolo)", "req=", req);
  loraSendOnce(CFG.LORA_SLAVE_ID, { t: "CMD", cmd: cmd, req: req });
}

// Debug da RPC
function valveOpen()  { sendCommand("CO-OP"); }
function valveClose() { sendCommand("CO-CL"); }

// === Listener Virtual Buttons ===
// Quando premi dall'app, il device genera un evento sul componente button:ID
Shelly.addEventHandler(function (event) {
  if (!event || !event.info) return;

  // Filtra solo eventi button dei virtual components
  // Tipicamente: event.name = "button" e event.id = <id>, event.info.event="single_push" / "pressed"
  if (event.name === "button" && (event.id === CFG.VC_OPEN_BTN_ID || event.id === CFG.VC_CLOSE_BTN_ID)) {
    let ev = event.info.event || "";
    // accettiamo qualsiasi “push/press” per evitare rogne tra firmware
    if (ev.indexOf("push") >= 0 || ev.indexOf("press") >= 0 || ev === "" ) {
      if (event.id === CFG.VC_OPEN_BTN_ID) {
        log("🟦 Virtual button:", CFG.VC_OPEN_BTN_ID, "-> APRI");
        sendCommand("CO-OP");
      } else if (event.id === CFG.VC_CLOSE_BTN_ID) {
        log("🟧 Virtual button:", CFG.VC_CLOSE_BTN_ID, "-> CHIUDI");
        sendCommand("CO-CL");
      }
    }
  }
});

// === RX LoRa (ACK/DONE/ERR) ===
Shelly.addEventHandler(function (event) {
  if (!event || !event.info || !event.info.data) return;

  let decoded;
  try { decoded = atob(event.info.data); } catch (e) { return; }

  let msg;
  try { msg = unpack(decoded); } catch (e) { return; }
  if (!msg || !msg.t || !msg.req) return;

  if (!pending) return;
  if (msg.req !== pending.req) return;

  let label = cmdLabel(pending.cmd);
  let elapsed = nowMs() - pending.t0;

  if (msg.t === "ACK") {
    log("📩 Ricevuta conferma RICEZIONE comando", label, "elapsed(ms)=", elapsed);
    return;
  }

  if (msg.t === "DONE") {
    log("✅ Esecuzione completata:", label, "| ok=", msg.ok, "| state=", msg.state, "| elapsed(ms)=", elapsed);

    // Aggiorna boolean:200 in base allo stato finale
    if (msg.state === "open") setValveStateBool(true);
    if (msg.state === "closed") setValveStateBool(false);

    clearPending("done");
    return;
  }

  if (msg.t === "ERR") {
    log("💥 ERRORE da SLAVE:", msg.err, "|", label, "| elapsed(ms)=", elapsed);
    clearPending("err");
    return;
  }
});

log("🚀 MASTER pronto. Usa i Virtual Buttons 200/201 dall’app oppure valveOpen()/valveClose().");
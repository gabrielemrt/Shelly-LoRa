# Shelly Gen3 LoRa – Reliable Remote Valve Control

## Abstract

This project implements a **reliable, bidirectional command-and-acknowledgment protocol** between two **Shelly 2 Gen3** devices using **LoRa**, designed to remotely control an electromechanical valve when the remote device has **no network connectivity**.

The solution addresses real-world LoRa constraints (half-duplex radio, packet loss, non-deterministic latency) and integrates natively with the **Shelly App** using **Virtual Components**, avoiding manual input, string commands, or cloud dependencies.

---

## Problem Statement

Typical scenario:

* **MASTER Shelly**

  * Connected to LAN / Shelly App
  * User-facing control device
* **SLAVE Shelly**

  * Physically connected to an electromechanical valve
  * No Internet / LAN connectivity
* Communication exclusively via **LoRa**

Constraints:

* LoRa is half-duplex
* RX packets can be lost during TX windows
* Latency is unpredictable
* No guaranteed delivery

A naive “send command once” approach is **not reliable**.

---

## Solution Overview

This project implements a **custom lightweight protocol** over LoRa with:

* Command correlation (`req` ID)
* Explicit acknowledgment (`ACK`)
* Execution confirmation (`DONE`)
* Duplicate command handling (idempotency)
* Burst-based retransmission (anti packet loss)
* Long RX windows on the MASTER

The result is **deterministic behavior** even under unstable radio conditions.

---

## Hardware Components

| Component               | Role                   |
| ----------------------- | ---------------------- |
| Shelly 2 Gen3 (MASTER)  | User-facing controller |
| Shelly 2 Gen3 (SLAVE)   | Valve controller       |
| Shelly LoRa Add-on      | Radio communication    |
| Electromechanical Valve | Final actuator         |

---

## Virtual Components (MASTER)

Used to interact exclusively through the Shelly App.

| Type            | ID            | Description                               |
| --------------- | ------------- | ----------------------------------------- |
| Virtual Button  | `button:200`  | Open valve                                |
| Virtual Button  | `button:201`  | Close valve                               |
| Virtual Boolean | `boolean:200` | Valve state (`true=open`, `false=closed`) |

No string commands, no manual RPC calls required from the app.

---

## Communication Protocol

### Message Types

| Type   | Description                |
| ------ | -------------------------- |
| `CMD`  | Command (`CO-OP`, `CO-CL`) |
| `ACK`  | Command received           |
| `DONE` | Command executed           |
| `ERR`  | Execution error            |

Each message includes:

* `req` → unique request ID
* optional payload (`state`, `ok`, `err`)

### Packet Format

```json
{
  "body": "{...payload...}",
  "chk": "XXXX"
}
```

* `chk` = XOR checksum (hex, uppercase)
* Payload is Base64-encoded for LoRa transmission

---

## Communication Flow

```
MASTER                              SLAVE
  │                                   │
  │  CMD (CO-OP / CO-CL, req)         │
  ├──────────────────────────────────▶│
  │                                   │
  │        ACK (burst)                │
  │◀──────────────────────────────────┤
  │                                   │
  │        DONE (burst)               │
  │◀──────────────────────────────────┤
```

---

## Design Decisions

### 1. Single TX from MASTER

The MASTER:

* sends the command **once**
* immediately switches to RX mode
* avoids TX/RX collisions inherent to LoRa

### 2. Burst ACK/DONE from SLAVE

The SLAVE:

* sends ACK and DONE multiple times
* mitigates packet loss during RX windows

### 3. Deduplication on SLAVE

If a `CMD` with the same `req` is received again:

* execution is skipped
* ACK/DONE are re-sent

This guarantees **idempotent behavior**.

### 4. Real State Confirmation

`DONE` is sent **only after**:

* querying `Cover.GetStatus`
* confirming `open` or `closed`

No optimistic assumptions.

---

## Code Structure

### MASTER Script Responsibilities

* Handle Virtual Button events
* Generate `CMD` messages
* Maintain pending command state
* Receive `ACK` / `DONE`
* Update `boolean:200`
* Optional RPC functions:

  * `valveOpen()`
  * `valveClose()`

### SLAVE Script Responsibilities

* Receive `CMD`
* Deduplicate requests
* Send ACK burst
* Execute valve command
* Poll valve state
* Send DONE burst

---

## Configuration Parameters

### MASTER

```js
LORA_SLAVE_ID
TIMEOUT_MS
```

### SLAVE

```js
COVER_ID
ACK_RETRIES
ACK_SPACING_MS
DONE_RETRIES
DONE_SPACING_MS
DONE_TIMEOUT_MS
```

All parameters are centralized and easily tunable.

---

## Usage

1. Flash MASTER script
2. Create Virtual Components
3. Flash SLAVE script
4. Configure correct LoRa IDs
5. Control valve directly from Shelly App

No cloud services required.

---

## Limitations

* No encryption (payload is plaintext + checksum)
* Single valve per SLAVE
* Single MASTER ↔ SLAVE link

---

## Possible Extensions

* Payload encryption
* Multi-valve support
* Multiple SLAVEs per MASTER
* Watchdog / heartbeat
* State recovery after reboot
* QoS statistics (RSSI, SNR logging)

---

## Contributing

Contributions are welcome.

This project was built from a real field requirement and intentionally kept simple, transparent, and extensible.

PRs, issues, and protocol improvements are encouraged.

---

## License

MIT License

Use, modify, and redistribute freely.

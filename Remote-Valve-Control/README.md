# Remote Valve Control (Shelly Gen3 + LoRa)

## Summary

This project implements a **reliable remote valve control** system using two **Shelly 2 Gen3** devices connected via **LoRa**:

* **MASTER**: user-facing controller (Shelly App + Virtual Components)
* **SLAVE**: remote actuator controller (valve via Cover API)

The solution is designed for real-world LoRa constraints (half-duplex radio, packet loss, unpredictable latency) and provides a deterministic control flow with acknowledgments and execution confirmation.

---

## Use Case / Problem

A remote location must control an electromechanical valve but has **no Internet connectivity**.

Requirements:

* Command valve **open/close** from the Shelly App
* Confirm that the remote device **received** the command
* Confirm that the valve **actually reached** the expected final state
* Operate reliably over LoRa despite packet loss and collisions
* Avoid manual typing / RPC calls from the app (prevent user input mistakes)

---

## Hardware / Components

| Component                                | Role                                           |
| ---------------------------------------- | ---------------------------------------------- |
| Shelly 2 Gen3 (MASTER)                   | App-facing controller + LoRa sender/receiver   |
| Shelly 2 Gen3 (SLAVE)                    | Remote valve controller + LoRa sender/receiver |
| Shelly LoRa Add-on                       | Radio communication                            |
| Electromechanical valve (via Cover mode) | Physical actuator                              |

---

## Shelly App Integration (MASTER)

The MASTER uses **Virtual Components** so the user can control the valve without typing any command:

| Virtual Component |            ID | Meaning                                   |
| ----------------- | ------------: | ----------------------------------------- |
| Virtual Button    |  `button:200` | Open valve                                |
| Virtual Button    |  `button:201` | Close valve                               |
| Virtual Boolean   | `boolean:200` | Valve state (`true=open`, `false=closed`) |

---

## Protocol Overview

### Message Types

| Type   | Description                              |
| ------ | ---------------------------------------- |
| `CMD`  | Command: `CO-OP` (open), `CO-CL` (close) |
| `ACK`  | Command received by SLAVE                |
| `DONE` | Command executed; includes final state   |
| `ERR`  | Execution error                          |

Each message carries a unique correlation ID: `req`.

---

## Robust Framing Format (v3)

LoRa can deliver **corrupted, truncated, or concatenated frames**.
To prevent JSON parsing failures, this project uses a **framed payload** with length + checksum validation.

### Frame Layout

```
~<LEN>:<PAYLOAD>|<CHK>#
```

* `~` start marker
* `#` end marker
* `<LEN>` decimal payload length
* `<PAYLOAD>` key/value string (see below)
* `<CHK>` XOR checksum (hex, uppercase) computed over `<PAYLOAD>`

### Payload Layout

Key-value pairs separated by `;`

Examples:

```
t=CMD;cmd=CO-CL;req=33b3d75e
t=ACK;req=33b3d75e
t=DONE;req=33b3d75e;ok=1;state=closed
t=ERR;req=33b3d75e;err=Cover.Close failed
```

### Why This Matters

The receiver **scans the decoded stream** and extracts only valid frames by:

* locating `~ ... #`
* validating `LEN`
* validating `CHK`

This works even if:

* the event contains extra garbage
* multiple frames arrive in one event
* one frame is partially corrupted

---

## Communication Flow

```
MASTER                                   SLAVE
  │                                        │
  │ CMD (CO-OP / CO-CL, req)               │
  ├───────────────────────────────────────▶│
  │                                        │
  │ ACK burst (3x)                          │
  │◀───────────────────────────────────────┤
  │                                        │
  │ SLAVE executes Cover.Open / Cover.Close │
  │ (poll Cover.GetStatus until final state)│
  │                                        │
  │ DONE burst (3x)                         │
  │◀───────────────────────────────────────┤
```

---

## Reliability Strategy

### 1) MASTER “single-flight” (no concurrency)

The MASTER handles **one pending command at a time**:

* prevents request overwrites and timer races
* avoids ambiguous state updates

If a button is pressed while an operation is pending, the command is ignored (logged).

### 2) Resend if no ACK

If no `ACK` is received within `RESEND_IF_NO_ACK_MS`, the MASTER resends the *same* command using the *same* `req` (idempotent), up to `MAX_RESENDS`.

### 3) Burst ACK/DONE on SLAVE

The SLAVE sends both `ACK` and `DONE` multiple times to mitigate packet loss during LoRa RX windows.

### 4) Idempotency (dedup on SLAVE)

If the SLAVE receives the same `req` again:

* it **does not re-execute** the valve action
* it **re-sends ACK/DONE**, ensuring state convergence

### 5) Real state confirmation

`DONE` is sent only after the SLAVE verifies the final state via `Cover.GetStatus`:

* `open`
* `closed`

---

## Configuration

### MASTER Key Parameters

| Setting               | Meaning                                           |
| --------------------- | ------------------------------------------------- |
| `LORA_SLAVE_ID`       | LoRa ID of the SLAVE                              |
| `TIMEOUT_MS`          | Max time window for the command                   |
| `RESEND_IF_NO_ACK_MS` | Resend delay if no ACK                            |
| `MAX_RESENDS`         | Number of resends (total sends = 1 + MAX_RESENDS) |
| `VC_OPEN_BTN_ID`      | Virtual button for OPEN                           |
| `VC_CLOSE_BTN_ID`     | Virtual button for CLOSE                          |
| `VC_STATE_BOOL_ID`    | Virtual boolean for state                         |

### SLAVE Key Parameters

| Setting                              | Meaning                       |
| ------------------------------------ | ----------------------------- |
| `COVER_ID`                           | Cover instance id (usually 0) |
| `DONE_TIMEOUT_MS`                    | Max time to reach final state |
| `ACK_RETRIES` / `DONE_RETRIES`       | Burst count                   |
| `ACK_SPACING_MS` / `DONE_SPACING_MS` | Burst spacing                 |
| `SEEN_TTL_MS`                        | Dedup window for request IDs  |

---

## File Layout

Typical project directory:

```text
Remote-Valve-Control/
├── README.md
├── master.js
└── slave.js
```

---

## Usage

1. Upload `slave.js` to the remote Shelly (SLAVE)
2. Upload `master.js` to the local Shelly (MASTER)
3. Create Virtual Components on MASTER:

   * `button:200` (Open)
   * `button:201` (Close)
   * `boolean:200` (Valve State)
4. Ensure LoRa IDs are correctly configured:

   * MASTER uses `LORA_SLAVE_ID` = SLAVE ID
5. Control the valve via the Shelly App (Virtual Buttons)

---

## Known Limitations

* No encryption/authentication (checksum is integrity-only, not security)
* Designed for a single MASTER ↔ single SLAVE link
* Single valve per SLAVE (Cover ID configurable)

---

## Suggested Improvements / Roadmap

* Optional payload encryption / signing
* Multi-slave support on MASTER
* Queue mode (store one pending command instead of ignoring presses)
* Heartbeat/status telemetry (RSSI/SNR sampling)
* Persisted state recovery after reboot

---

## License

MIT License

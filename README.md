# Shelly-LoRa

## Overview

This repository collects **practical, field-tested projects** based on **Shelly Gen3 devices** communicating via **LoRa**.

The focus is on building **reliable, deterministic, and maintainable solutions** for scenarios where:

* Internet connectivity is unavailable or unreliable
* long-range, low-power communication is required
* correctness and state confirmation matter more than raw throughput

All projects are implemented using **Shelly Script**, without external gateways, cloud services, or third-party brokers.

---

## Goals of the Repository

* Provide **reference implementations** for LoRa-based automation with Shelly
* Solve **real-world problems**, not theoretical demos
* Address LoRa constraints explicitly:

  * half-duplex operation
  * packet loss
  * non-deterministic latency
* Promote **clean protocols**, not ad-hoc message passing
* Enable **community contributions and improvements**

---

## Repository Structure

Each project lives in its own directory and is **self-contained**.

```text
Shelly-LoRa/
├── Remote-Valve-Control/
│   ├── README.md
│   ├── master.js
│   └── slave.js
│
├── <future-project>/
│   ├── README.md
│   └── ...
│
└── README.md   <-- you are here
```

---

## Current Projects

### 📂 Remote-Valve-Control

Reliable remote control of an electromechanical valve using:

* Shelly 2 Gen3 (MASTER / SLAVE)
* LoRa communication
* Bidirectional command/acknowledgment protocol
* Shelly App integration via Virtual Components

Key features:

* Explicit ACK and DONE confirmation
* Burst-based retransmission (LoRa loss mitigation)
* Idempotent command handling
* Real state verification via device status polling

➡ See [`Remote-Valve-Control/README.md`](./Remote-Valve-Control/README.md) for full documentation.

---

## Design Principles (Common to All Projects)

All projects in this repository follow these principles:

1. **Explicit state, never assumptions**

   * Actions are confirmed by device state, not by command dispatch.

2. **Idempotent behavior**

   * Duplicate messages must never cause duplicate actions.

3. **LoRa-aware protocol design**

   * TX/RX collisions and packet loss are expected and handled.

4. **No cloud dependency**

   * Everything runs locally on the devices.

5. **Readable and debuggable code**

   * Extensive logging and clear message formats.

---

## Requirements

* Shelly Gen3 devices
* Shelly LoRa Add-on
* Firmware supporting:

  * Shelly Script
  * Virtual Components
  * LoRa RPC (`Lora.SendBytes`)

---

## Contributing

Contributions are welcome and encouraged.

Possible contribution areas:

* New project directories
* Protocol improvements
* Bug fixes
* Performance tuning
* Documentation enhancements

If you add a new project:

* place it in its own directory
* include a dedicated `README.md`
* document protocol and assumptions clearly

---

## License

MIT License

All projects in this repository are released under the MIT license unless otherwise stated.

---

## Disclaimer

These projects interact with **physical devices** (valves, actuators, relays).
Use appropriate safeguards and test thoroughly before deploying in production environments.

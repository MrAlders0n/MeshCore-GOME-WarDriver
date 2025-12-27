# RX Wardrive Flow

```diagram
╔═══════════════════════════════════════════════════════════════════════════════╗
║                        RX WARDRIVING FLOW                                     ║
║                 *** ACCEPTS ALL PACKET TYPES ***                              ║
╚═══════════════════════════════════════════════════════════════════════════════╝


╔═══════════════════════════════════════════════════════════════════════════════╗
║                                 ON CONNECT                                    ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   BLE Connection → Acquire Slot → Ensure Channel → Start Unified RX Listening ║
║                                      │                                        ║
║                                      ▼                                        ║
║              Initialize rxBatchBuffer Map (empty) → Prime GPS                 ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
                                       │
                                       ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              CONTINUOUS RX LISTENING                          ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Radio receives packet → BLE pushes LogRxData event                          ║
║   {lastSnr: 11.5, lastRssi: -85, raw: <packet bytes>}                         ║
║                                      │                                        ║
║                                      ▼                                        ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │                        UNIFIED RX HANDLER.                            │   ║
║   ├───────────────────────────────────────────────────────────────────────┤   ║
║   │                                                                       │   ║
║   │   Parse packet from raw data                                          │   ║
║   │                                                                       │   ║
║   │   Log header for debugging (NO filtering here anymore)                │   ║
║   │   "[UNIFIED RX] Packet header: 0x11" (informational only)             │   ║
║   │                                                                       │   ║
║   │         ┌─────────────────────────────────────────────────-┐          │   ║
║   │         │ Session Log Tracking Active?  (6s after TX ping) │          │   ║
║   │         └────────────────────────┬───────────────────────-─┘          │   ║
║   │                                  │                                    │   ║
║   │                          ┌───────┴───────┐                            │   ║
║   │                         YES              NO                           │   ║
║   │                          │               │                            │   ║
║   │                          ▼               │                            │   ║
║   │         ┌────────────────────────┐       │                            │   ║
║   │         │ SESSION LOG HANDLER    │       │                            │   ║
║   │         │ (Strict Validation)    │       │                            │   ║
║   │         │ • Header = 0x15?       │       │                            │   ║
║   │         │ • Channel hash match?  │       │                            │   ║
║   │         │ • Decrypt & verify?    │       │                            │   ║
║   │         │ • Has path?            │       │                            │   ║
║   │         └───────────┬────────────┘       │                            │   ║
║   │                     │                    │                            │   ║
║   │             ┌───────┴───────┐            │                            │   ║
║   │            YES              NO           │                            │   ║
║   │  (tracked)  │    (not echo) │            │                            │   ║
║   │             │               │            │                            │   ║
║   │             ▼               ▼            │                            │   ║
║   │       ┌─────────┐    ┌──────────────────────────────────────┐         │   ║
║   │       │ RETURN  │    │  PASSIVE RX HANDLER (ALL PACKETS)    |         |   ║
║   │       │ (done)  │    │  *** NO HEADER OR CHANNEL FILTER *** │         │   ║
║   │       └─────────┘    └──────────────────────────────────────┘         │   ║
║   │                                                                       │   ║
║   └───────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
                                       │
                                       ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                   PASSIVE RX PROCESSING (PR #130 Simplified)                ║
║                    *** ONLY CHECKS PATH LENGTH ***                            ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │  SINGLE VALIDATION:  Path length > 0?                                 │   ║
║   │                                                                       │   ║
║   │ A packet's path array contains the sequence of repeater IDs that      │   ║
║   │ forwarded the message.  Packets with no path are direct transmissions │   ║
║   │ (node-to-node) and don't provide information about repeater coverage. │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                               ┌───────┴───────┐                               ║
║                              NO              YES                              ║
║                               │               │                               ║
║                               ▼               ▼                               ║
║   ┌───────────────────────────────┐   ┌───────────────────────────────────┐   ║
║   │    IGNORE                     │   │  ACCEPT PACKET                    │   ║
║   │ "no path (direct transmission,│   │ Extract LAST hop repeater ID      │   ║
║   │  not via repeater)"           │   │ path[path.length-1] → "92"        │   ║
║   └───────────────────────────────┘   └─────────────────┬─────────────────┘   ║
║                                                         │                     ║
║                                                         │                     ║
║                                                         ▼                     ║
║                                       ┌───────────────────────────────────┐   ║
║                                       │ GPS fix available?                │   ║
║                                       └─────────────────┬─────────────────┘   ║
║                                                         │                     ║
║                                                 ┌───────┴───────┐             ║
║                                                NO              YES            ║
║                                                 │               │             ║
║                                                 ▼               ▼             ║
║                                       ┌──────────────┐   ┌────────────────┐   ║
║                                       │    Skip      │   │   Add to:      │   ║
║                                       │ entry        │   │ • RX Log UI    │   ║
║                                       └──────────────┘   │ • Batch Buffer │   ║
║                                                          └───────┬────────┘   ║
║                                                                  │            ║
╚══════════════════════════════════════════════════════════════════╪════════════╝
                                                                   │
                                                                   ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                            BATCH TRACKING PER REPEATER                        ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   Each repeater ID gets its own independent batch in rxBatchBuffer            ║
║                                                                               ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │  First RX from repeater "92"?                                         │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                               ┌───────┴───────┐                               ║
║                              YES              NO                              ║
║                               │               │                               ║
║                               ▼               │                               ║
║   ┌───────────────────────────────────────┐   │                               ║
║   │    CREATE BATCH for "92"              │   │                               ║
║   │  {                                    │   │                               ║
║   │    firstLocation: {lat, lng}          │   │                               ║
║   │    firstTimestamp: now                │   │                               ║
║   │    samples: []                        │   │                               ║
║   │    timeoutId: dynamic timer           │   │                               ║
║   │  }                                    │   │                               ║
║   │  Timeout = warDriveInterval - 5000ms  │   │                               ║
║   │  (15s → 10s, 30s → 25s, 60s → 55s)   │   │                               ║
║   └───────────────────┬───────────────────┘   │                               ║
║                       │                       │                               ║
║                       └─────────────┬─────────┘                               ║
║                                     │                                         ║
║                                     ▼                                         ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │     ADD SAMPLE:  {snr, location, timestamp}                           │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                                       ▼                                       ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │    Distance from firstLocation ≥ 25m?  (RX_BATCH_DISTANCE_M)          │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                               ┌───────┴───────┐                               ║
║                              NO              YES                              ║
║                               │               │                               ║
║                               ▼               │                               ║
║                 ┌────────────────────┐        │                               ║
║                 │ Continue collecting│        │                               ║
║                 │ Wait for more RX   │        │                               ║
║                 │ or dynamic timeout │        │                               ║
║                 └────────────────────┘        │                               ║
║                                               │                               ║
╚═══════════════════════════════════════════════╪═══════════════════════════════╝
                                                │
             ┌──────────────────────────────────┼──────────────────────────────┐
             │                                  │                              │
             ▼                                  ▼                              ▼
    ╔══════════════════╗           ╔══════════════════╗           ╔════════════════╗
    ║  TRIGGER:        ║           ║  TRIGGER:        ║           ║  TRIGGER:      ║
    ║  DISTANCE (25m)  ║           ║  DYNAMIC TIMEOUT ║           ║  DISCONNECT    ║
    ║                  ║           ║  (interval - 5s) ║           ║                ║
    ╚════════╤═════════╝           ╚════════╤═════════╝           ╚════════╤═══════╝
             │                              │                              │
             └──────────────────────────────┼──────────────────────────────┘
                                            │
                                            ▼
╔═══════════════════════════════════════════════════════════════════════════════╗
║                          FLUSH BATCH → UNIFIED API POST                       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │     AGGREGATE SAMPLES                                                 │   ║
║   │                                                                       │   ║
║   │  snr_avg  = average of all sample SNRs                                │   ║
║   │  snr_max  = maximum SNR                                               │   ║
║   │  snr_min  = minimum SNR                                               │   ║
║   │  sample_count = number of samples                                     │   ║
║   │                                                                       │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                                       ▼                                       ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │    BUILD UNIFIED API PAYLOAD                                          │   ║
║   │                                                                       │   ║
║   │  Format heard_repeats as "repeater_id(snr_avg)"                       │   ║
║   │  Example: "92(12.0)" (absolute value with 1 decimal)                  │   ║
║   │                                                                       │   ║
║   │  {                                                                    │   ║
║   │    "key": "API_KEY",                                                  │   ║
║   │    "lat": 45.42150,                                                   │   ║
║   │    "lon": -75.69720,                                                  │   ║
║   │    "who": "DeviceName",                                               │   ║
║   │    "power": "0.6w",                                                   │   ║
║   │    "heard_repeats": "92(12.0)",                                       │   ║
║   │    "ver": "DEV-1703257800",                                           │   ║
║   │    "session_id": "abc123",                                            │   ║
║   │    "iata": "YOW",                                                     │   ║
║   │    "test": 0,                                                         │   ║
║   │    "WARDRIVE_TYPE": "RX"                                              │   ║
║   │  }                                                                    │   ║
║   │                                                                       │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                                       ▼                                       ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │     POST TO UNIFIED ENDPOINT                                          │   ║
║   │                                                                       │   ║
║   │                                                                       │   ║
║   └───────────────────────────────────┬───────────────────────────────────┘   ║
║                                       │                                       ║
║                                       ▼                                       ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │    CLEANUP:  Remove batch from rxBatchBuffer                          │   ║
║   └───────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝


╔═══════════════════════════════════════════════════════════════════════════════╗
║                      RX AUTO MODE - PERIODIC MAP UPDATES                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   When RX Auto mode is active, a unified war-drive timer runs periodically   ║
║   at the user-selected interval (15s/30s/60s) to:                            ║
║                                                                               ║
║   1. FLUSH API QUEUE (post all pending RX messages)                          ║
║   2. REFRESH COVERAGE MAP (after flush completes)                            ║
║                                                                               ║
║   This ensures the user sees updated map blocks immediately after posting    ║
║   new coverage data, providing visual feedback on RX war-drive progress.     ║
║                                                                               ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │                   RX AUTO MODE TIMER LIFECYCLE                        │   ║
║   │                                                                       │   ║
║   │   START RX AUTO:                                                     │   ║
║   │   • Start GPS watch                                                  │   ║
║   │   • Start unified RX listening                                       │   ║
║   │   • Schedule first timer tick immediately                            │   ║
║   │                                                                       │   ║
║   │   TIMER TICK (every 15s/30s/60s):                                    │   ║
║   │   • If queue has messages → flushApiQueue()                          │   ║
║   │   • refreshCoverageMap() (after flush completes)                     │   ║
║   │   • Schedule next tick                                               │   ║
║   │                                                                       │   ║
║   │   STOP RX AUTO:                                                      │   ║
║   │   • Stop timer                                                       │   ║
║   │   • Stop GPS watch                                                   │   ║
║   │   • Stop unified RX listening                                        │   ║
║   │   • Release wake lock                                                │   ║
║   └───────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
║   ┌───────────────────────────────────────────────────────────────────────┐   ║
║   │                   EXAMPLE: 15s INTERVAL                               │   ║
║   │                                                                       │   ║
║   │   0s         15s        30s        45s                                │   ║
║   │   │           │          │          │                                 │   ║
║   │   RX──────────┼──────────┼──────────┼                                 │   ║
║   │   │  RX   RX  │  RX   RX │  RX      │                                 │   ║
║   │   │           ▼          ▼          ▼                                 │   ║
║   │   │      FLUSH+MAP   FLUSH+MAP  FLUSH+MAP                             │   ║
║   │   │      (instant    (instant   (instant                              │   ║
║   │   │       update)     update)    update)                              │   ║
║   │   └───────────────────────────────────────                            │   ║
║   │                                                                       │   ║
║   │   User sees map refresh every 15s with latest RX coverage data       │   ║
║   └───────────────────────────────────────────────────────────────────────┘   ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```
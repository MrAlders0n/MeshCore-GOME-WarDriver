# MESHMAPPER API QUEUE SYSTEM

```diagram
        ┌─────────────────────────────────┐       ┌─────────────────────────────────┐
        │         TX WARDRIVE             │       │         RX WARDRIVE             │
        └─────────────┬────────---────────┘       └─────────────┬────────---────────┘
                      │                                         │
                      ▼                                         ▼
              ┌─────────────────┐                       ┌─────────────────┐
              │   sendPing()    │                       │  RX Listener    │
              │   (BLE ping)    │                       │  (always on)    │
              └────────┬────────┘                       └────────┬────────┘
                       │                                         │
                       ▼                                         │
              ┌─────────────────┐                                │
              │  Ping sent      │                                │
              │  + GPS coords   │                                │
              └────────┬────────┘                                │
                       │                                         │
                       ▼                                         ▼
              ┌─────────────────┐                       ┌─────────────────┐
              │ queueApiMessage │                       │ queueApiMessage │
              │ (type: "TX")    │                       │ (type:  "RX")   │
              │                 │                       │                 │
              │ • lat/lon       │                       │ • lat/lon       │
              │ • who           │                       │ • who           │
              │ • power         │                       │ • power         │
              │ • heard         │                       │ • heard         │
              │ • session_id    │                       │ • session_id    │
              └────────┬────────┘                       └────────┬────────┘
                       │                                         │
                       │      ┌──────────────────────────────────┘
                       │      │
                       ▼      ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                       │
│   ┌─────────────────────────────────────────────────────────────────────────────┐     │
│   │                          API QUEUE (apiQueue. messages)                     │     │
│   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         ┌──────┐              │     │
│   │  │ TX   │ │ RX   │ │ RX   │ │ TX   │ │ RX   │   ...   │ ??    │  max:  50   │     │
│   │  │ msg1 │ │ msg2 │ │ msg3 │ │ msg4 │ │ msg5 │         │msg50 │              │     │
│   │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘         └──────┘              │     │
│   └─────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                       │
│   QUEUE STATE:                                                                        │
│   • messages: []           ─── Array of pending payloads                              │
│   • flushTimerId: null     ─── War-drive interval periodic timer (15s/30s/60s)        │
│   • txFlushTimerId: null   ─── 3s TX flush timer                                      │
│   • isProcessing: false    ─── Lock to prevent concurrent flushes                     │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              │         FLUSH TRIGGERS      │                             │
              │                             │                             │
              │  ┌──────────────────────────┴────────────────────────┐    │
              │  │                                                   │    │
              ▼  ▼                                                   ▼    ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│                     │ │                     │ │                     │ │                     │
│   TX PING QUEUED    │ │   PERIODIC TIMER    │ │   QUEUE SIZE = 50   │ │   disconnect()      │
│                     │ │   (15s/30s/60s)     │ │                     │ │                     │
│  ┌───────────────┐  │ │  ┌───────────────┐  │ │  ┌───────────────┐  │ │  ┌───────────────┐  │
│  │ Start/Reset   │  │ │  │ setInterval   │  │ │  │  Immediate    │  │ │  │ Flush before  │  │
│  │ 3s timer      │  │ │  │ (dynamic)     │  │ │  │  flush        │  │ │  │ capacity      │  │
│  └───────────────┘  │ │  └───────────────┘  │ │  └───────────────┘  │ │  │ release       │  │
│                     │ │                     │ │                     │ │  └───────────────┘  │
│  Real-time map      │ │  Catches RX msgs    │ │  Batch limit        │ │                     │
│  updates for your   │ │  when no TX pings   │ │  protection         │ │  Clean shutdown     │
│  ping locations     │ │  happening          │ │                     │ │                     │
│                     │ │                     │ │                     │ │                     │
└──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
           │                       │                       │                       │
           └───────────────────────┴───────────────────────┴───────────────────────┘
                                            │
                                            ▼
                              ┌─────────────────────────┐
                              │     flushApiQueue()     │
                              │                         │
                              │  1. Check isProcessing  │
                              │  2. Set isProcessing    │
                              │  3. Grab & clear queue  │
                              │  4. POST batch to API   │
                              │  5. Handle response     │
                              │  6. Clear isProcessing  │
                              └────────────┬────────────┘
                                           │
                                           ▼
                              ┌─────────────────────────┐
                              │   MESHMAPPER API        │
                              │                         │
                              │   POST [                │
                              │    {TX, lat, lon... },  │
                              │     {RX, lat, lon...},  │
                              │    {RX, lat, lon...},   │
                              │     ...                 │
                              │   ]                     │
                              │                         │
                              │   Max: 50 per request   │
                              └────────────┬────────────┘
                                           │
                         ┌─────────────────┴─────────────────┐
                         ▼                                   ▼
              ┌─────────────────────┐             ┌─────────────────────┐
              │  allowed:  true     │             │  allowed: false     │
              │                     │             │                     │
              │  ✓ Success          │             │  ✗ Slot Revoked     │
              │  ✓ Continue         │             │  ✗ Stop timers      │
              │                     │             │  ✗ Disconnect       │
              └─────────────────────┘             └─────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   TIMING EXAMPLES                                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘

Example 1: TX triggers fast flush, nearby RX messages ride along
────────────────────────────────────────────────────────────────
  0s        1s        2s        3s        4s
  │         │         │         │         │
  │    RX   │         │         │         │
  │    (heard)        │         │         │
  │         │    TX   │         │         │
  │         │ (ping)  │         │         │
  │         │    │    │         │         │
  │         │    └────┼─────────┼─►FLUSH  │
  │         │         │         │(TX+RX)  │
  └─────────┴─────────┴─────────┴─────────┘
                      3 second delay from TX


Example 2: RX only (no pings) - periodic flush at war-drive interval
────────────────────────────────────────────────────────────────────
  15s interval:
  0s       5s       10s       15s
  │         │         │         │
  RX────────┼─────────┼─────────┼─►FLUSH + MAP REFRESH
  │    RX   │    RX   │         │ (3x RX)
  │         │    RX   │         │
  │         │         │         │
  └─────────┴─────────┴─────────┘
  (listening continuously, no TX pings sent)
  
  30s interval:
  0s       10s       20s       30s
  │         │         │         │
  RX────────┼─────────┼─────────┼─►FLUSH + MAP REFRESH
  │    RX   │    RX   │         │ (3x RX)
  │         │    RX   │         │
  │         │         │         │
  └─────────┴─────────┴─────────┘


Example 3: Busy session - multiple TX pings with RX traffic
───────────────────────────────────────────────────────────
  0s        3s        6s        9s       12s
  │         │         │         │         │
  TX────────┼─►FLUSH  │         │         │
  │    RX   │ (TX+RX) │         │         │
  │         │         TX────────┼─►FLUSH  │
  │         │         │    RX   │ (TX+RX) │
  │         │         │    RX   │         │
  └─────────┴─────────┴─────────┴─────────┘


Example 4: Disconnect flushes everything
────────────────────────────────────────
  0s        1s        2s
  │         │         │
  TX────────┼─────────┤
  │    RX   │    RX   │
  │         │    disconnect()
  │         │         │
  │         │         ▼
  │         │      FLUSH (TX + 2x RX)  ◄── session_id still valid
  │         │         │
  │         │         ▼
  │         │      checkCapacity("disconnect")  ◄── releases slot
  │         │         │
  │         │         ▼
  │         │      BLE cleanup
  └─────────┴─────────┘


┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                  DISCONNECT SEQUENCE                                    │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────┐
  │  disconnect()    │
  │  called          │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐     ┌─────────────────────────────────────┐
  │  Queue empty?    │─NO─►│  flushApiQueue()                    │
  └────────┬─────────┘     │  • session_id still valid ✓         │
           │               │  • POST all pending TX + RX         │
          YES              └──────────────────┬──────────────────┘
           │                                  │
           ◄──────────────────────────────────┘
           │
           ▼
  ┌──────────────────┐
  │ stopFlushTimers()│
  │ • Clear periodic │
  │ • Clear TX timer │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ checkCapacity    │
  │ ("disconnect")   │◄─── Releases session_id / slot
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ BLE disconnect   │
  │ State cleanup    │
  │ UI updates       │
  └──────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                          RX WAR-DRIVE MODE BEHAVIOR                                     │
└─────────────────────────────────────────────────────────────────────────────────────────┘

RX Auto Mode adds periodic map updates:
- Timer ticks at war-drive interval (15s/30s/60s - user-selectable)
- Each tick: FLUSH API queue → THEN refresh coverage map
- Ensures map updates immediately after posting new coverage data
- No TX transmissions (RX-only passive listening)

**CRITICAL TIMING SEQUENCE (PR #157):**
RX Batch flush → API Queue flush → Map Refresh

RX Batch buffer timeout is dynamically calculated to ensure RX messages
are moved to the API queue BEFORE the war-drive interval timer flushes:
- 15s interval → RX Batch timeout = 10s (15s - 5s)
- 30s interval → RX Batch timeout = 25s (30s - 5s)
- 60s interval → RX Batch timeout = 55s (60s - 5s)

Minimum RX Batch timeout: 2s (to collect burst RX events)

Example: RX Auto with 15s interval
──────────────────────────────────
  0s    5s    10s        15s       30s
  │     │      │          │         │
  RX────┼──────┼──────────┼─────────┼
  │ RX  │  RX  │          │  RX  RX │
  │     │      ▼          ▼         ▼
  │     │  RX Batch   API Flush  RX Batch
  │     │   flush →    + Map     flush →
  │     │  to queue    Refresh    API Flush
  │     │                          + Map
  └──────────────────────────────────────
  
  RX Batch flushes at 10s (before API flush at 15s)
  This ensures map shows newly heard RX messages

Example: RX Auto with 30s interval
──────────────────────────────────
  0s   10s   20s   25s        30s
  │     │     │     │          │
  RX────┼─────┼─────┼──────────┼
  │ RX  │ RX  │ RX  │          │
  │     │     │     ▼          ▼
  │     │     │  RX Batch   API Flush
  │     │     │   flush →    + Map
  │     │     │  to queue    Refresh
  └──────────────────────────────────
  
  RX Batch flushes at 25s (before API flush at 30s)
  ```
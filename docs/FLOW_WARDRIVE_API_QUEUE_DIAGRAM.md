# MESHMAPPER WARDRIVE QUEUE SYSTEM

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
              │  Capture at     │                                │
              │  ping time:     │                                │
              │  • lat/lon      │                                │
              │  • noisefloor   │                                │
              │  • timestamp    │                                │
              └────────┬────────┘                                │
                       │                                         │
                       ▼                                         ▼
              ┌─────────────────┐                       ┌─────────────────┐
              │  queueTxEntry() │                       │  queueRxEntry() │
              │  Entry-only:    │                       │  Entry-only:    │
              │                 │                       │                 │
              │ • type: "TX"    │                       │ • type: "RX"    │
              │ • lat/lon       │                       │ • lat/lon       │
              │ • noisefloor    │                       │ • noisefloor    │
              │ • heard_repeats │                       │ • heard_repeats │
              │ • timestamp     │                       │ • timestamp     │
              │ • debug_data?   │                       │ • debug_data?   │
              └────────┬────────┘                       └────────┬────────┘
                       │                                         │
                       │      ┌──────────────────────────────────┘
                       │      │
                       ▼      ▼
              ┌─────────────────┐
              │queueWardriveEntry│
              │ (push to queue) │
              └────────┬────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                       │
│   ┌─────────────────────────────────────────────────────────────────────────────┐     │
│   │                   WARDRIVE QUEUE (wardriveQueue.messages)                   │     │
│   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         ┌──────┐              │     │
│   │  │ TX   │ │ RX   │ │ RX   │ │ TX   │ │ RX   │   ...   │ ??   │  max: 50    │     │
│   │  │entry1│ │entry2│ │entry3│ │entry4│ │entry5│         │entry50              │     │
│   │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘         └──────┘              │     │
│   └─────────────────────────────────────────────────────────────────────────────┘     │
│                                                                                       │
│   QUEUE STATE:                                                                        │
│   • messages: []           ─── Array of entry-only payloads                           │
│   • flushTimerId: null     ─── 30s periodic timer                                     │
│   • txFlushTimerId: null   ─── 3s TX flush timer                                      │
│   • isProcessing: false    ─── Lock to prevent concurrent submissions                 │
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
│   TX ENTRY QUEUED   │ │   30s PERIODIC      │ │   QUEUE SIZE = 50   │ │   disconnect()      │
│                     │ │                     │ │                     │ │                     │
│  ┌───────────────┐  │ │  ┌───────────────┐  │ │  ┌───────────────┐  │ │  ┌───────────────┐  │
│  │ Start/Reset   │  │ │  │ setInterval   │  │ │  │  Immediate    │  │ │  │ Flush before  │  │
│  │ 3s timer      │  │ │  │ (30000ms)     │  │ │  │  submit       │  │ │  │ session       │  │
│  └───────────────┘  │ │  └───────────────┘  │ │  └───────────────┘  │ │  │ release       │  │
│                     │ │                     │ │                     │ │  └───────────────┘  │
│  Real-time map      │ │  Catches RX entries │ │  Batch limit        │ │                     │
│  updates for your   │ │  when no TX pings   │ │  protection         │ │  Clean shutdown     │
│  ping locations     │ │  happening          │ │                     │ │                     │
│                     │ │                     │ │                     │ │                     │
└──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
           │                       │                       │                       │
           └───────────────────────┴───────────────────────┴───────────────────────┘
                                            │
                                            ▼
                              ┌─────────────────────────┐
                              │  submitWardriveData()   │
                              │                         │
                              │  1. Check isProcessing  │
                              │  2. Validate session_id │
                              │  3. Set isProcessing    │
                              │  4. Grab & clear queue  │
                              │  5. Build wrapper:      │
                              │     {key, session_id,   │
                              │      data: [entries]}   │
                              │  6. POST to API (retry) │
                              │  7. Handle response     │
                              │  8. Schedule heartbeat  │
                              │  9. Clear isProcessing  │
                              └────────────┬────────────┘
                                           │
                                           ▼
                              ┌─────────────────────────┐
                              │   WARDRIVE API          │
                              │   /wardrive endpoint    │
                              │                         │
                              │   POST {                │
                              │     key: "...",         │
                              │     session_id: "...",  │
                              │     data: [             │
                              │       {type:"TX",...},  │
                              │       {type:"RX",...},  │
                              │       ...               │
                              │     ]                   │
                              │   }                     │
                              │                         │
                              │   Max: 50 entries       │
                              └────────────┬────────────┘
                                           │
                         ┌─────────────────┴─────────────────┐
                         ▼                                   ▼
              ┌─────────────────────┐             ┌─────────────────────┐
              │  success: true      │             │  success: false     │
              │                     │             │                     │
              │  + expires_at       │             │  + reason code      │
              │  → Schedule         │             │  → handleWardriveApiError()
              │    heartbeat        │             │                     │
              │  ✓ Continue         │             │  Session errors:    │
              │                     │             │  → Disconnect       │
              │                     │             │                     │
              │                     │             │  Rate limit:        │
              │                     │             │  → Warning only     │
              └─────────────────────┘             └─────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   HEARTBEAT SYSTEM                                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  Session acquired (auth)
          │
          ├─► expires_at returned
          │
          ▼
  ┌──────────────────┐
  │ scheduleHeartbeat│
  │ (expires_at)     │
  └────────┬─────────┘
           │
           │  5 minutes before expiry
           │  (HEARTBEAT_BUFFER_MS)
           │
           ▼
  ┌──────────────────┐
  │ sendHeartbeat()  │
  │                  │
  │ POST {           │
  │   key, session_id│
  │   heartbeat:true │
  │   coords:{...}   │
  │ }                │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ Response:        │
  │ success: true    │
  │ + new expires_at │
  └────────┬─────────┘
           │
           └─────────► scheduleHeartbeat() again
                       (continuous loop while connected)


┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                  ERROR HANDLING                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  submitWardriveData() or sendHeartbeat()
          │
          ▼
  ┌──────────────────┐
  │ success: false   │
  │ + reason code    │
  └────────┬─────────┘
           │
           ▼
  ┌────────────────────────────────────────────────────────────────┐
  │                    handleWardriveApiError(reason, message)     │
  │                                                                │
  │  ┌────────────────────┬────────────────────────────────────┐   │
  │  │ Reason Code        │ Action                             │   │
  │  ├────────────────────┼────────────────────────────────────┤   │
  │  │ session_expired    │ → Disconnect                       │   │
  │  │ session_invalid    │ → Disconnect                       │   │
  │  │ session_revoked    │ → Disconnect                       │   │
  │  │ invalid_key        │ → Disconnect                       │   │
  │  │ unauthorized       │ → Disconnect                       │   │
  │  │ session_id_missing │ → Disconnect                       │   │
  │  │ rate_limited       │ → Warning only (no disconnect)     │   │
  │  │ (unknown)          │ → Show error (no disconnect)       │   │
  │  └────────────────────┴────────────────────────────────────┘   │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   RETRY LOGIC                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  submitWardriveData() / sendHeartbeat()
          │
          ▼
  ┌──────────────────┐
  │ Attempt 1        │
  │ POST to API      │
  └────────┬─────────┘
           │
      ┌────┴────┐
      │ Success?│
      └────┬────┘
           │
    YES    │    NO (network error)
     │     │         │
     │     │         ▼
     │     │  ┌──────────────────┐
     │     │  │ Wait 2 seconds   │
     │     │  │ (WARDRIVE_RETRY_ │
     │     │  │  DELAY_MS)       │
     │     │  └────────┬─────────┘
     │     │           │
     │     │           ▼
     │     │  ┌──────────────────┐
     │     │  │ Attempt 2        │
     │     │  │ POST to API      │
     │     │  └────────┬─────────┘
     │     │           │
     │     │      ┌────┴────┐
     │     │      │ Success?│
     │     │      └────┬────┘
     │     │           │
     │     │    YES    │    NO
     │     │     │     │     │
     │     │     │     │     ▼
     │     │     │     │  ┌──────────────────┐
     │     │     │     │  │ Re-queue entries │
     │     │     │     │  │ for next attempt │
     │     │     │     │  │ (data submission)│
     │     │     │     │  │                  │
     │     │     │     │  │ OR               │
     │     │     │     │  │                  │
     │     │     │     │  │ Log error        │
     │     │     │     │  │ (heartbeat)      │
     │     │     │     │  └──────────────────┘
     │     │     │     │
     ▼     ▼     ▼     ▼
  ┌──────────────────────┐
  │ Continue operation   │
  └──────────────────────┘


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
  │  Queue empty?    │─NO─►│  submitWardriveData()               │
  └────────┬─────────┘     │  • session_id still valid ✓         │
           │               │  • POST all pending TX + RX         │
          YES              └──────────────────┬──────────────────┘
           │                                  │
           ◄──────────────────────────────────┘
           │
           ▼
  ┌──────────────────┐
  │stopWardriveTimers│
  │ • Clear 30s timer│
  │ • Clear TX timer │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ cancelHeartbeat()│◄─── Stop heartbeat timer
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ requestAuth      │
  │ ("disconnect")   │◄─── Releases session_id / slot
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │ BLE disconnect   │
  │ State cleanup    │
  │ UI updates       │
  └──────────────────┘
```

## Entry Payload Structure

Each entry in the queue contains only the wardrive data. The wrapper (key, session_id) is added by `submitWardriveData()`:

### TX Entry

```json
{
  "type": "TX",
  "lat": 45.12345,
  "lon": -75.12345,
  "noisefloor": -110,
  "heard_repeats": "4e(1.75),b7(-0.75)",
  "timestamp": 1704654321,
  "debug_data": [...]
}
```

### RX Entry

```json
{
  "type": "RX",
  "lat": 45.12345,
  "lon": -75.12345,
  "noisefloor": -110,
  "heard_repeats": "4e(12.0)",
  "timestamp": 1704654321,
  "debug_data": {...}
}
```

### Submission Wrapper

```json
{
  "key": "api_key_here",
  "session_id": "uuid-session-id",
  "data": [
    { "type": "TX", "lat": ..., "lon": ..., ... },
    { "type": "RX", "lat": ..., "lon": ..., ... }
  ]
}
```

### Heartbeat Payload

```json
{
  "key": "api_key_here",
  "session_id": "uuid-session-id",
  "heartbeat": true,
  "coords": {
    "lat": 45.12345,
    "lon": -75.12345,
    "timestamp": 1704654321
  }
}
```

## API Response Format

### Success Response

```json
{
  "success": true,
  "expires_at": 1704657921
}
```

### Error Response

```json
{
  "success": false,
  "reason": "session_expired",
  "message": "Session has expired, please reconnect"
}
```

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `API_BATCH_MAX_SIZE` | 50 | Maximum entries per submission |
| `API_TX_FLUSH_DELAY_MS` | 3000 | Delay after TX before submission |
| `API_BATCH_FLUSH_INTERVAL_MS` | 30000 | Periodic submission interval |
| `HEARTBEAT_BUFFER_MS` | 300000 | 5 minutes before session expiry |
| `WARDRIVE_RETRY_DELAY_MS` | 2000 | Delay between retry attempts |
| `WARDRIVE_ENDPOINT` | `https://meshmapper.net/wardrive-api.php/wardrive` | API endpoint |

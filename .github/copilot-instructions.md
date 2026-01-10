# MeshCore GOME WarDriver - AI Agent Instructions

> **Keeping This File Updated**: When you make architectural changes, add new workflows, or modify critical patterns, update this file. Ask the AI: *"Update .github/copilot-instructions.md to reflect the changes I just made"* - it will analyze the modifications and update relevant sections.

## Project Overview

Browser-based Progressive Web App for wardriving with MeshCore mesh network devices. Connects via Web Bluetooth to send GPS-tagged pings to a `#wardriving` channel, track repeater echoes, and post coverage data to the MeshMapper API for community mesh mapping.

**Tech Stack**: Vanilla JavaScript (ES6 modules), Web Bluetooth API, Geolocation API, Tailwind CSS v4

**Critical Files**:
- `content/wardrive.js` (5200+ lines) - Main application logic
- `content/device-models.json` - Device model database for auto-power selection
- `content/mc/` - MeshCore BLE protocol library (Connection classes, Packet parsing, Buffer utilities)
- `index.html` - Single-page UI with embedded Leaflet map
- `docs/` - Comprehensive workflow documentation (CONNECTION_WORKFLOW.md, PING_WORKFLOW.md, DEVICE_MODEL_MAPPING.md, etc.)

## Architecture & Data Flow

### 1. Connection Architecture
Three-layer connection system:
- **BLE Layer**: `WebBleConnection` (extends `Connection` base class) handles GATT connection, characteristic notifications
- **Protocol Layer**: `Connection.js` (2200+ lines) implements MeshCore companion protocol - packet framing, encryption, channel management, device queries
- **App Layer**: `wardrive.js` orchestrates connect/disconnect workflows with 10-step sequences (see `docs/CONNECTION_WORKFLOW.md`)

**Connect Sequence**: BLE GATT → Protocol Handshake → Device Info → Device Model Auto-Power → Time Sync → Capacity Check (API slot acquisition) → Channel Setup → GPS Init → Connected

### 2. Device Model Auto-Power Selection (NEW)
Automatic power configuration based on detected hardware:
- **Database**: `device-models.json` contains 32+ MeshCore device variants with recommended power levels
- **Detection**: `deviceQuery()` returns manufacturer string (e.g., "Ikoka Stick-E22-30dBm (Xiao_nrf52)nightly-e31c46f")
- **Parsing**: `parseDeviceModel()` strips build suffix ("nightly-COMMIT") for database matching
- **Lookup**: `findDeviceConfig()` searches database for exact/partial match
- **Auto-Set**: `autoSetPowerLevel()` configures radio power after successful deviceQuery()
- **Critical Safety**: PA amplifier models (33dBm, 30dBm) require specific input power to avoid hardware damage
- See `docs/DEVICE_MODEL_MAPPING.md` for complete architecture

### 3. Ping Lifecycle & API Queue System
Two independent data flows merge into a unified API batch queue:

**TX Flow** (Transmit):
1. User sends ping → `sendPing()` validates GPS/geofence/distance
2. Sends `@[MapperBot]<LAT LON>[ <power>]` to `#wardriving` channel via BLE
3. Starts 6-second RX listening window for repeater echoes
4. After window: posts to API queue with type "TX"
5. Triggers 3-second flush timer for real-time map updates

**RX Flow** (Receive - Passive monitoring):
1. Always-on `handleUnifiedRxLogEvent()` captures ALL incoming packets (no filtering)
2. Validates path length > 0 (must route via repeater, not direct)
3. Buffers RX events per repeater with GPS coordinates
4. Flushes to API queue on 25m movement or 30s timeout, type "RX"

**API Queue** (`apiQueue.messages[]`):
- Max 50 messages, auto-flush on size/30s timer/TX triggers
- Batch POST to `yow.meshmapper.net/wardriving-api.php`
- See `docs/FLOW_WARDRIVE_API_QUEUE_DIAGRAM.md` for visual flow

### 3. GPS & Geofencing
- **GPS Watch**: Continuous `navigator.geolocation.watchPosition()` with high accuracy
- **Freshness**: Manual pings use 60s max age, auto pings require fresh acquisition
- **Ottawa Geofence**: 150km radius from Parliament Hill (45.4215, -75.6972) - hard boundary
- **Min Distance Filter**: 25m between pings (prevents spam, separate from 25m RX batch trigger)

### 5. State Management
Global `state` object tracks:
- `connection`: Active BLE connection instance
- `wardrivingChannel`: Channel object for ping sends
- `txRxAutoRunning` / `autoTimerId` / `nextAutoPingTime`: Auto-ping state
- `lastPingLat/Lon`: For distance validation
- `cooldownEndTime`: 7-second cooldown after each ping
- `sessionId`: UUID for correlating TX/RX events per wardrive session
- `deviceModel`: Full manufacturer string from deviceQuery()
- `autoPowerSet`: Boolean tracking if power was automatically configured

**Device Model Database**: `DEVICE_MODELS` global array loaded from JSON on page load

**RX Batch Buffer**: `Map` keyed by repeater node ID → `{rxEvents: [], bufferedSince, lastFlushed, flushTimerId}`

## Critical Developer Workflows

### Build & Development
```bash
npm install                  # Install Tailwind CLI
npm run build:css            # One-time CSS build
npm run watch:css            # Watch mode for development
```

**No bundler/compiler** - Open `index.html` directly in browser (Chrome/Chromium required for Web Bluetooth).

### Debug Logging System
All debug output controlled by `DEBUG_ENABLED` flag (URL param `?debug=true` or hardcoded):
```javascript
debugLog("[TAG] message", ...args);   // General info
debugWarn("[TAG] message", ...args);  // Warnings
debugError("[TAG] message", ...args); // Errors (also adds to UI Error Log)
```

**Required Tags** (see `docs/DEVELOPMENT_REQUIREMENTS.md`): `[BLE]`, `[GPS]`, `[PING]`, `[API QUEUE]`, `[RX BATCH]`, `[UNIFIED RX]`, `[UI]`, etc. NEVER log without a tag.

### Status Message System
**Two separate status bars** (NEVER mix them):
1. **Connection Status** (`setConnStatus(text, color)`) - ONLY "Connected", "Connecting", "Disconnected", "Disconnecting"
2. **Dynamic Status** (`setDynamicStatus(text, color, immediate)`) - All operational messages, 500ms minimum visibility, blocks connection words

Use `STATUS_COLORS` constants: `idle`, `success`, `warning`, `error`, `info`

## Project-Specific Patterns

### 1. Countdown Timer Pattern
Reusable countdown system for cooldowns, auto-ping intervals, RX listening windows:
```javascript
function createCountdownTimer(getEndTime, getStatusMessage) {
  // Returns timer state, updates UI every 500ms
  // Handles pause/resume for manual ping interrupts
}
```
Used by `startAutoCountdown()`, `startRxListeningCountdown()`, cooldown logic.

### 2. Channel Hash & Decryption
**Pre-computed at startup**:
```javascript
WARDRIVING_CHANNEL_KEY = await deriveChannelKey("#wardriving");  // SHA-256 for hashtag channels
WARDRIVING_CHANNEL_HASH = await computeChannelHash(key);        // PSK channel identifier
```

**Channel Key Types**:
- **Hashtag channels** (`#wardriving`, `#testing`, `#ottawa`): Keys derived via SHA-256 of channel name
- **Public channel** (`Public`, no hashtag): Uses fixed key `8b3387e9c5cdea6ac9e5edbaa115cd72` (default MeshCore channel)

Used for:
- Repeater echo detection (match `channelHash` in received packets)
- Message decryption (AES-ECB via aes-js library)

### 3. Wake Lock Management
Auto-ping mode acquires Screen Wake Lock to keep GPS active:
```javascript
await acquireWakeLock();   // On auto-ping start
await releaseWakeLock();   // On stop/disconnect
```
Handles visibility changes (release on hidden, reacquire on visible).

### 4. Capacity Check (API Slot Management)
Before connecting, app must acquire a slot from MeshMapper backend:
```javascript
POST /capacitycheck.php { iatacode: "YOW", apikey: "...", apiver: "1.6.0" }
Response: { valid: true, reason: null } or { valid: false, reason: "outofdate" }
```
Slot released on disconnect. Prevents backend overload.

## Documentation Requirements (CRITICAL)

**ALWAYS update docs when modifying workflows**:

1. **Connection Changes** → Update `docs/CONNECTION_WORKFLOW.md` (steps, states, error handling)
2. **Ping/Auto-Ping Changes** → Update `docs/PING_WORKFLOW.md` (validation, lifecycle, UI impacts)
3. **New Status Messages** → Add to `docs/STATUS_MESSAGES.md` (exact text, trigger, color)
4. **Code Comments** → Use JSDoc (`@param`, `@returns`) for all functions
5. **Architecture/Pattern Changes** → Update `.github/copilot-instructions.md` (this file) to reflect new patterns, data flows, or critical gotchas

### Status Message Documentation Format
```markdown
#### Message Name
- **Message**: `"Exact text shown"`
- **Color**: Green/Red/Yellow/Blue (success/error/warning/info)
- **When**: Detailed trigger condition
- **Source**: `content/wardrive.js:functionName()`
```

## Integration Points & External APIs

### MeshMapper API (yow.meshmapper.net)
- **Capacity Check**: `capacitycheck.php` - Slot acquisition before connect
- **Wardrive Data**: `wardriving-api.php` - Batch POST TX/RX coverage blocks
  - Payload: `[{type:"TX"|"RX", lat, lon, who, power, heard, session_id, iatacode}]`
  - Auth: `apikey` in JSON body (NOT query string - see `docs/GEO_AUTH_DESIGN.md`)

### MeshCore Protocol (content/mc/)
Key methods on `Connection` class:
- `deviceQuery(protoVer)` - Protocol handshake
- `getDeviceName()`, `getPublicKey()`, `getDeviceSettings()` - Device info
- `sendTime()` - Time sync
- `getChannels()`, `createChannel()`, `deleteChannel()` - Channel CRUD
- `sendChannelMsg(channel, text)` - Send text message to channel

**Packet Structure**: Custom binary protocol with BufferReader/Writer utilities for serialization.

## Common Pitfalls & Gotchas

1. **Unified RX Handler accepts ALL packets** - No header filtering at entry point (removed in PR #130). Session log tracking filters headers internally.

2. **GPS freshness varies by context**: Manual pings tolerate 60s old GPS data, auto pings force fresh acquisition. Check `GPS_WATCH_MAX_AGE_MS` vs `GPS_FRESHNESS_BUFFER_MS`.

3. **Control locking during ping lifecycle** - `sendPing()` disables all controls until API post completes. Must call `unlockPingControls()` in ALL code paths (success/error).

4. **Auto-ping pause/resume** - Manual pings during auto mode pause countdown, resume after completion. Handle in `handleManualPingBlockedDuringAutoMode()`.

5. **Disconnect cleanup order matters**: Flush API queue → Release capacity → Delete channel → Close BLE → Clear timers/GPS/wake locks → Reset state. Out-of-order causes errors.

6. **Tailwind config paths**: Build scans `index.html` and `content/**/*.{js,html}`. Missing paths = missing styles.

7. **Status message visibility race** - Use `immediate=true` for countdown updates, `false` for first display (enforces 500ms minimum).

## Code Style Conventions

- **No frameworks/bundlers** - Vanilla JS with ES6 modules (`import`/`export`)
- **Functional > Classes** - Most code uses functions + closures (except mc/ library uses classes)
- **State centralization** - Global `state` object, explicit mutations
- **Constants at top** - All config in SCREAMING_SNAKE_CASE (intervals, URLs, thresholds)
- **Async/await** - Preferred over `.then()` chains
- **Error handling** - Wrap BLE/API calls in try-catch, log with `debugError()`

### AI Prompt Formatting
When generating prompts for AI agents or subagents, always format them in markdown code blocks using four backticks (````markdown) to prevent accidentally closing the code block when the prompt itself contains triple backticks (```):

````markdown
Example prompt for AI agent:
- Task description here
- Can safely include ```code examples``` without breaking the outer block
````

## Key Files Reference

- `content/wardrive.js:connect()` (line ~2020) - 10-step connection workflow
- `content/wardrive.js:sendPing()` (line ~2211) - Ping validation & send logic
- `content/wardrive.js:handleUnifiedRxLogEvent()` (line ~3100) - RX packet handler
- `content/wardrive.js:flushApiQueue()` (line ~3800) - Batch API POST
- `content/mc/connection/connection.js` - MeshCore protocol implementation
- `docs/FLOW_WARDRIVE_API_QUEUE_DIAGRAM.md` - Visual API queue architecture
- `docs/COVERAGE_TYPES.md` - Coverage block definitions (BIDIR, TX, RX, DEAD, DROP)

## Testing Approach

**No automated tests** - Manual testing only:
1. **Syntax check**: `node -c content/wardrive.js`
2. **Desktop testing**: Primary development on Chrome/Chromium desktop
   - Use Chrome DevTools Sensors tab for GPS simulation
   - Mobile device emulation for responsive UI testing
3. **Debug logging**: Enable via `?debug=true` to trace workflows
4. **Production validation**: App primarily used on mobile (Android Chrome, iOS Bluefy)
   - Desktop testing sufficient for most development
   - Real device testing with MeshCore companion for final validation

**Mobile-first app, desktop-tested workflow** - Most development happens on desktop with DevTools, but remember users are on phones with real GPS and BLE constraints.

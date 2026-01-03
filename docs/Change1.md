# MeshCore GOME WarDriver - Development Guidelines

## Overview
This document defines the coding standards and requirements for all changes to the MeshCore GOME WarDriver repository.  AI agents and contributors must follow these guidelines for every modification.

---

## Code Style & Standards

### Debug Logging
- **ALWAYS** include debug console logging for significant operations
- Use the existing debug helper functions: 
  - `debugLog(message, ...args)` - For general debug information
  - `debugWarn(message, ... args)` - For warning conditions
  - `debugError(message, ... args)` - For error conditions
- Debug logging is controlled by the `DEBUG_ENABLED` flag (URL parameter `? debug=true`)
- Log at key points: function entry, API calls, state changes, errors, and decision branches

#### Debug Log Tagging Convention

All debug log messages **MUST** include a descriptive tag in square brackets immediately after `[DEBUG]` that identifies the subsystem or feature area. This enables easier filtering and understanding of debug output. 

**Format:** `[DEBUG] [TAG] Message here`

**Required Tags:**

| Tag | Description |
|-----|-------------|
| `[BLE]` | Bluetooth connection and device communication |
| `[GPS]` | GPS/geolocation operations |
| `[PING]` | Ping sending and validation |
| `[API QUEUE]` | API batch queue operations |
| `[RX BATCH]` | RX batch buffer operations |
| `[PASSIVE RX]` | Passive RX logging logic |
| `[PASSIVE RX UI]` | Passive RX UI rendering |
| `[SESSION LOG]` | Session log tracking |
| `[UNIFIED RX]` | Unified RX handler |
| `[DECRYPT]` | Message decryption |
| `[UI]` | General UI updates (status bar, buttons, etc.) |
| `[CHANNEL]` | Channel setup and management |
| `[TIMER]` | Timer and countdown operations |
| `[WAKE LOCK]` | Wake lock acquisition/release |
| `[GEOFENCE]` | Geofence and distance validation |
| `[CAPACITY]` | Capacity check API calls |
| `[AUTO]` | Auto ping mode operations |
| `[INIT]` | Initialization and setup |
| `[ERROR LOG]` | Error log UI operations |

**Examples:**
```javascript
// ✅ Correct - includes tag
debugLog("[BLE] Connection established");
debugLog("[GPS] Fresh position acquired: lat=45.12345, lon=-75.12345");
debugLog("[PING] Sending ping to channel 2");

// ❌ Incorrect - missing tag
debugLog("Connection established");
debugLog("Fresh position acquired");
```

### Status Messages
- **ALWAYS** update `STATUS_MESSAGES.md` when adding or modifying user-facing status messages
- Use the `setStatus(message, color)` function for all UI status updates
- Use appropriate `STATUS_COLORS` constants: 
  - `STATUS_COLORS.idle` - Default/waiting state
  - `STATUS_COLORS. success` - Successful operations
  - `STATUS_COLORS.warning` - Warning conditions
  - `STATUS_COLORS.error` - Error states
  - `STATUS_COLORS.info` - Informational/in-progress states

---

## Documentation Requirements

### Code Comments
- Document complex logic with inline comments
- Use JSDoc-style comments for functions: 
  - `@param` for parameters
  - `@returns` for return values
  - Brief description of purpose

### docs/STATUS_MESSAGES.md Updates
When adding new status messages, include:
- The exact status message text
- When it appears (trigger condition)
- The status color used
- Any follow-up actions or states

### `docs/CONNECTION_WORKFLOW.md` Updates
When **modifying connect or disconnect logic**, you must:
- Read `docs/CONNECTION_WORKFLOW.md` before making the change (to understand current intended behavior).
- Update `docs/CONNECTION_WORKFLOW.md` so it remains accurate after the change:
  - Steps/sequence of the workflow
  - Any new states, retries, timeouts, or error handling
  - Any UI impacts (buttons, indicators, status messages)

### docs/PING_AUTO_PING_WORKFLOW.md Updates
When **modifying ping or auto-ping logic**, you must: 
- Read `docs/PING_AUTO_PING_WORKFLOW.md` before making the change (to understand current intended behavior).
- Update `docs/PING_AUTO_PING_WORKFLOW.md` so it remains accurate after the change:
  - Ping flows (manual `sendPing()`, auto-ping lifecycle)
  - Validation logic (geofence, distance, cooldown)
  - GPS acquisition and payload construction
  - Repeater tracking and MeshMapper API posting
  - Control locking and cooldown management
  - Auto mode behavior (intervals, wake lock, page visibility)
  - Any UI impacts (buttons, status messages, countdown displays)

---

### Requested Change

# Unified Refactor:  RX Parsing Architecture, Naming Standardization, and RX Auto Mode

## Overview
This is a comprehensive refactor covering three major tasks: 
1. **Unified RX Parsing Architecture**: Single parsing point for RX packet metadata
2. **Complete Naming Standardization**:  TX/RX terminology consistency across entire codebase
3. **RX Auto Mode**: New passive-only wardriving mode with always-on unified listener

## Repository Context
- **Repository**: MrAlders0n/MeshCore-GOME-WarDriver
- **Branch**: dev
- **Language**:  JavaScript (vanilla), HTML, CSS
- **Type**: Progressive Web App (PWA) for Meshtastic wardriving

---

## Task 1: Unified RX Parsing Architecture

### Objective
Refactor RX packet handling to use a single unified parsing function that extracts header/path metadata once, then routes to TX or RX wardriving handlers.  This eliminates duplicate parsing, ensures consistency, and fixes debug data accuracy issues. 

### Current Problems
1. Header and path are parsed separately in `handleSessionLogTracking()` and `handlePassiveRxLogging()`
2. Debug data uses `packet.path` from decrypted packet instead of actual raw path bytes
3. Performance waste - same bytes parsed multiple times per packet
4. Inconsistency risk - two different code paths doing same extraction
5. Debug mode `parsed_path` shows incorrect data (e.g., "0" instead of "4E")

### Required Changes

#### 1. Create Unified Metadata Parser

Create new function `parseRxPacketMetadata(data)` in `content/wardrive.js`:

**Location**: Add after `computeChannelHash()` function (around line 1743)

**Implementation**:
- Extract header byte from `data.raw[0]`
- Extract path length from header upper 4 bits:  `(header >> 4) & 0x0F`
- Extract raw path bytes as array: `data.raw.slice(1, 1 + pathLength)`
- Derive first hop (for TX repeater ID): `pathBytes[0]`
- Derive last hop (for RX repeater ID): `pathBytes[pathLength - 1]`
- Extract encrypted payload: `data.raw.slice(1 + pathLength)`

**Return object structure**:
{
  raw: data.raw,                    // Full raw packet bytes
  header: header,                   // Header byte
  pathLength: pathLength,           // Number of hops
  pathBytes: pathBytes,             // Raw path bytes array
  firstHop: pathBytes[0],          // First hop ID (TX)
  lastHop: pathBytes[pathLength-1], // Last hop ID (RX)
  snr: data.lastSnr,               // SNR value
  rssi: data.lastRssi,             // RSSI value
  encryptedPayload: payload        // Rest of packet
}

**JSDoc**: 
/**
 * Parse RX packet metadata from raw bytes
 * Single source of truth for header/path extraction
 * @param {Object} data - LogRxData event data (contains lastSnr, lastRssi, raw)
 * @returns {Object} Parsed metadata object
 */

**Debug logging**:
- Log when parsing starts
- Log extracted values (header, pathLength, firstHop, lastHop)
- Use `[RX PARSE]` debug tag

#### 2. Refactor TX Handler

Update `handleSessionLogTracking()` (will also be renamed to `handleTxLogging()` in Task 2):

**Changes**:
- Accept metadata object as first parameter instead of packet object
- Remove duplicate header/path parsing code
- Use `metadata.header` for header validation
- Use `metadata.firstHop` for repeater ID extraction
- Use `metadata.pathBytes` for debug data
- Store full metadata in repeater tracking for debug mode
- Decrypt payload using `metadata.encryptedPayload` if needed
- Update to work with pre-parsed metadata throughout

**Signature change**: 
// OLD:
async function handleSessionLogTracking(packet, data)

// NEW (after Task 2 rename):
async function handleTxLogging(metadata, data)

**Key changes**:
- Replace `packet.header` with `metadata.header`
- Replace `packet.path[0]` with `metadata.firstHop`
- Replace `packet.payload` with `metadata.encryptedPayload`
- Store metadata object (not just SNR) in `state.txTracking.repeaters` for debug mode
- For decryption, use metadata.encryptedPayload

#### 3. Refactor RX Handler

Update `handlePassiveRxLogging()` (will also be renamed to `handleRxLogging()` in Task 2):

**Changes**:
- Accept metadata object as first parameter instead of packet object
- Remove all header/path parsing code (already done in parseRxPacketMetadata)
- Use `metadata.lastHop` for repeater ID extraction
- Use `metadata.pathLength` for path length
- Use `metadata.header` for header value
- Pass metadata to batching function

**Signature change**:
// OLD:
async function handlePassiveRxLogging(packet, data)

// NEW (after Task 2 rename):
async function handleRxLogging(metadata, data)

**Key changes**:
- Replace `packet.path.length` with `metadata.pathLength`
- Replace `packet.path[packet.path.length - 1]` with `metadata.lastHop`
- Replace `packet.header` with `metadata.header`
- Pass metadata to handleRxBatching() instead of building separate rawPacketData object

#### 4. Fix Debug Data Generation

Update `buildDebugData()` function:

**Changes**:
- Accept metadata object as first parameter
- Use `metadata.pathBytes` for `parsed_path` field (NOT packet.path)
- Use `metadata.header` for `parsed_header` field
- Convert `metadata.pathBytes` directly to hex string
- Ensure repeaterId matches first/last byte of pathBytes

**Signature change**:
// OLD:
function buildDebugData(rawPacketData, heardByte)

// NEW:
function buildDebugData(metadata, heardByte, repeaterId)

**Implementation**: 
function buildDebugData(metadata, heardByte, repeaterId) {
  // Convert path bytes to hex string - these are the ACTUAL bytes used
  const parsedPathHex = Array.from(metadata. pathBytes)
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  
  return {
    raw_packet:  bytesToHex(metadata.raw),
    raw_snr: metadata.snr,
    raw_rssi: metadata.rssi,
    parsed_header: metadata.header. toString(16).padStart(2, '0').toUpperCase(),
    parsed_path_length:  metadata.pathLength,
    parsed_path: parsedPathHex,  // ACTUAL raw bytes
    parsed_payload: bytesToHex(metadata. encryptedPayload),
    parsed_heard: heardByte,
    repeaterId: repeaterId
  };
}

#### 5. Update Unified RX Handler

Update `handleUnifiedRxLogEvent()`:

**Changes**:
- Call `parseRxPacketMetadata(data)` FIRST before any routing
- Pass metadata to handlers instead of packet
- Remove `Packet.fromBytes()` call from unified handler (moved to individual handlers if needed)
- Keep decrypt logic in TX handler only (TX needs encrypted content)

**Updated flow**:
async function handleUnifiedRxLogEvent(data) {
  try {
    // Parse metadata ONCE
    const metadata = parseRxPacketMetadata(data);
    
    debugLog(`[UNIFIED RX] Packet received: header=0x${metadata.header.toString(16)}, pathLength=${metadata.pathLength}`);
    
    // Route to TX tracking if active
    if (state.txTracking.isListening) {
      debugLog("[UNIFIED RX] TX tracking active - delegating to TX handler");
      const wasEcho = await handleTxLogging(metadata, data);
      if (wasEcho) {
        debugLog("[UNIFIED RX] Packet was TX echo, done");
        return;
      }
    }
    
    // Route to RX wardriving if active
    if (state.rxTracking.isWardriving) {
      debugLog("[UNIFIED RX] RX wardriving active - delegating to RX handler");
      await handleRxLogging(metadata, data);
    }
  } catch (error) {
    debugError("[UNIFIED RX] Error processing rx_log entry", error);
  }
}

#### 6. Update Debug Mode Integration

Update debug data usage in:
- `postToMeshMapperAPI()` (TX debug data) - around line 1409
- `queueRxApiPost()` (RX debug data) - around line 2378

**Changes for TX debug data**:
- Access metadata from stored repeater data:  `repeater.metadata`
- Call `buildDebugData(repeater.metadata, heardByte, repeater.repeaterId)`
- For TX: heardByte is the repeaterId (first hop)

**Changes for RX debug data**:
- Access metadata from batch entry: `entry.metadata`
- Call `buildDebugData(entry.metadata, heardByte, entry.repeater_id)`
- For RX: heardByte is last hop from metadata. pathBytes

**Example TX integration**:
if (state.debugMode && state.tempTxRepeaterData && state.tempTxRepeaterData.length > 0) {
  const debugDataArray = [];
  for (const repeater of state.tempTxRepeaterData) {
    if (repeater.metadata) {
      const heardByte = repeater.repeaterId;
      const debugData = buildDebugData(repeater.metadata, heardByte, repeater.repeaterId);
      debugDataArray.push(debugData);
    }
  }
  if (debugDataArray.length > 0) {
    payload.debug_data = debugDataArray;
  }
}

**Example RX integration**:
if (state.debugMode && entry.metadata) {
  const lastHopId = entry.metadata.lastHop;
  const heardByte = lastHopId. toString(16).padStart(2, '0').toUpperCase();
  const debugData = buildDebugData(entry.metadata, heardByte, entry.repeater_id);
  payload.debug_data = debugData;
}

#### 7. Update Repeater Tracking Storage

In `handleTxLogging()` (renamed from handleSessionLogTracking):

**Store full metadata**:
state.txTracking.repeaters. set(pathHex, {
  snr: data.lastSnr,
  seenCount: 1,
  metadata: metadata  // Store full metadata for debug mode
});

In `stopTxTracking()` (renamed from stopRepeaterTracking):

**Return metadata with repeater data**:
const repeaters = Array.from(state.txTracking.repeaters.entries()).map(([id, data]) => ({
  repeaterId: id,
  snr: data.snr,
  metadata: data.metadata  // Include metadata for debug mode
}));

#### 8. Update RX Batching Storage

In `handleRxBatching()` (renamed from handlePassiveRxForAPI):

**Store metadata in buffer**:
buffer = {
  firstLocation: { lat: currentLocation.lat, lng: currentLocation.lon },
  bestObservation: {
    snr,
    rssi,
    pathLength,
    header,
    lat: currentLocation.lat,
    lon: currentLocation.lon,
    timestamp: Date.now(),
    metadata: metadata  // Store full metadata for debug mode
  }
};

In `flushRxBatch()` (renamed from flushBatch):

**Include metadata in entry**:
const entry = {
  repeater_id: repeaterId,
  location: { lat: best.lat, lng: best.lon },
  snr:  best.snr,
  rssi: best.rssi,
  pathLength: best.pathLength,
  header: best.header,
  timestamp: best.timestamp,
  metadata: best.metadata  // For debug mode
};

### Validation Requirements
- Debug data `parsed_path` must show actual raw bytes used for repeater ID determination
- For TX: `parsed_path` first byte must equal `repeaterId` and `parsed_heard`
- For RX: `parsed_path` last byte must equal `repeaterId` used in API post
- No duplicate parsing - single call to parseRxPacketMetadata() per packet
- All existing functionality preserved (TX/RX tracking, API posting, UI updates)
- Debug logging at each step with [RX PARSE] tag

---

## Task 2: Complete Naming Standardization

### Objective
Standardize all naming conventions across the codebase to use consistent TX/RX terminology, eliminating legacy "session log" and "repeater tracking" names.

### Naming Convention Rules
- **TX** = Active ping wardriving (send ping, track echoes)
- **RX** = Passive observation wardriving (listen to all packets)
- Use `Tracking` for operational state (lifecycle management)
- Use `Log` for UI state (display/export)
- Use `TxRxAuto` for combined TX + RX auto mode
- Use `RxAuto` for RX-only auto mode

### Required Changes

#### 1. State Object Renames

**File**: `content/wardrive.js`

**Main operational state (state object)**:

RENAME state.repeaterTracking TO state.txTracking
  - All properties: 
    - state.txTracking.isListening
    - state.txTracking. sentTimestamp
    - state.txTracking.sentPayload
    - state.txTracking.channelIdx
    - state.txTracking.repeaters
    - state. txTracking.listenTimeout
    - state.txTracking.rxLogHandler
    - state.txTracking.currentLogEntry

RENAME state.passiveRxTracking TO state. rxTracking
  - Properties:
    - state.rxTracking.isListening
    - state.rxTracking.rxLogHandler
  - REMOVE state.rxTracking.entries (unused array)

RENAME state.running TO state.txRxAutoRunning
  - This is the flag for TX/RX Auto mode
  - Find ALL references throughout codebase

state.rxAutoRunning - NO CHANGE (already correct)

**UI state (standalone consts)**:

RENAME sessionLogState TO txLogState
  - All references to sessionLogState
  
rxLogState - NO CHANGE
errorLogState - NO CHANGE

#### 2. Function Renames

**File**: `content/wardrive.js`

**Core handlers**: 
- RENAME handleSessionLogTracking() TO handleTxLogging()
- RENAME handlePassiveRxLogging() TO handleRxLogging()
- RENAME handlePassiveRxForAPI() TO handleRxBatching()
- handleUnifiedRxLogEvent() - NO CHANGE

**Lifecycle functions**:
- RENAME startRepeaterTracking() TO startTxTracking()
- RENAME stopRepeaterTracking() TO stopTxTracking()
- startUnifiedRxListening() - NO CHANGE
- stopUnifiedRxListening() - NO CHANGE

**UI functions**:
- RENAME addLogEntry() TO addTxLogEntry()
- RENAME updateLogSummary() TO updateTxLogSummary()
- RENAME renderLogEntries() TO renderTxLogEntries()
- RENAME toggleBottomSheet() TO toggleTxLogBottomSheet()
- RENAME updateCurrentLogEntryWithLiveRepeaters() TO updateCurrentTxLogEntryWithLiveRepeaters()
- RENAME updatePingLogWithRepeaters() TO updateTxLogWithRepeaters()
- RENAME logPingToUI() TO logTxPingToUI()
- addRxLogEntry() - NO CHANGE
- updateRxLogSummary() - NO CHANGE
- renderRxLogEntries() - NO CHANGE
- toggleRxLogBottomSheet() - NO CHANGE

**Export functions**:
- RENAME sessionLogToCSV() TO txLogToCSV()
- rxLogToCSV() - NO CHANGE
- errorLogToCSV() - NO CHANGE

**Batch/API functions**:
- RENAME flushBatch() TO flushRxBatch()
- RENAME flushAllBatches() TO flushAllRxBatches()
- RENAME queueApiPost() TO queueRxApiPost()

**Helper functions**:
- formatRepeaterTelemetry() - NO CHANGE (generic)

#### 3. DOM Element Reference Renames

**File**: `content/wardrive.js`

RENAME all Session Log DOM references:
- sessionPingsEl TO txPingsEl
- logSummaryBar TO txLogSummaryBar
- logBottomSheet TO txLogBottomSheet
- logScrollContainer TO txLogScrollContainer
- logCount TO txLogCount
- logLastTime TO txLogLastTime
- logLastSnr TO txLogLastSnr
- sessionLogCopyBtn TO txLogCopyBtn

RENAME button references:
- sendPingBtn TO txPingBtn
- autoToggleBtn TO txRxAutoBtn

RX Log DOM references - NO CHANGE (already correct):
- rxLogSummaryBar
- rxLogBottomSheet
- rxLogScrollContainer
- rxLogCount
- rxLogLastTime
- rxLogLastRepeater
- rxLogSnrChip
- rxLogEntries
- rxLogExpandArrow
- rxLogCopyBtn

#### 4. HTML Element ID Renames

**File**: `index.html`

UPDATE all Session Log element IDs:
- id="sessionPings" TO id="txPings"
- id="logSummaryBar" TO id="txLogSummaryBar"
- id="logBottomSheet" TO id="txLogBottomSheet"
- id="logScrollContainer" TO id="txLogScrollContainer"
- id="logCount" TO id="txLogCount"
- id="logLastTime" TO id="txLogLastTime"
- id="logLastSnr" TO id="txLogLastSnr"
- id="sessionLogCopyBtn" TO id="txLogCopyBtn"
- id="logExpandArrow" TO id="txLogExpandArrow"

UPDATE button IDs:
- id="sendPingBtn" TO id="txPingBtn"
- id="autoToggleBtn" TO id="txRxAutoBtn"

UPDATE user-facing labels:
- H2 heading text:  "Session Log" TO "TX Log"
- Button text: "Send Ping" TO "TX Ping"
- Button text: "Start Auto Ping" / "Stop Auto Ping" TO "TX/RX Auto" / "Stop TX/RX"

#### 5. Debug Log Tag Updates

**Files**: `content/wardrive.js`, all documentation files

REPLACE debug tags throughout:
- [SESSION LOG] TO [TX LOG]
- [PASSIVE RX] TO [RX LOG]
- [PASSIVE RX UI] TO [RX LOG UI]
- [AUTO] TO [TX/RX AUTO] (when referring to auto ping mode)

KEEP unchanged:
- [RX BATCH] (API batching operations)
- [API QUEUE]
- [UNIFIED RX]
- [BLE]
- [GPS]
- [PING]
- etc.

#### 6. CSS Comments Update

**File**: `content/style.css`

UPDATE comment: 
/* Session Log - Static Expandable Section */
TO
/* TX Log - Static Expandable Section */

#### 7. Documentation File Updates

**Files to update**: 

**docs/DEVELOPMENT_REQUIREMENTS.md**: 
- Update debug tag table:  [SESSION LOG] → [TX LOG]
- Update debug tag table: [AUTO] → [TX/RX AUTO]
- Update debug tag table:  [PASSIVE RX] → [RX LOG]
- Update debug tag table: [PASSIVE RX UI] → [RX LOG UI]

**docs/PING_WORKFLOW.md**:
- Replace "session log" with "TX log" throughout
- Replace "Session Log" with "TX Log" throughout
- Replace "repeater tracking" with "TX tracking" (when referring to TX)
- Replace "auto mode" with "TX/RX Auto mode"
- Replace "Auto Ping" with "TX/RX Auto"
- Update function references to new names
- Update state variable references to new names

**docs/CONNECTION_WORKFLOW.md**: 
- Replace "session log" with "TX log"
- Replace "repeater tracking" with "TX tracking"
- Update function references:  stopRepeaterTracking() → stopTxTracking()

**docs/FLOW_WARDRIVE_TX_DIAGRAM.md**:
- Replace "SESSION LOG HANDLER" with "TX LOG HANDLER"
- Replace "Session Log" with "TX Log" throughout
- Update all function names in diagram

**docs/FLOW_WARDRIVE_RX_DIAGRAM. md**:
- Replace "PASSIVE RX HANDLER" with "RX LOG HANDLER"
- Update function names in diagram

**CHANGES_SUMMARY.md**:
- Update historical references (optional, for consistency)

#### 8. Code Comments and JSDoc Updates

**File**: `content/wardrive.js`

UPDATE all inline comments:
- "session log" → "TX log"
- "Session Log" → "TX Log"
- "repeater tracking" (when referring to TX) → "TX tracking"
- "passive RX" (when referring to logging) → "RX logging"
- "auto mode" → "TX/RX Auto mode"
- "Auto Ping" → "TX/RX Auto"

UPDATE all JSDoc comments:
- Function descriptions mentioning "session log" → "TX log"
- Function descriptions mentioning "repeater" → "TX tracking" or "repeater telemetry" (as appropriate)
- Parameter descriptions
- Return value descriptions

#### 9. Event Listener Updates

**File**: `content/wardrive.js` (in onLoad function)

UPDATE event listeners:
- sendPingBtn. addEventListener → txPingBtn.addEventListener
- autoToggleBtn.addEventListener → txRxAutoBtn.addEventListener
- logSummaryBar.addEventListener → txLogSummaryBar.addEventListener
- sessionLogCopyBtn.addEventListener → txLogCopyBtn.addEventListener

#### 10. Copy to Clipboard Function Updates

**File**: `content/wardrive.js` (copyLogToCSV function)

UPDATE switch statement:
case 'session':  
  csv = txLogToCSV();
  logTag = '[TX LOG]';
  break;

### Validation Requirements
- All references to old names must be updated
- No broken references (undefined variables/functions)
- All functionality preserved (no behavior changes)
- Debug logging uses new tags consistently
- Documentation matches code
- UI labels updated for user-facing text
- HTML IDs match JavaScript selectors

---

## Task 3: RX Auto Mode with Always-On Unified Listener

### Objective
Add a new "RX Auto" button that enables RX-only wardriving (no transmission), while restructuring the unified RX listener to be always active when connected.  This enables three distinct modes:  TX Ping (manual), TX/RX Auto (current auto behavior), and RX Auto (new passive-only mode).

### Current Behavior
- Unified RX listener starts when TX/RX Auto button clicked
- Unified RX listener stops when TX/RX Auto button clicked again
- No way to do RX wardriving without TX transmission

### New Behavior
- Unified RX listener starts IMMEDIATELY on connect and stays on entire connection
- Unified listener NEVER stops except on disconnect
- RX wardriving subscription controlled by flag:  `state.rxTracking.isWardriving`
- Three buttons: TX Ping, TX/RX Auto, RX Auto

### Required Changes

#### 1. Add New State Properties

**File**: `content/wardrive.js`

ADD to state. rxTracking object:
state.rxTracking = {
  isListening: true,         // TRUE when connected (unified listener)
  isWardriving: false,       // TRUE when TX/RX Auto OR RX Auto enabled
  rxLogHandler: null
  // entries removed in Task 2
};

ADD new top-level state property:
state.rxAutoRunning = false;  // TRUE when RX Auto mode active

state.txRxAutoRunning already exists (renamed from state.running in Task 2)

#### 2. Update Connection Flow

**File**: `content/wardrive.js` (connect function)

**Changes in connect() function**: 

MOVE startUnifiedRxListening() to run IMMEDIATELY after channel setup:
async function connect() {
  // ... BLE connection ... 
  // ... Channel setup (ensureChannel) ...
  
  // START unified RX listener immediately after channel ready
  startUnifiedRxListening();
  debugLog("[BLE] Unified RX listener started on connect");
  
  // CLEAR all logs on connect (new session)
  txLogState.entries = [];
  renderTxLogEntries(true);
  updateTxLogSummary();
  
  rxLogState.entries = [];
  renderRxLogEntries(true);
  updateRxLogSummary();
  
  errorLogState.entries = [];
  renderErrorLogEntries(true);
  updateErrorLogSummary();
  
  debugLog("[BLE] All logs cleared on connect (new session)");
  
  // ...  GPS initialization ...
  // ... Connection complete ...
}

#### 3. Update Disconnect Flow

**File**: `content/wardrive.js` (disconnect handler)

**Changes in disconnected event handler**:

KEEP stopUnifiedRxListening() on disconnect (this is the ONLY place it should be called):
conn.on("disconnected", () => {
  // ... cleanup ...
  
  stopUnifiedRxListening();  // Stop unified listener on disconnect
  debugLog("[BLE] Unified RX listener stopped on disconnect");
  
  // DO NOT clear logs on disconnect (preserve for user review)
  // Logs are only cleared on connect
  
  // ... rest of cleanup ...
});

#### 4. Make startUnifiedRxListening() Idempotent

**File**:  `content/wardrive.js`

UPDATE startUnifiedRxListening() to be safe to call multiple times: 

function startUnifiedRxListening() {
  // Idempotent:  safe to call multiple times
  if (state.rxTracking.isListening && state.rxTracking.rxLogHandler) {
    debugLog("[UNIFIED RX] Already listening, skipping start");
    return;
  }
  
  if (!state.connection) {
    debugWarn("[UNIFIED RX] Cannot start:  no connection");
    return;
  }
  
  debugLog("[UNIFIED RX] Starting unified RX listening");
  
  const handler = (data) => handleUnifiedRxLogEvent(data);
  state.rxTracking.rxLogHandler = handler;
  state.connection.on(Constants.PushCodes.LogRxData, handler);
  state.rxTracking.isListening = true;
  
  debugLog("[UNIFIED RX] ✅ Unified listening started successfully");
}

#### 5. Add Defensive Check in Unified Handler

**File**: `content/wardrive.js`

UPDATE handleUnifiedRxLogEvent() with defensive check:

async function handleUnifiedRxLogEvent(data) {
  try {
    // Defensive check:  ensure listener is marked as active
    if (!state.rxTracking.isListening) {
      debugWarn("[UNIFIED RX] Received event but listener marked inactive - reactivating");
      state.rxTracking.isListening = true;
    }
    
    // Parse metadata ONCE (Task 1)
    const metadata = parseRxPacketMetadata(data);
    
    // Route to TX tracking if active (during 7s echo window)
    if (state.txTracking.isListening) {
      debugLog("[UNIFIED RX] TX tracking active - checking for echo");
      const wasEcho = await handleTxLogging(metadata, data);
      if (wasEcho) {
        debugLog("[UNIFIED RX] Packet was TX echo, done");
        return;
      }
    }
    
    // Route to RX wardriving if active (when TX/RX Auto OR RX Auto enabled)
    if (state.rxTracking.isWardriving) {
      debugLog("[UNIFIED RX] RX wardriving active - logging observation");
      await handleRxLogging(metadata, data);
    }
    
    // If neither active, packet is received but ignored
    // Listener stays on, just not processing for wardriving
    
  } catch (error) {
    debugError("[UNIFIED RX] Error processing rx_log entry", error);
  }
}

#### 6. Update TX/RX Auto Functions

**File**: `content/wardrive.js`

UPDATE startAutoPing() function (will be renamed to startTxRxAuto):

function startAutoPing() {  // Function name will stay as is, but references updated
  debugLog("[TX/RX AUTO] Starting TX/RX Auto mode");
  
  if (!state.connection) {
    debugError("[TX/RX AUTO] Cannot start - not connected");
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Check cooldown
  if (isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`[TX/RX AUTO] Start blocked by cooldown (${remainingSec}s remaining)`);
    setDynamicStatus(`Wait ${remainingSec}s before toggling TX/RX Auto`, STATUS_COLORS.warning);
    return;
  }
  
  // Defensive check: ensure unified listener is running
  if (state.connection && !state.rxTracking.isListening) {
    debugWarn("[TX/RX AUTO] Unified listener not active - restarting");
    startUnifiedRxListening();
  }
  
  // Clear any existing auto timer
  if (state.autoTimerId) {
    debugLog("[TX/RX AUTO] Clearing existing auto timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear any previous skip reason
  state.skipReason = null;
  
  // ENABLE RX wardriving
  state.rxTracking.isWardriving = true;
  debugLog("[TX/RX AUTO] RX wardriving enabled");
  
  // Start GPS watch for continuous updates
  debugLog("[TX/RX AUTO] Starting GPS watch");
  startGeoWatch();
  
  // Set TX/RX Auto mode flag
  state.txRxAutoRunning = true;  // Renamed from state.running
  updateAutoButton();
  updateControlsForCooldown();  // Disable RX Auto button
  
  // Acquire wake lock
  debugLog("[TX/RX AUTO] Acquiring wake lock");
  acquireWakeLock().catch(console.error);
  
  // Send first ping
  debugLog("[TX/RX AUTO] Sending initial auto ping");
  sendPing(false).catch(console.error);
}

UPDATE stopAutoPing() function:

function stopAutoPing(stopGps = false) {
  debugLog(`[TX/RX AUTO] Stopping TX/RX Auto mode (stopGps=${stopGps})`);
  
  // Check cooldown (unless stopGps is true for disconnect)
  if (!stopGps && isInCooldown()) {
    const remainingSec = getRemainingCooldownSeconds();
    debugLog(`[TX/RX AUTO] Stop blocked by cooldown (${remainingSec}s remaining)`);
    setDynamicStatus(`Wait ${remainingSec}s before toggling TX/RX Auto`, STATUS_COLORS.warning);
    return;
  }
  
  // Clear auto timer
  if (state.autoTimerId) {
    debugLog("[TX/RX AUTO] Clearing auto timer");
    clearTimeout(state.autoTimerId);
    state.autoTimerId = null;
  }
  stopAutoCountdown();
  
  // Clear skip reason and paused timer state
  state.skipReason = null;
  state.pausedAutoTimerRemainingMs = null;
  
  // DISABLE RX wardriving
  state.rxTracking.isWardriving = false;
  debugLog("[TX/RX AUTO] RX wardriving disabled");
  
  // DO NOT stop unified listener (stays on)
  // REMOVED:  stopUnifiedRxListening();
  
  // Stop GPS watch if requested
  if (stopGps) {
    stopGeoWatch();
  }
  
  // Clear TX/RX Auto mode flag
  state.txRxAutoRunning = false;  // Renamed from state.running
  updateAutoButton();
  updateControlsForCooldown();  // Re-enable RX Auto button
  releaseWakeLock();
  
  debugLog("[TX/RX AUTO] TX/RX Auto mode stopped");
}

#### 7. Add RX Auto Mode Functions

**File**: `content/wardrive.js`

ADD new startRxAuto() function:

function startRxAuto() {
  debugLog("[RX AUTO] Starting RX Auto mode");
  
  if (!state.connection) {
    debugError("[RX AUTO] Cannot start - not connected");
    alert("Connect to a MeshCore device first.");
    return;
  }
  
  // Defensive check: ensure unified listener is running
  if (state.connection && !state.rxTracking.isListening) {
    debugWarn("[RX AUTO] Unified listener not active - restarting");
    startUnifiedRxListening();
  }
  
  // ENABLE RX wardriving
  state.rxTracking.isWardriving = true;
  debugLog("[RX AUTO] RX wardriving enabled");
  
  // Set RX Auto mode flag
  state.rxAutoRunning = true;
  updateAutoButton();
  updateControlsForCooldown();  // Disable TX/RX Auto button
  
  // Acquire wake lock
  debugLog("[RX AUTO] Acquiring wake lock");
  acquireWakeLock().catch(console.error);
  
  setDynamicStatus("RX Auto started", STATUS_COLORS.success);
  debugLog("[RX AUTO] RX Auto mode started successfully");
}

ADD new stopRxAuto() function:

function stopRxAuto() {
  debugLog("[RX AUTO] Stopping RX Auto mode");
  
  if (!state.rxAutoRunning) {
    debugLog("[RX AUTO] RX Auto not running, nothing to stop");
    return;
  }
  
  // DISABLE RX wardriving
  state.rxTracking.isWardriving = false;
  debugLog("[RX AUTO] RX wardriving disabled");
  
  // DO NOT stop unified listener (stays on)
  // REMOVED: stopUnifiedRxListening();
  
  // Clear RX Auto mode flag
  state.rxAutoRunning = false;
  updateAutoButton();
  updateControlsForCooldown();  // Re-enable TX/RX Auto button
  releaseWakeLock();
  
  setDynamicStatus("RX Auto stopped", STATUS_COLORS.idle);
  debugLog("[RX AUTO] RX Auto mode stopped");
}

#### 8. Update Button Control Logic

**File**: `content/wardrive.js`

UPDATE updateControlsForCooldown() function:

function updateControlsForCooldown() {
  const connected = !!state.connection;
  const inCooldown = isInCooldown();
  
  debugLog(`[UI] updateControlsForCooldown: connected=${connected}, inCooldown=${inCooldown}, pingInProgress=${state.pingInProgress}, txRxAutoRunning=${state.txRxAutoRunning}, rxAutoRunning=${state.rxAutoRunning}`);
  
  // TX Ping button - disabled during cooldown or ping in progress
  txPingBtn.disabled = ! connected || inCooldown || state.pingInProgress;
  
  // TX/RX Auto button - disabled during cooldown, ping in progress, OR when RX Auto running
  txRxAutoBtn. disabled = !connected || inCooldown || state.pingInProgress || state.rxAutoRunning;
  
  // RX Auto button - disabled when TX/RX Auto running (no cooldown restriction for RX-only mode)
  rxAutoBtn.disabled = !connected || state.txRxAutoRunning;
}

UPDATE updateAutoButton() function:

function updateAutoButton() {
  // Update TX/RX Auto button
  if (state.txRxAutoRunning) {  // Renamed from state.running
    txRxAutoBtn.textContent = "Stop TX/RX";
    txRxAutoBtn. classList.remove("bg-indigo-600", "hover:bg-indigo-500");
    txRxAutoBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
  } else {
    txRxAutoBtn.textContent = "TX/RX Auto";
    txRxAutoBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
    txRxAutoBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
  }
  
  // Update RX Auto button
  if (state. rxAutoRunning) {
    rxAutoBtn.textContent = "Stop RX";
    rxAutoBtn.classList. remove("bg-indigo-600", "hover:bg-indigo-500");
    rxAutoBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
  } else {
    rxAutoBtn.textContent = "RX Auto";
    rxAutoBtn.classList.add("bg-indigo-600", "hover:bg-indigo-500");
    rxAutoBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
  }
}

#### 9. Update Page Visibility Handler

**File**: `content/wardrive.js`

UPDATE page visibility event listener: 

document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    debugLog("[UI] Page visibility changed to hidden");
    
    // Stop TX/RX Auto if running
    if (state.txRxAutoRunning) {
      debugLog("[UI] Stopping TX/RX Auto due to page hidden");
      stopAutoPing(true);  // Ignore cooldown, stop GPS
      setDynamicStatus("Lost focus, TX/RX Auto stopped", STATUS_COLORS.warning);
    }
    
    // Stop RX Auto if running
    if (state.rxAutoRunning) {
      debugLog("[UI] Stopping RX Auto due to page hidden");
      stopRxAuto();
      setDynamicStatus("Lost focus, RX Auto stopped", STATUS_COLORS.warning);
    }
    
    // Release wake lock if neither mode running
    if (!state.txRxAutoRunning && !state. rxAutoRunning) {
      debugLog("[UI] Releasing wake lock due to page hidden");
      releaseWakeLock();
    }
    
    // DO NOT stop unified listener
    
  } else {
    debugLog("[UI] Page visibility changed to visible");
    
    // Defensive check: ensure unified listener is running if connected
    if (state.connection && !state.rxTracking.isListening) {
      debugWarn("[UI] Page visible but unified listener inactive - restarting");
      startUnifiedRxListening();
    }
    
    // User must manually restart auto modes
  }
});

#### 10. Update Disconnect Handler

**File**: `content/wardrive.js`

UPDATE disconnected event handler:

conn.on("disconnected", () => {
  debugLog("[BLE] BLE disconnected event fired");
  debugLog(`[BLE] Disconnect reason: ${state.disconnectReason}`);
  
  // ...  set connection/dynamic status ...
  
  setConnectButton(false);
  deviceInfoEl.textContent = "—";
  state.connection = null;
  state.channel = null;
  state.devicePublicKey = null;
  state.wardriveSessionId = null;
  state. disconnectReason = null;
  state.channelSetupErrorMessage = null;
  state.bleDisconnectErrorMessage = null;
  
  // Stop auto modes
  stopAutoPing(true);  // Ignore cooldown, stop GPS
  stopRxAuto();  // Stop RX Auto
  
  enableControls(false);
  updateAutoButton();
  stopGeoWatch();
  stopGpsAgeUpdater();
  stopTxTracking();  // Renamed from stopRepeaterTracking
  
  // Stop unified RX listening on disconnect
  stopUnifiedRxListening();
  debugLog("[BLE] Unified RX listener stopped on disconnect");
  
  // Flush all pending RX batch data
  flushAllRxBatches('disconnect');  // Renamed from flushAllBatches
  
  // Clear API queue
  apiQueue. messages = [];
  debugLog("[API QUEUE] Queue cleared on disconnect");
  
  // Clean up all timers
  cleanupAllTimers();
  
  // DO NOT clear logs on disconnect (preserve for user review)
  // Logs are only cleared on connect
  
  state.lastFix = null;
  state.lastSuccessfulPingLocation = null;
  state.gpsState = "idle";
  updateGpsUi();
  updateDistanceUi();
  
  debugLog("[BLE] Disconnect cleanup complete");
});

#### 11. Add RX Auto Button to HTML

**File**: `index.html`

UPDATE ping controls section:

<div id="pingControls" class="w-full flex gap-2">
  <button id="txPingBtn"
    class="flex-1 min-w-0 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed">
    TX Ping
  </button>
  <button id="txRxAutoBtn"
    class="flex-1 min-w-0 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white disabled: opacity-40 disabled:cursor-not-allowed">
    TX/RX Auto
  </button>
  <button id="rxAutoBtn"
    class="flex-1 min-w-0 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white disabled: opacity-40 disabled:cursor-not-allowed">
    RX Auto
  </button>
</div>

#### 12. Add RX Auto Button Event Listener

**File**: `content/wardrive.js` (in onLoad function)

ADD event listener for RX Auto button: 

export async function onLoad() {
  // ... existing initialization ... 
  
  // Existing button listeners
  connectBtn.addEventListener("click", async () => { /* ... */ });
  txPingBtn.addEventListener("click", () => { /* ... */ });
  txRxAutoBtn.addEventListener("click", () => { /* ... */ });
  
  // NEW: RX Auto button listener
  rxAutoBtn.addEventListener("click", () => {
    debugLog("[UI] RX Auto button clicked");
    if (state.rxAutoRunning) {
      stopRxAuto();
    } else {
      startRxAuto();
    }
  });
  
  // ... rest of initialization ...
}

#### 13. Add RX Auto Debug Tag to Documentation

**File**: `docs/DEVELOPMENT_REQUIREMENTS.md`

ADD to debug tag table:

| Tag | Description |
|-----|-------------|
| `[TX/RX AUTO]` | TX/RX Auto mode operations |
| `[RX AUTO]` | RX Auto mode operations |

#### 14. Update Status Messages Documentation

**File**: `docs/STATUS_MESSAGES.md`

ADD RX Auto status messages:

##### RX Auto started
- **Message**: "RX Auto started"
- **Color**: Green (success)
- **When**: User clicks "RX Auto" button to start passive RX-only listening
- **Source**: `content/wardrive.js:startRxAuto()`

##### RX Auto stopped
- **Message**: "RX Auto stopped"
- **Color**: Slate (idle)
- **When**: User clicks "Stop RX" button
- **Source**: `content/wardrive.js:stopRxAuto()`

##### Lost focus, RX Auto stopped
- **Message**:  "Lost focus, RX Auto stopped"
- **Color**:  Amber (warning)
- **When**: Browser tab hidden while RX Auto mode running
- **Source**: `content/wardrive.js:visibilitychange handler`

UPDATE existing status messages: 
- "Lost focus, auto mode stopped" → "Lost focus, TX/RX Auto stopped"
- "Auto mode stopped" → "TX/RX Auto stopped"

#### 15. Update Workflow Documentation

**File**: `docs/PING_WORKFLOW.md`

ADD new section "RX Auto Mode Workflow":

## RX Auto Mode Workflow

### Overview
RX Auto mode provides passive-only wardriving without transmitting on the mesh network. It listens for all mesh traffic and logs received packets to the RX Log, which are then batched and posted to MeshMapper API.

### RX Auto Start Sequence
1. User clicks "RX Auto" button
2. Verify BLE connection active
3. Defensive check: ensure unified listener running
4. Set `state.rxTracking.isWardriving = true`
5. Set `state.rxAutoRunning = true`
6. Update button to "Stop RX" (amber)
7. Disable TX/RX Auto button (mutual exclusivity)
8. Acquire wake lock
9. Show "RX Auto started" status (green)

### RX Auto Stop Sequence
1. User clicks "Stop RX" button
2. Set `state.rxTracking.isWardriving = false`
3. Set `state.rxAutoRunning = false`
4. Update button to "RX Auto" (indigo)
5. Re-enable TX/RX Auto button
6. Release wake lock
7. Show "RX Auto stopped" status (idle)

### RX Auto Characteristics
- **Zero mesh TX** (no network impact)
- **No GPS requirement** to start
- **No cooldown restrictions**
- **Mutually exclusive** with TX/RX Auto mode
- **Unified listener stays on** (does not stop when mode stops)

### Behavior Comparison

| Feature | TX Ping | TX/RX Auto | RX Auto |
|---------|---------|------------|---------|
| Transmits | Yes (once) | Yes (auto) | No |
| TX Echo Tracking | Yes (7s) | Yes (per ping) | No |
| RX Wardriving | No | Yes | Yes |
| Mesh Load | Low | High | None |
| Cooldown | Yes (7s) | Yes (7s) | No |
| GPS Required | Yes | Yes | No |
| Wake Lock | No | Yes | Yes |
| Unified Listener | Always on | Always on | Always on |
| TX Tracking Flag | True (7s) | True (per ping) | False |
| RX Wardriving Flag | False | True | True |

### Validation Requirements
- Unified listener must start on connect and stay on entire connection
- Unified listener only stops on disconnect
- RX wardriving flag controls whether packets are logged
- TX/RX Auto and RX Auto are mutually exclusive
- All logs cleared on connect, preserved on disconnect
- Defensive checks ensure listener stays active
- startUnifiedRxListening() is idempotent (safe to call multiple times)

---

## Development Guidelines Compliance

### Debug Logging
- **ALWAYS** include debug logging for significant operations
- Use proper debug tags: 
  - `[RX PARSE]` for metadata parsing
  - `[TX LOG]` for TX logging operations (renamed from [SESSION LOG])
  - `[RX LOG]` for RX logging operations (renamed from [PASSIVE RX])
  - `[TX/RX AUTO]` for TX/RX Auto mode (renamed from [AUTO])
  - `[RX AUTO]` for RX Auto mode (new)
  - `[UNIFIED RX]` for unified listener operations
- Log at key points:  function entry, state changes, routing decisions, errors

### Status Messages
- Update `STATUS_MESSAGES.md` with all new status messages
- Use `setDynamicStatus()` for all UI status updates
- Use appropriate `STATUS_COLORS` constants

### Documentation Updates
When modifying connection, disconnect, or ping logic: 
- Read relevant workflow docs before making changes
- Update workflow docs to remain accurate after changes
- Document new modes, states, behaviors
- Update function references, state variables, button labels

### Code Comments
- Document complex logic with inline comments
- Use JSDoc-style comments for new functions
- Update existing JSDoc when function signatures change
- Explain defensive checks and idempotent patterns

---

## Testing Recommendations

Since this is a browser-based PWA with no automated tests, perform thorough manual testing:

### Connection Testing
- [ ] Connect to device - unified listener starts immediately
- [ ] Check debug log confirms listener started
- [ ] Verify all logs cleared on connect
- [ ] Disconnect - listener stops
- [ ] Reconnect - listener restarts

### TX Ping Testing
- [ ] Single TX Ping works
- [ ] TX log shows echoes
- [ ] Debug data shows correct parsed_path
- [ ] RX wardriving stays OFF during TX Ping

### TX/RX Auto Testing
- [ ] Start TX/RX Auto - both TX and RX wardriving active
- [ ] TX pings send automatically
- [ ] RX observations logged continuously
- [ ] RX Auto button disabled during TX/RX Auto
- [ ] Stop TX/RX Auto - both modes stop, listener stays on
- [ ] Unified listener still receiving events

### RX Auto Testing
- [ ] Start RX Auto - only RX wardriving active
- [ ] No TX transmissions
- [ ] RX observations logged continuously
- [ ] TX/RX Auto button disabled during RX Auto
- [ ] Stop RX Auto - RX wardriving stops, listener stays on
- [ ] Unified listener still receiving events

### Mutual Exclusivity Testing
- [ ] Cannot start TX/RX Auto when RX Auto running
- [ ] Cannot start RX Auto when TX/RX Auto running
- [ ] Buttons properly disabled/enabled

### Edge Case Testing
- [ ] Switch browser tab away - modes stop, listener stays on
- [ ] Switch browser tab back - listener still active
- [ ] Disconnect during TX/RX Auto - clean shutdown
- [ ] Disconnect during RX Auto - clean shutdown
- [ ] Multiple connect/disconnect cycles - no memory leaks

### Debug Mode Testing (with `? debug=true`)
- [ ] TX debug data shows correct parsed_path (actual raw bytes)
- [ ] RX debug data shows correct parsed_path (actual raw bytes)
- [ ] parsed_path matches repeaterId for TX (first hop)
- [ ] parsed_path matches repeaterId for RX (last hop)

### Log Clearing Testing
- [ ] All logs clear on connect
- [ ] All logs preserved on disconnect
- [ ] User can review RX data after disconnecting

---

## Summary

This comprehensive refactor accomplishes three major improvements:

1. **Unified RX Parsing**: Single parsing point eliminates duplication, improves performance, and fixes debug data accuracy
2. **Naming Standardization**: Consistent TX/RX terminology throughout codebase improves maintainability and clarity
3. **RX Auto Mode**:  New passive-only wardriving mode with always-on unified listener architecture

**Key architectural changes**:
- Unified RX listener always on when connected (never stops for mode changes)
- RX wardriving controlled by subscription flag (not listener lifecycle)
- Three distinct modes: TX Ping (manual), TX/RX Auto (active + passive), RX Auto (passive only)
- Defensive checks ensure listener stays active across edge cases
- Single metadata parsing eliminates duplication and inconsistency

**User-facing improvements**:
- Clear TX/RX button labels
- New RX Auto mode for zero-impact wardriving
- Consistent log naming (TX Log, RX Log)
- Logs preserved on disconnect for review

**Developer improvements**:
- Consistent naming conventions
- Single source of truth for packet parsing
- Idempotent functions prevent double-initialization
- Comprehensive debug logging
- Well-documented behavior
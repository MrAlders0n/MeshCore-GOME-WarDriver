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

<< Requested Changes go here >>
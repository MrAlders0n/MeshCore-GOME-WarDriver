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
  - Manual ping flow (`sendPing()` with `manual=true`)
  - Auto ping flow (`startAutoPing()`, `stopAutoPing()`, `scheduleNextAutoPing()`)
  - Ping validation logic (geofence, distance, cooldown checks)
  - GPS coordinate acquisition for pings (`getGpsCoordinatesForPing()`)
  - Payload construction (`buildPayload()`, power settings)
  - Repeater tracking logic (`startRepeaterTracking()`, `stopRepeaterTracking()`, `handleRxLogEvent()`)
  - MeshMapper API posting (`postToMeshMapperAPI()`)
  - Control locking behavior (`state.pingInProgress`, `updateControlsForCooldown()`)
  - Cooldown management (`startCooldown()`, `isInCooldown()`)
  - Auto countdown timer logic (pause, resume, skip reasons)
  - Ping interval configuration (15s/30s/60s)
  - Wake lock management during auto mode
  - Page visibility handling during auto mode
  - Any UI impacts (buttons, status messages, countdown displays)

---
## Requested Change: Update App Connection Flow (Reorder Steps)

### Background
Below is the **current** app connection flow used when a user connects to a device for wardriving.

#### Current Connection Flow
1. **User Initiates** → User clicks **Connect**
2. **Device Selection** → Browser displays BLE device picker
3. **BLE GATT Connection** → App establishes a GATT connection to the selected device
4. **Protocol Handshake** → App and device exchange/confirm protocol version compatibility
5. **Device Info** → App retrieves device metadata (e.g., device name, public key, settings)
6. **Time Sync** → App synchronizes the device clock
7. **Channel Setup** → App creates or finds the `#wardriving` channel
8. **GPS Init** → App starts GPS tracking
9. **Capacity Check** → App acquires an API slot from **MeshMapper**
10. **Connected** → App enables all controls; system is ready for wardriving

---

### Requested Change

<< Requested Changes go here >>
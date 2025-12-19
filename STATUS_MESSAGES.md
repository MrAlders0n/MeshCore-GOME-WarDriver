# Status Messages Documentation

This document provides a comprehensive inventory of all status messages displayed in the MeshCore Wardrive web application.

## Overview

All status messages enforce a **minimum visibility duration of 500ms** to ensure readability. This applies to non-timed messages. Countdown timers respect this minimum for their first display, but subsequent updates occur immediately.

## Standardization Rules

Status messages follow these consistent conventions:
- **No trailing punctuation** (no ellipsis or periods for short statuses)
- **Sentence case** capitalization
- **Present progressive tense** (-ing) for ongoing actions
- **Past tense** for completed actions
- **Concise and readable** phrasing

---

## Status Messages by Category

### 1. Connection Status Messages

#### Connecting
- **Message**: `"Connecting"`
- **Color**: Sky blue (info)
- **Used in**: `connect()`
- **Source**: `content/wardrive.js:1916`
- **Context**: When user clicks Connect button
- **Minimum Visibility**: Natural async timing during BLE pairing (typically 2-5 seconds)

#### Connected
- **Message**: `"Connected"`
- **Color**: Green (success)
- **Used in**: `connect()`
- **Source**: `content/wardrive.js:1926`
- **Context**: After BLE device successfully pairs
- **Minimum Visibility**: 500ms minimum enforced

#### Disconnecting
- **Message**: `"Disconnecting"`
- **Color**: Sky blue (info)
- **Used in**: `disconnect()`
- **Source**: `content/wardrive.js:1988`
- **Context**: When user clicks Disconnect button
- **Minimum Visibility**: 500ms minimum enforced

#### Disconnected
- **Message**: `"Disconnected"`
- **Color**: Red (error)
- **Used in**: `connect()`, `disconnect()`, event handlers
- **Source**: `content/wardrive.js:1950`, `content/wardrive.js:2046`
- **Context**: Initial state and when BLE device disconnects
- **Minimum Visibility**: N/A (persists until connection is established)

#### Connection failed
- **Message**: `"Connection failed"` (or error message)
- **Color**: Red (error)
- **Used in**: `connect()`, event handlers
- **Source**: `content/wardrive.js:1976`, `content/wardrive.js:2059`
- **Context**: BLE connection fails or connection button error
- **Minimum Visibility**: N/A (error state persists)

#### Channel setup failed
- **Message**: `"Channel setup failed"` (or error message)
- **Color**: Red (error)
- **Used in**: `connect()`
- **Source**: `content/wardrive.js:1944`
- **Context**: Channel creation or lookup fails during connection
- **Minimum Visibility**: N/A (error state persists)

#### Disconnect failed
- **Message**: `"Disconnect failed"` (or error message)
- **Color**: Red (error)
- **Used in**: `disconnect()`
- **Source**: `content/wardrive.js:2018`
- **Context**: Error during disconnect operation
- **Minimum Visibility**: N/A (error state persists)

---

### 2. Ping Operation Messages

#### Sending manual ping
- **Message**: `"Sending manual ping"`
- **Color**: Sky blue (info)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1655`, `content/wardrive.js:1662`
- **Context**: When ping button clicked
- **Minimum Visibility**: 500ms minimum enforced

#### Sending auto ping
- **Message**: `"Sending auto ping"`
- **Color**: Sky blue (info)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1659`
- **Context**: Auto ping triggers
- **Minimum Visibility**: 500ms minimum enforced

#### Ping sent
- **Message**: `"Ping sent"`
- **Color**: Green (success)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1749`
- **Context**: After successful ping transmission to mesh device (both manual and auto pings)
- **Minimum Visibility**: 500ms minimum enforced
- **Notes**: Consolidated from separate "Ping sent" and "Auto ping sent" messages

#### Ping failed
- **Message**: `"Ping failed"` (or error message)
- **Color**: Red (error)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1805`
- **Context**: Ping operation encounters an error
- **Minimum Visibility**: N/A (error state persists)

#### Ping skipped, outside of geofenced region
- **Message**: `"Ping skipped, outside of geofenced region"`
- **Color**: Amber (warning)
- **Used in**: `sendPing()`, `autoCountdownTimer`
- **Source**: `content/wardrive.js:1688`, `content/wardrive.js:297`
- **Context**: GPS coordinates outside Ottawa 150km radius
- **Minimum Visibility**: 500ms minimum enforced

#### Ping skipped, too close to last ping
- **Message**: `"Ping skipped, too close to last ping"`
- **Color**: Amber (warning)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1708`
- **Context**: Current location < 25m from last successful ping
- **Minimum Visibility**: 500ms minimum enforced

#### Wait Xs before sending another ping
- **Message**: `"Wait Xs before sending another ping"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **Used in**: `sendPing()`
- **Source**: `content/wardrive.js:1646`
- **Context**: User attempts manual ping during 7-second cooldown
- **Minimum Visibility**: 500ms minimum enforced

---

### 3. GPS Status Messages

#### Waiting for GPS fix
- **Message**: `"Waiting for GPS fix"`
- **Color**: Amber (warning)
- **Used in**: `getGpsCoordinatesForPing()`
- **Source**: `content/wardrive.js:1503`
- **Context**: Auto ping triggered but no GPS lock acquired yet
- **Minimum Visibility**: 500ms minimum enforced

#### GPS data too old, requesting fresh position
- **Message**: `"GPS data too old, requesting fresh position"`
- **Color**: Amber (warning)
- **Used in**: `getGpsCoordinatesForPing()`
- **Source**: `content/wardrive.js:1514`, `content/wardrive.js:1567`
- **Context**: GPS data is stale and needs refresh (used in both auto and manual ping modes)
- **Minimum Visibility**: 500ms minimum enforced

---

### 4. Countdown Timer Messages

These messages use a hybrid approach: **first display respects 500ms minimum**, then updates occur immediately every second.

#### Listening for heard repeats (Xs)
- **Message**: `"Listening for heard repeats (Xs)"` (X is dynamic countdown)
- **Color**: Sky blue (info)
- **Used in**: `rxListeningCountdownTimer`
- **Source**: `content/wardrive.js:328`
- **Context**: After successful ping, listening for repeater echoes
- **Duration**: 7 seconds total
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates

#### Finalizing heard repeats
- **Message**: `"Finalizing heard repeats"`
- **Color**: Sky blue (info)
- **Used in**: `rxListeningCountdownTimer`
- **Source**: `content/wardrive.js:325`
- **Context**: Countdown reached 0, processing repeater data
- **Minimum Visibility**: Immediate (countdown update)

#### Waiting for next auto ping (Xs)
- **Message**: `"Waiting for next auto ping (Xs)"` (X is dynamic countdown)
- **Color**: Slate (idle)
- **Used in**: `autoCountdownTimer`
- **Source**: `content/wardrive.js:314`
- **Context**: Auto mode active, between pings
- **Duration**: 15s, 30s, or 60s (user-selectable)
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates

#### Ping skipped, outside of geofenced region, waiting for next ping (Xs)
- **Message**: `"Ping skipped, outside of geofenced region, waiting for next ping (Xs)"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **Used in**: `autoCountdownTimer`
- **Source**: `content/wardrive.js:297`
- **Context**: Auto ping skipped due to geofence, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

#### Ping skipped, too close to last ping, waiting for next ping (Xs)
- **Message**: `"Ping skipped, too close to last ping, waiting for next ping (Xs)"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **Used in**: `autoCountdownTimer`
- **Source**: `content/wardrive.js:303`
- **Context**: Auto ping skipped due to distance check, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

#### Skipped (X), next ping (Ys)
- **Message**: `"Skipped (X), next ping (Ys)"` (X is skip reason, Y is countdown)
- **Color**: Amber (warning)
- **Used in**: `autoCountdownTimer`
- **Source**: `content/wardrive.js:309`
- **Context**: Auto ping skipped for generic reason (e.g., "gps too old"), showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

---

### 5. API and Map Update Messages

#### Posting to API
- **Message**: `"Posting to API"`
- **Color**: Sky blue (info)
- **Used in**: `postApiAndRefreshMap()`
- **Source**: `content/wardrive.js:1055`
- **Context**: After RX listening window, posting ping data to MeshMapper API
- **Timing**: Visible during API POST operation (3-second hidden delay + API call time, typically ~3.5-4.5s total)
- **Minimum Visibility**: 500ms minimum enforced (naturally ~4s due to 3s delay + API timing)
- **Notes**: A 3-second hidden delay occurs before the actual API call to ensure good visibility

#### Idle
- **Message**: `"Idle"`
- **Color**: Slate (idle)
- **Used in**: `postApiAndRefreshMap()`
- **Source**: `content/wardrive.js:1091`
- **Context**: Manual mode, after API post completes
- **Minimum Visibility**: 500ms minimum enforced

---

### 6. Auto Mode Messages

#### Auto mode stopped
- **Message**: `"Auto mode stopped"`
- **Color**: Slate (idle)
- **Used in**: `disconnect()` (event handler for stopping auto mode)
- **Source**: `content/wardrive.js:2070`
- **Context**: User clicks "Stop Auto Ping" button
- **Minimum Visibility**: 500ms minimum enforced

#### Lost focus, auto mode stopped
- **Message**: `"Lost focus, auto mode stopped"`
- **Color**: Amber (warning)
- **Used in**: `disconnect()` (page visibility handler)
- **Source**: `content/wardrive.js:2032`
- **Context**: Browser tab hidden while auto mode running
- **Minimum Visibility**: 500ms minimum enforced

#### Wait Xs before toggling auto mode
- **Message**: `"Wait Xs before toggling auto mode"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **Used in**: `stopAutoPing()`, `startAutoPing()`
- **Source**: `content/wardrive.js:1816`, `content/wardrive.js:1876`
- **Context**: User attempts to toggle auto mode during cooldown period
- **Minimum Visibility**: 500ms minimum enforced

---

## Implementation Details

### Minimum Visibility Enforcement

The `setStatus()` function implements minimum visibility using:

```javascript
const MIN_STATUS_VISIBILITY_MS = 500; // 500ms minimum

function setStatus(text, color, immediate = false) {
  const timeSinceLastSet = Date.now() - statusMessageState.lastSetTime;
  
  // If immediate flag is true (countdown updates), bypass minimum visibility
  if (immediate) {
    applyStatusImmediately(text, color);
    return;
  }
  
  // If 500ms has passed, apply immediately
  if (timeSinceLastSet >= MIN_STATUS_VISIBILITY_MS) {
    applyStatusImmediately(text, color);
    return;
  }
  
  // Otherwise, queue the message with appropriate delay
  const delayNeeded = MIN_STATUS_VISIBILITY_MS - timeSinceLastSet;
  // ... queue message ...
}
```

### Countdown Timer Behavior

Countdown timers use a hybrid approach:
- **First update**: Respects 500ms minimum visibility of previous message
- **Subsequent updates**: Immediate (using `immediate = true` flag)

This ensures that important status messages (like "Ping sent") are visible for at least 500ms before being replaced by countdown timers, while still allowing countdown updates to occur smoothly every second.

### Message Queue Strategy

When multiple messages arrive within the 500ms window:
- Only the **most recent** message is kept in the queue
- Previous queued messages are discarded (last-write-wins)
- This prevents a backlog of stale messages

Example:
```
Time 0ms:   "Message A" displayed
Time 100ms: "Message B" queued (will display at 500ms)
Time 200ms: "Message C" queued (replaces B, will display at 500ms)
Result:     "Message A" (visible 500ms) → "Message C"
```

---

## Summary

**Total Status Messages**: 25 unique message patterns
- **Connection**: 7 messages
- **Ping Operation**: 6 messages (consolidated "Ping sent" for both manual and auto)
- **GPS**: 2 messages
- **Countdown Timers**: 6 message patterns (with dynamic countdown values)
- **API/Map**: 2 messages
- **Auto Mode**: 3 messages

**Minimum Visibility**: All non-countdown messages enforce **500ms minimum visibility**. Countdown messages respect this minimum on first display, then update immediately.

**Standardization**: All messages follow consistent conventions:
- No trailing punctuation
- Sentence case capitalization
- Present progressive tense (-ing) for ongoing actions
- Past tense for completed actions
- Consistent "X failed" format for error messages
- Consistent tone (direct, technical) - removed "Please" from wait messages
- Proper compound words ("geofenced" not "geo fenced")

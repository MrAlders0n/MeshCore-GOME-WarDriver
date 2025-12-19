# Status Messages Documentation

This document provides a comprehensive inventory of all status messages displayed in the MeshCore Wardrive web application, along with their timing characteristics and visibility guarantees.

## Overview

All status messages now enforce a **minimum visibility duration of 500ms** to ensure readability. This applies to non-timed messages. Countdown timers respect this minimum for their first display, but subsequent updates occur immediately.

## Status Message Categories

### 1. Connection Status Messages

#### Disconnected
- **Message**: `"Disconnected"`
- **Color**: Red (error)
- **Location**: `wardrive.js:1929`, `wardrive.js:1833`
- **Timing**: Persists until connection is established
- **Context**: Initial state and when BLE device disconnects
- **Minimum Visibility**: N/A (persists until replaced by user action)

#### Connecting
- **Message**: `"Connecting…"`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:1799`
- **Timing**: Natural async timing during BLE pairing
- **Context**: When user clicks Connect button
- **Minimum Visibility**: Governed by BLE connection time (typically 2-5 seconds)

#### Connected
- **Message**: `"Connected"`
- **Color**: Green (success)
- **Location**: `wardrive.js:1809`
- **Timing**: Natural async timing after successful connection
- **Context**: After BLE device successfully pairs
- **Minimum Visibility**: 500ms minimum enforced

#### Disconnecting
- **Message**: `"Disconnecting..."`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:1871`
- **Timing**: Brief during disconnect operation
- **Context**: When user clicks Disconnect button
- **Minimum Visibility**: 500ms minimum enforced

#### Connection Errors
- **Message**: `"Failed to connect"` or error message
- **Color**: Red (error)
- **Location**: `wardrive.js:1859`, `wardrive.js:1942`
- **Timing**: Persists until user takes action
- **Context**: BLE connection fails
- **Minimum Visibility**: N/A (error state persists)

---

### 2. Ping Operation Messages

#### Sending Ping
- **Message**: `"Sending manual ping..."` or `"Sending auto ping..."`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:1555`, `wardrive.js:1559`, `wardrive.js:1562`
- **Timing**: Brief, displayed during GPS acquisition and validation
- **Context**: Immediately when ping button clicked or auto ping triggers
- **Minimum Visibility**: 500ms minimum enforced

#### Ping Sent (Primary Issue Fixed)
- **Message**: `"Ping sent"` or `"Auto ping sent"`
- **Color**: Green (success)
- **Location**: `wardrive.js:1724`
- **Timing**: **Now visible for ≥500ms** (previously ~100ms)
- **Context**: After successful ping transmission to mesh device
- **Minimum Visibility**: **500ms minimum enforced** ✅
- **Notes**: This was the primary message mentioned in the issue as flashing too quickly

#### Ping Validation Failures
- **Message**: `"Ping skipped, outside of geo fenced region"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1588`
- **Timing**: Persists until next ping attempt (manual) or shows in countdown (auto)
- **Context**: GPS coordinates outside Ottawa 150km radius
- **Minimum Visibility**: 500ms minimum enforced

- **Message**: `"Ping skipped, too close to last ping"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1608`
- **Timing**: Persists until next ping attempt
- **Context**: Current location < 25m from last successful ping
- **Minimum Visibility**: 500ms minimum enforced

#### Cooldown Messages
- **Message**: `"Please wait Xs before sending another ping"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1546`
- **Timing**: Shows remaining cooldown seconds
- **Context**: User attempts manual ping during 7-second cooldown
- **Minimum Visibility**: 500ms minimum enforced

- **Message**: `"Please wait Xs before toggling auto mode"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1699`, `wardrive.js:1759`
- **Timing**: Shows remaining cooldown seconds
- **Context**: User attempts to toggle auto mode during cooldown
- **Minimum Visibility**: 500ms minimum enforced

---

### 3. GPS Status Messages

#### GPS Acquisition
- **Message**: `"Waiting for GPS fix..."`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1403`
- **Timing**: Persists until GPS lock acquired
- **Context**: Auto ping triggered but no GPS fix available yet
- **Minimum Visibility**: 500ms minimum enforced

#### GPS Stale Data
- **Message**: `"GPS data old, trying to refresh position"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1414`
- **Timing**: Brief during GPS refresh attempt
- **Context**: Auto ping with stale GPS data, attempting refresh
- **Minimum Visibility**: 500ms minimum enforced

- **Message**: `"GPS data too old, requesting fresh position"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1467`
- **Timing**: Brief during GPS acquisition
- **Context**: Manual ping with stale GPS data
- **Minimum Visibility**: 500ms minimum enforced

---

### 4. Countdown Timer Messages

These messages use a hybrid approach: **first display respects 500ms minimum**, then updates occur immediately every second.

#### RX Listening Countdown
- **Message**: `"Listening for heard repeats (Xs)"`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:313` (countdown definition)
- **Timing**: 
  - **First display**: Respects 500ms minimum after "Ping sent"
  - **Updates**: Immediate every 1 second (7s → 6s → 5s → ...)
- **Context**: After successful ping, listening for repeater echoes
- **Duration**: 7 seconds total
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates

- **Message**: `"Finalizing heard repeats..."`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:310`
- **Timing**: Displays at end of 7-second window
- **Context**: Countdown reached 0, processing repeater data
- **Minimum Visibility**: Immediate (countdown update)

#### Auto Ping Countdown
- **Message**: `"Waiting for next auto ping (Xs)"`
- **Color**: Slate (idle)
- **Location**: `wardrive.js:299`
- **Timing**:
  - **First display**: Respects 500ms minimum
  - **Updates**: Immediate every 1 second
- **Context**: Auto mode active, between pings
- **Duration**: 15s, 30s, or 60s (user-selectable)
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates

- **Message**: `"Sending auto ping..."`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:278`
- **Timing**: Brief before auto ping execution
- **Context**: Auto countdown reaches 0
- **Minimum Visibility**: Immediate (countdown update at 0)

#### Auto Ping Countdown with Skip Reason
- **Message**: `"Ping skipped, outside of geo fenced region, waiting for next ping (Xs)"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:210`
- **Timing**: Updates every 1 second during countdown
- **Context**: Auto ping skipped due to geofence, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

- **Message**: `"Ping skipping, too close to last ping, waiting for next ping (Xs)"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:216`
- **Timing**: Updates every 1 second during countdown
- **Context**: Auto ping skipped due to distance check, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

- **Message**: `"Skipped (gps too old), next ping (Xs)"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:222`
- **Timing**: Updates every 1 second during countdown
- **Context**: Auto ping skipped due to GPS staleness, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates

---

### 5. API and Map Update Messages

#### Posting to API
- **Message**: `"Posting to API"`
- **Color**: Sky blue (info)
- **Location**: `wardrive.js:1037`
- **Timing**: Visible during API POST operation (typically ~500-1500ms)
- **Context**: After RX listening window, posting ping data to MeshMapper API
- **Minimum Visibility**: 500ms minimum enforced (naturally ~1000ms due to API timing)

#### Idle State
- **Message**: `"Idle"`
- **Color**: Slate (idle)
- **Location**: `wardrive.js:1070`
- **Timing**: Persists until next operation
- **Context**: Manual mode, after API post completes
- **Minimum Visibility**: 500ms minimum enforced

---

### 6. Channel and Setup Messages

#### Channel Setup
- **Message**: Error message from channel setup failure
- **Color**: Red (error)
- **Location**: `wardrive.js:1827`
- **Timing**: Persists until user takes action
- **Context**: Channel creation or lookup fails during connection
- **Minimum Visibility**: N/A (error state persists)

---

### 7. Page Visibility Messages

#### Lost Focus
- **Message**: `"Lost focus, auto mode stopped"`
- **Color**: Amber (warning)
- **Location**: `wardrive.js:1915`
- **Timing**: Persists until page regains focus
- **Context**: Browser tab hidden while auto mode running
- **Minimum Visibility**: 500ms minimum enforced

---

### 8. Auto Mode Toggle Messages

#### Auto Mode Stopped
- **Message**: `"Auto mode stopped"`
- **Color**: Slate (idle)
- **Location**: `wardrive.js:1953`
- **Timing**: Brief confirmation message
- **Context**: User clicks "Stop Auto Ping" button
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

## Testing

To test status message visibility:
1. Connect to a MeshCore device via Bluetooth
2. Observe "Connected" message remains visible for ≥500ms
3. Click "Send Ping" button
4. Verify "Ping sent" message is visible for ≥500ms before "Listening for heard repeats" appears
5. Observe countdown updates occur immediately (7s → 6s → 5s...)
6. In auto mode, verify countdown messages update every second without delay

---

## Summary

**Total Status Messages**: 26 unique message patterns
- **Connection**: 6 messages
- **Ping Operation**: 5 messages
- **GPS**: 3 messages
- **Countdown Timers**: 6 message patterns (with dynamic countdown values)
- **API/Map**: 2 messages
- **Channel Setup**: 1 message category
- **Page Visibility**: 1 message
- **Auto Mode**: 2 messages

**Minimum Visibility**: All non-countdown messages enforce **500ms minimum visibility**. Countdown messages respect this minimum on first display, then update immediately.

**Primary Fix**: The "Ping sent" message (the example in the original issue) now remains visible for **at least 500ms** before being replaced by "Listening for heard repeats".

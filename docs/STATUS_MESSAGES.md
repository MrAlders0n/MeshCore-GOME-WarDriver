# Status Messages Documentation

This document provides a comprehensive inventory of all status messages displayed in the MeshCore Wardrive web application.

## Overview

The application uses **two independent status bars**:

1. **Connection Status Bar** (`#connectionStatus`) - Shows connection state ONLY
2. **Dynamic App Status Bar** (`#status`) - Shows all non-connection operational messages

All dynamic status messages enforce a **minimum visibility duration of 500ms** to ensure readability. This applies to non-timed messages. Countdown timers respect this minimum for their first display, but subsequent updates occur immediately.

---

## Two-Bar System

### Connection Status Bar (`#connectionStatus`)
- **Purpose**: Display ONLY the connection state of the BLE device
- **Location**: Top status bar with status indicator dot
- **Messages**: Exactly **four fixed states** (see below)
- **Behavior**: Updates immediately (no minimum visibility delay)
- **Controlled by**: `setConnStatus(text, color)` function

### Dynamic App Status Bar (`#status`)
- **Purpose**: Display all operational messages EXCEPT connection state
- **Location**: Status message box below connection bar
- **Messages**: All progress, error, countdown, and informational messages
- **Behavior**: 500ms minimum visibility for first display, immediate for countdown updates
- **Placeholder**: Shows em dash (`—`) when no message is present
- **Protection**: Connection words (Connected/Connecting/Disconnecting/Disconnected) are blocked
- **Controlled by**: `setDynamicStatus(text, color, immediate)` function

---

## Connection Status Bar Messages

These **four messages** are the ONLY messages that appear in the Connection Status Bar:

### Connected
- **Message**: `"Connected"`
- **Color**: Green (success)
- **When**: Device is fully connected and ready for wardriving after complete workflow:
  1. User clicks Connect
  2. BLE GATT connection established
  3. Protocol handshake complete
  4. Device info retrieved
  5. Time sync complete
  6. Capacity check passed (API slot acquired)
  7. Channel setup complete (#wardriving found or created)
  8. GPS initialization complete
  9. **Then "Connected" is shown**
- **Source**: `content/wardrive.js` - `connect()` function after GPS init

### Connecting
- **Message**: `"Connecting"`
- **Color**: Sky blue (info)
- **When**: During the ENTIRE connection process from step 1 (user clicks Connect) through step 8 (GPS init in progress)
- **Duration**: Remains visible until GPS init completes successfully
- **Source**: `content/wardrive.js` - `connect()` function at start

### Disconnected
- **Message**: `"Disconnected"`
- **Color**: Red (error)
- **When**: 
  - Initial state when app loads
  - After disconnect sequence completes
  - After BLE connection is lost
- **Source**: `content/wardrive.js` - BLE disconnected event handler

### Disconnecting
- **Message**: `"Disconnecting"`
- **Color**: Sky blue (info)
- **When**: During the ENTIRE disconnection process:
  1. User clicks Disconnect (or error triggers disconnect)
  2. Disconnect function called
  3. Capacity slot released (API call)
  4. Channel deleted from device
  5. BLE GATT disconnected
  6. Cleanup operations (timers, GPS, wake locks)
  7. State reset
  8. **Then "Disconnected" is shown**
- **Source**: `content/wardrive.js` - `disconnect()` function

---

## Dynamic App Status Bar Messages

These messages appear in the Dynamic App Status Bar. They NEVER include connection state words.

### Message Categories

#### 1. Capacity Check Messages

##### BLE Connection Started
- **Message**: `"BLE Connection Started"`
- **Color**: Sky blue (info)
- **When**: At the beginning of the BLE connection process, before device selection dialog appears
- **Source**: `content/wardrive.js:connect()`

##### Acquiring wardriving slot
- **Message**: `"Acquiring wardriving slot"`
- **Color**: Sky blue (info)
- **When**: During connection, after time sync, checking with MeshMapper API for slot availability
- **Source**: `content/wardrive.js:checkCapacity()`

##### Acquired wardriving slot
- **Message**: `"Acquired wardriving slot"`
- **Color**: Green (success)
- **When**: Capacity check passed successfully, slot acquired from MeshMapper API
- **Source**: `content/wardrive.js:connect()`

##### WarDriving app has reached capacity
- **Message**: `"WarDriving app has reached capacity"`
- **Color**: Red (error)
- **When**: Capacity check API denies slot on connect (returns allowed=false)
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "WarDriving app has reached capacity" (terminal)

##### WarDriving app is down
- **Message**: `"WarDriving app is down"`
- **Color**: Red (error)
- **When**: Capacity check API returns error status or network is unreachable during connect
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Implements fail-closed policy - connection denied if API fails. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "WarDriving app is down" (terminal)

##### WarDriving slot has been revoked
- **Message**: `"WarDriving slot has been revoked"`
- **Color**: Red (error)
- **When**: During active session, API returns allowed=false during ping posting
- **Terminal State**: Yes (persists until user takes action)
- **Sequence**: 
  1. "Posting to API" (blue)
  2. "Error: Posting to API (Revoked)" (red, 1.5s)
  3. Connection bar: "Disconnecting" → "Disconnected"
  4. Dynamic bar: "WarDriving slot has been revoked" (terminal)

##### Error: Posting to API (Revoked)
- **Message**: `"Error: Posting to API (Revoked)"`
- **Color**: Red (error)
- **When**: Intermediate status shown when slot revocation detected during API posting
- **Duration**: 1.5 seconds (visible before disconnect begins)
- **Notes**: First status in revocation sequence, followed by disconnect flow

##### Unable to read device public key; try again
- **Message**: `"Unable to read device public key; try again"`
- **Color**: Red (error)
- **When**: Device public key is missing or invalid during connection
- **Terminal State**: Yes
- **Notes**: Triggers automatic disconnect

##### Session ID error; try reconnecting
- **Message**: `"Session ID error; try reconnecting"`
- **Color**: Red (error)
- **When**: 
  - Capacity check returns allowed=true but session_id is missing during connection
  - Attempting to post to MeshMapper API without a valid session_id
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Implements fail-closed policy - connection/posting denied if session_id is missing. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "Session ID error; try reconnecting" (terminal)
- **Source**: `content/wardrive.js:checkCapacity()`, `content/wardrive.js:postToMeshMapperAPI()`

##### Error: No session ID for API post
- **Message**: `"Error: No session ID for API post"`
- **Color**: Red (error)
- **When**: Intermediate status shown when attempting to post to MeshMapper API without a valid session_id
- **Duration**: 1.5 seconds (visible before disconnect begins)
- **Notes**: First status in session_id error sequence during API posting, followed by disconnect flow
- **Source**: `content/wardrive.js:postToMeshMapperAPI()`

#### 2. Channel Setup Messages

##### Looking for #wardriving channel
- **Message**: `"Looking for #wardriving channel"`
- **Color**: Sky blue (info)
- **When**: During connection setup, after capacity check, searching for existing channel
- **Source**: `content/wardrive.js:ensureChannel()`

##### Channel #wardriving found
- **Message**: `"Channel #wardriving found"`
- **Color**: Green (success)
- **When**: Existing #wardriving channel found on device
- **Source**: `content/wardrive.js:ensureChannel()`

##### Channel #wardriving not found
- **Message**: `"Channel #wardriving not found"`
- **Color**: Sky blue (info)
- **When**: Channel does not exist, will attempt to create it
- **Source**: `content/wardrive.js:ensureChannel()`

##### Created #wardriving
- **Message**: `"Created #wardriving"`
- **Color**: Green (success)
- **When**: Successfully created new #wardriving channel on device
- **Source**: `content/wardrive.js:ensureChannel()`

#### 3. GPS Initialization Messages

##### Priming GPS
- **Message**: `"Priming GPS"`
- **Color**: Sky blue (info)
- **When**: Starting GPS initialization during connection setup (after channel setup)
- **Source**: `content/wardrive.js:connect()`

##### GPS error - check permissions
- **Message**: `"GPS error - check permissions"`
- **Color**: Red (error)
- **When**: GPS geolocation watch encounters an error or GPS permission is denied
- **Terminal State**: Depends on context (persists until GPS is re-enabled or permissions granted)
- **Notes**: This error is displayed in the Dynamic Status Bar. The GPS section in the map overlay remains empty (shows "-") until valid coordinates are available. This ensures GPS errors are not shown in the GPS block itself.
- **Source**: `content/wardrive.js:startGeoWatch()`, `primeGpsOnce()`

##### Waiting for GPS fix
- **Message**: `"Waiting for GPS fix"`
- **Color**: Amber (warning)
- **When**: Auto ping triggered but no GPS lock acquired yet
- **Source**: `content/wardrive.js:getGpsCoordinatesForPing()`

##### GPS data too old, requesting fresh position
- **Message**: `"GPS data too old, requesting fresh position"`
- **Color**: Amber (warning)
- **When**: GPS data is stale and needs refresh (auto or manual ping modes)
- **Source**: `content/wardrive.js:getGpsCoordinatesForPing()`

#### 4. Ping Operation Messages

##### Sending manual ping
- **Message**: `"Sending manual ping"`
- **Color**: Sky blue (info)
- **When**: User clicks "Send Ping" button
- **Source**: `content/wardrive.js:sendPing()`

##### Sending auto ping
- **Message**: `"Sending auto ping"`
- **Color**: Sky blue (info)
- **When**: Auto ping timer triggers
- **Source**: `content/wardrive.js:sendPing()`

##### Ping sent
- **Message**: `"Ping sent"`
- **Color**: Green (success)
- **When**: After successful ping transmission to mesh device
- **Minimum Visibility**: 500ms enforced
- **Source**: `content/wardrive.js:sendPing()`

##### Ping failed
- **Message**: `"Ping failed"` or specific error message
- **Color**: Red (error)
- **When**: Ping operation encounters an error
- **Source**: `content/wardrive.js:sendPing()`

##### Ping skipped, outside of geofenced region
- **Message**: `"Ping skipped, outside of geofenced region"`
- **Color**: Amber (warning)
- **When**: GPS coordinates outside Ottawa 150km radius
- **Behavior**: 
  - In manual mode (auto OFF): Message persists until next action
  - In manual mode (auto ON): Message shown briefly, then auto countdown resumes
- **Source**: `content/wardrive.js:sendPing()`

##### Ping skipped, too close to last ping
- **Message**: `"Ping skipped, too close to last ping"`
- **Color**: Amber (warning)
- **When**: Current location < 25m from last successful ping
- **Behavior**: 
  - In manual mode (auto OFF): Message persists until next action
  - In manual mode (auto ON): Message shown briefly, then auto countdown resumes
- **Source**: `content/wardrive.js:sendPing()`

##### Wait Xs before sending another ping
- **Message**: `"Wait Xs before sending another ping"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **When**: User attempts manual ping during 7-second cooldown
- **Source**: `content/wardrive.js:sendPing()`

#### 5. Countdown Timer Messages

These messages use a hybrid approach: **first display respects 500ms minimum**, then updates occur immediately every second.

##### Listening for heard repeats (Xs)
- **Message**: `"Listening for heard repeats (Xs)"` (X is dynamic countdown)
- **Color**: Sky blue (info)
- **When**: After successful ping, listening for repeater echoes
- **Duration**: 7 seconds total
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates
- **Source**: `content/wardrive.js:rxListeningCountdownTimer`

##### Finalizing heard repeats
- **Message**: `"Finalizing heard repeats"`
- **Color**: Sky blue (info)
- **When**: Countdown reached 0, processing repeater data
- **Minimum Visibility**: Immediate (countdown update)
- **Source**: `content/wardrive.js:rxListeningCountdownTimer`

##### Waiting for next auto ping (Xs)
- **Message**: `"Waiting for next auto ping (Xs)"` (X is dynamic countdown)
- **Color**: Slate (idle)
- **When**: Auto mode active, between pings
- **Duration**: 15s, 30s, or 60s (user-selectable)
- **Minimum Visibility**: 500ms for first message, immediate for countdown updates
- **Source**: `content/wardrive.js:autoCountdownTimer`

##### Ping skipped, outside of geofenced region, waiting for next ping (Xs)
- **Message**: `"Ping skipped, outside of geofenced region, waiting for next ping (Xs)"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **When**: Auto ping skipped due to geofence, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates
- **Source**: `content/wardrive.js:autoCountdownTimer`

##### Ping skipped, too close to last ping, waiting for next ping (Xs)
- **Message**: `"Ping skipped, too close to last ping, waiting for next ping (Xs)"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **When**: Auto ping skipped due to distance check, showing countdown
- **Minimum Visibility**: 500ms for first message, immediate for updates
- **Source**: `content/wardrive.js:autoCountdownTimer`

##### Skipped (X), next ping (Ys)
- **Message**: `"Skipped (X), next ping (Ys)"` (X is skip reason, Y is countdown)
- **Color**: Amber (warning)
- **When**: Auto ping skipped for generic reason (e.g., "gps too old")
- **Minimum Visibility**: 500ms for first message, immediate for updates
- **Source**: `content/wardrive.js:autoCountdownTimer`

#### 6. API and Map Update Messages

##### Posting to API
- **Message**: `"Posting to API"`
- **Color**: Sky blue (info)
- **When**: After RX listening window, posting ping data to MeshMapper API
- **Timing**: Visible during API POST operation (3-second hidden delay + API call time, typically ~3.5-4.5s total)
- **Source**: `content/wardrive.js:postApiAndRefreshMap()`

##### — (em dash)
- **Message**: `"—"` (em dash character)
- **Color**: Slate (idle)
- **When**: 
  - Manual mode after API post completes
  - After successful connection (shows "Connected" in connection bar)
  - Normal disconnect (shows "Disconnected" in connection bar)
  - Any time there is no active message to display
- **Purpose**: Placeholder to indicate "no message" state
- **Source**: Multiple locations - `content/wardrive.js`

#### 7. Auto Mode Messages

##### Auto mode stopped
- **Message**: `"Auto mode stopped"`
- **Color**: Slate (idle)
- **When**: User clicks "Stop Auto Ping" button
- **Source**: `content/wardrive.js:autoToggleBtn click handler`

##### Lost focus, auto mode stopped
- **Message**: `"Lost focus, auto mode stopped"`
- **Color**: Amber (warning)
- **When**: Browser tab hidden while auto mode running
- **Source**: `content/wardrive.js:visibilitychange handler`

##### Wait Xs before toggling auto mode
- **Message**: `"Wait Xs before toggling auto mode"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **When**: User attempts to toggle auto mode during cooldown period
- **Source**: `content/wardrive.js:stopAutoPing()`, `startAutoPing()`

#### 8. Error Messages

##### Select radio power to connect
- **Message**: `"Select radio power to connect"`
- **Color**: Amber (warning)
- **When**: On app load or when disconnected, if no radio power option is selected
- **Terminal State**: Yes (persists until radio power is selected)
- **Notes**: Displayed in Dynamic Status Bar as a warning message to guide user that Connect button is disabled. Once radio power is selected, status changes to "Idle" (em dash) and Connect button becomes enabled.
- **Source**: `content/wardrive.js:updateConnectButtonState()`

##### Connection failed
- **Message**: `"Connection failed"` or specific error message
- **Color**: Red (error)
- **When**: BLE connection fails or connection button error
- **Source**: `content/wardrive.js:connect()`, event handlers

---

## Implementation Details

### Status Setter Functions

#### setConnStatus(text, color)
```javascript
/**
 * Set connection status bar message
 * Updates the #connectionStatus element with one of four fixed states
 */
function setConnStatus(text, color) {
  // Updates connection bar immediately (no minimum visibility delay)
  connectionStatusEl.textContent = text;
  connectionStatusEl.className = `font-medium ${color}`;
  // Also updates status indicator dot color
}
```

#### setDynamicStatus(text, color, immediate)
```javascript
/**
 * Set dynamic status bar message
 * Uses 500ms minimum visibility for first display, immediate for countdown updates
 * Blocks connection words and shows em dash for empty messages
 */
function setDynamicStatus(text, color, immediate) {
  // Normalize empty/null/whitespace to em dash
  if (!text || text.trim() === '') {
    text = '—';
  }
  
  // Block connection words from dynamic bar
  const connectionWords = ['Connected', 'Connecting', 'Disconnecting', 'Disconnected'];
  if (connectionWords.includes(text)) {
    debugWarn(`Connection word blocked from dynamic bar`);
    text = '—';
  }
  
  // Use existing setStatus implementation with minimum visibility
  setStatus(text, color, immediate);
}
```

### Minimum Visibility Enforcement

The `setStatus()` function (internal) implements minimum visibility:

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
  // (last-write-wins strategy)
}
```

### Countdown Timer Behavior

Countdown timers use a hybrid approach:
- **First update**: Respects 500ms minimum visibility of previous message
- **Subsequent updates**: Immediate (using `immediate = true` flag)

This ensures important status messages (like "Ping sent") are visible for at least 500ms before being replaced by countdown timers, while allowing smooth countdown updates every second.

---

## Standardization Rules

Status messages follow these consistent conventions:
- **No trailing punctuation** (no ellipsis or periods for short statuses)
- **Sentence case** capitalization
- **Present progressive tense** (-ing) for ongoing actions
- **Past tense** for completed actions
- **Concise and readable** phrasing
- **No "Disconnected:" prefix** - error reasons shown without prefix in dynamic bar

---

## Summary

**Connection Status Bar**: 4 fixed messages (Connected, Connecting, Disconnected, Disconnecting)

**Dynamic App Status Bar**: ~30+ unique message patterns covering:
- Capacity check: 9 messages (including session_id error messages)
- Channel setup: 4 messages
- GPS initialization: 3 messages
- Ping operations: 6 messages
- Countdown timers: 6 message patterns
- API/Map: 2 messages (including em dash placeholder)
- Auto mode: 3 messages
- Errors: Various context-specific messages

**Key Behaviors**:
- Connection bar updates immediately
- Dynamic bar enforces 500ms minimum visibility (except countdown updates)
- Em dash (`—`) placeholder for empty dynamic status
- Connection words blocked from dynamic bar
- All error reasons appear WITHOUT "Disconnected:" prefix

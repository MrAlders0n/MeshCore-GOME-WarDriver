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

##### MeshMapper at capacity
- **Message**: `"MeshMapper at capacity"`
- **Color**: Red (error)
- **When**: Capacity check API denies slot on connect (returns allowed=false)
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "MeshMapper at capacity" (terminal)

##### MeshMapper unavailable
- **Message**: `"MeshMapper unavailable"`
- **Color**: Red (error)
- **When**: Capacity check API returns error status or network is unreachable during connect
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Implements fail-closed policy - connection denied if API fails. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "MeshMapper unavailable" (terminal)

##### MeshMapper slot revoked
- **Message**: `"MeshMapper slot revoked"`
- **Color**: Red (error)
- **When**: During active session, API returns allowed=false during background ping posting
- **Terminal State**: Yes (persists until user takes action)
- **Sequence** (Updated for background API posting): 
  1. RX listening window completes → Status shows "Idle" or "Waiting for next ping"
  2. Background API post detects revocation (silent, no status change yet)
  3. "API post failed (revoked)" (red, 1.5s)
  4. Connection bar: "Disconnecting" → "Disconnected"
  5. Dynamic bar: "MeshMapper slot revoked" (terminal)
- **Notes**: With the new ping/repeat flow, revocation is detected during the background API post (which runs after the RX window completes and next timer starts)

##### API post failed (revoked)
- **Message**: `"API post failed (revoked)"`
- **Color**: Red (error)
- **When**: Intermediate status shown when slot revocation detected during background API posting
- **Duration**: 1.5 seconds (visible before disconnect begins)
- **Notes**: First visible status in revocation sequence, followed by disconnect flow. Appears after background API post detects revocation.

##### Device key error - reconnect
- **Message**: `"Device key error - reconnect"`
- **Color**: Red (error)
- **When**: Device public key is missing or invalid during connection
- **Terminal State**: Yes
- **Notes**: Triggers automatic disconnect

##### Session error - reconnect
- **Message**: `"Session error - reconnect"`
- **Color**: Red (error)
- **When**: 
  - Capacity check returns allowed=true but session_id is missing during connection
  - Attempting to post to MeshMapper API without a valid session_id
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Implements fail-closed policy - connection/posting denied if session_id is missing. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "Session error - reconnect" (terminal)
- **Source**: `content/wardrive.js:checkCapacity()`, `content/wardrive.js:postToMeshMapperAPI()`

##### App out of date, please update
- **Message**: `"App out of date, please update"`
- **Color**: Red (error)
- **When**: Capacity check API denies slot on connect with reason code "outofdate" (returns allowed=false, reason="outofdate")
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Indicates the app version is outdated and needs to be updated. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "App out of date, please update" (terminal). This is part of the extensible reason code system - future reason codes can be added to REASON_MESSAGES mapping.
- **Source**: `content/wardrive.js:checkCapacity()`, `content/wardrive.js` disconnected event handler

##### Connection not allowed: [reason]
- **Message**: `"Connection not allowed: [reason]"` (where [reason] is the API-provided reason code)
- **Color**: Red (error)
- **When**: Capacity check API denies slot on connect with an unknown reason code not defined in REASON_MESSAGES mapping (returns allowed=false, reason="unknown_code")
- **Terminal State**: Yes (persists until user takes action)
- **Notes**: Fallback message for future/unknown reason codes. Shows the raw reason code to help with debugging. Complete flow: Connection bar shows "Connecting" → "Disconnecting" → "Disconnected". Dynamic bar shows "Acquiring wardriving slot" → "Connection not allowed: [reason]" (terminal)
- **Source**: `content/wardrive.js` disconnected event handler

##### Missing session ID
- **Message**: `"Missing session ID"`
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

#### 4. Geo-Auth Zone Check Messages (Phase 4.1 - Preflight UI Only)

**Phase 4.1 Scope**: Zone checks provide **preflight UI feedback** while disconnected. Real validation happens server-side in Phase 4.2+ via `/auth` (connect) and `/wardrive` (ongoing) endpoints.

**Note**: Zone status appears in the **Settings Panel** (`#locationDisplay`) only. Errors (outside zone, outdated app) appear as persistent messages in the **Dynamic Status Bar**.

##### Checking...
- **Message (Settings Panel)**: `"Checking..."`
- **Color**: Gray (slate-400)
- **When** (Phase 4.1 - disconnected mode only): 
  - During app launch zone check (before Connect button enabled)
  - After 100m GPS movement while disconnected triggers zone recheck
- **Source**: `content/wardrive.js:performAppLaunchZoneCheck()`, `handleZoneCheckOnMove()`

##### Zone Code (e.g., YOW)
- **Message (Settings Panel)**: `"YOW"` (or other zone code)
- **Color**: Green (emerald-300) when available, Amber (amber-300) when at capacity
- **When**: Successfully validated location within enabled wardriving zone (Phase 4.1 preflight check)
- **Source**: `content/wardrive.js:updateZoneStatusUI()`

##### Outside zone (distance to nearest)
- **Message (Dynamic Status Bar)**: `"Outside zone (Xkm to CODE)"`
- **Message (Settings Panel)**: `"—"` (dash)
- **Color**: Red (error) - persistent message
- **When**: 
  - **Phase 4.1**: GPS coordinates outside any enabled wardriving zone boundary (preflight check, Connect button disabled)
- **Terminal State**: Yes (Connect button disabled, persistent error blocks other status messages)
- **Source**: `content/wardrive.js:updateZoneStatusUI()`

##### GPS/Zone Errors
- **Message (Settings Panel)**: `"GPS: stale"`, `"GPS: inaccurate"`, `"Unknown"`
- **Color**: Red (error)
- **When** (Phase 4.1 client-side GPS failure): 
  - GPS data too stale (>60s) → "GPS: stale"
  - GPS accuracy too poor (>50m) → "GPS: inaccurate"
  - GPS permissions denied or network error → "Unknown"
- **Terminal State**: Yes (Connect button disabled)
- **Source**: `content/wardrive.js:updateZoneStatusUI()`

##### App Version Outdated
- **Message (Dynamic Status Bar)**: API message or `"App version outdated, please update"`
- **Message (Settings Panel)**: `""` (empty)
- **Color**: Red (error) - persistent message
- **When**: Server returns `reason: "outofdate"` during zone check
- **Terminal State**: Yes (Connect button disabled, persistent error blocks other status messages)
- **Source**: `content/wardrive.js:updateZoneStatusUI()`

**Slot Availability Display** (Settings Panel only):
- **Location**: Settings panel "Status Info" section, Slots row
- **Display Format**:
  - `"N/A"` (gray) - Zone not checked yet or check failed
  - `"X available"` (green) - X slots available in zone
  - `"Full (0/Y)"` (red) - Zone at capacity, Y total slots
- **Update Frequency** (Phase 4.1):
  - 30 seconds while disconnected
  - Immediate when zone check completes
- **Source**: `content/wardrive.js:updateSlotsDisplay()`

**Zone Check Triggers** (Phase 4.1 - disconnected mode only):
1. **App Launch**: Automatic check on page load after GPS permission granted
2. **100m Movement (Disconnected)**: Continuous monitoring during GPS watch while disconnected, triggers recheck if moved ≥100m from last check
3. **30s Slot Refresh (Disconnected)**: Periodic timer updates slot availability while disconnected

**Phase 4.2+ Server-Side Triggers** (not yet implemented):
- `/auth` endpoint validation on connect
- `/wardrive` endpoint validation on every ping with GPS coordinates

**Connect Button Behavior**:
- Disabled initially during app launch zone check
- Enabled only if: `zone.enabled === true` AND `in_zone === true` AND `zone.at_capacity === false`
- Remains disabled on zone check failure or GPS unavailable

#### 6. Ping Operation Messages

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

#### 7. Countdown Timer Messages

These messages use a hybrid approach: **first display respects 500ms minimum**, then updates occur immediately every second.

##### Listening for heard repeats (Xs)
- **Message**: `"Listening for heard repeats (Xs)"` (X is dynamic countdown)
- **Color**: Sky blue (info)
- **When**: After successful ping, listening for repeater echoes
- **Duration**: 10 seconds total (changed from 7 seconds)
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

#### 8. API and Map Update Messages

##### Queued (X/50)
- **Message**: `"Queued (X/50)"` (X is current queue size)
- **Color**: Sky blue (info)
- **When**: After TX or RX message is added to the batch queue
- **Notes**: Shows queue depth to indicate messages waiting for batch posting. Queue automatically flushes at 50 messages, after 3 seconds for TX, or after 30 seconds for any pending messages.
- **Source**: `content/wardrive.js:queueApiMessage()`

##### Posting X to API
- **Message**: `"Posting X to API"` (X is batch size)
- **Color**: Sky blue (info)
- **When**: Batch queue is being flushed to MeshMapper API
- **Timing**: Visible during batch POST operation
- **Notes**: Batch can contain mixed TX and RX messages (up to 50 total). Debug logs show TX/RX breakdown.
- **Source**: `content/wardrive.js:flushApiQueue()`

##### Posting to API (DEPRECATED - Replaced by Queued/Batch system)
- **Message**: `"Posting to API"`
- **Color**: Sky blue (info)
- **When**: ~~After RX listening window, posting ping data to MeshMapper API~~ **REPLACED BY BATCH QUEUE**
- **Notes**: As of the batch queue implementation, individual API posts have been replaced by batched posts. Messages are queued and flushed in batches.
- **Source**: ~~`content/wardrive.js:postApiAndRefreshMap()`~~ Replaced by batch queue system

##### Error: API batch post failed (DEPRECATED)
- **Message**: `"Error: API batch post failed"`
- **Color**: Red (error)
- **When**: ~~Batch API POST fails during flush operation~~ **REPLACED BY NEW WARDRIVE API**
- **Notes**: Replaced by "Error: API submission failed" in new wardrive API system.
- **Source**: ~~`content/wardrive.js:flushApiQueue()`~~ Replaced by `submitWardriveData()`

##### Error: API submission failed
- **Message**: `"Error: API submission failed"`
- **Color**: Red (error)
- **When**: Wardrive data submission fails after 2 retry attempts
- **Notes**: Entries are re-queued for next submission attempt (unless queue is full). Does not trigger disconnect.
- **Source**: `content/wardrive.js:submitWardriveData()` error handler

##### Session expired
- **Message**: `"Session expired"`
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with reason `session_expired`, `session_invalid`, or `session_revoked`
- **Terminal State**: Yes (triggers disconnect)
- **Notes**: Session is no longer valid, triggers automatic disconnect after 1.5 seconds.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Invalid session
- **Message**: `"Invalid session"`
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with reason `bad_session`
- **Terminal State**: Yes (triggers disconnect)
- **Notes**: Session ID is invalid or doesn't match API key, triggers automatic disconnect after 1.5 seconds.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Authorization failed
- **Message**: `"Authorization failed"`
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with reason `invalid_key`, `unauthorized`, or `bad_key`
- **Terminal State**: Yes (triggers disconnect)
- **Notes**: API key issue, triggers automatic disconnect after 1.5 seconds.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Outside zone
- **Message**: `"Outside zone"`
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with reason `outside_zone`
- **Terminal State**: Yes (triggers disconnect)
- **Notes**: User has moved outside their assigned zone during active wardrive session, triggers automatic disconnect after 1.5 seconds.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Zone capacity changed
- **Message**: `"Zone capacity changed"`
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with reason `zone_full` during active wardrive session
- **Terminal State**: Yes (triggers disconnect)
- **Notes**: Zone TX capacity changed during active session (unexpected mid-session), triggers automatic disconnect after 1.5 seconds. Note: `zone_full` during auth is handled as RX-only mode (partial success), not an error.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Rate limited - slow down
- **Message**: `"Rate limited - slow down"`
- **Color**: Yellow (warning)
- **When**: Wardrive API returns `success=false` with reason `rate_limited`
- **Terminal State**: No (does not trigger disconnect)
- **Notes**: Submitting data too quickly. Does not trigger disconnect, user should slow down pings.
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### API error: [message]
- **Message**: `"API error: [message]"` (where [message] is the API-provided error message)
- **Color**: Red (error)
- **When**: Wardrive API returns `success=false` with an unknown reason code
- **Terminal State**: No (does not trigger disconnect)
- **Notes**: Fallback message for unknown error codes. Shows raw API message to help with debugging. Logged to Error Log but does not trigger disconnect (allows recovery from transient/unknown errors).
- **Source**: `content/wardrive.js:handleWardriveApiError()`

##### Error: API post failed (DEPRECATED)
- **Message**: `"Error: API post failed"`
- **Color**: Red (error)
- **When**: ~~Background API POST fails during asynchronous posting~~ **REPLACED BY BATCH QUEUE**
- **Notes**: Replaced by "Error: API submission failed" in new wardrive API system.
- **Source**: ~~`content/wardrive.js:postApiInBackground()`~~ Replaced by batch queue system

##### — (em dash)
- **Message**: `"—"` (em dash character)
- **Color**: Slate (idle)
- **When**: 
  - Manual mode immediately after RX listening window completes (changed from "after API post completes")
  - After successful connection (shows "Connected" in connection bar)
  - Normal disconnect (shows "Disconnected" in connection bar)
  - Any time there is no active message to display
- **Purpose**: Placeholder to indicate "no message" state
- **Notes**: With the new ping/repeat listener flow, the em dash appears immediately after the 10-second RX window, not after API posting (which now runs in background)
- **Source**: Multiple locations - `content/wardrive.js`

#### 9. Auto Mode Messages

##### TX/RX Auto stopped
- **Message**: `"Auto mode stopped"`
- **Color**: Slate (idle)
- **When**: User clicks "Stop TX/RX" button
- **Source**: `content/wardrive.js:txRxAutoBtn click handler`

##### Lost focus, TX/RX Auto stopped
- **Message**: `"Lost focus, TX/RX Auto stopped"`
- **Color**: Amber (warning)
- **When**: Browser tab hidden while TX/RX Auto mode running
- **Source**: `content/wardrive.js:visibilitychange handler`

##### Wait Xs before toggling TX/RX Auto
- **Message**: `"Wait Xs before toggling TX/RX Auto"` (X is dynamic countdown)
- **Color**: Amber (warning)
- **When**: User attempts to toggle TX/RX Auto mode during cooldown period
- **Source**: `content/wardrive.js:stopAutoPing()`, `startAutoPing()`

##### RX Auto started
- **Message**: `"RX Auto started"`
- **Color**: Green (success)
- **When**: User clicks "RX Auto" button to start passive RX-only listening
- **Source**: `content/wardrive.js:startRxAuto()`

##### RX Auto stopped
- **Message**: `"RX Auto stopped"`
- **Color**: Slate (idle)
- **When**: User clicks "Stop RX" button
- **Source**: `content/wardrive.js:stopRxAuto()`

##### Lost focus, RX Auto stopped
- **Message**: `"Lost focus, RX Auto stopped"`
- **Color**: Amber (warning)
- **When**: Browser tab hidden while RX Auto mode running
- **Source**: `content/wardrive.js:visibilitychange handler`

#### 10. Error Messages

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

**Dynamic App Status Bar**: ~40+ unique message patterns covering:
- Capacity check: 9 messages (including session_id error messages)
- Channel setup: 4 messages
- GPS initialization: 3 messages
- Geo-auth zone check: 7 messages (with dual display in connection bar and settings panel)
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
- Zone status has dual display: connection bar (when disconnected) + settings panel (always visible)

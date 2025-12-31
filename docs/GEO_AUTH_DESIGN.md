# Geo-Auth Design Document

This document outlines the design for geographic authentication in the MeshCore GOME WarDriver system.  

## Overview

The Geo-Auth system provides location-based authentication for wardriving sessions.  Devices must be within designated geographic zones to connect and submit data.   

## Architecture

### Components

1. **Zone Manager** — Manages geographic zone definitions and capacity
2. **Auth Service** — Handles authentication requests and token management
3. **GPS Validator** — Validates GPS coordinates for freshness and accuracy
4. **Device Registry** — Tracks known devices heard on mesh

### Flow

1. Device advertises on mesh (prerequisite)
2. Device checks zone status (preflight)
3. Device requests auth with coordinates
4. Server validates device is known + location, issues session
5. Device submits wardrive data with keepalive
6. Device disconnects when session ends

## Device Registration (Mesh-Based)

Devices must be "heard on mesh" before they can authenticate for wardriving.  This provides attribution and prevents anonymous abuse.

### How It Works

```
1. Device advertises on mesh (any normal mesh activity)
2. Advert packet is collected by observer on letsmesh
3. Backend parses adverts, adds public_key to known_devices table
4. Device can now authenticate for wardriving
```

### Manual Registration

Admins can manually add a companion's public key via the admin panel.  This is useful for:
- Testing new devices
- Onboarding users in areas with no observer coverage
- Troubleshooting registration issues

### Known Devices Table

| Field | Type | Description |
|-------|------|-------------|
| `public_key` | string | Device's unique public key |
| `first_heard` | timestamp | When device was first heard on mesh |
| `last_heard` | timestamp | When device was last heard on mesh |
| `last_wardrive` | timestamp | When device last authenticated for wardriving |
| `expires_at` | timestamp | 60 days after most recent activity |
| `registered_by` | string | `mesh` (automatic) or `admin` (manual) |

### Retention Policy

- Devices are retained for **60 days** after last activity
- Activity that resets the 60-day expiry:  
  - Device heard on mesh (updates `last_heard`)
  - Device authenticates for wardriving (updates `last_wardrive`)
- If a device has no activity for 60 days, it is removed from known_devices
- Device must advertise on mesh again (or be manually re-added) to re-register

### Expiry Reset Logic

```
on device heard on mesh:
    update last_heard = now
    update expires_at = now + 60 days

on device authenticates for wardriving:
    update last_wardrive = now
    update expires_at = now + 60 days
```

### Unknown Device Flow

```
Device tries to auth with public_key "ABC123"
    ↓
Server checks:  Is "ABC123" in known_devices?  
    ↓
NO  → Return error: "unknown_device"
      Message: "Unknown public key.  Please advertise yourself on the mesh."
    ↓
YES → Update last_wardrive and expires_at
      Proceed with normal auth flow
```

> **Note:** The backend handles how observers report heard devices. This is outside the scope of the wardrive client.

---

## Zone Configuration

Zones are defined as circular regions with: 
- Center coordinates (lat/lng)
- Radius in kilometers
- Maximum concurrent slots (TX only)
- Enable/disable flag

## Token Management

Tokens are opaque bearer tokens with:
- 30-minute expiration
- Session binding
- Zone assignment

## GPS Validation Rules

- **Staleness threshold:** 60 seconds max age
- **Accuracy threshold:** 50 meters max horizontal accuracy
- **Coordinate bounds:** Valid lat (-90 to 90), lng (-180 to 180)

## Session Types (WARDRIVE_TYPE)

Each wardrive data entry includes a `type` field:

| Type | Description | Slot Limited |
|------|-------------|--------------|
| `TX` | Transmit — Device is actively broadcasting/probing | **Yes** — Counts toward zone capacity |
| `RX` | Receive — Device is passively listening/capturing | **No** — Unlimited within zone |

### Rationale

- **TX sessions** consume zone slots because active transmissions need coordination within a geographic area.    
- **RX sessions** are passive and do not interfere with other devices, so they are not subject to slot limits.  

### Slot Allocation Behavior

- When a session is granted `tx_allowed:  true`, it holds a TX slot for the duration of the session.    
- Sessions with only `rx_allowed: true` do not consume slots.  
- If zone is at TX capacity, device can still start an RX-only session.  

---

## Response Format

All API responses follow a consistent format:

### Success Response
```json
{
  "success": true,
  ...  endpoint-specific fields ...  
}
```

### Error Response
```json
{
  "success": false,
  "reason": "error_code",
  "message":  "Human-readable description"
}
```

### Standard Fields

| Field | Type | Present | Description |
|-------|------|---------|-------------|
| `success` | boolean | Always | Whether the request succeeded |
| `reason` | string | On error, or partial success | Machine-readable error code |
| `message` | string | On error | Human-readable error description |

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `unknown_device` | 403 | Public key not recognized — device must advertise on mesh first |
| `outside_zone` | 403 | Device is not within any configured zone |
| `zone_disabled` | 403 | Zone is administratively disabled |
| `zone_full` | 200 | Zone at TX capacity (RX still allowed) |
| `gps_stale` | 403 | GPS timestamp is too old |
| `gps_inaccurate` | 403 | GPS accuracy exceeds threshold |
| `bad_session` | 401 | Session ID is invalid or doesn't match |
| `session_expired` | 401 | Session has timed out |
| `bad_key` | 401 | API key is invalid |
| `invalid_request` | 400 | Missing or invalid parameters |

---

## API Endpoint Examples

This section captures sample requests and responses for the major endpoints described in this document.  See implementation notes for exact contract details.

> **HTTP Status Code Conventions:**
> - `200 OK` — Success (includes partial success like RX-only when TX denied)
> - `400 Bad Request` — Missing/invalid parameters (`invalid_request`)
> - `401 Unauthorized` — Invalid session or API key (`bad_session`, `bad_key`)
> - `403 Forbidden` — Valid request but fully denied (`outside_zone`, `zone_disabled`, `gps_stale`, `gps_inaccurate`, `unknown_device`)
> - `429 Too Many Requests` — Rate limit exceeded (applies to `/zones/status`)

---

### Preflight — Zone Status Check

**Endpoint:**  
`POST /zones/status`  
Content-Type: `application/json`

> **Note:** POST is used (instead of GET) to allow structured JSON coordinates in the request body.

**Request:**
```json
{
  "lat": 45.4215,
  "lng": -75.6972,
  "accuracy_m": 15. 3,
  "timestamp": 1703980800
}
```

#### Server Logic

```
validate lat/lng are within valid bounds
validate timestamp is not stale (< 60 seconds old)
validate accuracy_m is acceptable (< 50 meters)

find zone containing coordinates:
    if in zone:
        return zone info with capacity status
    else:
        find nearest zone
        return nearest zone with distance
```

#### Client Logic

```
ZONE_CHECK_DISTANCE_M = 100  // recheck zone status every 100 meters

on app launch:
    disable buttons:  [Connect], [TX Ping], [TX/RX Auto], [RX Auto]
    get current GPS coordinates
    store lastZoneCheckCoords = current coords
    POST /zones/status with current coords
    
    if success == true AND in_zone == true:
        show zone info to user
        enable buttons: [Connect]
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]  // until session acquired
    else if success == true AND in_zone == false:
        show nearest zone and distance
        disable buttons: [Connect], [TX Ping], [TX/RX Auto], [RX Auto]
        show "Outside zone" warning
    else: 
        show error message
        disable buttons: [Connect], [TX Ping], [TX/RX Auto], [RX Auto]

on location change (while not connected):
    calculate distance from lastZoneCheckCoords
    if distance >= ZONE_CHECK_DISTANCE_M:
        POST /zones/status with new coords
        store lastZoneCheckCoords = new coords
        update UI based on response (same logic as app launch)
```

#### Preflight Responses

**In Zone (200 OK):**  
Device is within a configured zone — shows capacity status.   
```json
{
  "success":  true,
  "in_zone": true,
  "zone":  {
    "name": "Ottawa",
    "code": "YOW",
    "enabled": true,
    "at_capacity": false,
    "slots_available": 5,
    "slots_max": 10
  }
}
```

**Outside All Zones (200 OK):**  
Device is not within any zone — shows nearest zone for navigation.  
```json
{
  "success": true,
  "in_zone": false,
  "nearest_zone": {
    "name": "Ottawa",
    "code": "YOW",
    "distance_km": 2.3
  }
}
```

**GPS Too Stale (403 Forbidden):**  
GPS timestamp is too old — device should get fresh location.
```json
{
  "success": false,
  "reason": "gps_stale",
  "message": "GPS timestamp is too old"
}
```

**GPS Too Inaccurate (403 Forbidden):**  
GPS accuracy exceeds acceptable threshold.    
```json
{
  "success": false,
  "reason": "gps_inaccurate",
  "message": "GPS accuracy exceeds 50 meter threshold"
}
```

**Invalid Request (400 Bad Request):**  
Missing or invalid coordinates.
```json
{
  "success": false,
  "reason": "invalid_request",
  "message": "Missing required field: lat"
}
```

---

### Auth — Connect Request

**Endpoint:**  
`POST /auth`  
Content-Type: `application/json`

Device metadata (`who`, `ver`, `power`, `iata`) is captured at authentication time and bound to the session.  These fields do not need to be sent with subsequent wardrive posts.

**Request:**
```json
{
  "key": "<api_key>",
  "public_key": "<device_public_key>",
  "who": "Alice's Pixel 8",
  "ver": "2.1. 0",
  "power": "22",
  "iata": "YOW",
  "reason": "connect",
  "coords": {
    "lat": 45.4216,
    "lng": -75.6970,
    "accuracy_m":  12.0,
    "timestamp": 1703980842
  }
}
```

#### Server Logic

```
validate api key:  
    if invalid:
        return success:  false, reason: bad_key

validate public_key is in known_devices:
    if not found:  
        return success: false, reason: unknown_device,
               message: "Unknown public key. Please advertise yourself on the mesh."

// Device is known — reset expiry
update known_devices:  
    set last_wardrive = now
    set expires_at = now + 60 days

validate coords are fresh and accurate
find zone containing coords:
    if not in zone:
        return success:  false, reason: outside_zone

    if zone is disabled:
        return success: false, reason: zone_disabled

check TX slot availability:
    if slots available:
        acquire TX slot for public_key
        create session with tx_allowed: true, rx_allowed: true
    else:
        create session with tx_allowed: false, rx_allowed: true, reason: zone_full

store session metadata (who, ver, power, iata)
set session expiration to now + 30 minutes
return success: true, session_id, and expires_at
```

#### Client Logic

```
on connect button pressed:
    disable buttons: [Connect]  // prevent double-tap
    get fresh GPS coordinates
    POST /auth with device info and coords

    if success == true AND tx_allowed AND rx_allowed:
        store session_id
        schedule heartbeat timer for (expires_at - 5 min)
        enable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Connect] to show [Disconnect]
        show "Connected - Full Access" message

    else if success == true AND rx_allowed only:
        store session_id
        schedule heartbeat timer for (expires_at - 5 min)
        disable buttons: [TX Ping], [TX/RX Auto]
        enable buttons: [RX Auto]
        update [Connect] to show [Disconnect]
        show "Connected - RX Only (TX at capacity)" message

    else if reason == unknown_device:
        enable buttons: [Connect]  // allow retry after advertising
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        show error:  "Unknown device.  Please advertise yourself on the mesh and try again."

    else:
        enable buttons: [Connect]  // allow retry
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        show error: response. message
        if nearest_zone provided:
            show distance to nearest zone
```

#### Auth Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether the auth request succeeded |
| `tx_allowed` | boolean | Whether TX wardriving is permitted (slot acquired) |
| `rx_allowed` | boolean | Whether RX wardriving is permitted (always true if in zone) |
| `session_id` | string | Session ID (present if either TX or RX is allowed) |
| `reason` | string | Why TX was denied or request failed |
| `message` | string | Human-readable description (on error) |
| `zone` | object | Zone info (present if in zone) |
| `expires_at` | number | Session expiration timestamp (Unix epoch) |
| `nearest_zone` | object | Nearest zone info (only if outside all zones) |

#### Auth Responses

**Full Access, TX + RX (200 OK):**  
Device is in zone and a TX slot is available — full wardriving permitted. 
```json
{
  "success": true,
  "tx_allowed": true,
  "rx_allowed": true,
  "session_id": "<session_id>",
  "zone": {
    "name": "Ottawa",
    "code": "YOW"
  },
  "expires_at": 1703982642
}
```

**RX Only, Zone at TX Capacity (200 OK):**  
Device is in zone but all TX slots are occupied — RX wardriving still permitted.
```json
{
  "success": true,
  "tx_allowed": false,
  "rx_allowed": true,
  "reason": "zone_full",
  "session_id": "<session_id>",
  "zone": {
    "name": "Ottawa",
    "code": "YOW"
  },
  "expires_at": 1703982642
}
```

**Fully Denied, Unknown Device (403 Forbidden):**  
Device's public key has not been heard on mesh — must advertise first.  
```json
{
  "success": false,
  "reason": "unknown_device",
  "message": "Unknown public key. Please advertise yourself on the mesh."
}
```

**Fully Denied, Outside Zone (403 Forbidden):**  
Device is not within any configured zone — no wardriving permitted.
```json
{
  "success": false,
  "reason": "outside_zone",
  "message": "Device is not within any configured zone",
  "nearest_zone": {
    "name": "Ottawa",
    "code": "YOW",
    "distance_km": 1.2
  }
}
```

**Fully Denied, Zone Disabled (403 Forbidden):**  
Device is in zone but the zone is administratively disabled — no wardriving permitted.
```json
{
  "success":  false,
  "reason": "zone_disabled",
  "message": "Zone is currently disabled"
}
```

**Fully Denied, Bad API Key (401 Unauthorized):**  
API key is invalid or missing.    
```json
{
  "success": false,
  "reason": "bad_key",
  "message": "API key is invalid"
}
```

---

### Wardrive Post (Keepalive + Data Submission)

**Endpoint:**  
`POST /wardrive`  
Content-Type: `application/json`

The `/wardrive` endpoint serves two purposes:  
1. **Data submission** — Post wardrive data (TX and/or RX entries)
2. **Heartbeat** — Keep session alive when no data is available (e.g., quiet RX wardriving)

Both modes refresh the session expiration.    

#### Request Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | API key for authentication |
| `session_id` | string | Yes | Session ID from auth response |
| `data` | array | If not heartbeat | Array of wardrive entries |
| `heartbeat` | boolean | If no data | Set to `true` for keepalive only |
| `coords` | object | If heartbeat | Current location for zone validation |

#### Wardrive Data Entry Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `TX` or `RX` |
| `lat` | float | Latitude |
| `lon` | float | Longitude |
| `heard_repeats` | string | Repeaters heard with SNR, e.g.  `"4e(11. 5)"` or `"None"` |
| `timestamp` | number | Unix epoch (seconds) when this data was captured |

#### Heartbeat Coords Fields

| Field | Type | Description |
|-------|------|-------------|
| `lat` | float | Latitude |
| `lon` | float | Longitude |
| `timestamp` | number | Unix epoch (seconds) of current position |

> **Note:** Device metadata (`who`, `ver`, `power`, `iata`) is already bound to the session at auth time — no need to include in wardrive posts.

#### Server Logic

```
validate api key:
    if invalid:
        return success: false, reason: bad_key
validate session_id exists and matches key:
    if invalid:
        return success: false, reason: bad_session
check session not expired:
    if expired:  
        return success: false, reason: session_expired

if heartbeat == true:
    validate coords object is present:
        if missing:
            return success: false, reason: invalid_request
    validate coords are in session's assigned zone:
        if outside zone:
            return success: false, reason: outside_zone
    refresh session expiration to now + 30 minutes
    return success: true, expires_at

else: 
    validate data array is present and not empty:
        if missing or empty:
            return success: false, reason: invalid_request
    find entry with highest timestamp
    validate that entry's coords are in session's assigned zone: 
        if outside zone:
            return success: false, reason: outside_zone
    store all wardrive data entries
    refresh session expiration to now + 30 minutes
    return success: true, expires_at
```

#### Client Logic

```
on session start:
    set lastPostTime = now
    schedule heartbeatTimer for (expires_at - 5 min)

on wardrive data collected:
    add to local queue

on queue flush (every 30s or on TX):
    POST /wardrive with data array
    if success == true:
        lastPostTime = now
        cancel heartbeatTimer
        schedule heartbeatTimer for (new expires_at - 5 min)
    else if reason == outside_zone:
        show "Outside zone" warning
        stop wardriving
        cancel heartbeatTimer
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]
    else if reason == session_expired:
        show "Session expired" warning
        stop wardriving
        cancel heartbeatTimer
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]

on heartbeat timer fire:
    get fresh GPS coordinates
    POST /wardrive with heartbeat:  true, coords
    if success == true: 
        schedule heartbeatTimer for (new expires_at - 5 min)
    else if reason == outside_zone:
        show "Outside zone" warning
        stop wardriving
        cancel heartbeatTimer
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]
    else if reason == session_expired:
        show "Session expired" warning
        stop wardriving
        cancel heartbeatTimer
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]
```

#### When to Use Heartbeat

The heartbeat flag is a **safety net** for quiet RX wardriving sessions when no repeaters are heard for extended periods. 

| Situation | What Happens |
|-----------|--------------|
| Active TX wardriving | `/wardrive` posts with data keep session alive — heartbeat not needed |
| Active RX wardriving | `/wardrive` posts with data keep session alive — heartbeat not needed |
| Quiet RX wardriving | No data to post → heartbeat timer fires → `/wardrive` with `heartbeat: true` keeps session alive |
| Device crashes | No heartbeat, no wardrive → session expires → slot released |

#### Wardrive Request Examples

**Data Submission (normal wardrive post):**
```json
{
  "key": "<api_key>",
  "session_id": "<session_id>",
  "data": [
    {
      "type":  "TX",
      "lat":  45.4217,
      "lon": -75.6975,
      "heard_repeats": "4e(11.5),b7(9.75)",
      "timestamp": 1703980860
    },
    {
      "type": "RX",
      "lat": 45.4218,
      "lon": -75.6973,
      "heard_repeats": "22(8.2)",
      "timestamp": 1703980875
    }
  ]
}
```

**Heartbeat (keepalive, no data):**  
Used when RX wardriving is quiet and no repeaters have been heard. 
```json
{
  "key": "<api_key>",
  "session_id": "<session_id>",
  "heartbeat": true,
  "coords": {
    "lat": 45.4218,
    "lon": -75.6973,
    "timestamp": 1703980900
  }
}
```

#### Wardrive Responses

**Success, Session Extended (200 OK):**  
Data accepted (or heartbeat acknowledged) and session expiration extended.
```json
{
  "success": true,
  "expires_at": 1703982660
}
```

**Denied, Outside Assigned Zone (403 Forbidden):**  
Device has moved outside the zone it authenticated in.   
```json
{
  "success": false,
  "reason": "outside_zone",
  "message": "Device has moved outside the assigned zone"
}
```

**Denied, Invalid Session (401 Unauthorized):**  
Session ID is invalid or does not match the API key.  
```json
{
  "success": false,
  "reason": "bad_session",
  "message": "Session ID is invalid or does not match the API key"
}
```

**Denied, Session Expired (401 Unauthorized):**  
Session has timed out and requires re-authentication.
```json
{
  "success": false,
  "reason": "session_expired",
  "message": "Session has timed out and requires re-authentication"
}
```

**Denied, Invalid Request (400 Bad Request):**  
Request must include either `data` array or `heartbeat: true`.
```json
{
  "success": false,
  "reason": "invalid_request",
  "message": "Request must include either data array or heartbeat flag"
}
```

---

### Disconnect

**Endpoint:**  
`POST /auth`  
Content-Type: `application/json`

**Request:**
```json
{
  "key": "<api_key>",
  "public_key": "<device_public_key>",
  "reason":  "disconnect",
  "session_id": "<session_id>"
}
```

#### Server Logic

```
validate api key:
    if invalid: 
        return success: false, reason: bad_key
validate session_id exists and belongs to public_key:
    if invalid: 
        return success: false, reason: bad_session

if session held a TX slot:
    release TX slot back to zone pool

delete session
return success: true, disconnected:  true
```

#### Client Logic

```
on disconnect button pressed:
    cancel heartbeatTimer
    flush any pending wardrive data
    POST /auth with reason: disconnect
    if success == true:
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]
        show "Disconnected" message
    else: 
        // still clean up locally even if server fails
        clear local session_id
        disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
        update [Disconnect] to show [Connect]
        enable buttons: [Connect]
        show "Disconnected (server error:  " + response.message + ")"

on app close:
    same as disconnect button pressed (best effort)

on connection lost unexpectedly:
    cancel heartbeatTimer
    clear local session_id
    disable buttons: [TX Ping], [TX/RX Auto], [RX Auto]
    update [Disconnect] to show [Connect]
    enable buttons: [Connect]
    show "Connection lost - tap Connect to reconnect" message
    attempt POST /auth disconnect (best effort, don't block UI)
```

#### Disconnect Responses

**Success (200 OK):**  
Session terminated and TX slot released (if held).
```json
{
  "success": true,
  "disconnected": true
}
```

**Failed, Bad Session (401 Unauthorized):**  
Session ID is invalid or doesn't exist.
```json
{
  "success": false,
  "reason": "bad_session",
  "message": "Session ID is invalid or does not exist"
}
```

**Failed, Bad API Key (401 Unauthorized):**  
API key is invalid.    
```json
{
  "success": false,
  "reason": "bad_key",
  "message": "API key is invalid"
}
```

---

_Add further endpoint examples as APIs expand._

## Open Items / Next Brainstorm

### API Design
- [ ] **API Versioning** — Implement `/v1/auth`, `/v1/wardrive`, etc.  Add `API_VERSION` variable to client app for easy switching between dev/prod API versions
- [ ] **API Key Necessity** — Is `api_key` still required now that `public_key` (mesh-based identity) is the primary auth mechanism? Consider removing or making optional

### Security
- [ ] **Session Signing** — Should `session_id` be signed with `public_key` to prevent session hijacking? 

### Error Handling
- [ ] **Network Failures** — Client logic doesn't explicitly handle network errors (timeout, DNS failure, etc.). Define retry strategy, offline queueing, and user feedback
- [ ] **Concurrent Sessions** — Define behavior when same `public_key` tries to auth twice.  Options:  Allow multiple sessions?  Replace old session?  Reject second attempt?
- [ ] **GPS Jitter Tolerance** — Consider zone boundary hysteresis to prevent false `outside_zone` errors when GPS fluctuates near zone edge

### Slot Management
- [ ] **Slot Starvation** — If TX slots are always full, RX-only users never get upgraded.  Consider: Queue for TX slot?  Notification when slot becomes available?  Auto-upgrade RX session to TX when slot frees up?

### Zone Behavior
- [ ] **Zone Boundary Crossing** — What happens when user crosses zone boundary mid-session? Options:  End session immediately?  Grace period? Allow session to continue until next wardrive post fails validation?

### Admin Endpoints
- [ ] **Zone CRUD** — Create, read, update, disable zones via admin API
- [ ] **Manual Device Registration** — Admin endpoint to add companion public keys manually
- [ ] **Metrics Dashboard** — Admin dashboard for monitoring (active sessions, zone capacity, auth rates, etc.) — Maybe? 

# Geo-Auth Design Document

This document outlines the design for geographic authentication in the MeshCore GOME WarDriver system.

## Overview

The Geo-Auth system provides location-based authentication for wardriving sessions. Devices must be within designated geographic zones to connect and submit data.

## Architecture

### Components

1. **Zone Manager** — Manages geographic zone definitions and capacity
2. **Auth Service** — Handles authentication requests and token management
3. **GPS Validator** — Validates GPS coordinates for freshness and accuracy

### Flow

1. Device checks zone status (preflight)
2. Device requests auth with coordinates
3. Server validates location and issues token
4. Device submits wardrive data with keepalive
5. Device disconnects when session ends

## Zone Configuration

Zones are defined as circular regions with:
- Center coordinates (lat/lng)
- Radius in kilometers
- Maximum concurrent slots
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

---

## API Endpoint Examples

This section captures sample requests and responses for the major endpoints described in this document. See implementation notes for exact contract details.

> **HTTP Status Code Conventions:**
> - `200 OK` — Success
> - `400 Bad Request` — Missing/invalid parameters (`invalid_request`)
> - `401 Unauthorized` — Missing or invalid token (`missing_token`, `bad_token`)
> - `403 Forbidden` — Valid request but denied (`zone_full`, `outside_zone`, `zone_disabled`, `gps_stale`, `gps_inaccurate`)
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
  "accuracy_m": 15.3,
  "timestamp": 1703980800
}
```

**Response — In Zone (200 OK):**
```json
{
  "in_zone": true,
  "zone": {
    "name": "Ottawa",
    "code": "YOW",
    "enabled": true,
    "at_capacity": false,
    "slots_available": 5,
    "slots_max": 10
  }
}
```

**Response — Outside All Zones (200 OK):**
```json
{
  "in_zone": false,
  "nearest_zone": {
    "name": "Ottawa",
    "code": "YOW",
    "distance_km": 2.3
  }
}
```

**Response — GPS Too Stale (403 Forbidden):**
```json
{
  "in_zone": false,
  "error": true,
  "reason": "gps_stale"
}
```

---

### Auth — Connect Request

**Endpoint:**  
`POST /auth`  
Content-Type: `application/json`

**Request:**
```json
{
  "public_key": "<device_public_key>",
  "who": "Alice's Pixel 8",
  "version": "2.1.0",
  "reason": "connect",
  "coords": {
    "lat": 45.4216,
    "lng": -75.6970,
    "accuracy_m": 12.0,
    "timestamp": 1703980842
  }
}
```

**Response — Allowed (200 OK):**
```json
{
  "allowed": true,
  "token": "<opaque_bearer_token>",
  "session_id": "<session_id>",
  "zone": {
    "name": "Ottawa",
    "code": "YOW"
  },
  "expires_at": 1703982642
}
```

**Response — Denied, At Capacity (403 Forbidden):**
```json
{
  "allowed": false,
  "reason": "zone_full"
}
```

**Response — Denied, Outside Zone (403 Forbidden):**
```json
{
  "allowed": false,
  "reason": "outside_zone",
  "nearest_zone": {
    "name": "Ottawa",
    "code": "YOW",
    "distance_km": 1.2
  }
}
```

---

### Wardrive Post (Keepalive + Data Submission)

**Endpoint:**  
`POST /wardrive`  
Headers:  
- `Authorization: Bearer <token>`  
- `Content-Type: application/json`

**Request:**
```json
{
  "session_id": "<session_id>",
  "public_key": "<device_public_key>",
  "data": { ... },
  "coords": {
    "lat": 45.4217,
    "lng": -75.6975,
    "accuracy_m": 10.1,
    "timestamp": 1703980860
  }
}
```

**Response — Allowed, Session Extended (200 OK):**
```json
{
  "allowed": true,
  "expires_at": 1703982660
}
```

**Response — Denied, Outside Assigned Zone (403 Forbidden):**
```json
{
  "allowed": false,
  "reason": "outside_zone"
}
```

**Response — Denied, Invalid Token (401 Unauthorized):**
```json
{
  "allowed": false,
  "reason": "bad_token"
}
```

---

### Disconnect

**Endpoint:**  
`POST /auth`  
Headers:  
- `Authorization: Bearer <token>`  
- `Content-Type: application/json`

**Request:**
```json
{
  "reason": "disconnect",
  "session_id": "<session_id>"
}
```

**Response — Success (200 OK):**
```json
{
  "disconnected": true
}
```

---

_Add further endpoint examples as APIs expand._

## Open Items / Next Brainstorm

- [ ] Define rate limiting strategy for `/zones/status`
- [ ] Decide on token refresh vs re-auth approach
- [ ] Specify error response format consistency
- [ ] Consider WebSocket alternative for keepalive
- [ ] Document admin endpoints for zone management
- [ ] Add session type? TX vs RX? RX does not require to be limited.

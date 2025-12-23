# Geo-Fenced Community Auth System Design (Logic-Only)

> Design document for converting the existing `checkCapacity()` endpoint into a full geo-fenced community authentication system.
>
> Created: 2025-12-23  
> Updated: 2025-12-23  
>
> **Scope note:** This document intentionally contains **no code and no SQL**. It captures **behavior, rules, and contracts** only.

---

## Goals

- Gate access to wardriving by **geo-fenced communities** with per-community capacity limits.
- Provide a **preflight** check so the UI can show zone + availability before connecting.
- Enforce **strict GPS quality** rules (fail closed).
- Maintain a **single active session per device** (public_key) with **sliding TTL**.
- Ensure **auditability** of auth and session lifecycle events.

---

## Confirmed Decisions

- Scale: ~50 communities max.
- Admins: small trusted group; shared-secret admin auth is acceptable.
- Zone geometry: circles (center point + radius).
- Zone codes: IATA where possible; otherwise custom 3-char codes.
- Overlapping zones: **closest center wins** (deterministic tie-breaker by zone code if needed).
- Session TTL: **30 min sliding window**, extended by real wardrive activity.
- Slot display: show zone + availability **before** connecting.
- `/zones/status` is **public** and **hard rate-limited by IP**.
- GPS accuracy gate: **reject if accuracy > 100m**.
- GPS freshness gate: **reject if GPS fix age > 60 seconds** (applies to both `/zones/status` and `/auth`).
- Session uniqueness: **one active session per public_key globally**.
- Disconnect: best-effort; TTL expiry is authoritative.
- Expiry process: runs every minute.
- Auditing: keep a durable record of session endings and denial reasons.
- Geo enforcement on wardrive posts: **deny if outside zone** (`allowed=false`) and the client stops auto ping.

---

## Token Transport (Best Practice)

- Wardrive posts MUST send the session token using the standard HTTP header:
  - `Authorization: Bearer <token>`
- Tokens MUST NEVER be accepted via query string parameters.
- Tokens are treated as sensitive secrets and must be stored securely on device.

Rationale (high level):
- Header-based bearer tokens are standard and avoid common leakage paths (URLs, referrers, browser history, many default access logs).

Operational note:
- Ensure server / reverse proxy logs do not record `Authorization` headers (or redact them), especially for wardrive endpoints.

---

## Entities (Conceptual)

### Community (Zone)
A community is a named circular region:
- code (3 chars)
- name
- center_lat, center_lng
- radius_km
- max_slots
- enabled (boolean)

### Session (Active)
An active session represents a device that currently holds a slot:
- session_id
- public_key (device identity; globally unique for active sessions)
- token (opaque secret; stored server-side only as a hash)
- community_code (the zone this session is currently assigned to)
- issued_at, expires_at (sliding)
- last_activity
- last known coordinates (optional, for audit/diagnostics)

### Audit Trail (Ended Sessions + Events)
When a session ends, the system records:
- ended_at
- end_reason: disconnect / expired / revoked / replaced
- key details useful for debugging/metrics (optional)

---

## Core UX / System Flow

### 1) Preflight (Before BLE connect)
**Client action**
- Acquire GPS fix and call: `GET /zones/status` with:
  - lat, lng
  - accuracy_m
  - timestamp

**Server behavior (fail closed)**
1. Validate request shape (all required fields present).
2. Validate GPS freshness: **deny if fix age > 60 seconds**.
3. Validate GPS accuracy: **deny if accuracy_m > 100m**.
4. Determine zone membership:
   - If inside 0 zones → return `in_zone=false` and include nearest zone info.
   - If inside 1 zone → that is the zone.
   - If inside multiple zones → choose the zone whose center is closest to the point.
5. Compute availability:
   - slots_available = max_slots - active_sessions_in_zone
6. Include zone state in response:
   - enabled true/false
   - at_capacity true/false

**UI behavior**
- If in zone **and** zone is enabled **and** not at capacity:
  - Show: `You're in: <Name> (<CODE>)`
  - Show slots: `<available> / <max> available`
  - Enable **Connect**
- If in zone but zone is **disabled**:
  - Show: `<Name> (<CODE>) — temporarily unavailable`
  - Disable **Connect**
- If in zone but zone is **full**:
  - Show: `<Name> (<CODE>) — at capacity`
  - Disable **Connect**
- If outside all zones:
  - Show: `Outside coverage area`
  - Show nearest zone: `<Name> (<CODE>) — <distance_km> km away`
  - Disable **Connect** (or leave enabled but expect `/auth` to deny; recommended: disable)
  - 
**Optional**
- `/zones/status` is rate-limited hard by IP because it is unauthenticated.

---

### 2) Connect (Auth request)
**Client action**
- After BLE pairing, acquire a fresh high-accuracy GPS fix.
- Call: `POST /auth` with:
  - public_key, who/device name, version, reason="connect"
  - coords {lat,lng,accuracy_m,timestamp}

**Server behavior (fail closed, ordered checks)**
1. Validate app key and version policy (deny `outofdate` if needed).
2. Validate coords present.
3. Validate GPS freshness: **deny if fix age > 60 seconds**.
4. Validate GPS accuracy: **deny if accuracy_m > 100m**.
5. Determine winning zone (same rules as preflight).
   - If none: deny `outside_zone` (include nearest zone distance if helpful).
6. Check zone enabled:
   - If disabled: deny `zone_disabled`.
7. Check capacity:
   - If full: deny `zone_full`.
8. Enforce session uniqueness (one per public_key):
   - If a session already exists for this public_key:
     - end the old session as `replaced` (audit it)
9. Issue auth result:
   - allowed=true
   - token + session_id
   - assigned community (code + name)
   - expires_at (now + 30 min)

---

### 3) Active Use + Keepalive (TTL extension via wardrive posts)
You chose **Option B**: TTL refresh piggybacks on the existing wardrive data endpoint.

**Principle**
- A slot should be held only by devices doing real work.
- Therefore: **each accepted wardrive post extends session TTL**.

**Server behavior on wardrive post**
1. Validate authentication:
   - token present (deny `missing_token` if absent)
   - token valid (deny `bad_token` if invalid/unknown)
   - token must be bound to the session’s `public_key` (enforce device binding)
2. Validate session not expired.
3. Validate GPS gates:
   - freshness: deny if fix age > 60 seconds
   - accuracy: deny if accuracy_m > 100m
4. Geo enforcement (authoritative on each wardrive post):
   - Determine whether device is still within its assigned zone.
   - If outside: return `allowed=false` with reason `outside_zone`.
   - Client behavior: stop auto ping when this happens.
5. On success:
   - extend `expires_at = now + 30 minutes`
   - update last_activity and last coordinates

---

### 4) Disconnect (Best effort)
**Client action**
- On user disconnect, call `POST /auth` with reason="disconnect" plus auth context.

**Server behavior**
- Validate token/session, then end session:
  - free slot immediately
  - record end_reason `disconnect` in audit trail

**Note**
- Disconnect is best-effort; crashes/network loss are handled by expiry.

---

### 5) Expiry (Authoritative cleanup)
A scheduled job runs every minute:
- Find sessions with `expires_at < now`
- End them with end_reason `expired` and record in audit trail
- Ensure slots become available again

---

## Zone Selection Rules (Detailed)

Given a GPS point:
1. Compute distance to every enabled community center.
2. A community “contains” the point if distance <= radius.
3. If multiple communities contain the point:
   - select the one with smallest distance to center
   - if exact tie (unlikely): choose lexicographically smallest community code for determinism
4. If no community contains the point:
   - user is out of zone
   - also compute nearest zone by distance for UI feedback

---

## Capacity + Concurrency Rules

- Slots are allocated per community.
- Capacity check must be race-safe (avoid oversubscription during simultaneous connects).
- Behavioral requirement: if the community is at capacity at the moment of connect,
  - deny `zone_full`
  - do not create a session

(Implementation detail intentionally omitted here; the system must ensure the behavior is correct under concurrency.)

---

## Denial Reason Codes (Shared Across Endpoints)

These codes are used by `/zones/status`, `/auth`, and wardrive post validation.

- `outside_zone` — Outside coverage area
- `zone_full` — Community at capacity
- `zone_disabled` — Community temporarily unavailable
- `gps_stale` — GPS fix too old (> 60 seconds)
- `gps_inaccurate` — GPS accuracy too low (> 100m)
- `outofdate` — App out of date
- `missing_token` — Not authenticated (no token provided)
- `bad_token` — Session invalid (unknown/expired token)
- `invalid_request` — Missing/invalid parameters

---

## Observability / Audit (Ideas)

Minimum recommended audit events:
- zone_status_denied (gps_inaccurate/gps_stale/invalid_request)
- auth_success (connect)
- auth_denied (with reason)
- session_replaced
- session_disconnected
- session_expired
- wardrive_denied (bad_token/outside_zone/gps_inaccurate, etc.)

Each audit record should capture:
- timestamp
- public_key (if known)
- community_code (if known)
- reason code
- optional context (coords accuracy, distance to zone, etc.)

---

## Open Items / Next Brainstorm

1. **Admin auth (future)**:
   - For now: shared-secret admin access is acceptable (simple trusted group).
   - Later: consider migrating to GitHub OAuth or Discord OAuth.
2. **Public status page**:
   - whether to show all zones and availability publicly
3. **Messaging/UI copy**:
   - final user-facing strings for each denial reason

---

## Phased Deployment Plan (High Level)

### Phase 0 — Safe scaffolding (prod-friendly, no user impact)
- Keep current capacity API as-is for everyone.
- Add new parallel endpoints (e.g., `zones_status.php`, `auth.php`) that don’t affect existing flows.
- Add basic logging/metrics so you can see usage + denial reasons in prod.

### Phase 1 — Ship `/zones/status` first (read-only preflight)
- Deploy `GET /zones/status` (IP rate-limited).
- Enforce GPS gates (accuracy ≤ 100m, freshness ≤ 60s).
- Frontend: show zone + slots + disabled/full + GPS error messages, but don’t change actual connect behavior yet.

### Phase 2 — Opt-in auth sessions (connect/disconnect) for testers
- Deploy `POST /auth` (connect + disconnect) on the new endpoint.
- Restrict to you/testers (public_key allowlist or a temporary “dev mode” switch) since backend is prod-only.
- Frontend (dev env): add a toggle to use new auth, store token+session_id.

### Phase 3 — Enforce auth on wardrive posts + TTL extension
- Update wardrive post endpoint to accept `Authorization: Bearer <token>`.
- Validate token/session/public_key; extend TTL on accepted posts.
- If outside zone: return `allowed=false` so frontend stops auto ping.

### Phase 4 — Gradual rollout to everyone + deprecate old capacity flow
- Expand from allowlist → all users once stable.
- Keep old capacity endpoint for a transition window.
- Announce cutover date, then remove/disable old path when adoption is complete.

```diagram
┌──────────────────────────────────────────────────────────────────────────────┐
│                         PAGE LOAD / PREFLIGHT (PUBLIC)                       │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        │ 1) Get GPS fix (coarse is OK, but must pass gates)
        │    - accuracy_m <= 100
        │    - age_s <= 60
        ▼
┌──────────────────────────────────────────────┐
│ Client: GET /zones/status                    │
│   lat,lng,accuracy_m,timestamp               │
└──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────┐
│ Server: /zones/status (rate-limited by IP)   │
│  - validate request                          │
│  - validate GPS freshness (<=60s)            │
│  - validate GPS accuracy (<=100m)            │
│  - compute winning zone (closest-center)     │
│  - compute slots + enabled/full              │
└──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Client UI result                                                             │
│                                                                              │
│  A) GPS invalid: (gps_stale / gps_inaccurate)                                │
│     - show reason                                                            │
│     - Connect DISABLED                                                       │
│                                                                              │
│  B) In zone + enabled + slots available                                      │
│     - show "You're in: <Name> (<CODE>)" + "<avail>/<max>"                    │
│     - Connect ENABLED                                                        │
│                                                                              │
│  C) In zone but disabled OR full                                             │
│     - show state                                                             │
│     - Connect DISABLED                                                       │
│                                                                              │
│  D) Outside all zones                                                        │
│     - show "Outside coverage area" + nearest zone + distance                 │
│     - Connect DISABLED                                                       │
└──────────────────────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────────────────────┐
│                           CONNECT / AUTH (PRIVATE)                            │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        │ User clicks Connect (only enabled in valid in-zone case)
        │
        │ 2) BLE pair + get fresh high-accuracy GPS fix
        │    - accuracy_m <= 100
        │    - age_s <= 60
        ▼
┌──────────────────────────────────────────────┐
│ Client: POST /auth                           │
│  reason=connect                              │
│  public_key, who, ver, coords{...}           │
└──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────┐
│ Server: /auth (connect)                      │
│  - validate app key + version                │
│  - validate coords                           │
│  - validate GPS freshness (<=60s)            │
│  - validate GPS accuracy (<=100m)            │
│  - compute winning zone                      │
│      -> none => DENY outside_zone            │
│  - check zone enabled                        │
│      -> disabled => DENY zone_disabled       │
│  - check capacity                            │
│      -> full => DENY zone_full               │
│  - enforce 1 session per public_key          │
│      -> end old session as "replaced"        │
│  - create session + issue token + session_id │
│  - expires_at = now + 30 min                 │
└──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Client receives allowed=true                                                   │
│  - store token + session_id                                                   │
│  - start wardriving / auto ping                                               │
└──────────────────────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────────────────────┐
│                     WARDRIVE POSTS (KEEPALIVE + ENFORCEMENT)                  │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        │ Each wardrive post includes:
        │   Authorization: Bearer <token>
        │   session_id + public_key + GPS coords
        ▼
┌──────────────────────────────────────────────┐
│ Server: wardrive endpoint                    │
│  - validate token present -> else missing_token
│  - validate token/session/public_key -> else bad_token
│  - validate GPS freshness/accuracy           │
│  - validate still inside assigned zone       │
│      -> if outside => allowed=false outside_zone
│  - on success: extend expires_at +30 min     │
└──────────────────────────────────────────────┘
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Client behavior on allowed=false outside_zone                                 │
│  - stop auto ping                                                            │
│  - show message + require reconnect/auth                                     │
└──────────────────────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────────────────────┐
│                      DISCONNECT + EXPIRY (SESSION END)                        │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        ├─ Best-effort user disconnect:
        │     Client: POST /auth reason=disconnect
        │     Server: end session (audit "disconnect")
        │
        └─ Auto-expire (every 1 minute):
              Server: end expired sessions (audit "expired")
```
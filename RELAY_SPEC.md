# Relay Modes Matrix (Structured Spec Draft)
---

## Relay Mode Matrix v1

| Property | Static Infrastructure Relay | Mobile Ferry Relay | Station Fallback Relay | Volunteer (Wallet) Relay |
|-----------|---------------------------|-------------------|------------------------|--------------------------|
| Intended Use | Extend range on LAN | Physically move data between clusters | Degraded station mode | User volunteer mesh |
| Trust Level | Untrusted | Untrusted | Operationally trusted (identity exists but degraded) | Untrusted |
| Provisioning | Scan station QR | Scan station QR or manual crisis pin | Automatic (station loses credentials) | Toggle in app |
| Crisis Pin | Persistent | Ephemeral | Persistent | Ephemeral |
| Reset Behavior | Rare | Easy wipe/reset | Only via reprovision | Stop toggle |
| HQ Connectivity | Low-frequency | Very low-frequency | Normal station cadence (if restored) | Optional |
| Preferred Upstream | Station | Station (always prefer local) | HQ (when station restored) | Any |
| Auto-Connect | No | Yes (aggressive) | No | No |
| Auto-Broadcast | No | Yes (beacon-like during window) | No | No |
| Storage TTL | Normal | Shorter TTL | Normal | Short |
| Persistence Priority | High | Low | High | Low |
| Deployment Skill Required | Minimal (QR scan) | Minimal (QR scan + reset awareness) | None | None |
| Docker Container | Dedicated relay container | Separate “ferry” container | Station container | Inside wallet app |

---

# Static Infrastructure Relay

```
relay_role = "LAN_amplifier"
```
--- 

### Provisioning
- Scan nearby station QR
- Extract:
  - crisis_id
  - block_public_key
  - station LAN base URL
- Pin permanently (re-initialize device completely if needs to be changed)

### Behavior
- Maintain LAN connection to station peers
- Pull from station, not HQ (unless no station reachable)
- Host public “room” for users (similar to stations's "pool" but untrusted, no bulletin board UI)
- Low HQ polling cadence (if at all)
- Are lower class citizens, never prioritized over users or stations
- Amplify signals and data propagation velocity

### Design Philosophy
This device is:
> A LAN amplifier, not a data mover

It should be polite and stable, never trusted nor important.

---

# Mobile Ferry Relay (Distinct Relay Device Class)

```
relay_role = "delivery_facilition"
```
---

## Ferry Characteristics

- Physically travels between disconnected populations (set up in a vehicle, for eg)
- Auto-syncs aggressively when peers detected
- Prefers station connection over HQ
- Minimal persistence expectations
- Designed to be wiped and re-initialized easily depending on currently vehicle's deployment

---

## Ferry Pinning

Scan trusted station's displayed QR to initialize.

No HQ provisioning required.

No credentials required.

---

## Ferry Reset Model

You want:
> Quick wipe + reinitialize.

Implementation:
- Single command to wipe:
  - blocks
  - meta
  - queued
  - confirmed
- Return to uninitialized mode, scan station QR to initialize and pin crisis ID

This should be intentionally easier than static relay reset.

---

## Ferry Sync Behavior

When online:
- Pull blocks from nearest station
- Only pull HQ if no station reachable
- Sync interval aggressive when peers present
- Idle and broadcast when alone

When offline:
- Continue mesh sync with any and all connections
- Store long TTL queue
- Store full blockchain if possible

This node is:
> A packet mule, helping sync dislocated offline populations

---

# Station Fallback Relay (Mentioned for Spec Completeness)

Already mostly defined in the station behaviour, separate but similar in functionality relevent to this spec for its conceptual similarity, albeit coded in isolation as part of the station's specification.

Behavior:
- When identity revoked or invalid:
  - Downgrade to relay mode
  - No /checkin allowed (may NOT post to blockchain, relays other devices' posts to blockchain but not its own)
  - Still participates in mesh
- Maintains crisis pin
- Retains storage persistence

This is:
> A degraded operational endpoint.

---

# Volunteer Wallet Relay (Mentioned for Spec Completeness)

```
"user_volunteer"
```

This is:
> User-initiated temporary volunteer relay, activated via frontend app

Will be:
- Toggle-based
- Time-bound
- No HQ auto-sync
- Full station auto-sync
- Mesh-only default
- Separate UX

We mention it in spec but defer implementation as of Phase 6 (March 30 2026 time of writing)

---

# Upstream Selection Rule (Applies to All Relay Types)

```
if station reachable:
    use station
elif HQ reachable:
    use HQ
else:
    mesh only
```

Never:
- Simultaneously pull HQ and station
- Compete with stations for bandwidth
- Spam surrounding infrastructure

Stations are authoritative sync anchors, relays leverage their capabilities.

---

# Identity & Pin Philosophy

You now have three pin lifetimes:

| Lifetime | Used By |
|-----------|----------|
| Permanent | Station, Static Relay |
| Semi-Permanent | Station Fallback |
| Ephemeral | Ferry, Volunteer |

This distinction will prevent design confusion later.

---
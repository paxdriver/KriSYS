# Relay Modes Matrix (Structured Spec Draft)
---

## Relay Mode Matrix v1
| Property | `LAN_amplifier` | `delivery_facilitation` | Volunteer Relay (Wallet) |
|------------|----------------|-------------------------|--------------------------|
| Deployment Context | Static infrastructure (camp LAN, hospital LAN, shelter router) | Mobile aid vehicle, helicopter, roaming logistics unit | User-enabled temporary relay |
| Container Type | Dedicated relay container | Dedicated relay container | Frontend (React) |
| Operational Intent | Extend LAN range and host public rooms | Physically move canonical data between disconnected clusters | Increase mesh density temporarily |
| Trust Level | Untrusted | Untrusted | Untrusted |
| Crisis Pin | Persistent | Ephemeral / easily resettable | Ephemeral (session-scoped) |
| Provisioning Method | Scan station QR | Scan station QR (preferred) | User toggle |
| HQ Provisioning Required | No | No | No |
| Reset / Wipe | Rare | Expected to be easy and frequent | Stop toggle |
| Upstream Preference | Station → HQ → Mesh | Station → HQ → Mesh | Station → Relay → Mesh (no HQ) |
| HQ Pull Behavior | Low-frequency fallback only | Only when isolated from stations | None |
| HQ Push Behavior | None (cannot originate transactions) | None | None |
| Block Retention | Full blockchain (if storage permits) | Full blockchain (strongly preferred) | Full blockchain while active |
| Queue Retention | Standard | Extended (to maximize ferry usefulness) | Standard |
| Auto-Connect | No | Yes (aggressive while active) | Manual |
| Auto-Broadcast / Discovery | Passive | Active discovery window | Passive |
| LAN Room Hosting | Yes | Yes | Yes |
| Telemetry Tagging | relay_role=LAN_amplifier | relay_role=delivery_facilitation | volunteer |
| Intended Lifespan | Long-term | Short-term / mission-based | Short session |

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
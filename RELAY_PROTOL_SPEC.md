# RELAY_PROTOCOL_SPEC.md  
*KriSYS Relay Protocol Specification v1.0*

---

# 1. Relay Modes Matrix (Deployment Profiles Overview)

The KriSYS Relay system supports multiple deployment contexts.  
All relay types share identical **protocol invariants**, but differ in:

- Deployment intent
- Sync cadence
- Reset ergonomics
- Retention tuning
- Operational lifespan

These are **operational profiles**, not different protocols.

---

## Relay Mode Matrix v1

| Property | `LAN_amplifier` | `delivery_facilitation` | Volunteer Relay (Wallet) |
|------------|----------------|-------------------------|--------------------------|
| Deployment Context | Static infrastructure (camp LAN, hospital LAN, shelter router) | Mobile aid vehicle, helicopter, roaming logistics unit | User-enabled temporary relay |
| Container Type | Dedicated relay container | Dedicated relay container | Frontend (React) |
| Operational Intent | Extend LAN range and host public rooms | Physically move canonical data between disconnected clusters | Increase mesh density temporarily |
| Trust Level | Untrusted | Untrusted | Untrusted |
| Crisis Pin | Persistent | Persistent (resettable at device level) | Session-scoped |
| Provisioning Method | Station-mediated provisioning | Station-mediated provisioning | User toggle |
| HQ Provisioning Required | No | No | No |
| Reset / Wipe | Rare | Expected to be easy and frequent | Stop toggle |
| Upstream Preference | Station → HQ → Mesh | Station → HQ → Mesh | Station → Relay → Mesh |
| HQ Pull Behavior | Low-frequency fallback only | Only when isolated from stations | None |
| HQ Push Behavior | None | None | None |
| Block Retention | Verified canonical suffix (bounded) | Verified canonical suffix (bounded) | Verified suffix while active |
| Queue Retention | Standard TTL | Extended TTL | Standard |
| Auto-Connect | No | Yes (aggressive while active) | Manual |
| LAN Room Hosting | Yes | Yes | Yes |
| Intended Lifespan | Long-term | Mission-based | Short session |

---

## Important

All relay profiles obey the same **core protocol invariants** defined below.

Profiles only modify:

- Sync aggressiveness
- TTL values
- Reset expectations
- Persistence duration

They do NOT modify:

- Crisis pin rules
- Canonical block verification rules
- Authority model

---

# 2. Relay Definition & Authority Model

A relay is:

- Not provisioned by HQ
- Not authenticated
- Not operationally trusted
- Cryptographically pinned to a single crisis
- Transport-only infrastructure

A relay:

- Cannot post transactions to HQ
- Cannot accept check-ins
- Cannot create alerts
- Cannot sign blocks
- Cannot assert confirmations without verified block proof
- Cannot provision stations

Relays exist to:

- Store verified canonical blocks
- Store unconfirmed relay-layer messages
- Propagate both between peers

Canonical authority derives exclusively from:

> HQ-signed canonical blocks

Relays are infrastructure multipliers, not authorities.

---

# 3. Relay Lifecycle

Relays operate in two deterministic states:

```
UNINITIALIZED → PINNED
```

---

## 3.1 UNINITIALIZED

Relay has:

- No crisis_id
- No block_public_key
- No trust anchor
- No canonical chain

In this state:

- Relay does NOT serve normal `/mesh/*` endpoints
- Relay does NOT auto-pin from arbitrary peers
- Relay only accepts `/relay/provision`

Purpose:

Prevent trivial LAN denial-of-service via malicious first contact.

---

## 3.2 PINNED

Relay has:

- crisis_id (immutable)
- block_public_key (immutable)
- Verified genesis block
- Verified canonical block suffix

In this state:

- Relay accepts `/mesh/inventory`
- Relay accepts `/mesh/sync`
- Relay verifies canonical blocks
- Relay derives confirmations
- Relay participates in mesh transport

Returning to UNINITIALIZED requires:

- Explicit device wipe
- Database reset
- Manual operator action

No runtime crisis switching is allowed.

---

# 4. Relay Provisioning

## 4.1 Provisioning Authority

Relays must be provisioned by a station.

Stations:

- Are provisioned by HQ
- Are pinned to a crisis
- Are operationally trusted
- Provide correct trust anchor

Relays do NOT auto-pin from wallets.

---

## 4.2 Provisioning Endpoint

```
POST /relay/provision
```

Payload must include:

- crisis_id
- block_public_key
- genesis_block
- canonical block suffix (bounded)

Relay must:

1. Verify genesis block hash(body)
2. Verify genesis signature(header)
3. Store crisis_id
4. Store block_public_key
5. Store verified blocks
6. Transition to PINNED

If already PINNED:

- Reject provisioning
- Never allow crisis switching

---

# 5. Crisis Pin Invariants

Once PINNED:

- crisis_id is immutable
- block_public_key is immutable
- All incoming requests must match pinned crisis_id
- If block_public_key provided in request, it must match pinned key
- Reject all mismatches

A relay is forever bound to one crisis unless wiped.

---

# 6. Canonical Block Handling

Relays apply identical verification rules as stations.

For each incoming block:

1. Verify SHA-256 hash(body)
2. Verify PGP signature(header)
3. Enforce strict chain linkage
4. Reject forks
5. Reject mismatched previous_hash
6. Ignore conflicting blocks

Relays store:

- Only verified canonical blocks
- A bounded suffix (`MAX_BLOCKS_STORED`)

Relays derive confirmations:

- Extract relay_hash from transactions
- Mark relay_hash confirmed
- Remove from queued storage

Relays never accept peer “confirmed maps” as proof.

---

# 7. Relay Message Handling

Relay-layer items:

- Identified solely by relay_hash
- Deduplicated by relay_hash
- Sanitized before storage
- Bounded by payload limits
- Confirmed only via canonical block inclusion

Relays enforce:

- Max payload size
- Field shape validation
- Timestamp bounds
- Address count limits
- Per-origin rate limits

Relays never:

- Expand family-scoped addresses
- Modify transaction content
- Assert confirmation without block proof

---

# 8. Sync Model

All sync is bilateral:

```
Node A → Node B
```

Relay may sync with:

- Stations
- Other relays
- Clients

Relays:

- Never initiate authoritative behavior
- Never override canonical linkage
- Only propagate verified blocks and sanitized relay-layer messages

---

# 9. Upstream Selection Rule

Applies to all relay profiles.

```
if station reachable:
    use station
elif HQ reachable:
    use HQ
else:
    mesh only
```

Relays must never:

- Pull HQ and station simultaneously
- Compete with stations for bandwidth
- Spam surrounding infrastructure

Stations remain authoritative anchors.

Relays leverage stations.

---

# 10. Operational Profiles

All profiles inherit core protocol invariants.

Profiles modify cadence and retention only.

---

## 10.1 Static Infrastructure Relay

```
relay_role = "LAN_amplifier"
```

Purpose:

> A LAN amplifier, not a data mover.

Characteristics:

- Stable deployment
- Persistent crisis pin
- Low-frequency HQ fallback
- Pull primarily from station
- Host public LAN rooms
- Standard TTL retention

This relay is:

Polite, stable, unimportant to consensus.

---

## 10.2 Mobile Ferry Relay

```
relay_role = "delivery_facilitation"
```

Purpose:

> A packet mule moving canonical data between disconnected clusters.

Characteristics:

- Mission-based deployment
- Device-level reset expected
- Aggressive sync when peers detected
- Prefer station over HQ
- Extended TTL for queued messages
- Full canonical suffix retention preferred

Reset model:

- Single wipe command
- Return to UNINITIALIZED
- Re-provision via station

Important:

Ephemeral reset does NOT mean dynamic crisis switching while active.

Pin remains immutable until wipe.

---

## 10.3 Station Fallback Relay

Occurs when:

- Station identity revoked
- API key invalid
- Provisioning rejected

Behavior:

- Downgrade to relay mode
- No check-ins
- No HQ posting
- Retain crisis pin
- Continue mesh transport

This is:

> A degraded operational endpoint.

---

## 10.4 Volunteer Wallet Relay

```
relay_role = "user_volunteer"
```

User-initiated temporary relay.

Characteristics:

- Session-scoped
- No HQ auto-sync
- Mesh-only default
- Full canonical suffix while active
- Toggle-based UX

Implementation deferred beyond Phase 6.

---

# 11. Load & Fairness

Relays enforce:

- Bounded relay inventory
- Bounded block suffix
- TTL pruning
- High/low water storage limits

Relays may sync more frequently than stations.

Stations prioritize:

1. Clients
2. HQ sync
3. Peer sync

Relays prioritize:

1. Transport availability
2. Canonical verification
3. Propagation efficiency

---

# 12. Failure Handling

If sync fails:

- Abort immediately
- Retry later
- Remain passive

If verification fails:

- Reject block
- Continue operation

If storage pressure exceeds threshold:

- Pause intake
- Prune according to policy
- Resume when safe

Relay failure cannot corrupt canonical history.

---

# 13. Security Guarantees

Relay Protocol ensures:

- Canonical truth derived only from HQ-signed blocks
- No relay can assert confirmations without block proof
- No relay can inject unsigned canonical history
- Crisis pin is immutable
- Relay compromise cannot forge confirmations
- Relay misbehavior cannot corrupt chain state

Relays are infrastructure, not authority.

---

# 14. Design Philosophy

This protocol prioritizes:

- Determinism
- Crisis isolation
- Minimal authority
- Infrastructure modularity
- Bounded resource usage
- Field resilience

Stations coordinate.

HQ defines truth.

Relays amplify transport.

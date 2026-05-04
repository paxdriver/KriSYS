# KriSYS — Station Cooperation Protocol v1
*(deterministic behavioral specification draft as of March 2 2026)*

---

## 1. Purpose
The Station Cooperation Protocol defines how authorized stations:

- Discover peer stations
- Synchronize canonical blockchain state
- Exchange unconfirmed messages (relay layer)
- Converge toward shared inventory
- Operate autonomously while offline
- Resume safe behavior when connectivity to HQ returns

This protocol governs station ↔ station behavior only.

It does not define:

- Client sync behavior
- Beacon/distress mode
- Storage eviction policies
- Admin provisioning flows
- HQ mining policy

---

## 2. Roles & Trust Model

### 2.1 Station Definition
A station is:

- Provisioned by HQ
- Authenticated via API key
- Operationally trusted
- Cryptographically untrusted
- Not a source of canonical truth

Stations:

- Cannot sign blocks
- Cannot assert confirmations
- Cannot create alerts
- Cannot forge canonical state

Canonical truth is derived exclusively from:

- Verified blocks signed by HQ master key.

---

## 3. Peer Discovery Model

### 3.1 Source of Peer List
Stations obtain the list of authorized stations from HQ.

- Pulled after provisioning
- Refreshed whenever HQ connectivity is available
- Stored locally in station DB

### 3.2 No Autonomous LAN Scanning
Stations do not:

- Scan LAN for unknown peers
- Auto-trust unknown endpoints
- Join unrecognized station identities

Peer identity must match HQ-provided station list.

### 3.3 Unlimited Peers
Stations may maintain any number of peer stations.

However:

- Only one inter-station sync may occur at a time.
- Peer syncs are serialized.

---

## 4. Station Operational Loops

Stations operate two independent loops:

### 4.1 Loop A — Client Priority Loop (High Frequency)
**Purpose:**

- Serve clients
- Accept check-ins
- Accept queued messages
- Serve blocks
- Serve confirmations

**Characteristics:**

- Highest priority
- Preempts peer sync if under load
- Fair scheduling per client
- Bounded per-client payload

### 4.2 Loop B — Peer Cooperation Loop (Lower Frequency)
**Purpose:**

- Synchronize with other stations
- Exchange relay inventory
- Exchange block suffixes
- Increase redundancy

**Characteristics:**

- Runs on schedule (e.g., every N minutes)
- Skipped if client load high
- Serialized (one peer at a time)
- Bounded payload per sync
- Safe to abort mid-cycle

## JARGON - POOL vs ROOM
### POOL is:
- Trusted station hosting several p2p connections and coordinates data distribution

### ROOM is:
- Individual user hosts an untrusted room, same as pools but user-initiated
- User-initiated, untrusted WebRTC session (direct peer connection).
- Functionally similar transport layer, but without trusted station coordination.

### RELAY is a an untrusted peer, functionally acts like a room

```
[ Station Connect ]
   - Select Station
   - Allocate Offer (POST /station/allocate-offer)
   - Connect

[ Discover Stations on same LAN as connected station ]
   - GET /station/peers
   - Save stations

[ Direct Room (Manual) ]
   - Create Offer (client-side)
   - Paste Offer / Scan QR
   - POST /answer (Node on port 7000)
```

Stations on same LAN can discover one another and present them to a connected user for alternative connections and to save adjascent stations to local storage. This is ```localhost:6001/station/peers``` in dev.

Stations independent who broadcast an AP can be connected to manually by QR presented at the station. This is ```localhost:6003/station/allocate-offer``` in dev.

---

## 5. Bilateral Station Sync Protocol
All station cooperation is strictly bilateral.

There is no multi-peer coordination phase.

Each sync cycle involves:

- Station A → Station B

---

## 6. Sync Handshake Flow
Each peer sync follows this deterministic sequence:

### Step 1 — Identity & Tip Exchange
Station A sends:

- `crisis_id`
- `station_id`
- `chain_tip`:
  - `block_index`
  - `block_hash`
- `relay_hash_inventory` (bounded list)
- `confirmed relay hashes` (optional, bounded)

Station B validates:

- `crisis_id` matches
- `station_id` is authorized
- request format valid

### Step 2 — Block Divergence Check
Station B compares:

- A’s `block tip` vs local tip

Cases:

- **Case 1:** Tips identical  
  → No canonical block transfer needed.

- **Case 2:** B ahead of A  
  → B returns block suffix (bounded).

- **Case 3:** A ahead of B  
  → A will later provide suffix during reverse cycle.

Stations do not:

- Attempt fork resolution
- Accept unsigned blocks
- Accept mismatched hash blocks

Only verified canonical blocks are stored.

### Step 3 — Relay Inventory Comparison
Station B computes:

- `missing_relay_hashes` = hashes in A not present locally

Station B returns:

- `missing_relay_hashes`
- optionally block suffix

### Step 4 — Relay Payload Transfer
Station A sends:

- Full payloads for requested `relay_hashes`
- Bounded to `MAX_QUEUED_PER_PAYLOAD`

Station B:

- Sanitizes
- Deduplicates
- Stores if accepted
- Rejects if storage rules violated

### Step 5 — Completion
Peer sync ends.

Next peer scheduled later.

No further coordination required.

---
### Core Invariants Summary
#### Invariant 1 - Confirmation truth
If relay_hash is in a verified block
→ it MUST be in confirmed
→ it MUST NOT be in queued
#### Invariant 2 - Queue correctness
queued ∩ confirmed = ∅
#### Invariant 3 - Convergence
If two nodes have same chain_tip
→ eventually queued sets converge to same state
#### Invariant 4 - No phantom requests
If queued is empty
→ want_relay_hashes MUST be empty
#### Invariant 5 - Block authority
Only blocks can confirm relay_hash

#### Debugging Sync Logic
Invariant 1 broken → check confirmation logic
Invariant 3 broken → check block propagation
Invariant 4 broken → check inventory logic

Does relay have block? → no → propagation bug
Does relay confirm? → no → confirmation bug
Does relay prune? → no → queue bug

---

## 7. Convergence Model
Convergence is incremental.

Because:

- Payload sizes are bounded
- Relay inventory is bounded
- Block suffix is bounded

**Full convergence** may require multiple cycles.

This is acceptable and expected.

No global coordination phase exists.

---

## 8. Failure Handling
If peer sync fails:

- Abort immediately
- Log event
- Continue next scheduled cycle
- Do not block other peers

If peer repeatedly unreachable:

- Remains in peer list
- Future cycles may retry
- No automatic peer removal
- Revocation handled only by HQ.

---

## 9. Online Reconnection Behavior
When station regains internet:

- Immediately pull blocks from HQ.
- Immediately flush:
  - Check-ins
  - Queued messages
- Derive confirmations from verified blocks.
- Resume normal operation.

HQ does not:

- Prioritize stations over clients via blocking.
- Proxy traffic.
- Act as traffic arbiter.

Stations reduce HQ load because:

- Clients prefer station over HQ.

---

## 10. Canonical Block Handling Rules
Stations:

- Accept only signed blocks
- Verify hash(body)
- Verify PGP signature(header)
- Enforce chain linkage
- Reject forks
- Reject mismatched `previous_hash`
- Reject unsigned blocks

Stations do not:

- Accept peer confirmations without block proof
- Trust peer “confirmed maps” without block presence

---

## 11. Relay Handling Rules
Relay items:

- Identified solely by `relay_hash`
- Deduplicated by `relay_hash`
- Confirmed only via canonical blocks
- Stored as unconfirmed until block inclusion

Stations never:

- Assert confirmation without block proof
- Accept duplicate `relay_hash`
- Accept malformed payloads

---

## 12. Load & Fairness Constraints
The protocol enforces:

- Bounded relay inventory per sync
- Bounded block suffix per sync
- One peer sync at a time
- Peer sync preemptible by client load

The protocol does not enforce:

- Storage eviction policies
- Queue TTL rules
- Back-pressure logic

Those are station lifecycle concerns.

---

## 13. Explicit Non-Goals (v1)
This protocol does **NOT** include:

- Beacon/distress mode
- Multi-peer gossip graph
- Global station coordination
- Storage pressure negotiation
- QoS scheduling beyond fairness

These are future enhancements.

---

## 14. Security Guarantees
The protocol ensures:

- Canonical truth derived only from HQ-signed blocks
- No peer can assert confirmations
- No peer can inject unsigned canonical history
- Relay payloads are bounded and sanitized
- Station cooperation cannot corrupt chain state

---

## 15. Design Philosophy
This protocol prioritizes:

- Determinism
- Simplicity
- Bounded resource usage
- Incremental convergence
- Explicit trust boundaries
- Future extensibility
# KriSYS — Station Cooperation Protocol v1.1  
*(Authoritative Station Behavior + Relay Interaction Context)*

---

## 1. Purpose

The Station Cooperation Protocol defines how **authorized stations**:

- Discover peer stations  
- Synchronize canonical blockchain state  
- Exchange unconfirmed relay-layer messages  
- Converge toward shared inventory  
- Operate autonomously while offline  
- Resume safe behavior when HQ connectivity returns  

This protocol governs:

- **Station ↔ Station behavior**
- **Station ↔ Relay interaction**
- **Station ↔ Client behavior (high-level only)**

It does **not** define:

- Relay provisioning mechanics (see Relay Provisioning Protocol)
- Client UX flows
- Storage eviction policy details
- HQ mining policy
- Beacon/distress mode

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
- Cannot assert confirmations without block proof  
- Cannot create canonical alerts outside HQ  
- Cannot fork or rewrite history  

Canonical truth is derived exclusively from:

- **Verified blocks signed by the HQ master key**

---

### 2.2 Relay Definition (Context for Station Behavior)

A relay is:

- Not provisioned by HQ  
- Not authenticated  
- Not operationally trusted  
- Cryptographically pinned to a single crisis  
- Transport-only  

Relays:

- Cannot post transactions to HQ  
- Cannot accept check-ins  
- Cannot provision other nodes  
- Cannot assert confirmations without verified blocks  
- Store verified blocks + unconfirmed messages  
- Act as infrastructure access points  

Stations treat relays as:

- Passive transport peers  
- Untrusted but useful propagation nodes  
- Bandwidth multipliers  

Stations **never trust relays for authority** — only for transport.

---

## 3. Peer Discovery Model

### 3.1 Station Peer Source

Stations obtain the list of authorized stations from HQ:

- Pulled after provisioning  
- Refreshed whenever HQ connectivity is available  
- Stored locally  

Stations only sync with stations present in this list.

---

### 3.2 Relay Discovery

Relays:

- Do not appear in HQ station lists  
- May be discovered via:
  - Manual configuration
  - LAN presence
  - Known endpoints
  - Station advertisement mechanisms  

Stations treat relays as:

- Optional mesh amplifiers  
- Not part of the authoritative peer graph  

---

### 3.3 No Autonomous Trust Expansion

Stations do not:

- Auto-trust unknown station identities  
- Promote relays into station status  
- Accept canonical authority from peers  

---

## 4. Operational Loops

Stations operate multiple independent loops.

---

### 4.1 Loop A — Client Priority Loop (High Frequency)

**Purpose**

- Serve clients  
- Accept check-ins  
- Accept unconfirmed messages  
- Serve canonical blocks  
- Serve confirmations  

**Characteristics**

- Highest scheduling priority  
- Preempts peer sync under load  
- Fair scheduling per client  
- Bounded payload size  

Relays may serve similar client sync endpoints, but:

- Relays do not accept check-ins  
- Relays do not flush to HQ  

---

### 4.2 Loop B — Peer Cooperation Loop (Lower Frequency)

**Purpose**

- Synchronize with peer stations  
- Exchange relay inventory  
- Exchange canonical block suffix  
- Increase redundancy  

**Characteristics**

- Scheduled cadence  
- Serialized (one peer at a time)  
- Bounded payload  
- Abort-safe  

---

### 4.3 Loop C — Relay Interaction Loop

Stations may:

- Sync with relays  
- Pull missing blocks  
- Push missing unconfirmed relay payloads  

Relays:

- Do not initiate authoritative behavior  
- Only respond to inventory/sync exchanges  

Stations remain responsible for:

- HQ flush  
- Check-in posting  
- Crisis integrity  

---

## 5. Terminology — Pool vs Room vs Relay

### Pool

- Hosted by station  
- Trusted operationally  
- Coordinates multiple P2P clients  
- May advertise peers on LAN  

### Room

- User-hosted WebRTC session  
- Untrusted  
- Ephemeral  
- No coordination logic  

### Relay

- Infrastructure node  
- Untrusted  
- Long-running  
- Stores verified blocks + unconfirmed messages  
- Does not coordinate like station  

---

## 6. Bilateral Sync Model

All cooperation is strictly bilateral.

There is:

- No global graph sync
- No gossip storm
- No multi-peer broadcast phase

Each cycle involves:

```
Node A → Node B
```

Node may be:

- Station ↔ Station
- Station ↔ Relay

Relay ↔ Relay sync is permitted but non-authoritative.

---

## 7. Sync Handshake Flow

### Step 1 — Identity & Tip Exchange

Station A sends:

- crisis_id  
- station_id (if station)  
- chain_tip:
  - block_index  
  - block_hash  
- relay_hash_inventory (bounded)  
- optional confirmed relay hashes (bounded)  

Station B validates:

- crisis_id matches  
- If station peer → station_id authorized  
- Request format valid  

Relays validate:

- crisis_id matches pinned crisis  
- block_public_key matches pinned trust anchor  

---

### Step 2 — Block Divergence Check

Station compares tips.

Cases:

1. Tips identical → no transfer  
2. Peer ahead → return block suffix (bounded)  
3. Self ahead → provide suffix in reverse cycle  

Rules:

- No fork resolution  
- No unsigned blocks  
- No mismatched previous_hash  
- Only verified canonical blocks stored  

Relays apply identical block verification rules.

---

### Step 3 — Relay Inventory Comparison

Station computes:

```
missing_relay_hashes
```

Return:

- missing_relay_hashes  
- optionally block suffix  

Relays perform same comparison but do not assert authority.

---

### Step 4 — Relay Payload Transfer

Sender transmits:

- Full payloads for requested relay_hashes  
- Bounded to MAX_QUEUED_PER_PAYLOAD  

Receiver:

- Sanitizes  
- Deduplicates  
- Stores if valid  
- Rejects malformed payloads  

No peer can assert confirmation without block proof.

---

### Step 5 — Completion

- Sync ends deterministically  
- Next peer scheduled later  
- No cascading propagation phase  

---

## 8. Convergence Model

Convergence is incremental.

Because:

- Block suffix is bounded  
- Relay inventory is bounded  
- Payload transfer is bounded  

Multiple cycles may be required.

This is intentional.

---

## 9. Online Reconnection Behavior

When station regains internet:

- Immediately pull blocks from HQ  
- Immediately flush:
  - Check-ins  
  - Queued messages  
- Derive confirmations from verified blocks  
- Resume normal operation  

Relays:

- May pull blocks if configured  
- Never post to HQ  
- Never assert canonical authority  

---

## 10. Canonical Block Handling Rules

Stations:

- Accept only signed blocks  
- Verify hash(body)  
- Verify PGP signature(header)  
- Enforce chain linkage  
- Reject forks  
- Reject mismatched previous_hash  
- Reject unsigned blocks  

Relays:

- Apply identical verification rules  
- Never override canonical linkage  
- Never accept conflicting blocks  

---

## 11. Relay Handling Rules (Station Perspective)

Relay items:

- Identified solely by relay_hash  
- Deduplicated by relay_hash  
- Confirmed only via canonical blocks  
- Stored as unconfirmed until block inclusion  

Stations:

- Do not trust relay-confirmed maps  
- Derive confirmation only from verified blocks  

Relays:

- Never assert confirmation  
- Never alter canonical state  

---

## 12. Load & Fairness Constraints

The protocol enforces:

- Bounded relay inventory per sync  
- Bounded block suffix per sync  
- Serialized peer sync  
- Client loop priority over peer loop  

Stations prioritize:

1. Client servicing  
2. HQ synchronization  
3. Peer synchronization  

Relays prioritize:

1. Block verification  
2. Relay storage  
3. Mesh transport  

---

## 13. Failure Handling

If peer sync fails:

- Abort immediately  
- Log event  
- Continue next scheduled cycle  

Repeated unreachable peers:

- Remain in peer list  
- Retry later  
- Revocation handled only by HQ  

---

## 14. Security Guarantees

The protocol ensures:

- Canonical truth derived only from HQ-signed blocks  
- No peer can assert confirmations without block proof  
- No peer can inject unsigned canonical history  
- Relay payloads are bounded and sanitized  
- Station cooperation cannot corrupt chain state  
- Relays cannot escalate authority  

---

## 15. Design Philosophy

This protocol prioritizes:

- Determinism  
- Simplicity  
- Explicit trust boundaries  
- Bounded resource usage  
- Incremental convergence  
- Operational clarity  
- Infrastructure modularity (station ≠ relay)  

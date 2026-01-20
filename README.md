# KriSYS – Crisis Communication Ledger (Blockchain-Verified Messaging)

KriSYS is a humanitarian crisis communication system designed to keep working
during disasters and hostile conditions (rolling blackouts, poor cell service,
warzone interference). It behaves like a blockchain-based message ledger where
a crisis organization mines a single canonical chain, and everyone can verify
confirmed history offline. This enables victims to supply family members and
friends abroad with their wallet addresses so that concerned loved ones can
efficiently check in on their loved ones enduring any crisis ranging from war
zone to national disaster relief and everything in between.

The goal is *not* cryptocurrency. “Transactions” are:
- encrypted family/group messages
- authorized station check-ins (aid trucks, hospitals, camps, etc.)
- emergency alerts

KriSYS emphasizes:
- offline-first operation
- deterministic verification (bit-for-bit hashing and signature checks)
- privacy by default (no personal names on-chain; local-only contact labels)

---

## Primary Use Cases

- Aid coordination: alerts and operational messaging
- Inventory of supplies by location
- Data for administration and political accountability
- Check-in by QR codes
- Help identifying unconscious / deceased victims
- Reuniting families: QR-based identity and check-ins
- Offline message delivery: send/relay messages without internet
- Offline proof: verify mined history offline via signed blocks
- Low-complexity workflows: designed for high-stress, low-tech environments

---

## Current Status

### Current milestone: Phase 3.7 complete
Phase 3.7 completed the “station pooled rendezvous” architecture:
- offline message queuing on clients
- station-side pooled relay and dedupe
- station flush to central when connectivity returns
- mined block confirmation propagation back through stations
- offline check-in intake and flush via station
- verified block propagation and confirmation pruning (relay_hash based)

Next milestone: Phase 3.8
- Expand pooled rendezvous syncing to work without an authorized station
  (untrusted pool hosts and “dumb relays”), using the same inventory/sync rules.

---

## Core Architecture

### Central backend (crisis authority)
- Single canonical chain
- Only the aid organization mines blocks (no forks)
- Every mined block is signed by a crisis master key
- Clients verify blocks offline using the public key pinned in genesis metadata

### Clients (browsers, later native)
- Encrypt/decrypt messages client-side
- Maintain a local cache of canonical blocks for offline access
- Maintain a local queue of unconfirmed transactions
- Prune local queue when relay_hash is confirmed by a verified block

### Pooled rendezvous relays (offline infrastructure)
KriSYS does not require pairwise peer-to-peer gossip as the primary model.
Instead, it uses pooled rendezvous sync:
- Devices connect to a pool host (station / untrusted relay / temporary user pool)
- Clients perform an inventory handshake (relay_hash lists)
- Clients send only missing items
- Pool host dedupes and redistributes

This avoids N×N pairwise syncing and scales much better for camps/shelters.

---

## Trust Model (Non-negotiable)

### Trust anchor
- The trust anchor is the crisis `block_public_key` (public key used to verify
  signatures on mined blocks).
- The `block_public_key` is published in genesis metadata.
- Devices must bootstrap from a trusted central source at least once (TLS /
  trusted provisioning). Without the correct key, nothing can be verified.

### Untrusted offline relays
Offline peers (including untrusted pool hosts) are untrusted. They can:
- relay unconfirmed encrypted payloads
- relay signed blocks (which can be verified offline)

They cannot:
- forge confirmations (confirmations are derived only from verified blocks)
- forge canonical blocks (signatures won’t verify)

---

## IDs and Timestamp Units (Strict)

### IDs
- relay_hash:
	- UUID generated at the edge (client or station)
	- stable identity for offline relay, dedupe, and later confirmation
	- mesh logic depends on relay_hash, not transaction_id
- transaction_id:
	- server-generated UUID after central acceptance
	- exists only after posting to the central backend

### Timestamp units
Blockchain (deterministic; integer seconds):
- Transaction.timestamp_created: seconds
- Transaction.timestamp_posted: seconds
- Block.timestamp: seconds

Local bookkeeping (non-deterministic; integer milliseconds):
- queuedAt: ms
- generatedAt: ms
- confirmedAt: ms

Avoid floats anywhere.

---

## Deterministic Hashing and Signatures (Bit-for-bit)

All canonical verification depends on deterministic encoding. Bytes must match
exactly between Python and JavaScript.

### Block hash (body)
Block hash is SHA-256 of UTF-8 bytes of canonical JSON of:

- { block_index, timestamp, transactions, previous_hash, nonce }

Canonical JSON rules:
- sorted keys
- separators=(",", ":")
- ensure_ascii=False
- UTF-8 encoding

### Block signature (header)
Block signature is a detached PGP signature over canonical JSON of:

- { block_index, previous_hash, hash }

Same canonical JSON rules as above.

### Canonical chain verification (client/station)
A block is canonical iff:
- recomputed hash(body) equals block.hash
- PGP signature verifies over the canonical header using pinned block_public_key
- chain linkage is correct when appending:
	- previous_hash matches current tip hash
	- block_index increments by 1
- no forks are allowed; conflicts are ignored

---

## Addressing and Privacy Semantics

Wallets represent families/groups.
- family_id: the wallet identifier
- member addresses: family_id + “-suffix” (one per member)

related_addresses may contain:
- individual member addresses (family_id-suffix)
- the family_id itself (family-scoped)

Privacy constraint:
- Do not expand a family-scoped event into all member addresses, because that
  leaks family size and increases chain bloat.

UI rule:
- Wallet dashboards consider a transaction relevant if related_addresses includes
  either:
	- any member address in the wallet, or
	- the wallet’s family_id (family-scoped events)

---

## Offline Message and Confirmation Semantics

### Unconfirmed transactions
- Stored locally in a queue (relay_hash is the dedupe identity).
- Can be exchanged through pooled rendezvous syncing while offline.
- Must pass smell tests before being stored/relayed:
	- bounded sizes
	- bounded counts
	- shape validation
	- dedupe by relay_hash

### Confirmations
- A message/check-in is “confirmed” only when its relay_hash appears in a
  verified mined block.
- Confirmations propagate offline by relaying verified blocks.
- Queue pruning happens when a relay_hash is confirmed.

---

## Pooled Rendezvous Relay Modes (Phase 3.8 direction)

KriSYS uses pooled rendezvous syncing rather than requiring pairwise peer gossip.

Mode A — Authorized Station (operationally trusted pool host)
- Has a verified station API key (for central /checkin).
- Can submit check-ins to central.
- Can flush queued data to central.
- Can pull blocks from central when connectivity returns.
- Cannot forge confirmations (still derived only from signed blocks).
- Trust: operationally trusted, cryptographically untrusted.

Mode B — Untrusted Relay (dumb rendezvous box)
- No blockchain credentials.
- No private keys.
- Cannot decrypt messages.
- Stores and redistributes:
	- unconfirmed encrypted payloads (dedupe by relay_hash)
	- verified blocks (propagate confirmations)
- Cannot submit check-ins to central.
- Trust: fully untrusted, but safe because blocks are verifiable and messages are
  encrypted.

Mode C — Temporary User Pool (untrusted, user-hosted pool)
- A user can choose to open a temporary pool/room during a sync window.
- Other users opt-in to sync with it.
- Same capabilities and trust limitations as Mode B.

Operational model for safety and privacy:
- No background discovery or continuous beaconing by default.
- Scheduled sync windows (user opt-in) rather than continuous scanning.
- “Always-on” operation is an explicit user choice for special cases
  (rescue/search, stranded users).

---

## Check-in Stations (Authentication and Offline Behavior)

Stations authenticate check-ins to the central backend via API key:
- Header: X-Station-API-Key
- Body includes:
	- address (member address or family_id)
	- station_id
	- relay_hash (for offline dedupe/confirmation)
	- timestamp_created (seconds; preserve offline scan time)

Offline check-ins:
- The station device can accept check-ins locally while offline and queue them.
- When connectivity returns, the station flushes queued check-ins to central.
- Confirmations are derived when the relay_hash appears in a verified block.

Development note:
- Station plaintext API keys are stored in:
	station_identity_<STATION_ID>.json
  in the station’s mounted volume so the station can flush check-ins without
  manual copy/paste in dev.

---

## Dev Reset / Clean Slate Behavior (Strict)

To reset the entire crisis instance in development:
- delete: blockchain/dev_policy_id.txt

This triggers regeneration of:
- central blockchain DB
- master key files
- station DB
- station identity files

This prevents accidental mixing of:
- different crisis_id values
- different block_public_key trust anchors
- stale station provisioning data

---

## Development and Testing Notes (High level)

Typical offline workflow tests:
- create two wallets (A and B)
- unlock once to cache needed keys
- send messages while “offline mode” is enabled (queued locally)
- sync to a pool (authorized station in Phase 3.7)
- flush station to central
- mine a block
- sync again to propagate blocks and confirmations
- verify queues prune only on confirmed relay_hash in verified blocks

Phase 3.8 testing goal:
- replicate “camp LAN” conditions using an isolated local network where a pool
  host exists but central internet does not.
- validate pooled rendezvous sync without manual copy/paste where possible
  (local rendezvous host for signaling and/or pooled HTTP sync).

---

## API Overview (Selected)

Central backend:
- GET /crisis
- GET /blockchain
- POST /transaction (messages)
- POST /checkin (station-authenticated check-ins)
- POST /admin/mine
- POST /admin/alert
- POST /auth/unlock
- POST /wallet

Station server:
- POST /mesh/inventory
- POST /mesh/sync
- POST /station/checkin (offline intake)
- POST /station/flush (flush + pull blocks + derive confirmations)

---

## File Structure (comprehensive)

./krisys-backend
├── app.py
├── blockchain
│   ├── master_private_key.asc
│   ├── master_private_key.asc
│   └── dev_policy_id.txt
├── device-offline-server (simulating an offline registered station, relaying unconfirmed messages and maintaining latest blocks from anyone who visits and has a newer block that the station can verify and propagate throughout the rest of the network while offline)
│   ├── station-data  (simulating offline station persistent storage for blockchain and message queues when gathering offline unconfirmed transactions)
│   │   └── station.db
│   │   └── station_identity_*.json (the persistent api keys for authorized stations in lieu of wallet passphrases)
│   ├── app.py
│   └── Dockerfile
├── blockchain.db
├── blockchain.py
├── database.py
├── Dockerfile
├── requirements.txt
├── templates
│   ├── admin.html
│   ├── error.html
│   ├── index.html
│   ├── scanner.html
│   └── wallet_dashboard.html
./krisys-frontend
├── app
│   ├── globals.css
│   ├── layout.js
│   ├── page.js
│   ├── page.module.css
│   └── wallet
│       └── [familyId]
│           └── page.js
├── blockchain
├── components
│   ├── BlockchainExplorer
│   │   ├── BlockchainMeta.js
│   │   ├── BlockList.js
│   │   ├── index.js
│   │   └── WalletCreator.js
│   ├── DevTools
│   │   ├── devtools.css
│   │   └── index.js
│   ├── Scanner
│   │   └── QRScanner.js
│   └── WalletDashboard
│       ├── ContactName.js
│       ├── ContactPage.js
│       ├── index.js
│       ├── MembersOverview.js
│       ├── MembersPage.js
│       ├── MessageDisplay.js
│       ├── MessagingPage.js
│       ├── Overview.js
│       ├── RecentActivity.js
│       ├── Sidebar.js
│       ├── TransactionItem.js
│       └── UnlockForm.js
├── Dockerfile
├── package.json
├── package-lock.json
├── pages
│   └── api
│       ├── admin.js
│       └── public-key.js
├── README.md
├── services
│   ├── api.js
│   ├── blockVerifier.js
│   ├── contactStorage.js
│   ├── keyManager.js
│   └── localStorage.js
├── styles
│   ├── components
│   │   ├── scanner.css
│   │   └── wallet.css
│   ├── index.css
│   ├── landing.css
│   └── wallet_dashboard.css

LOCAL PORTS (DEV)
- backend: http://localhost:5000
- frontend: http://localhost:3000
- station: http://localhost:6001

---

## Security and Privacy (What KriSYS tries to guarantee)

- Canonical history is verifiable offline:
	- blocks must pass hash + signature verification
- Offline relays are untrusted:
	- no relay can “assert confirmation” without providing signed blocks
- Personal messages are encrypted end-to-end:
	- relays can store/forward ciphertext only
- No personal names are stored on-chain:
	- contact names are local-only

What KriSYS does not guarantee (realistic constraints):
- RF-layer tracking resistance:
	- WiFi/Bluetooth radios can leak physical presence at the network layer.
- Full metadata secrecy:
	- addresses and timing patterns can still leak under active surveillance.

KriSYS mitigations:
- scheduled sync windows and opt-in participation by default
- avoid stable device identifiers in payloads
- bounded payload sizes and strict validation

---

## Roadmap (Updated)

Phase 1: Core chain and persistence
- blocks/transactions
- SQLite persistence
- deterministic hashing
- mining

Phase 2: Wallets and messaging
- family wallets
- PGP key management
- client-side encryption/decryption
- local contact names

Phase 3.0–3.7: Offline pooling via authorized stations (complete)
- relay_hash queue + confirmation pruning
- station pooled relay (inventory/sync)
- station flush to central
- offline check-ins queued and flushed
- family-scoped addressing in UI

Phase 3.8: Pooled rendezvous without authorized stations (next)
- untrusted pool host mode (user-hosted or dumb relay boxes as no-trust stations)
- scheduled sync window UX, push notification reminders of manual opt-in sync sessions
- transport experimentation (likely WebRTC data channels, but protocol stays the same)
- prioritizing transactions and sync'ed data (blocks, alerts, station check-ins, then people)

Phase 4: Enhancements
- UX polish (threads, notifications, user preferences including offline connectivity mode selection)
- pruning strategies for local block storage
- station registration wizard (one-time codes for api keys)
- revocation workflows and operational tooling (esp. RE: stations)
- decommission wallets in case compromised or joining another active wallet (helps data analysts)
- automating relay nodes
- automating station 

Phase 5: Testing
- UI flows to and fro features of the app
- handling of corrupted blocks
- hanlding of hash_relay conflicts
- local storage management, pruning, manual purging
- rate limiting under load and abuse (automating address bans?)
- station relays
- user relays
- local database permissions
- sandboxing
- DoS, command injections, XSS, and malicious attacks

---
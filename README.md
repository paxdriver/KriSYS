# KriSYS – Crisis Communication Ledger (Blockchain-Verified Messaging)

KriSYS is a humanitarian crisis communication system designed to keep working
during disasters and hostile conditions (rolling blackouts, poor cell service,
warzone interference). 

It behaves like a blockchain-based message ledger where
a crisis organization mines a single canonical chain, and everyone can verify
confirmed history offline.

This enables victims to supply family members and
friends abroad with their wallet addresses so that concerned loved ones can
efficiently check in on their loved ones enduring any crisis ranging from war
zone to national disaster relief and everything in between.

## <center> The goal is *not* cryptocurrency. </center>

<br>

“Transactions” are:
- encrypted family/group/individual messages (obfuscation, as are wallet/individuals' addresses)
- authorized station check-ins (aid trucks, hospitals, camps, etc.)
- emergency alerts issued by the blockchain service provider (aid organization)

KriSYS emphasizes:
- offline operation in the event of network outages, communications propagate and persist
- deterministic verification (bit-for-bit hashing and signature checks)
- privacy by default (no personal names on-chain; local-only contact labels)

---

What “blockchain” means here:
- No tokens
- No mining incentives
- No peer consensus
- No forks
- No financial layer

Instead:
- A cryptographically signed, append-only ledger
- One canonical chain per crisis
- Used for:
	- verification
	- accountability
	- offline trust propagation

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
- Families, NGOs, journalists, and auditors can independently verify:
	- when and where a person was last checked in
	- where aid stations reported activity
	- which alerts were issued, by whom, and when

---

## Why KriSYS exists
- Traditional messaging fails under:
	- internet shutdowns
	- infrastructure collapse
	- censorship or surveillance
  - rolling power loss
- Centralized messengers require:
	- live servers
	- continuous connectivity
	- trust in third-party operators
  - vulnerability to man-in-the-middle interception
- Paper logs and ad-hoc radio communication are:
  - unverifiable
	- not portable
	- easily lost or tampered with
- Accountability and auditability:
  - Check-ins and alerts become immutable once confirmed
  - Offline verification prevents later rewriting of history

KriSYS exists to provide verifiable, offline-capable communication and
accountability for humanitarian crises, even when the network, the grid, or
the government is hostile or absent. The anonymized data collected further
helps train future relief efforts to make the best use of limited resources
during future events of crisis requiring deployment of aid and volunteers.

---
## Quick Start
1. Clone the repo 
    - use the latest branch "phase-five-react" at the time of writing this
    - use the latest commit with "CP" or "CHECKPOINT" prefix to make sure you get the latest working state
2. Run `docker-compose up --build` to spin up the blockchain, frontend, and a local station.
3. Navigate to http://localhost:3000 to create a wallet with a passphrase.
4. Log in to the wallet and use dev tools for some basic functionality tests
5. Create a second wallet in another browser (separate local storage) and send messages side by side
6. Play with the devtools for simulating offline so you can connect 2 wallets in offline mode by copy-pasting connection codes, sync offline messages
7. Explore localhost:3000/explorer for the blockchain explorer, the way family members abroad can track loved ones and see the alerts practically live during a crisis

---

## Current Status
### Current milestones: Phase 4 complete
Phase 4 completed the lifecycle of stations, relays and central HQ mining
- automatically mines
- rate limiting transaction queues
- checking for connectivity
- thread locks for race condition mitigation
- prioritizing messages
- adaptive timing based on volume of transaction and queue sizes
Phase 3 completed the “station pooled rendezvous” architecture:
- offline message queuing on clients
- station-side pooled relay and dedupe
- station flush to central when connectivity returns
- mined block confirmation propagation back through stations
- offline check-in intake and flush via station
- verified block propagation and confirmation pruning (relay_hash based)
- Expand pooled rendezvous syncing to work without an authorized station (untrusted pool hosts and “dumb relays”), using the same inventory/sync rules.



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
- member addresses: family_id + “-suffix” (intended one per person, but not restricted)

related_addresses may contain:
- individual member addresses (family_id-suffix)
- the family_id itself (family/group-scoped for group check-in or messages)

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

## Transaction Priority System Semantics
(this is set in the service provider's blockchain policy definition when it is initialized)

### Priority 1 = Emergency interrupt
- Alerts only
- Provider‑issued only
- Mine immediately

### Priority 2 = Operational
- Check‑ins by default
- Can be used by provider for other urgent-but-not-interrupt messages

### Priority 3 & 4 = Reserved / configurable
- Weather, logistics, responder channels, etc.
- Not used by default

### Priority 5 = Best effort
- Person‑to‑person messages

---
TODO: Offline Gossip eviction rules, pruning algorithm
TODO: Set eviction rules and priority system rules to policy
TODO: client-side prune and eviction rules, set by user settings, not policy

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

### Stations authenticate check-ins to the central backend via API key:
- Header: X-Station-API-Key
- Body includes:
	- address (member address or family_id)
	- station_id
	- relay_hash (for offline dedupe/confirmation)
	- timestamp_created (seconds; preserve offline scan time)

### Offline check-ins:
- The station device can accept check-ins locally while offline and queue them.
- When connectivity returns, the station flushes queued check-ins to central.
- Confirmations are derived when the relay_hash appears in a verified block.

Development note:
- Station plaintext API keys are stored in:
	station_identity_<STATION_ID>.json
  in the station’s mounted volume so the station can flush check-ins without
  manual copy/paste in dev.

Stations have their own wallet addresses but become configured by a single first password entry upon activation. HQ provides their metadata, fixed plain text template message for handling check-ins, will later have their GUI launch for camera and station details to display to the public. Activated stations auto-login with api key from local storage after activation and fallback to relay status when offline. Connectivity loop checks for active connection and maintains blockchain and unconfirmed messages can be pushed to HQ from a station that has de-duped messages, verified hashes, and analyzed transaction for limits prescribed by the blockchain's policy when the KriSys blockchain was first set up.

Stations do NOT rotate keys. They are completely reset and provided a new activation code by HQ if a new api key is required. Hard reset only mitigates risk of elevated message priority messages from being tampered with and simplifies revocation of station credentials by HQ when a device is intercepted or otherwise compromised.
---
---

### Summary of Communication Flow
```
Station boots
    ↓
Detect HQ reachability
    ↓
Emit lifecycle event (stored locally)
    ↓
Flush loop sends telemetry to HQ
    ↓
HQ stores event in admin_events
    ↓
Admin endpoint aggregates
    ↓
Derived lifecycle & connectivity shown
```
---

#### If Station dies:
```
No telemetry
    ↓
HQ stale detection triggers offline
```
---

#### if HQ dies:
```
Station records offline locally
    ↓
HQ returns
    ↓
Station flushes historical lifecycle
```
---

## Relay-Only Nodes (Online & Offline Behaviour)
### Relay devices are:
- never signed in or provided API keys to function properly.
- auto-pull blocks from HQ if they contain a valid pinned Crisis ID (set when device drive is flashed)
- help confirmed block propagation, unconfirmed message propagation, and offline load distribution blindly
- assist stations with verifying / deduplication of untrusted messages, networking P2P, broadening reach of mesh network
### Relay devices can NOT:
- ever become stations
- ever post transactions to be mined as blocks by central HQ (can't corrupt blockchain)
- ever be trusted
- compromise the network thanks to hardening & hash checks

---

## Conceptual Overview of STATION vs RELAY:
### There are two separate responsibilities:
Station Responsibilities
- Detect connectivity to HQ
- Determine operational mode (station / relay / uninitialized)
- Record lifecycle transitions locally
- Persist telemetry events even when offline
- Flush stored events to HQ when online
- Emit periodic heartbeat while online

HQ Responsibilities
- Receive authenticated telemetry from stations
- Store structured events in admin_events
- Aggregate latest lifecycle + summary state
- Infer offline state when telemetry becomes stale
- Render current state to admin UI

### <b>*HQ never polls stations. Stations always push telemetry.*</b>

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
### Central backend:
- GET /health
- GET /crisis
- GET /blockchain
- GET /admin/* (auth placeholder)
- GET /admin/events
- GET /admin/stations/status
- POST /admin/telemetry
- POST /transaction (messages)
- POST /checkin (station-authenticated check-ins)
- POST /admin/mine
- POST /admin/alert
- POST /auth/unlock
- POST /wallet

### Station server:
- GET /health
- POST /mesh/inventory
- POST /mesh/sync
- POST /station/checkin (offline intake)
- POST /station/flush (flush + pull blocks + derive confirmations)
- GET /station/pools
- POST /station/pools

### UI's:
- krisys-frontend → User wallet UI
- device-offline-server/station-frontend → Station kiosk/operational UI
- krisys-backend → Admin panel
---

## File Structure (comprehensive)
```
./krisys-backend
├── app.py
├── blockchain
│   ├── master_private_key.asc
│   ├── master_private_key.asc
│   └── dev_policy_id.txt	(delete this in dev to kill master keys, db's, and start fresh automatically)
├── device-offline-server (simulating an offline registered station, relaying unconfirmed messages and maintaining latest blocks from anyone who visits and has a newer block that the station can verify and propagate throughout the rest of the network while offline)
│   ├── station-frontend
│   │   ├── app
│   │   │	├── layout.js
│   │   │	└── page.js
│   │   ├── components
│   │   │	├── StationIdentity.js
│   │   │	└── StationPool.js
│   │   ├── services
│   │   │	├── stationQr.js
│   │   │	├── stationHandshake.js
│   │   │	├── webrtcRoomCode.js
│   │   │	├── webrtcChunking.js
│   │   │	└── stationApi.js
│   │   ├── package.json
│   │   └── next.config.js
│   ├── station-data  (simulating offline station persistent storage for blockchain and message queues when gathering offline unconfirmed transactions)
│   │   ├── station.db
│   │   └── station_identity_HOSPITAL-SE-001.json (hardcoded dummy for devtools UI functionality)
│   │   └── station_identity_STATION-001.json (hardcoded dummy for devtools UI functionality)
│   │   └── station_identity_*.json (the persistent api keys for authorized stations in lieu of wallet passphrases)
│   ├── app.py
│   └── Dockerfile
├── blockchain.db
├── blockchain.py
├── camp_central
│   ├── station-data  (simulating independent station for station-station peer exchange)
│   │   ├── station.db
│   │   └── station_identity_CAMP_CENTRAL.json
├── database.py
├── Dockerfile
├── relay-offline-server 
│   ├── relay-data  (simulating offline dumb relay with persistent storage to help propagate offline messages)
│   │   └── relay.db
│   ├── app.py
│   └── Dockerfile
├── requirements.txt
├── templates
│   ├── admin.html
│   ├── error.html
│   ├── index.html
│   ├── scanner.html
│   └── wallet_dashboard.html
├── dev_seed_stations.sh (automates curl request to create 3 stations using proper endpoints)
├── dev_proivision_station.sh (automates curl request to activates station called "FOODTRUCK_001" from dev_seed_stations)
└── dev_station_checkin.sh (automates curl request to perform check-in by providing wallet address as a parameter)
./krisys-frontend
├── app
│   ├── explorer
│   │	└── page.js
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
│       ├── ConnectionsPage.js
│       ├── ContactName.js
│       ├── ContactPage.js
│       ├── index.js
│       ├── MembersOverview.js
│       ├── MembersPage.js
│       ├── MessageDisplay.js
│       ├── MessagingPage.js
│       ├── Overview.js
│       ├── P2PRoom.js
│       ├── RecentActivity.js
│       ├── Sidebar.js
│       ├── StorageMeter.js
│       ├── TransactionItem.js
│       ├── UserSettings.js
│       └── UnlockForm.js
├── contexts
│   └── P2PContext.js
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
│   ├── keySeal.js
│   ├── localStorage.js
│   ├── meshSync.js
│   ├── poolJoinCode.js
│   ├── stationQr.js
│   ├── stationHandshake.js
│   ├── storageMeter.js
│   ├── walletPublicKeyShare.js
│   ├── webrtcChunking.js
│   └── webrtcRoomCode.js
├── styles
│   ├── components
│   │   ├── scanner.css
│   │   └── wallet.css
│   ├── index.css
│   ├── landing.css
│   └── wallet_dashboard.css
```
LOCAL PORTS (DEV)
- backend: http://localhost:5000
- frontend: http://localhost:3000
- station: http://localhost:6001	(foodtruck*, hospital, station_001)
- station: http://localhost:6003	(camp_central*)
- station-frontend: http://localhost:6600 (station frontend UI)
*fake stations for devtools actions, NOT provisioned or conventional, dev only dummies
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

## Security and Privacy (in plain-er language)

KriSYS assumes:
- Devices may be lost, stolen, damaged, or inspected
- Networks may be monitored or disrupted
- Offline relays may be malicious or compromised
- Users may be non-technical and under stress

KriSYS does not assume:
- Always-on internet
- Trusted local infrastructure
- Secure physical environments (messages are PGP encrypted on publicly visible blockchain)
- Unlimited access to reliable power (conscious of mobile battery usage)

KriSYS is designed so that compromise of any single relay, device, or pool does
not compromise the integrity of confirmed history or the privacy of messages; it also can't
guarantee that messages never be de-obfuscated over time, since the chain is still public.

* Encyption used for messages simply enables users to reunite before messages can be decrypted,
but they are not secure enough to pass sensitive information such as banking details or personally
identifying credentials.

## What KriSYS does *NOT* do:
- Cost money beyond the servers and verified check-in stations supplied by the blockchain host (usually the aid organization in charge of relief efforts):
  - FEMA (in USA)
  - Canadian Disaster Response Organization (EMOs)
  - Red Cross, etc.
- No background peer discovery by default
- No device tracking or redistribution
- No location tracking unless explicitly encoded in a transaction
- No automatic trust of unverified data
- No global peer-to-peer mesh without user consent

*NOTE: This does not prevent long‑term metadata correlation by powerful adversaries, but it ensures KriSYS itself does not add new tracking surfaces.*

---

# *ROADMAP*
### Phase 1 — Core chain and persistence (Completed)
Core ledger + canonical chain rules:
- Single canonical chain (no forks; conflicts ignored)
- Central backend is the only miner (authoritative chain)
- Blocks include:
	- `block_index`, `timestamp` (seconds), `transactions`, `previous_hash`, `nonce`, `hash`, `signature`
- Deterministic block hashing (non-negotiable):
	- SHA-256 over UTF-8 bytes of canonical JSON body:
		- `{ block_index, timestamp, transactions, previous_hash, nonce }`
	- Canonical JSON rules (must match Python + JS):
		- sorted keys
		- separators `(",", ":")`
		- `ensure_ascii=False`
		- UTF-8 encoding
- Block signing (non-negotiable):
	- Detached PGP signature over canonical JSON header:
		- `{ block_index, previous_hash, hash }`
- Genesis metadata:
	- Genesis block contains `crisis_metadata` payload with:
		- `crisis_id`
		- `block_public_key` (trust anchor)
		- crisis details (name/org/contact/description/created_at)
- Persistence:
	- SQLite storage on central:
		- `blocks`, `transactions`, `wallets`, `wallet_keys`, `stations`
	- Transaction load ordering from SQLite:
		- `transactions ORDER BY id ASC`
	- Deterministic tx ordering inside mined blocks:
		- `priority_level ASC`
		- `timestamp_created ASC`
		- `transaction_id ASC`
- Idempotency (server acceptance):
	- `relay_hash` uniqueness enforced for non-empty values (SQLite partial unique index)
	- `/transaction` idempotent by `relay_hash` (dedupe success responses)

---

### Phase 2 — PGP messaging & wallets (Completed)
Wallet identity + encryption plumbing (no currency):
- Wallet model:
	- `family_id` wallet
	- multiple `members[]` with `address` identifiers
- PGP keys per wallet:
	- public key is shareable for offline encryption
	- private key is delivered to client only after unlock (client-side decrypt)
- Message encryption:
	- outgoing messages encrypted to recipient wallet public key (and optionally sender key for sent-message readability)
	- stored on-chain as encrypted armored PGP message text
- Wallet unlock flow:
	- `POST /auth/unlock` returns wallet private key (client validates/caches)
	- client stores validated private key locally for offline decryption access
- Client-side decryption:
	- decrypts PGP messages locally using cached private key
	- UI marks messages as confirmed vs unconfirmed based on block verification
- Public key exchange (offline-friendly):
	- QR + always-show-text for:
		- addresses
		- join codes
		- public key share codes
	- Public key share code format `krisys:key:v1` includes:
		- `family_id`
		- optional `crisis_id`
		- armored public key block

Data handling constraints:
- No per-transaction signatures; only blocks are signed
- Confirmations are true only when proven by verified blocks

---

### Phase 3 — Offline propagation (Completed)
Mesh sync between devices and offline nodes:
- Stable offline transaction identity:
	- `relay_hash` is the offline idempotency key (dedupe + pruning)
	- `transaction_id` is server-generated on acceptance (not used for mesh dedupe)
- Timestamp conventions:
	- blockchain timestamps are integer seconds:
		- `Transaction.timestamp_created`, `Transaction.timestamp_posted`, `Block.timestamp`
	- local bookkeeping times are milliseconds:
		- `queuedAt`, `generatedAt`, `confirmedAt`
- Priority semantics:
	- lower number = higher priority
	- priority 1 reserved for provider-issued alerts (mines immediately)
	- stations do not choose priorities; provider policy defines defaults
- Mesh sync payload v1 (shared over HTTP + WebRTC):
	- `{ version, deviceId, crisisId, generatedAt, chain_tip, blocks, queued, confirmed }`
	- bounded lists (anti-abuse):
		- queued bounded per payload
		- confirmed bounded per payload
		- blocks suffix bounded
- Offline Station server (trusted operationally, untrusted cryptographically):
	- Has station API key (for central checkin flushing)
	- Endpoints:
		- `POST /mesh/inventory`
		- `POST /mesh/sync`
		- `POST /station/checkin` (offline intake)
		- `POST /station/flush` (push queued to central when online; pull blocks)
	- Stores:
		- queued, confirmed, blocks, checkins_queued (SQLite)
	- Behavior:
		- verifies received blocks (hash + signature) using pinned `block_public_key`
		- derives confirmations only from verified blocks
		- prunes queued/confirmed using TTL + high/low-water bounds
- Offline Relay server (untrusted rendezvous box):
	- No credentials
	- Endpoints:
		- `POST /mesh/inventory`
		- `POST /mesh/sync`
	- First-contact pinning:
		- pins `crisisId + block_public_key` on first valid request
	- Behavior:
		- stores queued messages (smell-tested)
		- stores verified blocks only
		- derives confirmations only from verified blocks
		- bounded storage + TTL pruning
- Client offline caches:
	- `crisis metadata` (includes pinned `block_public_key`)
	- `canonical blocks` (verified + linked)
	- `queued messages` (unconfirmed relay pool)
	- `confirmed relay map` (prunes queue when on-chain)

Core security boundaries:
- Mesh endpoints are open to untrusted clients
- Relays cannot create provider alerts or check-ins
- Confirmations never trusted from peer “confirmed maps”; only from verified blocks

Dev reset behavior (dev-only):
- Deleting `blockchain/dev_policy_id.txt` resets:
	- central DB
	- master keys
	- station DB + station identity files
	- relay DB
- Everything regenerates together

---

### Phase 4 — Operational hardening (Completed)
Goal: align dev prototype with real-world operation before multi-device field tests.

Phase 4a — Client hardening
- LocalStorage namespacing:
	- prevent cross-wallet and cross-crisis cache bleed
	- namespace at least by `crisisId` and `family_id`
- Offline reload readiness:
	- PWA app-shell caching (service worker) so the UI can open/reload offline
- Real network status:
	- replace simulated offline fetch/axios interception with real connectivity indicators
- Storage observability:
	- storage meter (used vs configured limit; category breakdown) to support offline storage decisions
- P2P lifecycle scope:
	- P2P connection context scoped to `app/wallet/[familyId]/layout.js`
	- connection survives internal navigation; tears down on wallet exit

Phase 4b — Station/relay hardening
- Station identity handling:
	- load station identity (station_id/api_key/central_url/policy) from local file/volume
	- explicit boot behavior when identity missing (dev: fail or show provisioning stub)
- Station lifecycle:
	- operate offline immediately
	- retry central connectivity in background
	- flush queued on reconnect
- Relay lifecycle:
	- strict pinning to single crisis trust anchor
	- verified-block-only storage
	- bounded queue/blocks storage
- Environment separation:
	- central ≠ station ≠ relay deployment configs (no monolithic compose assumption)
- Dev-only endpoints gated:
	- ensure dev-only identity fetch endpoints remain dev-only

---

### Phase 5 — System Validation & Field Testing (Completed)
Goal: prove the system survives realistic conditions across devices and networks.

Core validation scenarios:
- Remote central (Linode) + local clients (laptop/desktop)
- Station device:
	- offline check-in intake
	- delayed flush to central
	- block pull + confirmation propagation
- Relay device:
	- offline queue aggregation
	- verified block propagation
	- confirmation derivation from canonical chain
- Mixed connectivity:
	- one device online, others offline
	- intermittent uplinks
	- delayed confirmations
- WebRTC P2P:
	- multi-browser sync
	- chunking + backpressure
	- push-only mode validation (push queued without pulling blocks/queued)
- Performance baselines:
	- latency sensitivity
	- payload size behavior
	- pruning behavior under load

Field-test artifacts:
- repeatable test scripts/runbooks (manual steps)
- expected results for each scenario (pass/fail criteria)
- logs/metrics snapshots (sizes, counts, timings)

---

### Phase 6 — UX cleanup & optimization (In Progress)
Goal: improve usability without changing the trust model or protocol.

Targets:
- Clearer status surfaces:
	- [x] central connectivity vs mesh-only
	- [x] station/relay reachable indicators
	- [ ] P2P connected/active status
	- [ ] Facilitate visibility of P2P pools
- Better error messaging:
	- [x] offline/online transitions
	- [x] missing keys / missing crisis metadata
	- [ ] invalid blocks / signature failures
- Storage/bandwidth optimizations:
	- [ ] pruning strategy UX
	- [ ] user-visible limits and defaults
	- [ ] block/queue bandwidth negotiation
- UI declutter:
	- [ ] move dev-only tools behind explicit dev gates
	- [ ] unify “Connections” UX for station/relay/P2P
- [ ] Accessibility and mobile-friendly layout improvements

#### Phase 6.1 — Visibility MVP
Add structured log emitter utility in:
- [x] backend
- [x] station
- [ ] relay
- [x] Add admin telemetry endpoint on HQ

Add admin UI panel:
- [ ] Recent warnings/errors
- [ ] Replace with proper JWT/session-based auth
- [ ] Remove token injection from template
- [x] Station list with:
	- [x] mode
	- [x] online/offline
	- [x] identity state

Add simple filters:
- [ ] station_id (search/lookup)
- [ ] connection status
- [ ] activation status
- [ ] event severity
- [ ] event type


#### Phase 6.2 — Health Model
Define & display formal station states:
- [x] active + online
- [x] active + offline
- [x] relay fallback
- [x] identity rejected
- [ ] storage paused

Establish simplified relay flow:<br>
(*Uncertain best approach for this, perhaps provide url via qr with simple json containing pertinent info for application to consume when manually setting device to relay mode?*)
- [ ] pinning device to crisis_id

HQ:
- [ ] mining active
- [ ] pending count
- [ ] block interval
- [ ] adaptive trigger frequency

#### Phase 6.3 — Coordination of Public Pools (In Progress)
Iron out rules and flow of coordinating P2P:
- [x] Bulletin board hosted by stations to publish join codes
- [ ] Establish public gathering to facilitate offline pools / exchanges
- [ ] Automate propagation between pools (pool-2-pool sharing)
- [ ] Aggregate propagated unconfirmed queues to stations

#### Phase 6.4 — Safe Admin Controls
Add admin controls:
- [ ] Admin auth lock and session state management
- [ ] Revoke station (set status = revoked)
- [ ] Provision new station / passphrase
- [ ] Pause station intake remotely
- [ ] Force pull blocks

On state change actions:
- [x] Logged to admin logs
- [x] Does not alter historical blocks
- [x] Does not break determinism

#### Phase 6.5+ Extra considerations
Storage & Abuse Monitoring:
- [ ] Storage trend graph (queued growth over time)
- [ ] Repeated identity rejection alerts
- [ ] Excessive relay input detection
- [ ] Abnormal block rejection rates
- [ ] Admin controls to replace DevTools UI

Execution Order:
- [x] Structured logs (foundation)
- [x] Telemetry ingestion endpoint
- [x] Health state formalization
- [x] Retention + log pruning
- [ ] Pool finding rules
- [ ] Admin dashboard UI
- [ ] UX clarity refinements

---

### Phase 7 — Wizards, tutorials, documentation, demos (Planned)
Goal: make the system adoptable by providers and understandable by users.

Deliverables:
- Crisis/policy creation wizard (provider)
- Station provisioning flow (provider + field operator)
- Station UI:
	- QR scan
	- QR display
	- metadata display
	- connection status
- User onboarding:
	- join code usage
	- offline key exchange
	- safe usage reminders (manual sync cadence)
- Operational documentation:
	- deployment guides (central/station/relay)
	- security boundaries and threat model
	- troubleshooting playbooks
- Presentations/slides/demo scripts for stakeholders

---

### Phase 8 — React Native migration (Planned)
Goal: mobile-first deployment with device radios and cameras.

Targets:
- Native camera scanning (QR) for:
	- addresses
	- room codes
	- key share codes
- Better local networking primitives:
	- Wi-Fi AP / hotspot support (platform-dependent)
	- Bluetooth/Wi-Fi Direct exploration (optional)
- Storage evolution:
	- move large offline data from localStorage to IndexedDB/native storage
- Background behavior policy:
	- explicit user-controlled “mesh active” state
	- no silent background syncing by default

---
---

# Offline Data Propagation Diagrams

### Legend:
- Clients upload INVENTORY (relay_hash list)
- Pool hosts request only missing payloads
- Pool hosts dedupe by relay_hash
- Pool hosts exchange inventory + missing payloads
- Verified blocks propagate across all pool hosts
- Confirmations are derived ONLY from verified blocks
- Blocks propagate outward

---
## SYNC WINDOW (OFFLINE) - ASCII VERSION

```

    CLIENTS                     POOL HOSTS / STATIONS

 [ Client A ] ──┐
 [ Client B ] ──┼──>  [ Pool Host #1 ]  <────┐
 [ Client C ] ──┘             │              │
                              │              │
 [ Client D ] ──┐             │              │
 [ Client E ] ──┼──>  [ Pool Host #2 ]  <────┼── inter‑pool sync
 [ Client F ] ──┘             │              │
                              │              │
 [ Client G ] ──┐             │              │
 [ Client H ] ──┼──>  [ Pool Host #3 ]  <────┘
 [ Client I ] ──┘
```

---

## SYNC WINDOW (OFFLINE) - GitHub VERSION

CLIENTS                        POOL HOSTS (RENDEZVOUS)

Client A  ─┐
Client B  ─┼─▶ Pool Host #1
Client C  ─┘          │
                       │
Client D  ─┐          │
Client E  ─┼─▶ Pool Host #2
Client F  ─┘          │
                       │
Client G  ─┐          │
Client H  ─┼─▶ Pool Host #3
Client I  ─┘

POOL‑TO‑POOL EXCHANGE (DURING SAME SYNC WINDOW)

Pool Host #1  ⇄  Pool Host #2  ⇄  Pool Host #3

---

## SYNC WINDOW (OFFLINE) - MERMAID VERSION

flowchart LR
	A[Client A] --> P1[Pool Host #1]
	B[Client B] --> P1
	C[Client C] --> P1

	D[Client D] --> P2[Pool Host #2]
	E[Client E] --> P2
	F[Client F] --> P2

	G[Client G] --> P3[Pool Host #3]
	H[Client H] --> P3
	I[Client I] --> P3

	P1 <--> P2
	P2 <--> P3

---

## Station Runtime Acrhitecture
The station runs two background threads. 
```
background_loop()
event_flush_loop()
```

### A) background_loop()
This loop runs frequently (~250ms sleep).

It handles:
- Central reachability checks (/health)
- Mode detection
- Lifecycle transition detection
- Heartbeat scheduling
- Adaptive sync cadence
- Flush trigger scheduling
- It does NOT directly push telemetry to HQ.

It only records events locally.

### B) event_flush_loop()
This loop runs slower (e.g. every 15 seconds).
- Checks if HQ is reachable
- If online → flushes locally stored telemetry events
- Deletes events only after HQ confirms receipt

This separation prevents telemetry logic blocking sync logic, long network timeouts stalling station behavior, and race conditions between connectivity and telemetry.

---

## Station Event Model (minimal operational telemetry, NOT recorded on the blockchain)
Stations store events locally in station_events trable (SQLite)

```
event_type   → lifecycle | summary
event_name   → online | offline | mode_changed | heartbeat | flush_summary
context_json → structured JSON
created_at   → unix seconds
```

Stations never emit redundant events, only mode changes (station fallsback to relay failing to auth its api key, for eg), or connection changes (fails to reach remote HQ's /health).

Oh heartbeat, station emits:
```
event_type: lifecycle
event_name: heartbeat
context:
    mode
    central_ok
    queued_count
    blocks_cached
```

It's for HQ's observability, allowing it to infer lost station connection by checking updating "last_seen_at". This is not functionally applicable to the blockchain, it's just so that HQ knows the station is alive and authenticated. 

```
last_online_state
last_mode_state
```
#### Architecture is "Push-based telemetry with derived liveness inference."

---

## Station Flush Summary Event
```
event_type: summary
event_name: flush_summary
context:
    messages_sent
    checkins_sent
    blocks_pulled
```
Exists solely to help report volumes, not specific details. Knowing the traffic load of a station or technical issues, and it may help coordinate the deployment of aid most effectively.

---

## Station Meta Table
Station stores persistent state in meta:
- crisisId
- block_public_key
- last_online_state
- last_mode_state
- deviceId
- intake_paused

This allows:
- Clean reboot recovery
- No repeated boot events
- Proper lifecycle continuity
---

# Scaling Considerations
Current design scales well because: 
- stations push telemetry (HQ never polls)
- aggregation complexity is O(stations + recent_events) ['Big O Notation']
- Stale detection is O(stations) ['Big O Notation']
- No persistent lifecycle state stored in DB
- No heavy per-station computation

### Even with 1,000 stations, 1,000 stale checks per request is trivial CPU cost. Logs are sparse summaries prepared by station nodes in advance, and HQ can selectively batch updates in larger deployments as needed. This is push-based telemetry with derived liveness inference.


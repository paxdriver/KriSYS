# KriSYS – Crisis Communication Blockchain System

A humanitarian blockchain system enabling crisis organizations to coordinate aid, reunite families, and maintain communication during disasters when traditional infrastructure fails.

System designed for humanitarian crises – prioritizing reliability, privacy, and simplicity for people operating under extreme stress with limited technical resources.

---

## Primary Use Cases

- Crisis organization resource management: real-time coordination of supplies, personnel, and aid distribution
- Inventory and aid distribution: supply chain tracking and resource allocation management
- Reuniting missing persons: remote family tracking and check-in system with QR code identification
- Offline message delivery: encrypted personal communications and emergency alerts without internet or power
- QR code check-in stations: simple identification using bracelets, necklaces, or printed codes

---

## **Current Status: Phase 2 Complete**

### ✅ Completed Features
- Flask backend API with custom blockchain implementation
- React/Next.js frontend with component-based architecture
- PGP key management system with KeyManager abstraction
- Contact management (names replacing addresses, edited and stored locally)
- Client-side message encryption and decryption
- Docker containerized development environment
- Real-time blockchain explorer
- Family wallet management with passphrase protection
- QR code generation for member identification
- Offline message queuing system
- Local relay/confirmation tracking (relay_hash per message) 
- Block signing for canonical chain verification by users offline & online

- DevTools banner for:  
  - manually mining a block
  - sending admin alerts / check-ins
  - simulated offline mode
  - processing offline message queue
  - experimental sync payload export/import
  - Rate limiting ovverride

---

### Anticipated Future Features
- Device registration
- Station api key revocation
- Provider setup wizard
- Message threads
- Blockchain explorer culling / sorting / filtering
- QR code sharing to display / read codes between users for contact management

### Phase IN-sensitive TO-DO's
- QR scanner implementation for check-in stations  
- Wallet creation at stations
- Advanced contact management features  
- Mobile-responsive optimizations and UX features/flow
- Refinement of offline sync UX (beyond dev-only JSON copy/paste)  

---

## **Phase 3 - Offline Data Propagation Between Users **

### Overview
- Peer-to-peer WiFi or local-network sync for offline device communication  
- Enhanced station templates and check-in types  
- Message threading and reply chains  
- Optional embedding of public keys in QR codes to reduce server lookups  

### Phase 3 Steps - Mesh & Offline Sync
1. Show unconfirmed messages locally
Display locally queued messages alongside confirmed on‑chain ones.
(Done ✓)

2. Offline blockchain access
Load chain and wallet data from local cache when no network connection is available.

3. Peer sync payload definition
Define a precise JSON structure for what is exchanged between devices
(e.g. queued messages + confirmed relay map + blocks + metadata).

4. Peer sync merge logic
Implement how devices merge those payloads and resolve conflicts safely
(using signatures, timestamps, relay hashes, etc.).

5. Manual payload transfer
Add simple import/export options (QR, copy/paste, file) so users can sync devices manually offline.

6. Automatic mesh transport (optional later)
Add WebRTC / Bluetooth / Wi‑Fi Direct, etc., to do automatic peer‑to‑peer sync using the same payload format.

7. Testing & validation
Test network loss → message queue → peer sync → reconfirmation → server reconciliation end‑to‑end.
---

# Architecture Overview

## Backend (Flask – port 5000)
- Custom blockchain with configurable block intervals and automatic background mining thread  
- Transaction types: `check_in`, `message`, `alert`, `damage_report`  
- Policy system with crisis-specific configurations, transaction size limits, rate limiting, and allowed transaction types  
- PGP key management with 4096-bit RSA master keypair per crisis  
- SQLite database with separate tables for blocks, transactions, wallets, crises, and wallet keys  

## Frontend (React/Next.js – port 3000)
- Modular component architecture  
- Client-side decryption (all message decryption happens in browser)  
- KeyManager abstraction for crypto operations  
- Offline storage (`disasterStorage`)  
  - Blockchain snapshot  
  - Message queue  
  - Public key cache  
  - Confirmed-relay map for deduplication  
- Privacy-first contact storage (`contactStorage`)  

---

# Project Structure

```
krisys/
├── docker-compose.yml              # Development environment
├── blockchain/                     # Shared database volume
├── krisys-backend/                # Flask API server
│   ├── app.py                     # Main Flask application & routes
│   ├── blockchain.py              # Blockchain, Policy, and Wallet classes
│   ├── database.py                # SQLite schema and connections
│   └── requirements.txt           # Python dependencies
├── krisys-frontend/               # React application
│   ├── app/
│   │   ├── page.js               # Landing page with blockchain explorer
│   │   └── wallet/[familyId]/    # Dynamic wallet dashboard route
│   ├── components/
│   │   ├── BlockchainExplorer/   # Public blockchain viewing components
│   │   ├── WalletDashboard/      # Multi-page wallet interface
│   │   │   ├── index.js          # Main dashboard router
│   │   │   ├── MessagingPage.js  # Encrypted messaging interface
│   │   │   ├── MessageDisplay.js # Message decryption and rendering
│   │   │   ├── ContactPage.js    # Private contact management
│   │   │   ├── UnlockForm.js     # Wallet authentication
│   │   │   └── TransactionItem.js # Reusable transaction display
│   │   └── DevTools/             # Development controls and mining
│   ├── pages/api/                # Next.js API routes
│   │   ├── admin.js              # Admin proxy for development
│   │   └── public-key.js         # Public key fetching proxy
│   ├── services/
│   │   ├── api.js                # Flask backend integration
│   │   ├── blockVerifier.js      # User verification of block's signature (signed by provider server-side when mined)
│   │   ├── keyManager.js         # PGP crypto operations abstraction
│   │   ├── localStorage.js       # Disaster-specific offline storage
│   │   └── contactStorage.js     # Privacy-first contact management
│   └── styles/                   # Custom CSS (no frameworks)
```

<br>

---
---

# PGP and Key Management

## Master Key and Admin Authentication
- 4096-bit RSA master keypair generated on initialization:  
  - `master_public_key.asc` stored publicly  
  - `master_private_key.asc` stored securely  
- Public key encrypts user wallet keys before storing in DB  
- Private key decrypts those wallet keys on `/auth/unlock` requests  
- Development admin access uses `X-Admin-Token` header containing base64-encoded master private key  

---

## Wallet Key Storage (Dual-Layer)
1. Generate user PGP keypair with passphrase  
2. Serialize passphrase-protected private key  
3. Encrypt that result again with blockchain master public key  
4. Store only encrypted private key and user’s public key  

Wallet unlock process:
1. Server decrypts the outer layer with master private key  
2. Returns still passphrase-protected private key to client  
3. Client decrypts with passphrase locally for message reading  

Server never stores decrypted private keys; all decryption happens on client.

---

## Message Encryption and Delivery
- Client encrypts with recipient’s public key using KeyManager  
- Server stores encrypted payload only (message_data field)  
- Recipient decrypts with their private key (protected by passphrase)  

First contact requires being online once to fetch recipient public key via `/wallet/{family_id}/public-key`.  
After that, it is cached in localStorage and usable offline.  

---

# Offline Queue, Relay, and Sync Design

- Each outgoing message has a unique `relay_hash` used for deduplication and confirmation.
- Local queue (`MESSAGE_QUEUE`) holds unsent messages while offline.
- Confirmed messages stored in `CONFIRMED_RELAYS` and automatically pruned.
- Export/import sync payload allows two devices to share:
  - unconfirmed queued messages
  - confirmed relay list

## Example Sync Payload
### These payloads can be copy/pasted using DevTools Export/Import to simulate peer-to-peer sync.
{
	"deviceId": "device_123456_xyz",
	"queued": [ ... message objects ... ],
	"confirmed": { "relay_hash": { "confirmedAt": 1234567890 } }
}
<br><br>
---

# CHECK-IN STATION AUTH FLOW
Check-in and Station Authentication
===================================

Overview
--------
Aid stations (e.g. hospitals, food distribution points, registration tents) act
as "check-in" points for victims and families. Each station has a human-readable
station ID (e.g. "HOSPITAL_SE_001") and is responsible for scanning victim/family
QR codes and submitting check-in transactions to the crisis blockchain.

The KriSYS system treats stations as special, authenticated senders of
check-in data. Stations DO NOT sign blocks (only the crisis master key signs
blocks), but stations must authenticate themselves in order to post check-ins.

This avoids trivial spoofing of station activity (e.g. a malicious client
claiming to be "HOSPITAL_SE_001") while keeping the deployment and UX simple
for non-technical aid workers.

Station Data Model
------------------
Each station is stored in the backend database in a "stations" table, keyed by:

- crisis_id           : ID of the crisis/blockchain instance
- station_id          : human-readable identifier, e.g. "HOSPITAL_SE_001"
- name                : descriptive name, e.g. "Southeast Field Hospital"
- type                : "hospital", "shelter", "food", etc.
- location            : optional descriptive location
- registration_code_hash : hash of a one-time activation code (future use)
- api_key_hash        : hash of the station's long-term API key
- status              : "pending", "active", or "revoked"
- created_at          : timestamp of creation

Important design points:

- Stations are referenced by `station_id` in transactions. This remains
  human-readable and is visible in on-chain data.
- The ability to USE a station_id is gated by `api_key_hash` and `status`,
  not by the station_id string alone.
- KriSYS does NOT rely on station secrets to protect the entire blockchain.
  Canonical chain integrity is guaranteed by a separate crisis master key
  that signs blocks. Station keys only authenticate the origin of check-ins.

One-Time Station Registration (Design)
--------------------------------------
In the final design, each station will go through a one-time activation process:

1. Crisis admin creates a station:

   - Picks a station_id, name, type, and location.
   - KriSYS generates a random one-time registration code.
   - The server stores hash(registration_code) in `registration_code_hash`.
   - The station is initially `status = "pending"`.

2. The registration code is delivered to the station admin out-of-band
   (e.g. printed on paper or as a QR code), separate from the physical device.

3. In the field, when the station device (e.g. a Raspberry Pi kiosk) is first
   powered on and connected, it runs in "unregistered" mode:

   - Prompts the user to enter the station_id and registration code,
     or scan a QR containing them.

4. The device sends a registration request to the backend:

   - `{ station_id, registration_code }`.

5. The server validates:

   - There is a station row for this crisis_id + station_id.
   - status == "pending".
   - hash(registration_code) matches `registration_code_hash`.

   If valid:

   - The server generates a long random API key.
   - Stores hash(api_key) in `api_key_hash`.
   - Clears `registration_code_hash`.
   - Sets status = "active".
   - Returns the plain API key ONCE to the device.

6. The device stores the API key locally (e.g. on disk) and switches into
   normal "scanning" mode. Operators never need to remember passwords.

If someone intercepts the device image before activation:

- The SD card image itself contains no API key.
- They would also need the registration code.
- Once the real station successfully activates with that code, the code is
  invalidated. Any later attempts with the same station_id/code are rejected.

If the device is stolen AFTER activation:

- The thief gains the station's API key and can impersonate that station until
  the crisis admin revokes it (status = "revoked") or rotates to a new station.

Day-to-Day Operation: Authenticated Check-ins
---------------------------------------------
Once a station is active, all check-in requests it sends must be authenticated
with its API key.

For each /checkin request, the station device sends:

- JSON body:
  - address    : victim/family address scanned from QR code
  - station_id : station_id string (e.g. "HOSPITAL_SE_001")

- HTTP header:
  - X-Station-API-Key: <long random API key>

The backend /checkin handler enforces:

1. station_id must exist in the stations table for the current crisis_id.
2. status for that station must be "active".
3. hash(provided_api_key) must match `api_key_hash` for that station.

Only then does the server create a `check_in` transaction with:

- type_field      : "check_in"
- related_addresses : [address]
- station_address : station_id
- timestamp_created : now
- priority_level  : appropriate value (often highest or high priority)

These transactions are then subject to the usual rules:

- They are unconfirmed until included in a crisis master-key-signed block.
- Once in a signed block, they become canonical and can be trusted as
  "station-verified check-ins" for families and aid coordinators.

Relationship to Block Signatures
--------------------------------
Station authentication (API keys) and crisis block signatures serve different
but complementary purposes:

- Station API keys:
  - Prove that a given check-in originated from a specific, approved station
    (as long as that station's device/secret is not compromised).
  - Prevent trivial spoofing of station IDs by random clients.

- Crisis block signature (block_public_key):
  - Proves that a block and all its transactions have been accepted by the
    crisis authority (aid organization) and fixed into the canonical history.
  - Prevents malicious peers from forging or modifying blocks, regardless of
    station behavior.

Clients and offline devices should treat:

- Station-authenticated but unconfirmed check-ins as "unconfirmed reports"
  that may still be pending inclusion.
- Check-ins in validly signed blocks as fully confirmed facts.

Current Implementation Status
-----------------------------
At this stage of KriSYS development:

- The database schema includes fields for registration_code_hash, api_key_hash,
  and station status.
- Station auth for /checkin requests uses the stored api_key_hash and status
  to accept or reject check-ins.
- In development, stations may be pre-provisioned with API keys (generated at
  startup and logged for testing) instead of going through the full one-time
  registration flow.

The one-time registration workflow described above is planned but not yet
implemented in full. The data model and auth checks are designed so that this
workflow can be wired in later without changing the core check-in semantics
or the blockchain trust model.

----------

# Quick Start

### Clone repository
a) git clone <repo-url> <br>
b) cd krisys<br>
c) docker-compose up --build<br>

React Frontend: http://localhost:3000<br>
Flask Backend: http://localhost:5000

Frontend: http://localhost:3000  
Backend: http://localhost:5000  

### Testing Workflow
1. Create two wallets (A and B).  
2. Unlock both wallets.  
3. Send message A → B while online (to cache B’s public key).  
4. Go offline in wallet A and send another message.  
5. Come back online and use “Queue” in DevTools to send queued message.  
6. Mine a block (wallet B’s DevTools) to confirm it.  

---

# Development Phases

### **Phase 1 – Core Infrastructure**
- Blockchain, transactions, SQLite persistence, policy system.

### **Phase 2 – Wallet System**
- Family wallets, members, QR codes, passphrase-protected keys.

### **Phase 2.5 – Messaging System**
- End-to-end encryption.
- Offline queue.
- Contact management.
- Real-time message display.

### **Phase 2.7 – Offline Sync (Current)**
- `relay_hash` deduplication.
- Confirmed relay tracking.
- Export/import sync payload JSON.

### **Phase 3 - Peer Discovery and WiFi sync**
- Implement connections between offline devices
- Handle queue clearing and confirmation checks
- Implement downloading and diff of blockchain between offline devices

### **Phase 4 – Advanced Features (Planned)**
- Multiple station types (medical, food, shelter).
- Message threading, attachments.
- Chain pruning optimization.

---

# Core API Endpoints

### Public
- `GET /blockchain` – full blockchain data  
- `GET /crisis` – crisis metadata and current policy  
- `GET /policy` – current crisis policy config  
- `POST /wallet` – create family wallet  
- `POST /transaction` – submit message or check-in  
- `POST /checkin` – process QR check-in  

### Wallet
- `GET /wallet/{family_id}` – wallet metadata  
- `GET /wallet/{family_id}/transactions` – transaction list  
- `GET /wallet/{family_id}/public-key` – get wallet public key  
- `GET /wallet/{family_id}/qr/{address}` – get member QR image  
- `POST /auth/unlock` – unlock wallet with passphrase  

### Admin (Development)
- `POST /admin/mine` – mine pending transactions  
- `POST /admin/alert` – broadcast alert  
- `POST /admin/policy` – change current crisis policy  

---

# Security and Privacy Model

### Development
- Allows blank passphrases for testing  
- Admin auth via base64-encoded master private key  
- Rate limiting can be disabled via DevTools  
- Simulated offline mode through request interceptor  

### Production Considerations
- Require strong passphrase (8+ chars)  
- HTTPS/TLS encryption  
- Master key rotation and secure storage  
- Key revocation support  
- Strict rate limit enforcement  

### Privacy
- No PII stored on blockchain  
- Names and contacts stored only locally  
- All personal messages encrypted client-side  

---

# Technology Stack

**Backend**
- Python 3.11 / Flask  
- SQLite  
- PGP via `pgpy`  
- QR generation via `qrcode`  

**Frontend**
- React 18 / Next.js 14  
- OpenPGP.js  
- Plain CSS (no frameworks)  

**Deployment**
- Docker containers with shared volume for blockchain data  

---

# Crisis Response Workflow

1. Crisis setup – deploy KriSYS instance with crisis policy and master keypair.  
2. Family registration – create wallets and distribute QR codes.  
3. Deploy stations – setup check-in scanners at aid hubs.  
4. Active response – families check-in, exchange encrypted messages, receive alerts.  
5. Recovery – assess data and coordinate resources based on recorded transactions.  

---

# License & Contact

**License:** MIT  
**Author:** Kristopher Driver  
**Website:** [https://krisdriver.com](https://krisdriver.com)  
**Social:** @paxdriver  
**Email:** kris@krisdriver.com

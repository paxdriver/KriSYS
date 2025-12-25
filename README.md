# KriSYS – Crisis Communication Blockchain System

A humanitarian blockchain system enabling crisis organizations to coordinate aid, reunite families, and maintain communication during disasters when traditional infrastructure fails.

System designed for humanitarian crises – prioritizing reliability, privacy, and simplicity for people operating under extreme stress with limited technical resources.

---

## Primary Use Cases

- Crisis organization resource management: real-time coordination of supplies, personnel, and aid distribution  
- Reuniting missing persons: family tracking and check-in system with QR code identification  
- Inventory and aid distribution: supply chain tracking and resource allocation management  
- Offline message delivery: encrypted personal communications and emergency alerts without internet  
- QR code check-in stations: simple identification using bracelets, necklaces, or printed codes  

---

## **Current Status: Phase 2.5 Complete**

### ✅ Completed Features
- Flask backend API with custom blockchain implementation  
- React/Next.js frontend with component-based architecture  
- PGP key management system with KeyManager abstraction  
- Client-side message encryption and decryption  
- Docker containerized development environment  
- Real-time blockchain explorer  
- Family wallet management with passphrase protection  
- QR code generation for member identification  
- Offline message queuing system  
- Local relay/confirmation tracking (relay_hash per message)  
- DevTools for:  
  - manual mining  
  - admin alerts  
  - simulated offline mode  
  - processing offline message queue  
  - experimental sync payload export/import  

### 🔄 In Progress
- QR scanner implementation for check-in stations  
- Advanced contact management features  
- Mobile-responsive optimizations  
- Refinement of offline sync UX (beyond dev-only JSON copy/paste)  

### 📋 Next Phase
- Peer-to-peer WiFi or local-network sync for offline device communication  
- Enhanced station templates and check-in types  
- Message threading and reply chains  
- Optional embedding of public keys in QR codes to reduce server lookups  

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
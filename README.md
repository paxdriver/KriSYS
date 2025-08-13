KriSYS - Crisis Communication Blockchain System


A humanitarian blockchain system enabling crisis organizations to coordinate aid, reunite families, and maintain communication during disasters when traditional infrastructure fails.

Primary Use Cases

- Crisis Organization Resource Management: Real-time coordination of supplies, personnel, and aid distribution
- Reuniting Missing Persons: Family tracking and check-in system with QR code identification
- Inventory & Aid Distribution: Supply chain tracking and resource allocation management
- Offline Message Delivery: Encrypted personal communications and emergency alerts without internet
- QR Code Check-in Stations: Simple identification system using bracelets, necklaces, or printed codes

Current Status: Phase 2.5 Complete


✅ Completed Features:


- Flask backend API with custom blockchain implementation
- React frontend with component-based architecture
- PGP key management system with KeyManager abstraction
- Client-side message encryption/decryption
- Docker containerized development environment
- Real-time blockchain explorer
- Family wallet management with passphrase protection
- QR code generation for member identification
- Offline message queuing system
- Admin controls for mining and emergency alerts
🔄 In Progress:


- QR scanner implementation for check-in stations
- Advanced contact management features
- Mobile-responsive optimizations
📋 Next Phase:


- Peer-to-peer WiFi sync for offline device communication
- Enhanced station templates and check-in types
- Message threading and reply chains

Architecture Overview

Backend (Flask - Port 5000)

- Custom Blockchain: 3-minute block intervals with admin validation
- Transaction Types: check_in, message, alert, damage_report
- Policy System: Crisis-specific configurations and rate limiting
- PGP Key Management: Secure key storage with dual-layer encryption
- SQLite Database: Optimized with separate key storage tables

Frontend (React/Next.js - Port 3000)

- Component Architecture: Modular wallet dashboard with pages
- Client-side Decryption: All message reading happens on user device
- KeyManager Service: Abstracted crypto operations
- Offline Storage: Message queuing and public key caching
- Contact Management: Privacy-first local address book


Project Structure
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


PGP Implementation Details

Blockchain Admin Authentication


The system uses a dual-layer admin authentication approach:


1. 
Master Keypair Generation: When blockchain initializes, generates 4096-bit RSA keypair


	- Public Key: Stored in blockchain/master_public_key.asc
	- Private Key: Stored in blockchain/master_private_key.asc
	- Used for admin API authentication and wallet key encryption
2. 
Admin API Access: Development admin requests use base64-encoded master private key

# Backend validates by decoding and comparing full key
decoded_token = base64.b64decode(auth_token).decode('utf8')
if decoded_token != ADMIN_TOKEN: # ADMIN_TOKEN is full PGP private key

User Wallet Encryption (Dual-Layer Security)


The wallet system implements dual-layer encryption to protect user messages while allowing simple passphrase recovery:


1. 
Wallet Creation Process:

# 1. Generate user PGP keypair with user's passphrase
user_keypair = generate_keypair(user_passphrase)

# 2. User's private key is encrypted with their passphrase
user_encrypted_key = str(user_keypair)  # Already encrypted by PGP

# 3. Encrypt the encrypted key again with blockchain master key
master_encrypted_key = master_public_key.encrypt(user_encrypted_key)

# 4. Store only the double-encrypted key
database.store(family_id, master_encrypted_key, user_keypair.pubkey)



2. 
Wallet Unlock Process:
# 1. Server decrypts with master private key (never stores result)
user_encrypted_key = master_private_key.decrypt(stored_key)

# 2. Send encrypted key to client
return user_encrypted_key  # Still encrypted with user passphrase

# 3. Client decrypts with passphrase for message reading
actual_private_key = decrypt_with_passphrase(user_encrypted_key, passphrase)


3. 
Message Encryption Flow:

- Sending: Client encrypts with recipient's public key using KeyManager
- Receiving: Client decrypts with own private key (unlocked with passphrase)
- Server Role: Only stores/delivers encrypted content, never decrypts messages


This design ensures:

- Admin Access: Blockchain admin can decrypt wallet keys for recovery but cannot read messages
- User Privacy: Only user's passphrase can decrypt their messages
- Simple Recovery: Users only need to remember one passphrase
- Offline Capability: Private keys cached locally after first unlock



Quick Start
# Clone repository
git clone <repo-url>
cd krisys

# Start development environment
docker-compose up --build

# Access applications
# React Frontend: http://localhost:3000
# Flask API: http://localhost:5000

# Development workflow
# 1. Create a family wallet with passphrase
# 2. Unlock wallet to enable message decryption
# 3. Send encrypted messages between family members
# 4. Use DevTools to manually mine blocks
# 5. View messages decrypt in real-time



Development Phases & Progress

✅ PHASE 1: Core Infrastructure (Complete)

- Custom blockchain with admin validation
- Transaction types: check_in, message, alert, damage_report
- SQLite persistence with optimized schema
- Policy system framework for crisis-specific configurations
- Basic web interface with blockchain explorer

✅ PHASE 2: Wallet System (Complete)

- Family wallet creation with PGP keypair generation
- Individual member addresses within family wallets
- QR code generation for member identification
- Passphrase-protected wallet unlocking
- Enhanced web interface with wallet dashboard

✅ PHASE 2.5: Messaging System (Complete)

- End-to-end encrypted messaging between wallets
- Client-side decryption with KeyManager abstraction
- Message queue system for offline scenarios
- Contact management with privacy protection
- Real-time message display and transaction handling

🔄 PHASE 3: Offline Sync (In Progress)

- Device-to-device WiFi communication
- Peer discovery and message queue sharing
- Duplicate detection and transaction confirmation
- Mobile background sync capabilities

📋 PHASE 4: Advanced Features (Planned)

- Multiple check-in station types (medical, food, shelter)
- Enhanced policy system with priority hierarchies
- Message threading and group communications
- Image/voice attachment capability
- Chain pruning and storage optimization

Core API Endpoints

Public Endpoints

- GET /blockchain - Full blockchain data
- GET /crisis - Current crisis information
- POST /wallet - Create family wallet
- POST /transaction - Submit transaction
- POST /checkin - QR code check-in

Wallet Management

- GET /wallet/{family_id} - Wallet info (no keys)
- GET /wallet/{family_id}/transactions - Transaction history
- GET /wallet/{family_id}/public-key - Public key for encryption
- POST /auth/unlock - Authenticate and retrieve private key

Admin Controls

- POST /admin/mine - Manual block mining
- POST /admin/alert - Broadcast emergency alert
- POST /admin/policy - Update crisis policy

Security Model

Development Environment

- Empty passphrases accepted for rapid testing
- CORS enabled for localhost development
- Base64-encoded admin tokens
- Rate limiting can be disabled via DevTools

Production Considerations

- Passphrase Requirements: Minimum 8+ character requirement
- HTTPS/TLS: All API communication encrypted
- Admin Key Rotation: Secure master key management
- Rate Limiting: Transaction frequency controls
- Key Revocation: Mechanism for compromised key recovery

Privacy Protection

- No PII on Blockchain: Only addresses and encrypted content
- Local Contact Storage: Names stored only on user device
- Wallet Locking: Contact names hidden when wallet locked
- Message Obfuscation: All personal communications encrypted

Technology Stack

- Backend: Python 3.11, Flask, SQLite, pgpy (PGP), QR code generation
- Frontend: React 18, Next.js 14, OpenPGP.js, Custom CSS
- Deployment: Docker containers with shared volume
- Development: No TypeScript, no CSS frameworks for simplicity

Crisis Response Workflow

1. Crisis Setup: Aid organization deploys KriSYS instance with crisis-specific policy
2. Family Registration: Families create wallets, receive QR codes for members
3. Deployment: QR scanners installed at aid stations, shelters, medical facilities
4. Active Response:
	- Families check in via QR codes at various locations
	- Emergency alerts broadcast to all registered families
	- Private coordination via encrypted family messages
	- Resource tracking and supply distribution management
5. Recovery Phase: Damage assessment reports and long-term coordination

License & Contact


License: MIT
Author: Kristopher Driver
Website: krisdriver.com
Social: @paxdriver
Email: kris@krisdriver.com



---

System designed for humanitarian crises - prioritizing reliability, privacy, and simplicity for people operating under extreme stress with limited technical resources.
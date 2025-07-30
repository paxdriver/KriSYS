KriSYS - Crisis Communication Blockchain System

OVERVIEW:

KriSYS is a humanitarian blockchain system for tracking people and coordinating aid during disasters and crises. Unlike traditional blockchains, this uses centralized validation by aid organizations rather than mining or proof-of-stake. The system enables offline message queuing, family tracking, and aid coordination when internet and cellular networks are compromised.

Core Concept
- Aid organizations host their own blockchain for a specific crisis
- Users get family wallets (with individual addresses) via QR codes from aid stations
- Messages/check-ins are recorded as transactions on the blockchain
- Offline devices sync via WiFi when in proximity, queuing messages until someone reaches a station
- Families abroad can track loved ones via blockchain browser using wallet addresses

Technical Architecture
- Backend: Python API server with custom blockchain implementation (no mining - admin validates all blocks)
- Frontend: HTML/JavaScript (will port to React later)
- Database: Custom blockchain structure with 3-minute block intervals
- Communication: WiFi-based device-to-device sync when offline
- Deployment: Web server hosting blockchain + API, with public read-only blockchain access


DEVELOPMENT PHASES

PHASE 1: Basic Infrastructure

Priority: Core blockchain + basic check-ins

1. Custom blockchain implementation in Python
	- Block structure with 3-minute intervals
	- Transaction format: timestamp_created, timestamp_posted, station_address, message_data, related_addresses, relay_hash, transaction_id, posted_id, type_field, priority_level
	- Admin validation system (no cryptographic mining)
	- Transaction deduplication by ID

2. Basic API endpoints
	- POST /transaction (add to blockchain)
	- GET /blockchain (read-only access)
	- GET /address/{address} (get transactions for address)
	- Admin endpoints for block validation

3. Simple web interface
	- Blockchain browser/search by address
	- Basic transaction viewing
	- Admin panel for blockchain management

4. Policy system framework (not fully implemented)
	- Design structure for message priorities, size limits, frequency controls
	- Single default policy class for MVP
	- Prepare for multi-tier priority system later


PHASE 2: Wallet System + QR Codes

Priority: User wallet management

1. Wallet generation system
	- Family wallet creation (group address)
	- Individual address generation within wallet
	- QR code generation for addresses

2. Station check-in system
	- QR code scanning functionality
	- Template message system for different station types
	- Raspberry Pi + webcam scanning setup instructions

3. Enhanced web interface
	- Wallet management interface
	- Address book with custom labels (local storage only)
	- Subscription system for following other addresses



***********************************************************
Project Checkpoint Summary & Next Steps Prompt

Project Name: KriSYS - Crisis Communication Blockchain System
Current Phase: Phase 1 Complete (Core Blockchain + Basic Wallet System)
Checkpoint Date: July 30, 2025
Git Commit: 6bb5824a491f6b5983c1e82f057ddce178ce857d
-----------------------------------------------------------

Core Achievements:

1. ✅ Custom blockchain implementation (Python) with policy-driven crisis configurations
2. ✅ Wallet management system with PGP authentication
3. ✅ Hurricane crisis policy configured:
	- Block interval: 180s
	- Max TX size: 10KB
	- Priority levels: Evacuation(1), Medical(2), Shelter(3), Supplies(4), Personal(5)
	- TX types: check_in, message, alert, damage_report
4. ✅ API endpoints:
	- Blockchain explorer
	- Wallet management
	- Transaction submission
	- Crisis metadata
5. ✅ Dockerized deployment with SQLite persistence

Next Priority Tasks:
1. Implement message type handling (user messages vs admin alerts)
2. Add PGP encryption/decryption for wallet messages
3. Build station check-in system with QR scanning
4. Develop admin alert broadcasting system
5. Create frontend wallet interface (HTML/JS)

Technical Environment:
- Python 3.11
- Flask API
- PGPy for encryption
- SQLite database
- Docker deployment
- VS Code on Linux Mint

Critical Design Principles:
1. Privacy First: User messages encrypted, admin alerts plaintext
2. Offline Resilience: WiFi-based device sync
3. Crisis-Specific: Each disaster has own blockchain instance
4. Aid-Organization Controlled: Full validation control
***********************************************************




PHASE 3: Offline Messaging + Sync

Priority: Device-to-device communication


1. Message queue system
	- Local message storage (max ~1GB)
	- Transaction ID generation (hash of address + timestamp)
	- Queue management and cleanup
2. WiFi peer-to-peer sync
	- Device discovery when app running in background
	- Message queue sharing between devices
	- Duplicate detection and removal
	- Sync confirmation system (transaction_id to posted_id mapping)
3. Mobile optimizations
	- Background sync toggle
	- Battery optimization considerations
	- Storage management and pruning options

PHASE 4: Advanced Features

Priority: Enhanced functionality

1. Multiple message types
	- Check-in templates (food, medical, shelter stations)
	- Emergency alerts/warnings
	- Custom user messages (rate-limited)
	- Group messaging (multiple addresses per transaction)
2. Enhanced policy system
	- Priority hierarchies (medical > food > transportation > personal)
	- Message size limits (5KB default)
	- Frequency controls (1 message per 3 minutes default)
	- Station-specific rules
3. Advanced features
	- Message threading (reply chains)
	- Image/voice attachment capability
	- Chain pruning options
	- Lite mode for low-storage devices

Key Technical Requirements

- Transaction Size: Max 5KB, typically 1-2KB
- Block Interval: 3 minutes
- Queue Limits: Device storage dependent (~1GB suggested)
- Message Frequency: 1 per user per 3 minutes (policy-controlled)
- Station Hardware: Raspberry Pi + webcam sufficient
- Privacy: Address-only searching, no name-based lookup
- Scalability: Linear scaling, supports billions of transactions
- Recovery: QR code replacement system, address subscription for message history

Critical Design Principles

1. Privacy First: No personally identifiable information on blockchain
2. Offline Resilience: System must work without internet connectivity
3. Family-Focused: Designed for family/group coordination
4. Aid-Organization Controlled: Blockchain owners have full validation control
5. Crisis-Specific: Each disaster gets its own blockchain instance
6. Simple UX: Must work for people under extreme stress with minimal tech literacy

Testing Strategy

Set up test scenario with multiple devices, simulate offline conditions, test message queuing and sync, validate blockchain integrity across all operations.


Deployment Notes

System designed for humanitarian crises - prioritize reliability and simplicity over advanced features. Each aid organization can deploy independently for their crisis response efforts.


License: MIT - Attribute: Kristopher Driver krisdriver.com @paxdriver on social media kris@krisdriver.com


NOTES: current file structure while under development
/krisys-project
├── docker-compose.yml
├── Dockerfile
├── blockchain/ (volume for database)
└── src/
    ├── app.py
    ├── blockchain.py
    ├── database.py
    ├── requirements.txt
    └── templates/
        ├── index.html
        └── scanner.html

Test routes as of July 22 2025:
- http://localhost:5000 - Blockchain explorer
- http://localhost:5000/scanner - QR scanner interface
- http://localhost:5000/wallet - Wallet creation endpoint
- view blockchain - curl http://localhost:5000/blockchain 
	-> [{"block_index":0,"hash":"bb04c0087d4deb91a232bdd83988245ae6bdfc0bc7918918494c8618d1ad30b9","nonce":0,"previous_hash":"0","timestamp":1753203088.20498,"transactions":[]}]

- manual mining - curl -X POST -H "X-Admin-Token: default_admin_token_please_change" http://localhost:5000/admin/mine

- checking in - curl -X POST -H "Content-Type: application/json" -d '{"address": "bb04c0087d4deb91a232bdd83988245ae6bdfc0bc7918918494c8618d1ad30b9"}' http://localhost:5000/checkin 
	-> {"message":"Checked in bb04c0087d4deb91a232bdd83988245ae6bdfc0bc7918918494c8618d1ad30b9 at station STATION_001","status":"success","transaction_id":"70819e8662976cd1bfcee0132bb912a09ffbb7db924dd427adfcc2da390f773e"}


Final structure to look more similar to this:
krisys/
├── backend/
│   ├── blockchain/
│   │   ├── __init__.py
│   │   ├── block.py
│   │   ├── transaction.py
│   │   └── chain.py
│   ├── api/
│   │   ├── __init__.py
│   │   └── endpoints.py
│   ├── policies/
│   │   ├── __init__.py
│   │   └── message_policy.py
│   └── main.py
├── frontend/
│   ├── index.html
│   ├── js/
│   │   └── main.js
│   └── css/
│       └── style.css
└── requirements.txt
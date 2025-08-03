KriSYS - Crisis Communication Blockchain System

Overview

KriSYS is a humanitarian blockchain system for tracking people and coordinating aid during disasters when traditional communication networks fail. Unlike traditional blockchains, KriSYS uses centralized validation by aid organizations, enabling efficient crisis response with offline capabilities.

Core Concept:

- Aid organizations host dedicated blockchains for specific crises
- Families receive wallet addresses via QR codes
- Messages and check-ins are recorded as blockchain transactions
- Offline devices sync via WiFi when in proximity
- Global family tracking through blockchain explorer

Current Status (August 2025)

✅ Completed Features

- Custom Blockchain Implementation
	- Admin-validated blocks (no mining)
	- 3-minute block intervals
	- Transaction deduplication
	- SQLite persistence
- Policy System
	- Crisis-specific configurations
	- Priority levels (Evacuation, Medical, Shelter, Supplies, Personal)
	- Message type handling
- Wallet Management
	- Family wallet creation
	- Individual member addresses
	- PGP encryption/decryption
- API Endpoints
	- Transaction submission
	- Blockchain explorer
	- Wallet management
	- Admin operations
- Web Interface
	- Wallet dashboard
	- Transaction viewing
	- QR code generation
- Deployment
	- Dockerized environment
	- SQLite database persistence

🚧 In Progress

- Message decryption workflow
- Device-to-device sync prototype
- Enhanced admin alert system
- QR scanning interface

Technical Architecture

	graph TD
	    A[Frontend] -->|HTTP| B[Flask API]
	    B --> C[Blockchain Engine]
	    C --> D[SQLite Database]
	    E[Mobile Devices] -->|WiFi Sync| F[Offline Queue]
	    F --> B


GETTING STARTED

Prerequisites
- Docker
- Docker Compose
- Python 3.11

Installation

1. Clone repository:
	git clone https://github.com/yourusername/krisys.git
	cd krisys

2. Build and start containers:
	docker-compose up --build


Usage

1. Access Web Interface:
http://localhost:5000

2. Create Test Wallet:
	docker exec -it krisys_blockchain_1 python test_pgpwallet.py

3. Send Test Message:
	docker exec -it krisys_blockchain_1 python test_private_message.py

4. Access Wallet Dashboard:
http://localhost:5000/wallet/dashboard/<family_id>


File Structure

	/kriSYS/
	├── docker-compose.yml
	├── Dockerfile
	├── blockchain/               	# Database volume
	│   └── blockchain.db
	└── src/
	    ├── app.py                	# Main application
	    ├── blockchain.py         	# Core blockchain logic
	    ├── database.py           	# Database operations
	    ├── requirements.txt
	    ├── test_crisis.py        	# Integration tests
	    ├── test_pgpwallet.py     	# Wallet tests
	    ├── test_private_message.py # Messaging tests
	    ├── static/
	    │   ├── js/
	    │   │   └── wallet_dashboard.js
	    │   └── css/
	    │       └── wallet_dashboard.css
	    └── templates/
	        ├── index.html
	        ├── admin.html
	        ├── wallet_dashboard.html
	        └── scanner.html

Key Endpoints

ENDPOINT						METHOD		DESCRIPTION
---------------------------------------------------------------------
/								GET			Blockchain explorer
/wallet							POST		Create new family wallet
/wallet/<family_id>				GET			Get wallet info
/wallet/dashboard/<family_id>	GET			Wallet dashboard
/transaction					POST		Submit transaction
/admin/mine						POST		Mine pending transactions
/admin/alert					POST		Broadcast admin alert
/checkin						POST		Record station check-in


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
Checkpoint Date: Aug 2, 2025
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
/KriSYS/
├── docker-compose.yml
├── Dockerfile
├── blockchain/ (volume for database)
    └── blockchain.db
└── src/
    ├── app.py
    ├── blockchain.py
    ├── database.py
    ├── camera_server.py
    ├── requirements.txt
    └── static/
    	├── js/
			└── wallet_dashboard.js
		└── css/
			└── wallet_dashboard.css
    └── templates/
        ├── index.html
        ├── admin.html
        ├── wallet_dashboard.html
        └── scanner.html


NOTE: For common commands and testing as of now, see "DEV - quick referece.txt" and "DEV - Agenda Notes".txt

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
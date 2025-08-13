KriSYS - Crisis Communication Blockchain System

Overview

KriSYS is a humanitarian blockchain system for tracking people and coordinating aid during disasters when traditional communication networks fail. Unlike traditional blockchains, KriSYS uses centralized validation by aid organizations, enabling efficient crisis response with offline capabilities.

Core Concept:

- Aid organizations host dedicated blockchains for specific crises
- Families receive wallet addresses via QR codes
- Messages and check-ins are recorded as blockchain transactions
- Using blockchain for offline message/alert relaying
- Offline devices sync via WiFi when in proximity 
- Global family tracking through blockchain explorer
- Ad Hoc inventory / needs analysis data for supplies
- Immediate updates for journalists, public, court evidence


Current Status (August 5 2025)

# KriSYS - Crisis Communication Blockchain System

A humanitarian blockchain system for crisis communication enabling offline message queuing, family tracking, and aid coordination during disasters when internet/cellular networks are compromised.

## Project Status: Phase 2.5 (React Migration Complete)

✅ **Completed:**
- Flask backend API with custom blockchain implementation
- React frontend with component-based architecture
- Separated PGP key management system
- Client-side message decryption
- Docker containerized development environment
- Real-time blockchain explorer
- Family wallet management
- QR code generation for check-ins

🔄 **In Progress:**
- PGP message decryption in React components
- QR scanner implementation
- Advanced authentication features

## Architecture Overview

### Backend (Flask - Port 5000)
- **Custom Blockchain**: 3-minute block intervals, admin-validated blocks
- **Transaction Types**: check_in, message, alert, damage_report  
- **Policy System**: Crisis-specific configurations
- **PGP Key Management**: Secure key storage and delivery
- **SQLite Database**: Optimized with separate key storage

### Frontend (React/Next.js - Port 3000)
- **Component Architecture**: Modular, reusable components
- **Client-side Decryption**: All message decryption on user device
- **Real-time Updates**: Auto-refreshing blockchain data
- **Responsive Dashboard**: Multi-page wallet interface

### Security Model
- **Public Blockchain**: Transparent for check-ins and alerts
- **Encrypted Messages**: PGP-encrypted personal communications
- **Key Delivery**: Server only decrypts keys for authenticated users
- **Client Decryption**: All message reading happens on user device

## Quick Start

```bash
# Clone repository
git clone <repo-url>
cd krisys

# Start development environment
docker-compose up --build

# Access applications
# React Frontend: http://localhost:3000
# Flask API: http://localhost:5000
```

## Project Structure -File Structure
krisys/
├── docker-compose.yml          # Development environment
├── blockchain/                 # Shared SQLite database volume
├── krisys-backend/            # Flask API server
│   ├── Dockerfile
│   ├── app.py                 # Main Flask application
│   ├── blockchain.py          # Blockchain and wallet logic
│   ├── database.py            # Database management
│   └── requirements.txt       # Python dependencies
├── krisys-frontend/           # React application
│   ├── Dockerfile
│   ├── app/                   # Next.js pages
│   ├── components/            # React components
│   ├── services/api.js        # Flask API integration
│   ├── hooks/                 # Custom React hooks
│   └── styles/                # CSS styling
└── DEV-*.txt                  # Development notes

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


## Core Features

### 1. Blockchain Explorer
- View all blocks and transactions in real-time
- Create new family wallets
- Generate QR codes for family members

### 2. Family Wallet Dashboard  
- Multi-member wallet management
- Message encryption/decryption
- Transaction history and filtering
- Device registration for access

### 3. Crisis Communication
- **Public Alerts**: Broadcast emergency information
- **Private Messages**: Encrypted family communications  
- **Check-ins**: QR code-based location tracking
- **Damage Reports**: Structured incident reporting

### 4. Security & Authentication
- **Passphrase Protection**: Wallet access control
- **PGP Encryption**: End-to-end message security
- **Client-side Decryption**: Private keys never stored on server
- **Device Registration**: Multi-device access support

## Database Schema

### Core Tables
- **blocks**: Blockchain block storage
- **transactions**: Individual transaction records
- **wallets**: Lightweight family wallet data
- **wallet_keys**: Encrypted PGP key storage (separate for performance)
- **crises**: Crisis metadata and policies

## API Endpoints

### Public Endpoints
- `GET /blockchain` - Get full blockchain
- `GET /crisis` - Crisis information
- `POST /wallet` - Create family wallet
- `POST /checkin` - QR code check-in

### Wallet Endpoints  
- `GET /wallet/{id}` - Wallet information (no keys)
- `GET /wallet/{id}/transactions` - Wallet transaction history
- `POST /auth/unlock` - Authenticate and get private key

### Admin Endpoints
- `POST /admin/mine` - Manual block mining
- `POST /admin/alert` - Broadcast emergency alert

## Development Notes

### Technology Stack
- **Backend**: Python 3.11, Flask, SQLite, PGP (pgpy)
- **Frontend**: React 18, Next.js 14, JavaScript (no TypeScript)
- **Containerization**: Docker, docker-compose
- **Styling**: Custom CSS (no frameworks)

### Key Design Decisions
- **No TypeScript**: Keeping JavaScript-only for simplicity
- **No Tailwind**: Using custom CSS for full control
- **Client-side Crypto**: All decryption happens in browser
- **Separate Key Storage**: Performance optimization for frequent queries
- **Empty Passphrases**: Development convenience (will be secured in production)

## Crisis Response Workflow

1. **Setup Phase**: Admin creates crisis policy and initializes blockchain
2. **Registration**: Families create wallets and receive QR codes
3. **Emergency Response**: 
   - Check-ins at stations via QR scan
   - Emergency alerts broadcast to all users
   - Private family coordination via encrypted messages
4. **Recovery**: Damage reports and resource coordination

## Security Considerations

### Current (Development)
- Empty passphrases for easy testing
- CORS enabled for all origins
- Basic admin token authentication

### Production Requirements
- Strong passphrase requirements
- HTTPS/TLS encryption for all API calls  
- Admin key rotation and proper secrets management
- Rate limiting and DDoS protection
- Key revocation mechanisms


## DEVELOPMENT PHASES

### PHASE 1: Basic Infrastructure

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


### PHASE 2: Wallet System + QR Codes

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
Checkpoint Date: Aug 5 2025
-----------------------------------------------------------


### PHASE 3: Offline Messaging + Sync

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

### PHASE 4: Advanced Features

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


### Key Technical Requirements

- Transaction Size: Max 5KB, typically 1-2KB
- Block Interval: 3 minutes
- Queue Limits: Device storage dependent (~1GB suggested)
- Message Frequency: 1 per user per 3 minutes (policy-controlled)
- Station Hardware: Raspberry Pi + webcam sufficient
- Privacy: Address-only searching, no name-based lookup
- Scalability: Linear scaling, supports billions of transactions
- Recovery: QR code replacement system, address subscription for message history

### Critical Design Principles

1. Privacy First: No personally identifiable information on blockchain
2. Offline Resilience: System must work without internet connectivity
3. Family-Focused: Designed for family/group coordination
4. Aid-Organization Controlled: Blockchain owners have full validation control
5. Crisis-Specific: Each disaster gets its own blockchain instance
6. Simple UX: Must work for people under extreme stress with minimal tech literacy

### Testing Strategy

Set up test scenario with multiple devices, simulate offline conditions, test message queuing and sync, validate blockchain integrity across all operations.

### Development Workflow

1. Backend changes: Modify Flask app, test with curl/Postman
2. Frontend changes: Update React components, test in browser
3. Database changes: Update schema in database.py, restart containers
4. Integration testing: Full workflow testing with both services

System designed for humanitarian crises - prioritize reliability and simplicity over advanced features. Each aid organization can deploy independently for their crisis response efforts.


License: MIT - Attribute: Kristopher Driver krisdriver.com @paxdriver on social media kris@krisdriver.com
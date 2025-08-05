PGP AUTH FLOW

Server Responsibilities:


Flask Backend (the API server at port 5000):


- Stores encrypted private keys in SQLite database
- Handles passphrase authentication
- Decrypts and delivers private keys to authenticated users
- Stores public blockchain data
- NO message decryption (that's moving to client)
Next.js Frontend (port 3000):


- Receives private key from Flask backend after authentication
- Stores private key in browser memory only
- Handles all message decryption client-side
- Manages unlock state in React

Implementation Plan:


Flask Backend Changes:


1. Modify wallet creation to encrypt private keys with user passphrase
2. Add authentication endpoint that returns decrypted private key
3. Remove all message decryption from dashboard routes
React Frontend Changes:


1. Store received private key in React state
2. Each message component decrypts its own content using that key
3. Private key never leaves browser memory
Database Changes:


1. Store encrypted private keys in wallets table
2. Remove any session-based unlock tracking
The key insight: Flask backend becomes a secure key vault that only does authentication and key delivery, while React frontend becomes the crypto engine that decrypts all messages locally.
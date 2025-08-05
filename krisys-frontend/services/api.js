// services/api.js
import axios from 'axios'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'

export const api = {
    // Blockchain endpoints
    getBlockchain: () => axios.get(`${API_BASE}/blockchain`),
    getCrisisInfo: () => axios.get(`${API_BASE}/crisis`),
  
    // Wallet endpoints
    createWallet: (numMembers) => axios.post(`${API_BASE}/wallet`, { num_members: numMembers }),
    getWallet: (familyId) => axios.get(`${API_BASE}/wallet/${familyId}`),
    getWalletTransactions: (familyId) => axios.get(`${API_BASE}/wallet/${familyId}/transactions`),
    getWalletQR: (familyId, address) => axios.get(`${API_BASE}/wallet/${familyId}/qr/${address}`),
        
    unlockWallet: (familyId, passphrase) => 
        axios.post(`${API_BASE}/auth/unlock`, {
            family_id: familyId,
            passphrase: passphrase || "" // Empty for dev
        }).then(res => res.data)
        .catch(error => {
            console.error("Unlock error:", error.response?.data);
            throw new Error(error.response?.data?.error || "Unlock failed");
        }),
  
    // Auth endpoints
    unlockWallet: (familyId, passphrase) => axios.post(`${API_BASE}/auth/unlock`, { family_id: familyId, passphrase }),
    
    // Transaction endpoints
    addTransaction: (transaction) => axios.post(`${API_BASE}/transaction`, transaction),
    checkin: (address, stationId = 'STATION_001') => axios.post(`${API_BASE}/checkin`, { address, station_id: stationId }),
    
    // Admin endpoints (you can add headers for admin token later)
    adminMine: () => axios.post(`${API_BASE}/admin/mine`),
    adminAlert: (message, priority) => axios.post(`${API_BASE}/admin/alert`, { message, priority }),
}
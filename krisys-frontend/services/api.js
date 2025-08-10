// services/api.js
import axios from 'axios'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'

// Create axios instance with interceptor for dev overrides
const apiClient = axios.create({
    baseURL: API_BASE
})

// blockchain's private_key
const ADMIN_TOKEN = process.env.NEXT_PUBLIC_ADMIN_TOKEN // this should be taken from blockchain/master_private_key.asc

// Add request interceptor to include dev headers
apiClient.interceptors.request.use((config) => {
    // Add rate limit override header if enabled
    if (localStorage.getItem('dev_bypass_rate_limit') === 'true') {
        config.headers['X-Dev-Rate-Override'] = 'true'
    }
    // Add admin token for admin endpoints
    if (config.url?.startsWith('/admin/')) {
        // For development, we'll read the master private key from a known location
        // In production, this would be handled more securely
        config.headers['X-Admin-Token'] = ADMIN_TOKEN
    }
    
    return config
})

export const api = {
    // Blockchain endpoints
    getBlockchain: () => axios.get(`${API_BASE}/blockchain`),
    getCrisisInfo: () => axios.get(`${API_BASE}/crisis`),
    getCurrentPolicy: () => apiClient.get('/policy'),
  
    // Wallet endpoints
    createWallet: (numMembers) => axios.post(`${API_BASE}/wallet`, { num_members: numMembers }),
    getWallet: (familyId) => axios.get(`${API_BASE}/wallet/${familyId}`),
    getWalletTransactions: (familyId) => axios.get(`${API_BASE}/wallet/${familyId}/transactions`),
    getWalletQR: (familyId, address) => axios.get(`${API_BASE}/wallet/${familyId}/qr/${address}`),
        
    // Auth endpoints
    unlockWallet: (familyId, passphrase) => 
        axios.post(`${API_BASE}/auth/unlock`, {
            family_id: familyId,
            passphrase: passphrase || "" // Empty for dev
        }).then(res => res.data)
        .catch(error => {
            console.error("Unlock error:", error.response?.data);
            throw new Error(error.response?.data?.error || "Unlock failed");
        }),

    // Transaction endpoints
    addTransaction: (transaction) => apiClient.post('/transaction', transaction),
    checkin: (address, stationId = 'MEDICAL_TENT_05') => axios.post(`${API_BASE}/checkin`, { address, station_id: stationId }),
    
    // Admin endpoints (you can add headers for admin token later)
    adminMine: () => {
        return fetch(`${API_BASE}/admin/mine`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': ADMIN_TOKEN // THIS IS SUPPOSED TO INTERCEPTED BY APICLIENT, I THOUGHT?
            }
        }).then(res => res.json())
    },
    
    adminAlert: (message, priority) => {
        return fetch(`${API_BASE}/admin/alert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Token': ADMIN_TOKEN // You'll need to set this properly
            },
            body: JSON.stringify({ message, priority })
        })
    }

}
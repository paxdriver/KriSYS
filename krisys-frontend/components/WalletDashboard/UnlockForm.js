// components/WalletDashboard/UnlockForm.js
import { useState, useEffect } from 'react'
import { api } from '../../services/api'
import { disasterStorage } from '../../services/localStorage'

export default function UnlockForm({ familyId, onUnlock }) {
    const [passphrase, setPassphrase] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    
    // CHECK FOR EXISTING LOCAL KEY ON COMPONENT LOAD
    useEffect(() => {
        console.log('🔍 Checking for existing private key in local storage...')
        const localKey = disasterStorage.getPrivateKey(familyId)
        if (localKey) {
            console.log('✅ Found existing private key! Auto-unlocking wallet...')
            // Use setTimeout to defer state update
            setTimeout(() => onUnlock(localKey), 0)
        }
    }, [familyId, onUnlock])

    const handleUnlock = async (e) => {
        e.preventDefault()
        setLoading(true)
        setError('')

        try {
            console.log('🌐 Attempting to fetch private key from server...')
            
            const result = await api.unlockWallet(familyId, passphrase)
            
            if (result.status === 'unlocked' && result.private_key) {
                console.log('✅ Server returned private key')
                
                // SAVE TO LOCAL STORAGE FOR OFFLINE ACCESS
                console.log('💾 Saving private key locally for disaster communication')
                disasterStorage.savePrivateKey(familyId, result.private_key)
                
                // Also save wallet data if we have it
                // This enables offline message reading and queuing
                    // defer state update for hydration error workaround
                setTimeout(() => onUnlock(result.private_key), 0)   
                
            } else {
                setError(result.error || 'Unlock failed')
            }
        }
        catch (error) {
            console.error('🚨 Server unlock failed:', error.message)
            
            // TRY LOCAL STORAGE AS FALLBACK (for offline scenarios)
            console.log('🔄 Server failed - checking local storage...')
            const localKey = disasterStorage.getPrivateKey(familyId)
            if (localKey) {
                console.log('🏠 Using locally stored key (offline mode)')
                onUnlock(localKey)
            } else {
                setError('Cannot unlock: No internet connection and no local key found')
            }
        } 
        finally {
            setLoading(false)
        }
    }
    
    return (
        <form onSubmit={handleUnlock} className="unlock-form">
            <h3>Unlock Wallet</h3>
            <p className="unlock-hint">
                💡 Your key will be stored locally for offline message access
            </p>
            <label>Enter Passphrase:</label>
            <input 
                type="password" 
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="form-input"
                disabled={loading}
                placeholder="Development: leave empty"
            />
            <button 
                type="submit" 
                className="btn" 
                disabled={loading}
            >
                {loading ? 'Unlocking...' : 'Unlock Wallet'}
            </button>
            {error && <p className="error">{error}</p>}
        </form>
    )
}
// components/WalletDashboard/UnlockForm.js
import { useState } from 'react'
import { api } from '../../services/api'

export default function UnlockForm({ familyId, onUnlock }) {
    const [passphrase, setPassphrase] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    
    const handleUnlock = async (e) => {
        e.preventDefault()
        setLoading(true)
        setError('')

        try {
            console.log('🔓 Attempting unlock for family_id:', familyId)
            console.log('🔓 Passphrase:', passphrase || '(empty)')
            
            const result = await api.unlockWallet(familyId, passphrase)
            
            console.log('🔓 API Response:', result)
            
            if (result.status === 'unlocked') {
                console.log('✅ Unlock successful, calling onUnlock with key:', result.private_key ? 'KEY_PRESENT' : 'NO_KEY')
                onUnlock(result.private_key); // Pass decrypted key to parent
            } 
            else {
                console.log('❌ Unlock failed - status:', result.status)
                setError(result.error || 'Unlock failed')
            }
        }
        catch (error) {
            console.error('🚨 API Error:', error)
            console.error('🚨 Error response:', error.response?.data)
            setError(`Server error: ${error.message}`)
        } 
        finally {
            setLoading(false)
        }
    }
    
    return (
        <form onSubmit={handleUnlock} className="unlock-form">
        <h3>Unlock Wallet</h3>
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
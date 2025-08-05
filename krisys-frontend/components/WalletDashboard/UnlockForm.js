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
            
            const result = await api.unlockWallet(familyId, passphrase)
            
            if (result.data.status === 'unlocked' && result.private_key) {
                onUnlock(result.private_key); // Pass decrypted key to parent
            } 
            else {
                setError(result.error || 'Unlock failed')
            }
        }
        catch (error) {
            console.error('Unlock error:', error.message)
            console.log(error)
            setError('Server error during unlock form submission.')
        } 
        finally {
            setLoading(false)
        }
    }
    
    return (
        <form onSubmit={handleSubmit} className="unlock-form">
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
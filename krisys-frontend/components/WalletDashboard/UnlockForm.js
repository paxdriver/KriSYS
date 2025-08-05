// components/WalletDashboard/UnlockForm.js
import { useState } from 'react'
import { api } from '../../services/api'

export default function UnlockForm({ familyId, onUnlock }) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  
  const handleUnlock = async () => {
    try {
      setLoading(true)
      setError('')
      
      const response = await api.unlockWallet(familyId, passphrase)
      
      if (response.data.status === 'unlocked') {
        onUnlock()
      } else {
        setError(response.data.error || 'Unlock failed')
      }
    } catch (error) {
      console.error('Unlock error:', error)
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }
  
  return (
    <div id="unlock-form" className="unlock-form">
      <h3>Unlock Wallet</h3>
      <label>Enter Passphrase:</label>
      <input 
        type="password" 
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        className="form-input"
        onKeyPress={(e) => e.key === 'Enter' && handleUnlock()}
      />
      <button 
        className="btn" 
        onClick={handleUnlock}
        disabled={loading}
      >
        {loading ? 'Unlocking...' : 'Unlock Wallet'}
      </button>
      {error && <p style={{color: 'red'}}>{error}</p>}
    </div>
  )
}
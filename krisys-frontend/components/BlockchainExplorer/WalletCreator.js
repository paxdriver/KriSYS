import { useState } from 'react'
import { api } from '../../services/api'
import { useRouter } from 'next/navigation'

export default function WalletCreator() {
    const [numMembers, setNumMembers] = useState(3)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const router = useRouter()

    const createWallet = async () => {
        setLoading(true)
        setError('')
        
        try {
            const response = await api.createWallet(numMembers)
            const wallet = response.data
            
            alert(`Wallet created!\nFamily ID: ${wallet.family_id}`)
            
            // Redirect to wallet dashboard
            router.push(`/wallet/${wallet.family_id}`)
            
        } catch (error) {
            setError(error.response?.data?.error || 'Failed to create wallet')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="card">
            <div className="card-header">
                <h3>Create Family Wallet</h3>
            </div>
            <div className="card-body">
                <div className="form-group">
                    <label>Number of family members:</label>
                    <input 
                        type="number" 
                        min="1" 
                        max="20"
                        value={numMembers}
                        onChange={(e) => setNumMembers(parseInt(e.target.value))}
                        className="form-input"
                        disabled={loading}
                    />
                </div>
                
                <button 
                    onClick={createWallet}
                    className="btn"
                    disabled={loading}
                >
                    {loading ? 'Creating...' : 'Create Wallet'}
                </button>
                
                {error && <p className="error">{error}</p>}
            </div>
        </div>
    )
}
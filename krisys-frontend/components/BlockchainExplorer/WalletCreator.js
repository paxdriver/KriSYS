// components/BlockchainExplorer/WalletCreator.js - FIXED
import { useState } from 'react'
import { api } from '../../services/api'

export default function WalletCreator() {
    const [numMembers, setNumMembers] = useState(3)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [createdWallet, setCreatedWallet] = useState(null)
    const [debugInfo, setDebugInfo] = useState(null)

    const createWallet = async () => {
        setLoading(true)
        setError('')
        
        try {
            const response = await api.createWallet(numMembers)
            const wallet = response.data
            
            setCreatedWallet(wallet)
            
            // Load debug info - get the latest block and transactions
            const [blockchainRes, walletTxRes] = await Promise.all([
                api.getBlockchain(),
                api.getWalletTransactions(wallet.family_id)
            ])
            
            setDebugInfo({
                latestBlock: blockchainRes.data[blockchainRes.data.length - 1],
                walletTransactions: walletTxRes.data,
                fullWalletData: wallet
            })
            
            console.log('Created Wallet:', wallet)
            console.log('Latest Block:', blockchainRes.data[blockchainRes.data.length - 1])
            console.log('Wallet Transactions:', walletTxRes.data)
            
        } catch (error) {
            setError(error.response?.data?.error || 'Failed to create wallet')
        } finally {
            setLoading(false)
        }
    }

    const copyAddress = (address) => {
        navigator.clipboard.writeText(address)
        alert('Address copied!')
    }

    const goToWallet = () => {
        if (createdWallet) {
            window.location.href = `/wallet/${createdWallet.family_id}`
        }
    }

    return (
        <div className="card">
            <div className="card-header">
                <h3>Create Family Wallet</h3>
            </div>
            <div className="card-body">
                {!createdWallet ? (
                    <>
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
                    </>
                ) : (
                    <div className="wallet-created">
                        <h4>✅ Wallet Created!</h4>
                        <div className="wallet-info">
                            <div>
                                <strong>Family ID:</strong> 
                                <span onClick={() => copyAddress(createdWallet.family_id)} style={{cursor: 'pointer', marginLeft: '8px'}}>
                                    {createdWallet.family_id} 📋
                                </span>
                            </div>
                            
                            <h5>Members:</h5>
                            {createdWallet.members?.map(member => (
                                <div key={member.address} className="member-debug">
                                    <span>{member.name}: </span>
                                    <span 
                                        onClick={() => copyAddress(member.address)}
                                        style={{cursor: 'pointer', fontFamily: 'monospace'}}
                                    >
                                        {member.address} 📋
                                    </span>
                                </div>
                            ))}
                        </div>
                        
                        <div className="wallet-actions">
                            <button onClick={goToWallet} className="btn">
                                Open Wallet Dashboard
                            </button>
                            <button 
                                onClick={() => {
                                    setCreatedWallet(null)
                                    setDebugInfo(null)
                                }} 
                                className="btn"
                            >
                                Create Another
                            </button>
                        </div>
                        
                        {/* Debug Info */}
                        {debugInfo && process.env.NODE_ENV === 'development' && (
                            <details className="debug-info">
                                <summary>Debug Info (Development Only)</summary>
                                <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
                            </details>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
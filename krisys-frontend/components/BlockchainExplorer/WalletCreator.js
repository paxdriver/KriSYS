// components/BlockchainExplorer/WalletCreator.js
'use client'
import { useState } from 'react'
import { api } from '../../services/api'
import { useRouter } from 'next/navigation'
import '../../styles/landing.css'

const MIN_PASSPHRASE_LENGTH = 1

export default function WalletCreator() {
    const [numMembers, setNumMembers] = useState(3)
    const [passphrase, setPassphrase] = useState('')
    const [confirmPassphrase, setConfirmPassphrase] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [createdWallet, setCreatedWallet] = useState(null)
    const [debugInfo, setDebugInfo] = useState(null)

    const router = useRouter()

    const createWallet = async () => {
        // Validate passphrase
        if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
            setError('Passphrase must be at least 8 characters')
            return
        }
        
        if (passphrase !== confirmPassphrase) {
            setError('Passphrases do not match')
            return
        }
        
        setLoading(true)
        setError('')
        
        try {
            const response = await api.createWallet(numMembers, passphrase)
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
            router.push(`/wallet/${createdWallet.family_id}`)
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
                        
                        <div className="form-group">
                            <label>Wallet Passphrase:</label>
                            <input 
                                type="password"
                                value={passphrase}
                                onChange={(e) => setPassphrase(e.target.value)}
                                placeholder="At least 8 characters"
                                className="form-input"
                                disabled={loading}
                                required
                            />
                            <small className="form-hint">
                                💡 This passphrase protects your private messages. Write it down!
                            </small>
                        </div>
                        
                        <div className="form-group">
                            <label>Confirm Passphrase:</label>
                            <input 
                                type="password"
                                value={confirmPassphrase}
                                onChange={(e) => setConfirmPassphrase(e.target.value)}
                                placeholder="Re-enter passphrase"
                                className="form-input"
                                disabled={loading}
                                required
                            />
                        </div>
                        
                        <button 
                            onClick={createWallet}
                            className="btn"
                            disabled={loading || !passphrase || !confirmPassphrase}
                        >
                            {loading ? 'Creating...' : 'Create Wallet'}
                        </button>
                        
                        {error && <p className="error">{error}</p>}
                        
                        <div className="security-info">
                            <h4>🔐 Security Features:</h4>
                            <ul>
                                <li>✅ Your passphrase encrypts your private key</li>
                                <li>✅ Messages are encrypted end-to-end</li>
                                <li>✅ Keys stored locally for offline access</li>
                                <li>✅ Blockchain admin cannot read your messages</li>
                            </ul>
                        </div>
                    </>
                ) : (
                    <div className="wallet-created">
                        <h4>✅ Wallet Created!</h4>
                        <div className="security-reminder">
                            <p>🔒 <strong>Important:</strong> Keep your passphrase safe! You will need it to unlock your wallet and read messages.</p>
                        </div>
                        
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
                                    setPassphrase('')
                                    setConfirmPassphrase('')
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
// components/WalletDashboard/UnlockForm.js
'use client'
import { useState, useEffect } from 'react'
import { KeyManager } from '../../services/keyManager'

export default function UnlockForm({ familyId, onUnlock }) {
    const [passphrase, setPassphrase] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [validating, setValidating] = useState(true)
    const [isFirstTime, setIsFirstTime] = useState(false)
    
    // CHECK FOR EXISTING LOCAL KEY ON COMPONENT LOAD (OFFLINE-SAFE)
    useEffect(() => {
        const checkExistingKey = async () => {
            console.log('🔍 Checking for existing cached private key...')
            setValidating(true)

            try {
                const cachedKey = localStorage.getItem('krisys_private_key')
                if (cachedKey) {
                    const keyData = JSON.parse(cachedKey)
                    if ( keyData.familyId === familyId && keyData.privateKey) {
                        console.log(
                            'Found cached private key for this wallet. Auto-unlocking without server (offline-safe).'
                        )
                        setTimeout( () => onUnlock(keyData.privateKey), 0 )
                        
                        return
                    }
                }

                console.log(
                    'No cached key for this wallet - user needs to unlock online at least once.'
                )
                setIsFirstTime(true)
            } 
            catch (error) {
                console.log(
                    '⚠️ Auto-unlock check failed - user needs to enter passphrase'
                )
                setIsFirstTime(true)
            } 
            finally {
                setValidating(false)
            }
        }

        checkExistingKey()
    }, [familyId, onUnlock])

    const handleUnlock = async (e) => {
        e.preventDefault()
        setLoading(true)
        setError('')

        try {
            console.log('🔑 Attempting to unlock wallet with passphrase...')
            
            // Use KeyManager for the full flow
            const privateKey = await KeyManager.getPrivateKey(familyId, passphrase)
            
            if (privateKey) {
                console.log('✅ Wallet unlocked successfully')
                setTimeout(() => onUnlock(privateKey), 0)
            } else {
                setError('Unlock failed - no private key returned')
            }
            
        } catch (error) {
            console.error('🚨 Unlock failed:', error.message)
            
            // More specific error messages
            if (error.message.includes('Invalid passphrase')) {
                setError('Incorrect passphrase. Please try again.')
            } else if (error.message.includes('No internet')) {
                setError('Cannot unlock: No internet connection and no local key found')
            } else if (error.message.includes('does not match')) {
                setError('Key validation failed - this may not be your wallet')
            } else {
                setError(error.message || 'Unlock failed')
            }
        } finally {
            setLoading(false)
        }
    }
    
    // Show loading state while checking for existing keys
    if (validating) {
        return (
            <div className="unlock-form">
                <h3>Loading Wallet</h3>
                <div className="loading-spinner">
                    🔍 Checking for existing keys...
                </div>
            </div>
        )
    }
    
    return (
        <form onSubmit={handleUnlock} className="unlock-form">
            <h3>Unlock Wallet</h3>
            {isFirstTime && (
                <p className="first-time-hint">
                    🔑 Enter the passphrase you used when creating this wallet
                </p>
            )}
            <p className="unlock-hint">
                Your validated key will be stored locally for offline message access
            </p>
            <label>Enter Passphrase:</label>
            <input 
                type="password" 
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="form-input"
                disabled={loading}
                placeholder={isFirstTime ? "Enter your wallet passphrase" : "Development: leave empty"}
            />
            <button 
                type="submit" 
                className="btn" 
                disabled={loading}
            >
                {loading ? 'Unlocking...' : 'Unlock Wallet'}
            </button>
            {error && <p className="error">{error}</p>}
            
            <div className="unlock-info">
                <details>
                    <summary>🔒 Security Info</summary>
                    <p>Your private key is:</p>
                    <ul>
                        <li>Encrypted with your passphrase</li>
                        <li>Validated against your wallet</li>
                        <li>Stored locally for offline access</li>
                        <li>Never seen by the server in plain text</li>
                    </ul>
                </details>
            </div>
        </form>
    )
}
// components/WalletDashboard/MessageDisplay.js
'use client'
import { useState, useEffect } from 'react'
import { KeyManager } from '@/services/keyManager'

export default function MessageDisplay({ message, privateKey, family_id, className = "" }) {
    const [decryptedText, setDecryptedText] = useState('')
    const [decrypting, setDecrypting] = useState(false)
    const [decryptError, setDecryptError] = useState(null)

    useEffect(() => {
        if (!privateKey || !family_id) {
            setDecryptedText('')
            return
        }
        
        // If not encrypted, show as-is
        if (!message?.includes('BEGIN PGP MESSAGE')) {
            setDecryptedText(message)
            return
        }

        // Use KeyManager for all the complex stuff
        const decryptMessage = async () => {
            setDecrypting(true)
            setDecryptError(null)
            
            try {
                // KeyManager should handle all the decryption logic
                const decrypted = await KeyManager.decryptMessage(message, privateKey)
                setDecryptedText(decrypted)
            } catch (error) {
                console.error('❌ Decryption failed:', error)
                setDecryptError(error.message)
                setDecryptedText('')
            } finally {
                setDecrypting(false)
            }
        }

        decryptMessage()
    }, [message, privateKey, family_id])

    // Simple rendering logic
    if (decrypting) {
        return (
            <div className={`message-content decrypting ${className}`}>
                <span className="encrypted">🔓 Decrypting...</span>
            </div>
        )
    }

    if (decryptedText) {
        return (
            <div className={`message-content decrypted ${className}`}>
                {decryptedText}
                <span className="decrypt-status">🔓</span>
            </div>
        )
    }

    // Show encrypted blob
    return (
        <div className={`message-content encrypted-blob ${className}`}>
            <div className="encrypted-preview">
                🔒 {message?.substring(0, 60)}...
            </div>
            {decryptError && (
                <div className="decrypt-error">
                    Failed to decrypt: {decryptError}
                </div>
            )}
        </div>
    )
}
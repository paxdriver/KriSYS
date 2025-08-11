// /components/MessageDisplay.js
import { useState, useEffect } from 'react'
import * as openpgp from 'openpgp'
import { KeyManager } from '@/services/keyManager'

export default function MessageDisplay({ message, privateKey, className = "" }) {
    const [decryptedText, setDecryptedText] = useState('')
    const [decrypting, setDecrypting] = useState(false)
    const [decryptError, setDecryptError] = useState(null)

    // Check for user's private key and fetch if no good
    useEffect(() => {
        if (!privateKey || !walletData?.family_id) {
            setDecryptedText('')
            return
        }
        
        // DEV NOTE: CHANGE THIS TO SOMETHING MORE ROBUST, IT IS POSSIBLE SOMEONE WILL SEND A PGP MESSAGE ENCRYPTED THEMSELVES PRIVATELY OVER THE CHAIN SO THE DECRYPTED MESSAGE WOULD STILL CONTAIN 'BEGIN PGP MESSAGE'
        if (!message?.includes('BEGIN PGP MESSAGE')) {
            setDecryptedText(message)
            return
        }

        const decryptMessage = async () => {
            setDecrypting(true)
            setDecryptError(null)
            
            try {
                console.log('🔓 Decrypting message...')
                
                // Get the actual private key (from cache or server)
                const actualPrivateKey = await KeyManager.getPrivateKey(
                    walletData.family_id, 
                    '' // Empty passphrase for development
                )
                
                // Decrypt the private key object
                const privateKeyObj = await openpgp.decryptKey({
                    privateKey: await openpgp.readPrivateKey({ armoredKey: actualPrivateKey }),
                    passphrase: '' // Already decrypted by KeyManager
                })
                
                // Read and decrypt the message
                const messageObj = await openpgp.readMessage({ 
                    armoredMessage: message  // Fixed: was messageObj
                })
                
                const { data: decrypted } = await openpgp.decrypt({
                    message: messageObj,
                    decryptionKeys: privateKeyObj,
                    format: 'utf8'
                })
                
                setDecryptedText(decrypted)
                console.log('✅ Message decrypted successfully')
                
            } catch (error) {
                console.error('❌ Decryption failed:', error)
                setDecryptError(`Decryption failed: ${error.message}`)
            } finally {
                setDecrypting(false)
            }
        }

        decryptMessage()
    }, [message, privateKey, walletData?.family_id])



    // Render logic
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

    
    // Show encrypted blob (no key or decryption failed)
    return (
        <div className={`message-content encrypted-blob ${className}`}>
            <div className="encrypted-preview">
                🔒 {message?.substring(0, 60)}...
            </div>
            {decryptError && (
                <div className="decrypt-error">Failed to decrypt</div>
            )}
        </div>
    )
}
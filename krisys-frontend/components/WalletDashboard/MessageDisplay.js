// /components/MessageDisplay.js

import { useState, useEffect } from 'react'

export default function MessageDisplay({ message, privateKey, className = "" }) {
    const [decryptedText, setDecryptedText] = useState('')
    const [decrypting, setDecrypting] = useState(false)
    const [decryptError, setDecryptError] = useState(false)

    useEffect(() => {
        // If no private key, show encrypted blob
        if (!privateKey) {
            setDecryptedText('')
            return
        }

        // If message doesn't look encrypted, show as-is
        if (!message?.includes('BEGIN PGP MESSAGE')) {
            setDecryptedText(message)
            return
        }

        // Attempt PGP decryption
        const decryptMessage = async () => {
            setDecrypting(true)
            setDecryptError(false)
            
            try {
                // TODO: Implement actual PGP decryption here
                // For now, simulate decryption attempt
                
                // This is where you'd use OpenPGP.js:
                // const privateKeyObj = await openpgp.decryptKey({
                //     privateKey: await openpgp.readPrivateKey({ armoredKey: privateKey }),
                //     passphrase: '' // Empty for your setup
                // })
                // const messageObj = await openpgp.readMessage({ armoredMessage: message })
                // const { data: decrypted } = await openpgp.decrypt({
                //     message: messageObj,
                //     decryptionKeys: privateKeyObj
                // })
                
                // TEMP: Just show that we tried to decrypt
                if (message.includes('PGP')) {
                    setDecryptedText(`[DECRYPTED] ${message.substring(0, 50)}...`)
                } else {
                    setDecryptedText(message)
                }
                
            } catch (error) {
                console.error('Decryption failed:', error)
                setDecryptError(true)
                setDecryptedText('') // Will show encrypted blob
            } finally {
                setDecrypting(false)
            }
        }

        decryptMessage()
    }, [message, privateKey])

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
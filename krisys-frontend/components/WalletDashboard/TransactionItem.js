// components/WalletDashboard/TransactionItem.js

import { useEffect, useState } from 'react'

export default function TransactionItem({ transaction, privateKey }) {
    const [decryptedContent, setDecryptedContent] = useState('')
    const [isDecrypting, setIsDecrypting] = useState(false)
    const [decryptError, setDecryptError] = useState('')

    useEffect(() => {
        const decryptMessage = async () => {
            if (!privateKey || transaction.type_field !== 'message') return
            
            try {
                setIsDecrypting(true)
                
                // Import PGP key
                const pgpKey = new pgpy.PGPKey()
                await pgpKey.parse(privateKey)
                
                // Parse encrypted message
                const encryptedMsg = pgpy.PGPMessage.fromBlob(transaction.message_data)
                
                // Decrypt
                const decrypted = await pgpKey.decrypt(encryptedMsg)
                setDecryptedContent(decrypted.message)
            } catch (err) {
                console.error("Decryption failed:", err)
                setDecryptError("Failed to decrypt message")
                setDecryptedContent(transaction.message_data) // Show encrypted version
            } 
            finally {
                setIsDecrypting(false)
            }
        }

        decryptMessage()
    }, [privateKey, transaction])

    return (
        <div className="transaction">
            <div className="tx-header">
                <span className="tx-type">{transaction.type_field}</span>
                
                {transaction.type_field === 'message' && (
                    <span className="tx-lock">
                        {decryptedContent ? '🔓' : '🔒'}
                        {isDecrypting && '⏳'}
                    </span>
                )}
                
                <span className="tx-time">
                    {new Date(transaction.timestamp_posted * 1000).toLocaleTimeString()}
                </span>
            </div>
        
            <div className="tx-message">
                {transaction.type_field === 'message' ? (<>
                    {decryptedContent || transaction.message_data}
                    {decryptError && <div className="error">{decryptError}</div>}
                </>) : (
                    transaction.message_data
                )}
            </div>
    </div>)
}
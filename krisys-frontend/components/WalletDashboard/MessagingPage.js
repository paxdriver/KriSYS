import { useState, useEffect, useMemo } from 'react'
import { api } from '../../services/api'
import * as openpgp from 'openpgp'
import MessageDisplay from './MessageDisplay'
import { disasterStorage } from '@/services/localStorage'
import ContactName from './ContactName'

export default function MessagingPage({ walletData, transactions, privateKey }) {
    const [selectedRecipient, setSelectedRecipient] = useState('')
    const [messageText, setMessageText] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState('')
    const [decryptedMessages, setDecryptedMessages] = useState({})
 
    // Memoize addresses to prevent unnecessary recalculations
    const myAddresses = useMemo(() => 
        walletData?.members?.map(m => m.address) || []
    , [walletData?.members])

    // Memoize filtered messages to prevent infinite loop
    const myMessages = useMemo(() => 
        transactions?.filter(tx => 
            tx.type_field === 'message' && 
            myAddresses.some(addr => tx.related_addresses?.includes(addr))
        ) || []
    , [transactions, myAddresses])

    const encryptMessageOffline = async (messageText, recipientAddress) => {
        console.log('🔐 Starting offline message encryption...')
        console.log('📝 Message:', messageText)
        console.log('👤 Recipient:', recipientAddress)
        
        try {
            // STEP 1: Extract family_id from member address
            // Address format: "familyId-memberSuffix" (e.g., "abc123-def456")
            const familyId = recipientAddress.split('-').slice(0, -1).join('-')
            console.log('🏠 Recipient family ID:', familyId)
            
            // STEP 2: Try to get public key from local storage first (for offline)
            const publicKeys = disasterStorage.getPublicKeys()
            let publicKeyString = publicKeys[familyId]?.publicKey
            
            if (publicKeyString) {
                console.log('🏠 Found recipient public key in local storage!')
            } else {
                console.log('🌐 Public key not in local storage - fetching from server...')
                
                // STEP 3: Fetch public key from server and cache it locally
                try {
                    const response = await api.getWallet(familyId)
                    const walletData = response.data
                    
                    // Get the actual public key from wallet_keys table
                    const keyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/wallet/${familyId}/public-key`)
                    const keyData = await keyResponse.json()
                    
                    publicKeyString = keyData.public_key
                    
                    if (publicKeyString) {
                        // Save for future offline use
                        console.log('💾 Caching public key locally for offline encryption')
                        disasterStorage.savePublicKey(familyId, publicKeyString)
                    } else {
                        throw new Error('No public key found for recipient')
                    }
                    
                } catch (fetchError) {
                    console.error('❌ Failed to fetch public key:', fetchError)
                    throw new Error('Cannot encrypt: Recipient public key not available offline and server unreachable')
                }
            }
            
            // STEP 4: Parse the public key string into OpenPGP key object
            console.log('📖 Parsing recipient public key...')
            const publicKey = await openpgp.readKey({
                armoredKey: publicKeyString
            })
            
            // STEP 5: Create message object from plaintext
            console.log('📝 Creating message object...')
            const message = await openpgp.createMessage({
                text: messageText
            })
            
            // STEP 6: Encrypt message with recipient's public key
            console.log('🔒 Encrypting message...')
            const encryptedMessage = await openpgp.encrypt({
                message: message,
                encryptionKeys: publicKey,
                format: 'armored' // Returns ASCII-armored string
            })
            
            console.log('✅ Message encrypted successfully!')
            console.log('📦 Encrypted message preview:', encryptedMessage.substring(0, 100) + '...')
            
            return encryptedMessage
            
        } catch (error) {
            console.error('❌ Encryption failed:', error)
            throw new Error(`Encryption failed: ${error.message}`)
        }
    }

    const sendMessage = async (e) => {
        e.preventDefault()
        if (!selectedRecipient || !messageText.trim()) return

        setSending(true)
        setError('')

        try {
            // Encrypt message locally using stored public keys
            const encryptedMessage = await encryptMessageOffline(messageText, selectedRecipient)
            
            const transaction = {
                timestamp_created: Date.now() / 1000,
                station_address: myAddresses[0],
                message_data: encryptedMessage,
                related_addresses: [selectedRecipient],
                type_field: 'message',
                priority_level: 5
            }

            // TRY TO SEND ONLINE FIRST
            try {
                await api.addTransaction(transaction)
                console.log('📡 Message sent online immediately')
                alert('Message sent!')
            } catch (networkError) {
                // QUEUE FOR OFFLINE TRANSMISSION
                console.log('📱 No connection - queueing message for later transmission')
                disasterStorage.queueMessage(transaction)
                alert('📱 No internet - message queued for transmission when connected')
            }
            
            setMessageText('')
            setError('')

        } catch (err) {
            setError(err.message || 'Failed to send message')
        } finally {
            setSending(false)
        }
    }

    // TODO - Helper function to find wallet by member address
    const findWalletByMemberAddress = async (memberAddress) => {
        // Extract family_id from address (everything before the last dash)
        const familyId = memberAddress.split('-').slice(0, -1).join('-')
        try {
            const response = await api.getWallet(familyId)
            return response.data
        } catch {
            return null
        }
    }

    return (
        <div id="messaging-page" className="page">
            <div className="page-header">
                <h1 className="page-title">Direct Messages</h1>
            </div>

            {/* Send Message Form */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">Send Message</h3>
                </div>
                <div className="card-body">
                    <form onSubmit={sendMessage}>
                        <div className="form-group">
                            <label>Send to:</label>
                            <select 
                                value={selectedRecipient}
                                onChange={(e) => setSelectedRecipient(e.target.value)}
                                className="form-input"
                                disabled={sending}
                            >
                                <option value="">Select recipient...</option>
                                {walletData?.members?.map(member => (
                                    <option key={member.address} value={member.address}>
                                        <select>
                                            <ContactName 
                                                address={member.address} 
                                                isUnlocked={!!privateKey}
                                            /> 
                                                {/* ({member.address}) */}
                                        </select>
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="form-group">
                            <label>Message:</label>
                            <textarea 
                                value={messageText}
                                onChange={(e) => setMessageText(e.target.value)}
                                className="form-input"
                                rows="4"
                                placeholder="Type your message..."
                                disabled={sending}
                            />
                        </div>

                        <button 
                            type="submit" 
                            className="btn"
                            disabled={sending || !selectedRecipient || !messageText.trim()}
                        >
                            {sending ? 'Sending...' : 'Send Message'}
                        </button>
                        
                        {error && <p className="error">{error}</p>}
                    </form>
                </div>
            </div>

            {/* Messages List */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">My Messages ({myMessages.length})</h3>
                </div>
                <div className="card-body">
                    {myMessages.length === 0 ? (
                        <p>No messages yet</p>
                    ) : (
                        myMessages
                            .sort((a, b) => b.timestamp_posted - a.timestamp_posted)
                            .map(tx => (
                                <div key={tx.transaction_id} className="message-item">
                                    <div className="message-header">
                                        
                                            <span className="message-from">
                                                From: <ContactName 
                                                    address={tx.station_address}
                                                    isUnlocked={!!privateKey}
                                                    editable={true}
                                                />
                                            </span>
                                        
                                        <span className="message-time">
                                            {new Date(tx.timestamp_posted * 1000).toLocaleString()}
                                        </span>
                                    </div>
                                    <MessageDisplay message={tx.message} privateKey={privateKey} />
                                </div>
                            ))
                    )}
                </div>
            </div>
        </div>
    )
}
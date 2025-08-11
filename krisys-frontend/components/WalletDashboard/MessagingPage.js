// components/WalletDashboard/MessagingPage.js
import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
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
    const [showContactPicker, setShowContactPicker] = useState(false)
    const searchParams = useSearchParams()

    const myAddresses = useMemo(() => 
        walletData?.members?.map(m => m.address) || []
    , [walletData?.members])

    const myMessages = useMemo(() => 
        transactions?.filter(tx => 
            tx.type_field === 'message' && 
            myAddresses.some(addr => tx.related_addresses?.includes(addr))
        ) || []
    , [transactions, myAddresses])

    useEffect( ()=> {
        const urlRecipient = searchParams.get('recipient')
        if (urlRecipient) setSelectedRecipient(urlRecipient)
    }, [searchParams])

    const encryptMessageOffline = async (messageText, recipientAddress) => {
        console.log('🔐 Starting offline message encryption...')
        
        try {
            const familyId = recipientAddress.split('-').slice(0, -1).join('-')
            
            const publicKeys = disasterStorage.getPublicKeys()
            let publicKeyString = publicKeys[familyId]?.publicKey
            
            if (!publicKeyString) {
                console.log('🌐 Fetching public key from server...')
                const keyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/wallet/${familyId}/public-key`)
                const keyData = await keyResponse.json()
                publicKeyString = keyData.public_key
                
                if (publicKeyString) {
                    disasterStorage.savePublicKey(familyId, publicKeyString)
                } else {
                    throw new Error('No public key found for recipient')
                }
            }
            
            const publicKey = await openpgp.readKey({ armoredKey: publicKeyString })
            const message = await openpgp.createMessage({ text: messageText })
            const encryptedMessage = await openpgp.encrypt({
                message: message,
                encryptionKeys: publicKey,
                format: 'armored'
            })
            
            console.log('✅ Message encrypted successfully!')
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
            const encryptedMessage = await encryptMessageOffline(messageText, selectedRecipient)
            
            // Create transaction
            const transaction = {
                timestamp_created: Date.now() / 1000,
                station_address: myAddresses[0],
                message_data: encryptedMessage,
                related_addresses: [selectedRecipient],
                type_field: 'message',
                priority_level: 5
            }

            try { // to send message
                await api.addTransaction(transaction)
                console.log('📡 Message sent online immediately')
                alert('Message sent!')
            } 
            catch (error) {
                if (error.isNetworkError) {
                    // QUEUE FOR OFFLINE TRANSMISSION
                    console.log('📱 No connection - queueing message for later transmission')
                    disasterStorage.queueMessage(transaction)
                    alert('📱 No internet - message queued for transmission when connected')
                }
                else {
                    // Handle application errors differently
                    console.error('Application error:', error.message)
                    setError(error.message || 'Failed to send message')
                }
            }
            
            setMessageText('')
            setSelectedRecipient('')
            setError('')

        } catch (err) {
            setError(err.message || 'Failed to send message')
        } finally {
            setSending(false)
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
                            
                            {/* Custom Contact Picker instead of dropdown */}
                            <div className="contact-picker">
                                {selectedRecipient ? (
                                    <div className="selected-contact" onClick={() => setSelectedRecipient('')}>
                                        <ContactName 
                                            address={selectedRecipient} 
                                            isUnlocked={!!privateKey}
                                        />
                                        <span className="remove-contact">✕</span>
                                    </div>
                                ) : (
                                    <button 
                                        type="button"
                                        className="btn-contact-picker"
                                        onClick={() => setShowContactPicker(!showContactPicker)}
                                    >
                                        Select recipient...
                                    </button>
                                )}
                                
                                {showContactPicker && (<>
                                    <input 
                                        type="text"
                                        value={selectedRecipient}
                                        onChange={(e) => setSelectedRecipient(e.target.value)}
                                        className="form-input"
                                        placeholder="Enter wallet address"
                                        disabled={sending}
                                    />
                                    <p className="input-hint">
                                        Paste any wallet address (e.g. familyId-memberId)
                                    </p>
                                    <div className="contact-list-dropdown">
                                        {walletData?.members?.map(member => (
                                            <div 
                                                key={member.address}
                                                className="contact-option"
                                                onClick={() => {
                                                    setSelectedRecipient(member.address)
                                                    setShowContactPicker(false)
                                                }}
                                            >
                                                <ContactName 
                                                    address={member.address} 
                                                    isUnlocked={!!privateKey}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </>)}

                            </div>
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
                                    <MessageDisplay message={tx.message_data} privateKey={privateKey} />
                                </div>
                            ))
                    )}
                </div>
            </div>
        </div>
    )
}
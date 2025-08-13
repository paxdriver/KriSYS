'use client'
// components/WalletDashboard/MessagingPage.js
import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '../../services/api'
import { disasterStorage } from '@/services/localStorage'
import ContactName from './ContactName'
import { KeyManager } from '@/services/keyManager'
import TransactionItem from './TransactionItem'

export default function MessagingPage({ walletData, transactions, privateKey }) {
    const [selectedRecipient, setSelectedRecipient] = useState('')
    const [messageText, setMessageText] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState('')
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

    const sendMessage = async (e) => {
        e.preventDefault()
        if (!selectedRecipient || !messageText.trim()) return

        setSending(true)
        setError('')

        try {
            // Extract family ID from recipient address
            let familyId = selectedRecipient.includes('-') 
                ? selectedRecipient.split('-').slice(0, -1).join('-')
                : selectedRecipient

            // Use KeyManager for encryption
            const encryptedMessage = await KeyManager.encryptMessage(messageText, familyId)
            
            // Create transaction
            const transaction = {
                timestamp_created: Date.now() / 1000,
                station_address: myAddresses[0],
                message_data: encryptedMessage,
                related_addresses: [selectedRecipient],
                type_field: 'message',
                priority_level: 5
            }

            // Send or queue
            try {
                await api.addTransaction(transaction)
                console.log('📡 Message sent online immediately')
                alert('Message sent!')
            } catch (error) {
                if (error.isNetworkError) {
                    console.log('📱 No connection - queueing message for later transmission')
                    disasterStorage.queueMessage(transaction)
                    alert('📱 No internet - message queued for transmission when connected')
                } else {
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
                            
                            {/* Manual Address Input - Always visible */}
                            <div className="manual-address-input">
                                <input 
                                    type="text"
                                    value={selectedRecipient}
                                    onChange={(e) => setSelectedRecipient(e.target.value)}
                                    className="form-input"
                                    placeholder="Paste wallet address (e.g. familyId-memberId)"
                                    disabled={sending}
                                />
                                <p className="input-hint">
                                    💡 Enter any wallet address manually, or select from your family members below
                                </p>
                            </div>

                            {/* Family Members Quick Select */}
                            <div className="family-members-picker">
                                <label className="sub-label">Or select from your family:</label>
                                <div className="member-buttons">
                                    {walletData?.members?.map(member => (
                                        <button 
                                            key={member.address}
                                            type="button"
                                            className={`member-btn ${selectedRecipient === member.address ? 'selected' : ''}`}
                                            onClick={() => setSelectedRecipient(member.address)}
                                            disabled={sending}
                                        >
                                            <ContactName 
                                                address={member.address} 
                                                isUnlocked={!!privateKey}
                                            />
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Selected Contact Display */}
                            {selectedRecipient && (
                                <div className="selected-contact-display">
                                    <span className="selected-label">Sending to: </span>
                                    <ContactName 
                                        address={selectedRecipient} 
                                        isUnlocked={!!privateKey}
                                    />
                                    <button 
                                        type="button"
                                        className="clear-recipient"
                                        onClick={() => setSelectedRecipient('')}
                                        title="Clear recipient"
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
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
                                <TransactionItem
                                    key={tx.transaction_id}
                                    transaction={tx}
                                    privateKey={privateKey}
                                    familyId={walletData.family_id}
                                />
                            ))
                    )}
                </div>
            </div>
        </div>
    )
}
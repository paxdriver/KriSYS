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
    const [senderAddress, setSenderAddress] = useState('')
    const [selectedRecipients, setSelectedRecipients] = useState([])
    const [manualRecipientInput, setManualRecipientInput] = useState('')
    const [messageText, setMessageText] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState('')
    const searchParams = useSearchParams()

    const myAddresses = useMemo(
        () => walletData?.members?.map((m) => m.address) || [],
        [walletData?.members]
    )

    // Initialise senderAddress to first member when wallet data is available
    useEffect(() => {
        if (!senderAddress && myAddresses.length > 0) {
            setSenderAddress(myAddresses[0])
        }
    }, [myAddresses, senderAddress])

    // Canonical, on-chain messages involving this wallet (sent or received)
    const myMessages = useMemo(() => {
        if (!transactions || !transactions.length) return []

        return transactions.filter((tx) => {
            if (tx.type_field !== 'message') return false

            const fromMe =
                tx.station_address &&
                myAddresses.includes(tx.station_address)
            const toMe =
                Array.isArray(tx.related_addresses) &&
                tx.related_addresses.some((addr) =>
                    myAddresses.includes(addr)
                )

            return fromMe || toMe
        })
    }, [transactions, myAddresses])

    // Locally queued (unconfirmed) messages that involve this wallet
    const queuedMyMessages = useMemo(() => {
        const queue = disasterStorage.getMessageQueue()
        if (!queue || queue.length === 0) return []

        return queue.filter((msg) => {
            if (msg.type_field !== 'message') return false

            // Only show still-pending items
            const _status = msg.status || 'pending'     // robustness check, not strictly necessary
            if (_status !== 'pending' && _status !== 'sent') return false

            // Skip anything already known as confirmed
            if (disasterStorage.isMessageConfirmed(msg.relay_hash)) {
                return false
            }

            const fromMe =
                msg.station_address &&
                myAddresses.includes(msg.station_address)
            const toMe =
                Array.isArray(msg.related_addresses) &&
                msg.related_addresses.some((addr) =>
                    myAddresses.includes(addr)
                )

            return fromMe || toMe
        })
    }, [myAddresses])

    // Merge canonical and queued into a single list for display
    const allMessages = useMemo(() => {
        // Canonical on-chain messages
        const canonical = (myMessages || []).map((tx) => ({
            ...tx,
            _isConfirmed: true,
            _sortTimestamp: tx.timestamp_posted || tx.timestamp_created,
        }))

        // Relay hashes that already have canonical confirmations
        const confirmedRelayHashes = new Set(
            canonical
                .map((tx) => tx.relay_hash)
                .filter((rh) => typeof rh === 'string' && rh.length > 0)
        )

        // Locally queued messages (unconfirmed)
        const queued = queuedMyMessages
            .filter(
                (msg) =>
                    !msg.relay_hash ||
                    !confirmedRelayHashes.has(msg.relay_hash)
            )
            .map((msg) => {
                const sortTs =
                    msg.timestamp_posted ||
                    msg.queuedAt ||
                    msg.timestamp_created

                return {
                    transaction_id:
                        msg.transaction_id ||
                        msg.relay_hash ||
                        `queued-${sortTs}`,
                    timestamp_created: msg.timestamp_created,
                    timestamp_posted: sortTs,
                    station_address: msg.station_address,
                    message_data: msg.message_data,
                    related_addresses: msg.related_addresses,
                    type_field: msg.type_field,
                    priority_level: msg.priority_level,
                    relay_hash: msg.relay_hash,
                    _isConfirmed: false,
                    _isQueuedLocal: true,
                    _sortTimestamp: sortTs,
                }
            })

        return [...canonical, ...queued].sort(
            (a, b) => b._sortTimestamp - a._sortTimestamp
        )
    }, [myMessages, queuedMyMessages])

    // Pre-select recipient from URL (e.g. from Contacts page)
    useEffect(() => {
        const urlRecipient = searchParams.get('recipient')
        if (urlRecipient) {
            setSelectedRecipients((prev) =>
                prev.includes(urlRecipient)
                    ? prev
                    : [...prev, urlRecipient]
            )
        }
    }, [searchParams])

    // Toggle a member as recipient
    const toggleRecipient = (address) => {
        setSelectedRecipients((prev) =>
            prev.includes(address)
                ? prev.filter((a) => a !== address)
                : [...prev, address]
        )
    }

    // Add manual recipient from input
    const handleAddManualRecipient = () => {
        const value = manualRecipientInput.trim()
        if (!value) return

        setSelectedRecipients((prev) =>
            prev.includes(value) ? prev : [...prev, value]
        )
        setManualRecipientInput('')
    }

    // Utility: derive familyId from an address
    const getFamilyIdFromAddress = (address) => {
        return address.includes('-')
            ? address.split('-').slice(0, -1).join('-')
            : address
    }

    const sendMessage = async (e) => {
        e.preventDefault()
        if (selectedRecipients.length === 0 || !messageText.trim()) return

        setSending(true)
        setError('')

        try {
            // Determine which address we're sending from
            const fromAddress =
                senderAddress || (myAddresses.length > 0
                    ? myAddresses[0]
                    : null)

            if (!fromAddress) {
                setError('No sender address available in this wallet')
                setSending(false)
                return
            }

            // Group recipients by familyId so each family gets one tx
            const groups = {}
            for (const addr of selectedRecipients) {
                const fid = getFamilyIdFromAddress(addr)
                if (!groups[fid]) groups[fid] = []
                groups[fid].push(addr)
            }

            let totalGroups = 0
            let queuedCount = 0

            for (const [familyId, addrs] of Object.entries(groups)) {
                totalGroups++

                try {
                    // Encrypt once per recipient family
                    const encryptedMessage =
                        await KeyManager.encryptMessage(
                            messageText,
                            familyId,               // recipient's family
                            walletData.family_id, // sender's family, so sent messages can be read too
                        )

                    // Stable per-message ID for offline relay
                    const relayHash =
                        (typeof window !== 'undefined' &&
                            window.crypto &&
                            window.crypto.randomUUID &&
                            window.crypto.randomUUID()) ||
                        `${Date.now()}_${Math.random()
                            .toString(36)
                            .slice(2)}`

                    const transaction = {
                        timestamp_created: Date.now() / 1000,
                        station_address: fromAddress,
                        message_data: encryptedMessage,
                        related_addresses: addrs, // all recipients in this family
                        type_field: 'message',
                        priority_level: 5,
                        relay_hash: relayHash,
                        origin_device: disasterStorage.getDeviceId(),
                    }

                    try {
                        await api.addTransaction(transaction)
                        console.log(
                            '📡 Message sent online for family group',
                            familyId
                        )
                    } catch (error) {
                        if (error.isNetworkError) {
                            console.log(
                                '📱 No connection - queueing message for family group',
                                familyId
                            )
                            disasterStorage.queueMessage(transaction)
                            queuedCount++
                        } else {
                            console.error(
                                'Application error while sending to family group',
                                familyId,
                                error
                            )
                            setError(
                                error.message ||
                                    'Failed to send message to one or more recipients'
                            )
                        }
                    }
                } catch (err) {
                    console.error(
                        'Encryption or send failed for family group',
                        familyId,
                        err
                    )
                    setError(
                        err.message ||
                            'Encryption failed for one or more recipient groups'
                    )
                }
            }

            if (queuedCount > 0) {
                alert(
                    `Messages queued for ${queuedCount} recipient group(s); they will be sent when online.`
                )
            } else {
                alert(
                    `Message sent to ${totalGroups} recipient group(s).`
                )
            }

            setMessageText('')
            setSelectedRecipients([])
            setManualRecipientInput('')
        } catch (err) {
            setError(err.message || 'Failed to send message')
        } finally {
            setSending(false)
        }
    }

    const hasRecipients = selectedRecipients.length > 0

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
                        {/* Sender selection */}
                        <div className="form-group">
                            <label>Send as:</label>
                            <div className="member-buttons">
                                {walletData?.members?.map((member) => (
                                    <button
                                        key={member.address}
                                        type="button"
                                        className={`member-btn ${
                                            senderAddress ===
                                            member.address
                                                ? 'selected'
                                                : ''
                                        }`}
                                        onClick={() =>
                                            setSenderAddress(
                                                member.address
                                            )
                                        }
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

                        <div className="form-group">
                            <label>Send to:</label>

                            {/* Manual Address Input */}
                            <div className="manual-address-input">
                                <input
                                    type="text"
                                    value={manualRecipientInput}
                                    onChange={(e) =>
                                        setManualRecipientInput(
                                            e.target.value
                                        )
                                    }
                                    className="form-input"
                                    placeholder="Paste wallet address (e.g. familyId-memberId)"
                                    disabled={sending}
                                />
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={handleAddManualRecipient}
                                    disabled={
                                        sending ||
                                        !manualRecipientInput.trim()
                                    }
                                >
                                    Add recipient
                                </button>
                                <p className="input-hint">
                                    💡 Enter any wallet address manually, or
                                    select from your family members below.
                                </p>
                            </div>

                            {/* Family Members Quick Select */}
                            <div className="family-members-picker">
                                <label className="sub-label">
                                    Or select from your family:
                                </label>
                                <div className="member-buttons">
                                    {walletData?.members?.map((member) => (
                                        <button
                                            key={member.address}
                                            type="button"
                                            className={`member-btn ${
                                                selectedRecipients.includes(
                                                    member.address
                                                )
                                                    ? 'selected'
                                                    : ''
                                            }`}
                                            onClick={() =>
                                                toggleRecipient(
                                                    member.address
                                                )
                                            }
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

                            {/* Selected Contacts Display */}
                            {hasRecipients && (
                                <div className="selected-contact-display">
                                    <span className="selected-label">
                                        Sending to:{' '}
                                    </span>
                                    <span className="selected-list">
                                        {selectedRecipients.map(
                                            (addr) => (
                                                <span
                                                    key={addr}
                                                    className="selected-chip"
                                                >
                                                    <ContactName
                                                        address={addr}
                                                        isUnlocked={
                                                            !!privateKey
                                                        }
                                                    />
                                                    <button
                                                        type="button"
                                                        className="clear-recipient"
                                                        onClick={() =>
                                                            toggleRecipient(
                                                                addr
                                                            )
                                                        }
                                                        title="Remove recipient"
                                                    >
                                                        ✕
                                                    </button>
                                                </span>
                                            )
                                        )}
                                    </span>
                                </div>
                            )}
                        </div>

                        <div className="form-group">
                            <label>Message:</label>
                            <textarea
                                value={messageText}
                                onChange={(e) =>
                                    setMessageText(e.target.value)
                                }
                                className="form-input"
                                rows="4"
                                placeholder="Type your message..."
                                disabled={sending}
                            />
                        </div>

                        <button
                            type="submit"
                            className="btn"
                            disabled={
                                sending ||
                                !hasRecipients ||
                                !messageText.trim()
                            }
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
                    <h3 className="card-title">
                        My Messages ({allMessages.length})
                    </h3>
                </div>
                <div className="card-body">
                    {allMessages.length === 0 ? (
                        <p>No messages yet</p>
                    ) : (
                        allMessages.map((tx) => (
                            <TransactionItem
                                key={tx.transaction_id}
                                transaction={tx}
                                privateKey={privateKey}
                                familyId={walletData.family_id}
                                isConfirmed={tx._isConfirmed}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
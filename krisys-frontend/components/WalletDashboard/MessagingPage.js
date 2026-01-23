'use client'
// components/WalletDashboard/MessagingPage.js
import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '../../services/api'
import { disasterStorage } from '@/services/localStorage'
import ContactName from './ContactName'
import { KeyManager } from '@/services/keyManager'
import TransactionItem from './TransactionItem'
import QRScanner from '../Scanner/QRScanner'
import { parsePublicKeyShareCode } from '@/services/walletPublicKeyShare'

async function sha256HexUtf8(text) {
	const enc = new TextEncoder()
	const bytes = enc.encode(text)
	const subtle = globalThis.crypto?.subtle
	if (!subtle) return null
	const digest = await subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

export default function MessagingPage({ walletData, transactions, privateKey }) {
	const [senderAddress, setSenderAddress] = useState('')
	const [selectedRecipients, setSelectedRecipients] = useState([])
	const [manualRecipientInput, setManualRecipientInput] = useState('')
	const [messageText, setMessageText] = useState('')
	const [sending, setSending] = useState(false)
	const [error, setError] = useState('')
	const searchParams = useSearchParams()

	// Local state bumpers for re-rendering when storage changes
	const [queueVersion, setQueueVersion] = useState(1)
	const [keyCacheVersion, setKeyCacheVersion] = useState(0)

	// Public key import UI state
	const [pubKeyInput, setPubKeyInput] = useState('')
	const [pubKeyImportError, setPubKeyImportError] = useState('')
	const [scannerOpen, setScannerOpen] = useState(false)

	useEffect(() => {
        // Triggers re-renders on storage state changes, nothing more
		const onLocalDataChanged = () => setQueueVersion( v => v + 1)

		window.addEventListener('krisys:queue_updated', onLocalDataChanged)
		window.addEventListener('krisys:confirmed_updated', onLocalDataChanged)

		return () => {
			window.removeEventListener('krisys:queue_updated', onLocalDataChanged)
			window.removeEventListener('krisys:confirmed_updated', onLocalDataChanged)
		}
	}, [])

	const myAddresses = useMemo(
		() => walletData?.members?.map((m) => m.address) || [],
		[walletData?.members]
	)

	useEffect(() => {
		if (!senderAddress && myAddresses.length > 0) {
			setSenderAddress(myAddresses[0])
		}
	}, [myAddresses, senderAddress])

	// Utility: derive familyId from an address
	const getFamilyIdFromAddress = (address) => {
		return address.includes('-')
			? address.split('-').slice(0, -1).join('-')
			: address
	}

	const walletId = walletData?.family_id || null

	// Canonical, on-chain messages involving this wallet (sent or received)
	const myMessages = useMemo(() => {
		if (!transactions || !transactions.length) return []

		return transactions.filter((tx) => {
			if (tx.type_field !== 'message') return false

			const fromMe = tx.station_address && myAddresses.includes(tx.station_address)
			const toMember =
				Array.isArray(tx.related_addresses) &&
				tx.related_addresses.some((addr) => myAddresses.includes(addr))
			const toFamily =
				walletId &&
				Array.isArray(tx.related_addresses) &&
				tx.related_addresses.includes(walletId)

			return fromMe || toMember || toFamily
		})
	}, [transactions, myAddresses, walletId])

	// Locally queued (unconfirmed) messages that involve this wallet
	const queuedMyMessages = useMemo(() => {
		const queue = disasterStorage.getMessageQueue()
		if (!queue || queue.length === 0) return []

		return queue.filter((msg) => {
			if (msg.type_field !== 'message') return false

			const _status = msg.status || 'pending'
			if (_status !== 'pending' && _status !== 'sent') return false

			if (disasterStorage.isMessageConfirmed(msg.relay_hash)) {
				return false
			}

			const fromMe = msg.station_address && myAddresses.includes(msg.station_address)
			const toMe =
				Array.isArray(msg.related_addresses) &&
				msg.related_addresses.some((addr) => myAddresses.includes(addr))
			const toFamily =
				walletId &&
				Array.isArray(msg.related_addresses) &&
				msg.related_addresses.includes(walletId)

			return fromMe || toMe || toFamily
		})
	}, [myAddresses, queueVersion, walletId])

	// Merge canonical and queued into a single list for display
	const allMessages = useMemo(() => {
		const canonical = (myMessages || []).map((tx) => ({
			...tx,
			_isConfirmed: true,
			_sortTimestamp: tx.timestamp_posted || tx.timestamp_created,
		}))

		const confirmedRelayHashes = new Set(
			canonical
				.map((tx) => tx.relay_hash)
				.filter((rh) => typeof rh === 'string' && rh.length > 0)
		)

		const queued = queuedMyMessages
			.filter((msg) => !msg.relay_hash || !confirmedRelayHashes.has(msg.relay_hash))
			.map((msg) => {
				const sortTsSeconds =
					typeof msg.timestamp_posted === 'number'
						? msg.timestamp_posted
						: typeof msg.queuedAt === 'number'
							? Math.floor(msg.queuedAt / 1000)
							: msg.timestamp_created

				return {
					transaction_id:
						msg.transaction_id || msg.relay_hash || `queued-${sortTsSeconds}`,
					timestamp_created: msg.timestamp_created,
					timestamp_posted: sortTsSeconds,
					station_address: msg.station_address,
					message_data: msg.message_data,
					related_addresses: msg.related_addresses,
					type_field: msg.type_field,
					priority_level: msg.priority_level,
					relay_hash: msg.relay_hash,
					_isConfirmed: false,
					_isQueuedLocal: true,
					_sortTimestamp: sortTsSeconds,
				}
			})

		return [...canonical, ...queued].sort((a, b) => b._sortTimestamp - a._sortTimestamp)
	}, [myMessages, queuedMyMessages])

	useEffect(() => {
		const urlRecipient = searchParams.get('recipient')
		if (urlRecipient) {
			setSelectedRecipients((prev) => {
				prev.includes(urlRecipient) ? prev : [...prev, urlRecipient]
            })
		}
	}, [searchParams])

	const toggleRecipient = (address) => {
		setSelectedRecipients((prev) => {
            prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address]
        })
	}

	const handleAddManualRecipient = () => {
		const value = manualRecipientInput.trim()
		if (!value) return

		setSelectedRecipients((prev) => (prev.includes(value) ? prev : [...prev, value]))
		setManualRecipientInput('')
	}

	const selectedFamilyIds = useMemo(() => {
		const set = new Set()
		for (const addr of selectedRecipients) {
			if (typeof addr !== 'string' || !addr.trim()) continue
			set.add(getFamilyIdFromAddress(addr.trim()))
		}
		return Array.from(set)
	}, [selectedRecipients])

	const recipientKeyStatus = useMemo(() => {
		const publicKeys = disasterStorage.getPublicKeys() || {}
		return selectedFamilyIds.map((fid) => {
			const k = publicKeys[fid]?.publicKey
			return {
				familyId: fid,
				hasKey: typeof k === 'string' && k.length > 0,
			}
		})
		// keyCacheVersion forces refresh after import
	}, [selectedFamilyIds, keyCacheVersion])

	const handleImportPublicKey = async () => {
		setPubKeyImportError('')

		try {
			const parsed = parsePublicKeyShareCode(pubKeyInput)

			const existing = disasterStorage.getPublicKeys()?.[parsed.familyId]?.publicKey
			if (existing && existing !== parsed.publicKeyArmored) {
				const oldFp = await sha256HexUtf8(existing)
				const newFp = await sha256HexUtf8(parsed.publicKeyArmored)

				const ok = confirm(
					`A public key for ${parsed.familyId} already exists on this device.\n\n` +
						`Old: ${oldFp || 'unknown'}\n` +
						`New: ${newFp || 'unknown'}\n\n` +
						`Overwrite it?`
				)
				if (!ok) return
			}

			disasterStorage.savePublicKey(parsed.familyId, parsed.publicKeyArmored)
			setKeyCacheVersion((v) => v + 1)

			alert(`Saved public key for family: ${parsed.familyId}`)
		} 
        catch (e) {
			setPubKeyImportError(e?.message || String(e))
		}
	}

	const handleScanPublicKey = () => {
		setPubKeyImportError('')
		setScannerOpen(true)
	}

	const handleScanned = (text) => {
		setScannerOpen(false)
		setPubKeyInput(text)
		alert('Scanned public key code. Click "Import Public Key" to save it.')
	}

	const sendMessage = async (e) => {
		e.preventDefault()
		if (selectedRecipients.length === 0 || !messageText.trim()) return

		setSending(true)
		setError('')

		try {
			const fromAddress = senderAddress || (myAddresses.length > 0 ? myAddresses[0] : null)

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
					const encryptedMessage = await KeyManager.encryptMessage(messageText, familyId, walletData.family_id)

					const relayHash =
						(typeof window !== 'undefined' &&
							window.crypto &&
							window.crypto.randomUUID &&
							window.crypto.randomUUID()) ||
						`${Date.now()}_${Math.random().toString(36).slice(2)}`

					const transaction = {
						timestamp_created: Math.floor(Date.now() / 1000),
						station_address: fromAddress,
						message_data: encryptedMessage,
						related_addresses: addrs,
						type_field: 'message',
						priority_level: 5,
						relay_hash: relayHash,
						origin_device: disasterStorage.getDeviceId(),
					}

					try {
						await api.addTransaction(transaction)
					} 
                    catch (error) {
						if (error.isNetworkError) {
							disasterStorage.queueMessage(transaction)
							queuedCount++
						} 
                        else setError(error.message || 'Failed to send message to one or more recipients')
					}
				}
                catch (err) {
					// Most common offline failure here is: no public key cached for recipient.
					setError((err?.message || 'Encryption failed') + 
                    '\n\nIf you are offline, you may need to import the recipient public key.')
				}
			}

            // DEV
			if (queuedCount > 0) alert(`Messages queued for ${queuedCount} recipient group(s); they will be sent when online.`)
            else alert(`Message sent to ${totalGroups} recipient group(s).`)

			setMessageText('')
			setSelectedRecipients([])
			setManualRecipientInput('')
		} 
        catch (err) {
			setError(err.message || 'Failed to send message')
		} 
        finally {
			setSending(false)
		}
	}

	const hasRecipients = selectedRecipients.length > 0

	return (
		<div id="messaging-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Direct Messages</h1>
			</div>

			{scannerOpen && (
				<QRScanner
					title="Scan Public Key Code"
					onScan={handleScanned}
					onClose={() => setScannerOpen(false)}
				/>
			)}

			{/* Send Message Form */}
			<div className="card">
				<div className="card-header">
					<h3 className="card-title">Send Message</h3>
				</div>
				<div className="card-body">
					<form onSubmit={sendMessage}>
						<div className="form-group">
							<label>Send as:</label>
							<div className="member-buttons">
								{walletData?.members?.map((member) => (
									<button
										key={member.address}
										type="button"
										className={`member-btn ${
											senderAddress === member.address ? 'selected' : ''
										}`}
										onClick={() => setSenderAddress(member.address)}
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

							<div className="manual-address-input">
								<input
									type="text"
									value={manualRecipientInput}
									onChange={(e) => setManualRecipientInput(e.target.value)}
									className="form-input"
									placeholder="Paste wallet address (e.g. familyId-memberId)"
									disabled={sending}
								/>
								<button
									type="button"
									className="btn"
									onClick={handleAddManualRecipient}
									disabled={sending || !manualRecipientInput.trim()}
								>
									Add recipient
								</button>
							</div>

							<div className="family-members-picker">
								<label className="sub-label">Or select from your family:</label>
								<div className="member-buttons">
									{walletData?.members?.map((member) => (
										<button
											key={member.address}
											type="button"
											className={`member-btn ${
												selectedRecipients.includes(member.address)
													? 'selected'
													: ''
											}`}
											onClick={() => toggleRecipient(member.address)}
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

							{hasRecipients && (
								<div className="selected-contact-display">
									<span className="selected-label">Sending to:</span>
									<span className="selected-list">
										{selectedRecipients.map((addr) => (
											<span key={addr} className="selected-chip">
												<ContactName address={addr} isUnlocked={!!privateKey} />
												<button
													type="button"
													className="clear-recipient"
													onClick={() => toggleRecipient(addr)}
													title="Remove recipient"
												>
													✕
												</button>
											</span>
										))}
									</span>
								</div>
							)}
						</div>

						{/* Offline public key import */}
						<div className="form-group">
							<label>Recipient public key (offline import)</label>

							<div className="privacy-notice" style={{ marginBottom: '8px' }}>
								If you are offline and encryption fails, import the recipient’s
								public key share code here (paste or scan).
							</div>

							{recipientKeyStatus.length > 0 && (
								<div className="privacy-notice" style={{ marginBottom: '8px' }}>
									Recipient key status:{' '}
									{recipientKeyStatus
										.map((s) => `${s.familyId}: ${s.hasKey ? 'yes' : 'no'}`)
										.join(' | ')}
								</div>
							)}

							<textarea
								value={pubKeyInput}
								onChange={(e) => setPubKeyInput(e.target.value)}
								className="form-input"
								rows="4"
								placeholder="Paste krisys:key:v1... (or scan)"
								disabled={sending}
							/>

							<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
								<button
									type="button"
									className="btn"
									onClick={handleImportPublicKey}
									disabled={sending || !pubKeyInput.trim()}
								>
									Import Public Key
								</button>

								<button
									type="button"
									className="btn"
									onClick={handleScanPublicKey}
									disabled={sending}
								>
									Scan Public Key
								</button>
							</div>

							{pubKeyImportError && <p className="error">{pubKeyImportError}</p>}
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
							disabled={sending || !hasRecipients || !messageText.trim()}
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
					<h3 className="card-title">My Messages ({allMessages.length})</h3>
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
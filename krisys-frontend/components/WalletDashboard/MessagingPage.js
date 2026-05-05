// components/WalletDashboard/MessagingPage.js
'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { api } from '@/services/api'
import { disasterStorage } from '@/services/localStorage'
import ContactName from './ContactName'
import { KeyManager } from '@/services/keyManager'
import TransactionItem from './TransactionItem'
import QRScanner from '../Scanner/QRScanner'
import { parsePublicKeyShareCode } from '@/services/walletPublicKeyShare'
import { contactStorage } from '@/services/contactStorage'	// resolve typed contact addresses by name

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

	// Controls whether the recipient suggestions are visible, and detect click out of bounds of input and dropdown area
	const [showRecipientSuggestions, setShowRecipientSuggestions] = useState(false)
	const recipientInputRef = useRef(null)

	const crisisId = useMemo(() => {
		try {
			return disasterStorage.getCrisisMetadata()?.id || null
		} catch {
			return null
		}
	}, [])

    // Helper function to normalize recipients always to an array
    const recipientsList = Array.isArray(selectedRecipients) ? selectedRecipients : []

	useEffect(() => {
        // Triggers re-renders on storage state changes, nothing more
		const onLocalDataChanged = () => setQueueVersion(v => v + 1)

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
		return address.includes('-') ? 
			address.split('-').slice(0, -1).join('-') : address
	}

	const walletId = walletData?.family_id || null
	const familyId = walletId


	// Load saved contacts for this wallet context : shape is { [address]: displayName }.
	const savedContacts = useMemo(() => {
		if (!crisisId || !familyId) {
			return {}
		}
		return contactStorage.getContacts({ crisisId, familyId })
	}, [crisisId, familyId])

	// Convert the saved contacts object into an array that is easier to filter and render.
	const contactOptions = useMemo(() => {
		return Object.entries(savedContacts).map(([address, name]) => ({ address, name }))
	}, [savedContacts])

	// Filter contacts based on what the user typed.
	// We match: [contact display name] TO [raw address] (but exclude any address that is already selected)
	const recipientSuggestions = useMemo(() => {
		const query = manualRecipientInput.trim().toLowerCase()

		// No typed input means no suggestions.
		if (!query) {
			return []
		}

		return contactOptions
			.filter((contact) => {
				// Skip malformed contacts.
				if (!contact?.address) {
					return false
				}

				// Skip contacts already selected as recipients.
				if (recipientsList.includes(contact.address)) {
					return false
				}

				const nameText =
					typeof contact.name === 'string' ? contact.name.toLowerCase() : ''
				const addressText = contact.address.toLowerCase()

				// Match either the saved name or the underlying address.
				return nameText.includes(query) || addressText.includes(query)
			})
			// Keep the suggestion list small and readable.
			.slice(0, 8)
	}, [contactOptions, manualRecipientInput, recipientsList])

	// Close the suggestions dropdown when the user clicks outside it.
	useEffect(() => {
		const handleDocumentClick = (event) => {
			// If the click happened inside the recipient input area, keep the dropdown open.
			if (recipientInputRef.current?.contains(event.target)) {
				return
			}

			// Otherwise hide suggestions.
			setShowRecipientSuggestions(false)
		}

		document.addEventListener('mousedown', handleDocumentClick)

		return () => {
			document.removeEventListener('mousedown', handleDocumentClick)
		}
	}, [])


	// Canonical, on-chain messages involving this wallet (sent or received)
	const myMessages = useMemo(() => {
		if (!Array.isArray(transactions) || transactions.length === 0) return []

		return transactions.filter((tx) => {
			if (tx.type_field !== 'message') return false
			const senderAddress = tx.sender_address || tx.station_address	// legibility only: prior variable name "station_addres" was being overloaded
			const fromMe = senderAddress && myAddresses.includes(senderAddress)
			const toMember = Array.isArray(tx.related_addresses) &&
				tx.related_addresses.some( (addr) => myAddresses.includes(addr))
			const toFamily = walletId && Array.isArray(tx.related_addresses) &&
				tx.related_addresses.includes(walletId)

			return fromMe || toMember || toFamily
		})
	}, [transactions, myAddresses, walletId])

	// Locally queued (unconfirmed) messages that involve this wallet
	const queuedMyMessages = useMemo(() => {
		const queue = (crisisId && familyId) ? disasterStorage.getMessageQueue({crisisId, familyId}) : []
		if (!queue || queue.length === 0) return []

		return queue.filter((msg) => {
			if (msg.type_field !== 'message') return false

			const _status = msg.status || 'pending'
			if (_status !== 'pending' && _status !== 'sent') return false

			if (disasterStorage.isMessageConfirmed({ crisisId, relayHash: msg.relay_hash })) {
				return false
			}

			const senderAddress = msg.sender_address || msg.station_address	// legibility only: prior variable name "station_addres" was being overloaded
			const fromMe = senderAddress && myAddresses.includes(senderAddress)
			
			const toMe = Array.isArray(msg.related_addresses) &&
				msg.related_addresses.some((addr) => myAddresses.includes(addr))
			const toFamily = walletId && Array.isArray(msg.related_addresses) &&
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
				const sortTsSeconds = typeof msg.timestamp_posted === 'number' ? 
					msg.timestamp_posted : typeof msg.queuedAt === 'number' ? 
						Math.floor(msg.queuedAt / 1000) : msg.timestamp_created

				return {
					transaction_id: msg.transaction_id || msg.relay_hash || `queued-${sortTsSeconds}`,
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
		if (!urlRecipient) return

		setSelectedRecipients( prev => {
			// If the recipient is already selected, keep the existing array unchanged
			if (prev.includes(urlRecipient)) return prev

			// ... otherwise append the recipient from the url query string
			else return [...prev, urlRecipient]
		})
	
	}, [searchParams])

	const toggleRecipient = (address) => {
		setSelectedRecipients((prev) => {
			const arr = Array.isArray(prev) ? prev : []
			return arr.includes(address) ? 
				arr.filter((a) => a !== address) : [...arr, address]
		})
	}


	// Add a recipient chosen from the suggestions dropdown.
	const handleSelectSuggestedRecipient = (address) => {
		if (!address) return 	// Ignore empty addresses

		// Add the selected address once only.
		setSelectedRecipients((prev) => {
			if (prev.includes(address)) return prev
			return [...prev, address]
		})

		setManualRecipientInput('') 	// Clear the input after selection so the user can add another person.
		setShowRecipientSuggestions(false)	// Hide the dropdown after a choice is made.
	}

	const handleAddManualRecipient = () => {
		const value = manualRecipientInput.trim()
		if (!value) return

		// First try exact name match against saved contacts
		const exactNameMatch = contactOptions.find((contact) => {
			if (typeof contact.name !== 'string') return false
			
			// This lets a user type a full saved contact name and add it directly
			return contact.name.trim().toLowerCase() === value.toLowerCase()
		})

		// If there is an exact name match, use that contact's real address
		if (exactNameMatch?.address) {
			setSelectedRecipients((prev) => {
				if (prev.includes(exactNameMatch.address)) return prev
				return [...prev, exactNameMatch.address]
			})

			setManualRecipientInput('')
			setShowRecipientSuggestions(false)
			return
		}

		setSelectedRecipients( prev => (prev.includes(value) ? prev : [...prev, value]) )
		setManualRecipientInput('')
	}

	const selectedFamilyIds = useMemo(() => {
		const set = new Set()

		for (const addr of recipientsList) {
			if (typeof addr !== 'string' || !addr.trim()) continue
			set.add(getFamilyIdFromAddress(addr.trim()))
		}

		return Array.from(set)
	}, [recipientsList])

	const recipientKeyStatus = useMemo(() => {
		const publicKeys = crisisId ? disasterStorage.getCachedPublicKeys({crisisId}) : {}
		return selectedFamilyIds.map((fid) => {
			const k = publicKeys[fid]?.publicKey
			return {
				familyId: fid,
				hasKey: typeof k === 'string' && k.length > 0,
			}
		})
		// keyCacheVersion forces refresh after import
	}, [selectedFamilyIds, keyCacheVersion, crisisId])

const handleImportPublicKey = async () => {
	setPubKeyImportError('')

	try {
		const parsed = parsePublicKeyShareCode(pubKeyInput)	// parsed from qr code
		const targetFamilyId = parsed.familyId
		
		// pulled from local cache all public keys on devices (shared across crisis namespace aka the domain)
		const publicKeys = crisisId ? disasterStorage.getCachedPublicKeys({ crisisId }) : {}	
		const existing = publicKeys[parsed.familyId]?.publicKey

		if (existing && existing !== parsed.publicKeyArmored) {
			const oldFp = await sha256HexUtf8(existing)
			const newFp = await sha256HexUtf8(parsed.publicKeyArmored)

			const ok = confirm(
				`A public key for ${targetFamilyId} already exists on this device.\n\n` +
					`Old: ${oldFp || 'unknown'}\n` +
					`New: ${newFp || 'unknown'}\n\n` +
					`Overwrite it?`
			)
			if (!ok) return
		}

		disasterStorage.saveCachedPublicKey({
			crisisId,
			targetFamilyId,
			publicKey: parsed.publicKeyArmored,
		})

		setKeyCacheVersion((v) => v + 1)

		alert(`Saved public key for family: ${targetFamilyId}`)
	} catch (e) {
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
					const encryptedMessage = await KeyManager.encryptMessage(messageText, familyId, walletData.family_id, crisisId)

					const relayHash = (typeof window !== 'undefined' &&
						window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
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
							disasterStorage.queueMessage({ crisisId, familyId: familyId, message: transaction })
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
											crisisId={crisisId}
    										familyId={walletData.family_id}
										/>
									</button>
								))}
							</div>
						</div>

						<div className="form-group">
							<label>Send to:</label>

							<div 
								className="manual-address-input"
								ref={recipientInputRef}
								style={{ position: 'relative' }}
							>
								<input
									type="text"
									value={manualRecipientInput}
									onChange={(e) => {
										setManualRecipientInput(e.target.value) 	// Update the typed text
										setShowRecipientSuggestions(true)			// Open suggestions while there is input
									}}
									onFocus={() => {
										if (manualRecipientInput.trim()) {	// Re-open suggestions when the input regains focus
											setShowRecipientSuggestions(true)
										}
									}}
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
								{showRecipientSuggestions && recipientSuggestions.length > 0 && (
									<div
										style={{
											position: 'absolute',
											top: '100%',
											left: 0,
											right: 0,
											zIndex: 20,
											background: '#111',
											border: '1px solid #333',
											borderRadius: '6px',
											marginTop: '4px',
											padding: '4px 0',
										}}
									>
										{recipientSuggestions.map((contact) => (
											<button
												key={contact.address}
												type="button"
												onClick={() => handleSelectSuggestedRecipient(contact.address)}
												style={{
													display: 'block',
													width: '100%',
													textAlign: 'left',
													background: 'transparent',
													color: '#ddd',
													border: 'none',
													padding: '8px 12px',
													cursor: 'pointer',
												}}
											>
												<div>
													<strong>{contact.name || contact.address}</strong>
												</div>
												<div style={{ fontSize: '12px', opacity: 0.8 }}>
													{contact.address}
												</div>
											</button>
										))}
									</div>
								)}
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
												crisisId={crisisId}
    											familyId={walletData.family_id}
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
												<ContactName 
													address={addr} 
													isUnlocked={!!privateKey}
													crisisId={crisisId}
													familyId={walletData.family_id}
												/>
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
								crisisId={crisisId}
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
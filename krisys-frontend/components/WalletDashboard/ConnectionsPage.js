// krisys-frontend/components/WalletDashboard/ConnectionsPage.js
'use client'
import { useMemo, useEffect, useState } from 'react'
import { syncWithMeshHost } from '@/services/meshSync'
import { performStationHandshake } from '@/services/stationHandshake'
import { disasterStorage } from '@/services/localStorage'
import { createJoinCode, parseJoinCode } from '@/services/poolJoinCode'
import { createPublicKeyShareCode, parsePublicKeyShareCode } from '@/services/walletPublicKeyShare'
import { showTextQr } from '@/utils/qr'
import QRScanner from '../Scanner/QRScanner'
import { parseStationQr } from '@/services/stationQr'
import P2PRoom from './P2PRoom'
import { useP2P } from '@/contexts/P2PContext'

const DEFAULT_STATION_URL = process.env.NEXT_PUBLIC_STATION_URL || 'http://localhost:6001'
const DEFAULT_RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || 'http://localhost:6002'
const STORAGE_LAST_HOST_URL = 'krisys_mesh_last_host_url'
const STORAGE_LAST_HOST_LABEL = 'krisys_mesh_last_host_label'

function getLocalCounts({ crisisId, familyId }) {
	if (!crisisId) {
		return {
			blockCount: 0,
			queuedPendingCount: 0,
			confirmedCount: 0,
		}
	}

	const blocks = disasterStorage.getBlockchain({ crisisId }) || []
	const queue = crisisId && familyId ? disasterStorage.getMessageQueue({ crisisId, familyId }) : []
	const confirmed = disasterStorage.getConfirmedRelays({ crisisId }) || {}

	return {
		blockCount: Array.isArray(blocks) ? blocks.length : 0,
		queuedPendingCount: Array.isArray(queue) ?
			queue.filter((m) => (m?.status || 'pending') === 'pending').length : 0,
		confirmedCount: confirmed && typeof confirmed === 'object' ?
			Object.keys(confirmed).length : 0,
	}
}

// CONNECTIONSPAGE COMPONENT
export default function ConnectionsPage({ onRefresh, walletData }) {
	const [hostUrl, setHostUrl] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_LAST_HOST_URL) || DEFAULT_STATION_URL
		}
		catch {
			return DEFAULT_STATION_URL
		}
	})

	const [hostLabel, setHostLabel] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_LAST_HOST_LABEL) || ''
		}
		catch {
			return ''
		}
	})

	const [joinCodeInput, setJoinCodeInput] = useState('')
	const [keyCodeInput, setKeyCodeInput] = useState('')
	const [scannerMode, setScannerMode] = useState(null)      // join, key, or null
	const [scannerOpen, setScannerOpen] = useState(false)
	const [error, setError] = useState(null)

	const crisis = useMemo(() => disasterStorage.getCrisisMetadata(), [])
	const crisisId = crisis?.id || null
	const familyId = walletData?.family_id || null

	const [stationJsonInput, setStationJsonInput] = useState('')
	const [trustedStations, setTrustedStations] = useState(() => crisisId ? disasterStorage.getStations({ crisisId }) : {})
	const [selectedStationId, setSelectedStationId] = useState(null)

	const { connectToStation, connectToRelay, lastResult, setLastResult, sendPing, setSyncing, syncing } = useP2P()
	const [stationPools, setStationPools] = useState({})
	const [loadingPools, setLoadingPools] = useState(false)

	const localCounts = useMemo(() => getLocalCounts({ crisisId, familyId }), [lastResult])

	const setPreset = (url, label) => {
		const nextUrl = typeof url === 'string' ? url.trim() : ''
		const nextLabel = typeof label === 'string' ? label.trim() : ''

		if (!nextUrl) return

		setHostUrl(nextUrl)
		setHostLabel(nextLabel)

		try {
			// DEV NOTE: TODO - THESE MUST BE SCOPED AND WRAPPED IN disasterStorage CLASS IN services/localStorage.js!!!!
			localStorage.setItem(STORAGE_LAST_HOST_URL, nextUrl)
			localStorage.setItem(STORAGE_LAST_HOST_LABEL, nextLabel)
		}
		catch {
			// ignore
		}
	}

	// DEV NOTE: Button for convenience will change to "scan station qr code"
	const fetchStationProfile = async () => {
		const res = await fetch(`${process.env.NEXT_PUBLIC_STATION_API}/station/profile`)
		if (!res.ok) throw new Error("Failed to fetch station profile")
		const profile = await res.json()

		return profile
	}
	// DEV NOTE: helper functions for now
	const addStationFromJson = () => {
		try {
			const parsed = JSON.parse(stationJsonInput)
			
			if (!parsed.station_id || !parsed.station_public_key || !parsed.fingerprint) {
				throw new Error('Invalid station JSON')
			}
			
			disasterStorage.saveStation({ crisisId,station: parsed, })
			setTrustedStations(disasterStorage.getStations({ crisisId }))
			
			setStationJsonInput('')
			alert(`Station ${parsed.station_id} added`)
		} catch (e) {
			setError(e?.message || String(e))
		}
	}
	const removeStation = stationId => {
		disasterStorage.removeStation({ crisisId, stationId })
		setTrustedStations(disasterStorage.getStations({ crisisId }))
	}

	const fetchStationPools = async () => {
		if (!selectedStationId) {
			setError('Select a trusted station first')
			return
		}

		setLoadingPools(true)
		setError(null)

		try {
			const station = trustedStations[selectedStationId] // UI to test connection to station as if user scanned station's qr code
			const res = await fetch(`${hostUrl}/station/peers`) // UI to test trusted station exposing LAN-connected stations the user has not yet scanned
			if (!res.ok) throw new Error("Failed to fetch station's known trusted peers (on same LAN)")
			const data = await res.json()
			setStationPools(data || {})
		} 
		catch (e) {
			setError(e?.message || String(e))
		} 
		finally {
			setLoadingPools(false)
		}
	}

	// Save a station from pool list into trusted storage
	const saveStationFromPool = async (peer) => {
		try {
			if (!peer?.base_url) {
				throw new Error('Missing base_url for station')
			}

			// Fetch full trusted identity from station
			const res = await fetch(`${peer.base_url}/station/profile`)
			if (!res.ok) {
				throw new Error('Failed to fetch station profile')
			}

			const profile = await res.json()

			// Validate proper structure (same as addStationFromJson)
			if (!profile.station_id || !profile.station_public_key || !profile.fingerprint) {
				throw new Error('Invalid station profile')
			}

			// Save using existing logic
			disasterStorage.saveStation({
				crisisId,
				station: profile,
			})

			setTrustedStations(disasterStorage.getStations({ crisisId }))

		} catch (e) {
			setError(e?.message || String(e))
		}
	}

	// END HELPER FUNCS
	// ------------------------------

	const handleGenerateJoinCode = async () => {
		setError(null)
		try {
			const crisisMeta = disasterStorage.getCrisisMetadata()

			const code = await createJoinCode({
				url: (hostUrl || '').trim(),
				label: (hostLabel || '').trim(),
				crisisId: crisisMeta?.id || null,
				blockPublicKeyArmored: crisisMeta?.block_public_key || null,
			})

			// Always also populate the textbox so you can copy/paste without QR.
			setJoinCodeInput(code)

			// Show QR + ALWAYS show the text in the popup (disaster robustness)
			// await showTextQr({ 			// DEV NOTE: WORKS, DISABLING FOR DEV BECAUSE IT'S ANNOYING ME
			// 	text: code,
			// 	displayName: (hostLabel || '').trim() || 'Join Code',
			// 	title: 'Join Code',
			// 	heading: 'Join Code (Share this to join the room)',
			// })

			// Convenience: try clipboard, but popup already shows text.
			try {
				await navigator.clipboard.writeText(code)
			}
			catch {
				// ignore
			}
		}
		catch (e) {
			setError(e?.message || String(e))
		}
	}

	const handleApplyJoinCode = () => {
		setError(null)

		try {
			const parsed = parseJoinCode(joinCodeInput)

			// Sanity check only (not trust). Helps avoid joining the wrong crisis.
			const localCrisis = disasterStorage.getCrisisMetadata()
			if (parsed.crisisId && localCrisis?.id && parsed.crisisId !== localCrisis.id) {
				const ok = confirm(`Join code crisisId mismatch.\n` + `Local: ${localCrisis.id}\n` +
					`Code: ${parsed.crisisId}\n\n` + `Continue anyway?`)
				if (!ok) return
			}

			setHostUrl(parsed.url)
			setHostLabel(parsed.label || '')

			try {
				localStorage.setItem(STORAGE_LAST_HOST_URL, parsed.url)
				localStorage.setItem(STORAGE_LAST_HOST_LABEL, parsed.label || '')
			}
			catch {
				// ignore
			}
		}
		catch (e) {
			setError(e?.message || String(e))
		}
	}

	const handleShowMyPublicKey = async () => {
		setError(null)

		try {
			const familyId = walletData?.family_id
			if (!familyId) throw new Error('Missing wallet family_id')

			// public keys are domain shared scope, not wallet scoped
			const publicKeys = disasterStorage.getCachedPublicKeys({ crisisId }) || {}
			const myKey = publicKeys[familyId]?.publicKey

			if (!myKey) {
				throw new Error('Your public key is not cached on this device yet. ' +
					'Go online once (or unlock/validate key) so it can be cached.')
			}

			const crisisId = disasterStorage.getCrisisMetadata()?.id || null

			const code = createPublicKeyShareCode({
				familyId,
				publicKeyArmored: myKey,
				crisisId,
			})

			setKeyCodeInput(code)

			// For public keys we prefer lower error correction to fit.
			await showTextQr({
				text: code,
				displayName: `Public Key (${familyId})`,
				title: 'Public Key',
				heading: 'Public Key (Share for offline encrypted messaging)',
				qrOptions: {
					errorCorrectionLevel: 'L',
					scale: 6,
				},
			})
		}
		catch (e) {
			setError(e?.message || String(e))
		}
	}

	const handleImportPublicKey = () => {
		setError(null)

		try {
			const parsed = parsePublicKeyShareCode(keyCodeInput)

			// Store in cache so KeyManager.getPublicKey() works offline.
			disasterStorage.saveCachedPublicKey({ crisisId, targetFamilyId: parsed.familyId, publicKey: parsed.publicKeyArmored })

			alert(`Saved public key for family: ${parsed.familyId}`)
		}
		catch (e) {
			setError(e?.message || String(e))
		}
	}

	const openScanner = (mode) => {
		setError(null)
		setScannerMode(mode)
		setScannerOpen(true)
	}

	const handleScanned = (text) => {
		setScannerOpen(false)

		if (scannerMode === 'join') {
			setJoinCodeInput(text)
			alert('Scanned join code. Click "Apply Join Code" to use it.')
			return
		}

		if (scannerMode === 'key') {
			setKeyCodeInput(text)
			alert('Scanned public key code. Click "Import Public Key" to save it.')
			return
		}
		
		if (scannerMode === 'station') {
			try {
				const parsed = parseStationQr(text)
				disasterStorage.saveStation({ crisisId, station: parsed, })
				setTrustedStations(disasterStorage.getStations({ crisisId }))
				
				// does NOT run in background, users must actively connect to it to avoid draining batteries and broadcasting device credentials constantly.
				alert(`Station ${parsed.station_id} can be trusted! Saved to device so you can now connect to it even when the internet is down, check-ins and messages can still be shared while offline through this station when ever you like.`) 
			} 
			catch (e) {
				setError(e?.message || String(e))
			}
			return
		}

		// Unknown mode fallback
		setJoinCodeInput(text)
		alert('Scanned code. Review and apply/import as needed.')
	}

	return (
		<div id="connections-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Connections</h1>
				<button
					className="btn"
					type="button"
					onClick={sendPing}
				>
					SEND PING TO ALL
				</button>
			</div>

			{/* P2P Rooms */}
			<div className='p2proom-wrapper'>
				<P2PRoom />
			</div>

			{scannerOpen && (
				<QRScanner
					title={
						scannerMode === 'key'
							? 'Scan Public Key Code'
							: 'Scan Join Code'
					}
					onScan={handleScanned}
					onClose={() => {
						setScannerOpen(false)
						setScannerMode(null)
					}}
				/>
			)}

			{error && <div className="error">{error}</div>}
			
			{/* STATION HANDSHAKE */}
			<div className="card">
				<div className="card-header">
					<h3 className="card-title">Trusted Stations</h3>
				</div>
				<div className="card-body">

					{/* Dev helper: Fetch profile */}
					<div style={{ marginBottom: '1rem' }}>
						<button
							className="btn"
							type="button"
							onClick={async () => {
								try {
									const profile = await fetchStationProfile()
									setStationJsonInput(JSON.stringify(profile, null, 2))
								} catch (e) {
									setError(e?.message || String(e))
								}
							}}
						>
							Fetch Station Profile
						</button>
					</div>

					{/* Paste / Scan station JSON */}
					<div className="form-group">
						<label>Paste station profile JSON</label>
						<textarea
							className="form-input"
							rows="6"
							value={stationJsonInput}
							onChange={(e) => setStationJsonInput(e.target.value)}
							placeholder='{"station_id": "..."}'
						/>
					</div>

					<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
						<button
							className="btn"
							type="button"
							onClick={addStationFromJson}
							disabled={!stationJsonInput.trim()}
						>
							Add Station
						</button>

						<button
							className="btn"
							type="button"
							onClick={() => openScanner('station')}
						>
							Scan Station QR
						</button>

						<button
							className="btn"
							type="button"
							onClick={connectToStation}
						>
							CONNECT TO STATION
						</button>
					</div>

					{/* Station List */}
					{Object.keys(trustedStations).length === 0 ? (
						<div className="privacy-notice">No trusted stations yet.</div>
					) : (
						Object.values(trustedStations).map((station) => {
							const isActive = station.station_id === selectedStationId

							return (
								<div key={station.station_id} 
									className="contact-item"
									style={{
										borderLeft: isActive ? '4px solid var(--primary)' : '4px solid transparent',
										paddingLeft: '0.5rem',
									}}
								>
									<div>
										<strong>{station.station_id}</strong>
										<div className="contact-address">
											{station.fingerprint?.slice(0, 16)}...
										</div>
									</div>

									<div style={{ display: 'flex', gap: '0.5rem' }}>
										<button className="btn-icon save" type="button"
											onClick={() => {
												setSelectedStationId(station.station_id)
												setHostUrl(DEFAULT_STATION_URL)
												setHostLabel(station.station_id)
											}}
										>
											{isActive ? 'Selected' : 'Select'}
										</button>

										<button className="btn" type="button"
											onClick={() => removeStation(station.station_id)}
											style={{ background: 'var(--danger)' }}
										>
											Remove
										</button>

										<button className="btn" type="button"
											style={{ background: 'var(--danger)' }}
											onClick={async () => {
												const res = await fetch(`${hostUrl}/station/qr`)
												const data = await res.json()
												await showTextQr({
													text: data.qr_string,
													displayName: 'Station QR',
													title: 'Station QR Code',
													heading: 'Scan to Trust Station',
												})
											}}
										>
											Show Station QR
										</button>
									</div>
								</div>
							)
						})
					)}
					
				</div>
			</div>

			{/* AVAILABLE POOLS */}
				<hr style={{ margin: '12px 0', opacity: 0.2 }} />

				<div>
					<div style={{ fontWeight: 700, marginBottom: '6px' }}>
						Available Pools
					</div>

					<h3>Available Station Pools</h3>
					{Array.isArray(stationPools?.peers) && stationPools.peers.length === 0 && (
						<p>No station pools found.</p>
					)}
					Active connections: {stationPools?.activePeers ?? 'unknown'}
					<hr />
					<br />
					{Array.isArray(stationPools?.peers) && stationPools.peers.map((peer) => {
						const isSaved = !!trustedStations[peer.station_id]

						return (
							<div key={peer.station_id} style={{ marginBottom: 12 }}>
								<strong>{peer.name || 'Station Pool'}</strong>
								<br />
								Peer Pool ID: {peer.station_id}
								<br />
								Active connections: {peer.activePeers ?? 'unknown'}
								<hr />
								<div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
									<button
										onClick={async () => {
											setHostUrl(peer.base_url)
											setHostLabel(peer.station_id)
											setSelectedStationId(peer.station_id)

											await connectToStation()
										}}
									>
										Connect
									</button>
									{/* Save / Remove toggle */}
									{isSaved ? (
										<button
											className="btn"
											style={{ background: 'var(--danger)' }}
											onClick={() => removeStation(peer.station_id)}
										>
											Remove
										</button>
									) : (
										<button
											className="btn"
											onClick={() => saveStationFromPool(peer)}
										>
											Save
										</button>
									)}
								</div>
							</div>
						)}
					)}

					<button
						className="btn"
						type="button"
						onClick={fetchStationPools}
						disabled={!selectedStationId || loadingPools}
						style={{ marginBottom: '10px' }}
					>
						{loadingPools ? 'Loading...' : 'Refresh Pools'}
					</button>
				</div>

			<div className="card-grid">
				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Join a Room</h3>
					</div>
					<div className="card-body">
						<div className="form-group">
							<label>Paste join code</label>
							<textarea
								className="form-input"
								style={{fontSize: "10px"}}
								rows="6"
								value={joinCodeInput}
								onChange={(e) => setJoinCodeInput(e.target.value)}
								placeholder="krisys:join:v1:..."
								disabled={syncing}
							/>
						</div>

						<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
							<button
								className="btn"
								type="button"
								onClick={() => {
									handleApplyJoinCode()
									console.log(`Before connecting to relay, check the hostUrl: ${hostUrl}`)
									connectToRelay(hostUrl)
								}}
								disabled={!joinCodeInput.trim() || syncing}
							>
								CONNECT TO RELAY
							</button>

							<button
								className="btn"
								type="button"
								onClick={() => openScanner('join')}
								disabled={syncing}
							>
								Scan Join Code
							</button>
						</div>

						<div className="privacy-notice" style={{ marginTop: '0.75rem' }}>
							TODO: discovery + sort by signal strength.
						</div>
					</div>
				</div>

				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Host Settings</h3>
					</div>
					<div className="card-body">
						<div className="form-group">
							<label>Room name (label)</label>
							<input
								className="form-input"
								value={hostLabel}
								onChange={(e) => setHostLabel(e.target.value)}
								placeholder="e.g. Truck Relay A"
								disabled={syncing}
							/>
						</div>

						<div className="form-group">
							<label>Host URL</label>
							<input
								className="form-input"
								value={hostUrl}
								onChange={(e) => setHostUrl(e.target.value)}
								placeholder="http://localhost:6002"
								disabled={syncing}
							/>
						</div>

						<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
							<button
								className="btn"
								type="button"
								onClick={() => setPreset(DEFAULT_RELAY_URL, 'Relay')}
								disabled={syncing}
							>
								Use Relay
							</button>

							<button
								className="btn"
								type="button"
								onClick={() => setPreset(DEFAULT_STATION_URL, 'Station')}
								disabled={syncing}
							>
								Use Station
							</button>

							<button
								className="btn"
								type="button"
								onClick={handleGenerateJoinCode}
								disabled={syncing || !(hostUrl || '').trim()}
							>
								Show Join Code
							</button>
						</div>

						<div style={{ marginTop: '1rem' }}>
							<div className="privacy-notice">
								Crisis: {crisis?.id || 'unknown'} (block key:{' '}
								{crisis?.block_public_key ? 'cached' : 'missing'})
							</div>
						</div>
					</div>
				</div>

				{/* IN THE PROCESS OF DEPRECATING - we want to use connect button and sync loop instead  */}
				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Public Key Exchange</h3>
					</div>
					<div className="card-body">
						<div className="form-group">
							<label>Paste public key code</label>
							<textarea
								className="form-input"
								rows="6"
								value={keyCodeInput}
								onChange={(e) => setKeyCodeInput(e.target.value)}
								placeholder="krisys:key:v1..."
								disabled={syncing}
							/>
						</div>

						<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
							<button
								className="btn"
								type="button"
								onClick={handleShowMyPublicKey}
								disabled={syncing}
							>
								Show My Public Key
							</button>

							<button
								className="btn"
								type="button"
								onClick={handleImportPublicKey}
								disabled={!keyCodeInput.trim() || syncing}
							>
								Import Public Key
							</button>

							<button
								className="btn"
								type="button"
								onClick={() => openScanner('key')}
								disabled={syncing}
							>
								Scan Public Key
							</button>
						</div>

						<div className="privacy-notice" style={{ marginTop: '0.75rem' }}>
							This enables offline encryption when the server is unreachable.
						</div>
					</div>
				</div>

				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Local Cache</h3>
					</div>
					<div className="card-body">
						<div>Blocks cached: {localCounts.blockCount}</div>
						<div>Queued pending: {localCounts.queuedPendingCount}</div>
						<div>Confirmed messages: {localCounts.confirmedCount}</div>
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-header">
					<h3 className="card-title">Last Sync Result</h3>
				</div>
				<div className="card-body">
					{!lastResult ? (
						<div className="privacy-notice">No sync run yet.</div>
					) : (
						<div style={{
							fontSize: '12px',           // smaller text
							lineHeight: '1.9',
							wordBreak: 'break-all',     // forces long strings to wrap
							overflowWrap: 'anywhere',   // modern wrap fallback
							maxWidth: '100%',
							padding: '8px',
							background: '#111',
							color: '#ddd',
							borderRadius: '6px'
						}}>
							<div>Host: {lastResult?.label} ({lastResult?.hostUrl})</div>
							<div>Time: {new Date(lastResult?.at).toLocaleString()}</div>
							<div>Type: {lastResult?.type}</div>
							<div>Connection ID: {lastResult?.connId}</div>
							<div>Connection Object: 
								<pre style={{
									marginTop: '4px',
									fontSize: '11px',
									whiteSpace: 'pre-wrap',	// wrap JSON
									wordBreak: 'break-word',
									maxHeight: '250px',		// prevent huge overflow
									overflowY: 'auto',		// scroll if large
									background: '#000',
									padding: '6px',
									borderRadius: '4px'
								}}>
									{lastResult?.connObj}
								</pre>
							</div>
						</div>
					)}
				</div>
			</div>

		</div>
	)
}
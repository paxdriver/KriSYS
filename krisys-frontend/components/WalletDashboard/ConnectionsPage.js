// krisys-frontend/components/WalletDashboard/ConnectionsPage.js
'use client'
import { useMemo, useState } from 'react'
import { syncWithMeshHost } from '@/services/meshSync'
import { disasterStorage } from '@/services/localStorage'
import { createJoinCode, parseJoinCode } from '@/services/poolJoinCode'
import { createPublicKeyShareCode, parsePublicKeyShareCode } from '@/services/walletPublicKeyShare'
import { showTextQr } from '@/utils/qr'
import QRScanner from '../Scanner/QRScanner'
import P2PRoom from './P2PRoom'

const DEFAULT_STATION_URL =	process.env.NEXT_PUBLIC_STATION_URL || 'http://localhost:6001'
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

export default function ConnectionsPage({ onRefresh, walletData }) {
	const [hostUrl, setHostUrl] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_LAST_HOST_URL) || DEFAULT_RELAY_URL
		} 
        catch {
			return DEFAULT_RELAY_URL
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
	const [syncing, setSyncing] = useState(false)
	const [lastResult, setLastResult] = useState(null)
	const [error, setError] = useState(null)

	const crisis = useMemo(() => disasterStorage.getCrisisMetadata(), [])
	const crisisId = crisis?.id || null
	const familyId = walletData?.family_id || null

	const localCounts = useMemo(() => getLocalCounts({crisisId, familyId}), [lastResult, crisisId, familyId])

	const setPreset = (url, label) => {
		const nextUrl = typeof url === 'string' ? url.trim() : ''
		const nextLabel = typeof label === 'string' ? label.trim() : ''

		if (!nextUrl) return

		setHostUrl(nextUrl)
		setHostLabel(nextLabel)

		try {
			localStorage.setItem(STORAGE_LAST_HOST_URL, nextUrl)
			localStorage.setItem(STORAGE_LAST_HOST_LABEL, nextLabel)
		} 
        catch {
			// ignore
		}
	}

	const runSync = async () => {
		setSyncing(true)
		setError(null)
		setLastResult(null)

		const trimmedUrl = (hostUrl || '').trim()
		if (!trimmedUrl) {
			setError('Enter a host URL')
			setSyncing(false)
			return
		}

		try {
			try {
				localStorage.setItem(STORAGE_LAST_HOST_URL, trimmedUrl)
				localStorage.setItem( STORAGE_LAST_HOST_LABEL, (hostLabel || '').trim() )
			} 
            catch {
				// ignore
			}

			// Label is just UI sugar (helps logs + results read nicer)
			const label = (hostLabel || '').trim() || (
                trimmedUrl === DEFAULT_STATION_URL ? 
                    'Station' : trimmedUrl === DEFAULT_RELAY_URL ?
                    'Relay' : 'Host')

            console.warn(`trimmedUrl in connectionspage: ${trimmedUrl}`)

			const result = await syncWithMeshHost({ baseUrl: trimmedUrl, label, familyId })

			setLastResult({
				...result,
				at: Date.now(),
				hostUrl: trimmedUrl,
				label,
			})

			if (onRefresh) onRefresh()
		} 
        catch (e) {
			setError(e?.message || String(e))
		} 
        finally {
			setSyncing(false)
		}
	}

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
			await showTextQr({
				text: code,
				displayName: (hostLabel || '').trim() || 'Join Code',
				title: 'Join Code',
				heading: 'Join Code (Share this to join the room)',
			})

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
				const ok = confirm( `Join code crisisId mismatch.\n` + `Local: ${localCrisis.id}\n` + 
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

			alert('Join code applied. You can now click Sync Now.')
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
			disasterStorage.saveCachedPublicKey({crisisId, targetFamilyId: parsed.familyId, publicKey: parsed.publicKeyArmored})

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

		// Unknown mode fallback
		setJoinCodeInput(text)
		alert('Scanned code. Review and apply/import as needed.')
	}

	return (
		<div id="connections-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Connections</h1>
				<button className="btn" onClick={runSync} disabled={syncing}>
					{syncing ? 'Syncing...' : 'Sync Now'}
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
								rows="4"
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
								onClick={handleApplyJoinCode}
								disabled={!joinCodeInput.trim() || syncing}
							>
								Apply Join Code
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
							TODO (later): discovery + sort by signal strength.
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
						<div>Confirmed relays: {localCounts.confirmedCount}</div>
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
						<div>
							<div>
								Host: {lastResult.label} ({lastResult.hostUrl})
							</div>
							<div>Time: {new Date(lastResult.at).toLocaleString()}</div>
							<div>Sent queued to host: {lastResult.sentQueuedCount}</div>
							<div>Host blocks returned: {lastResult.hostBlocksCount}</div>
							<div>Host queued returned: {lastResult.hostQueuedCount}</div>
							<div>Host tip: {lastResult.hostTip?.block_index ?? 'n/a'}</div>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
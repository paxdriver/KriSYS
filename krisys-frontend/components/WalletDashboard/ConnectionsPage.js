// krisys-frontend/components/WalletDashboard/ConnectionsPage.js
'use client'
import { useMemo, useState } from 'react'
import { syncWithMeshHost } from '@/services/meshSync'
import { disasterStorage } from '@/services/localStorage'

const DEFAULT_STATION_URL =
	process.env.NEXT_PUBLIC_STATION_URL || 'http://localhost:6001'
const DEFAULT_RELAY_URL =
	process.env.NEXT_PUBLIC_RELAY_URL || 'http://localhost:6002'

const STORAGE_LAST_HOST_URL = 'krisys_mesh_last_host_url'

function getLocalCounts() {
	const blocks = disasterStorage.getBlockchain() || []
	const queue = disasterStorage.getMessageQueue() || []
	const confirmed = disasterStorage.getConfirmedRelays() || {}

	return {
		blockCount: Array.isArray(blocks) ? blocks.length : 0,
		queuedPendingCount: Array.isArray(queue)
			? queue.filter((m) => (m?.status || 'pending') === 'pending').length
			: 0,
		confirmedCount:
			confirmed && typeof confirmed === 'object'
				? Object.keys(confirmed).length
				: 0,
	}
}

export default function ConnectionsPage({ onRefresh }) {
	const [hostUrl, setHostUrl] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_LAST_HOST_URL) || DEFAULT_RELAY_URL
		} catch {
			return DEFAULT_RELAY_URL
		}
	})

	const [syncing, setSyncing] = useState(false)
	const [lastResult, setLastResult] = useState(null)
	const [error, setError] = useState(null)

	const crisis = useMemo(() => disasterStorage.getCrisisMetadata(), [])
	const localCounts = useMemo(() => getLocalCounts(), [lastResult])

	const setPreset = (url) => {
		setHostUrl(url)
		try {
			localStorage.setItem(STORAGE_LAST_HOST_URL, url)
		} catch {
			// ignore
		}
	}

	const runSync = async () => {
		setSyncing(true)
		setError(null)
		setLastResult(null)

		const trimmed = (hostUrl || '').trim()
		if (!trimmed) {
			setError('Enter a host URL')
			setSyncing(false)
			return
		}

		try {
			// Persist so your DEV offline shim (and future UI) can reuse it
			try {
				localStorage.setItem(STORAGE_LAST_HOST_URL, trimmed)
			} catch {
				// ignore
			}

			const label =
				trimmed === DEFAULT_STATION_URL
					? 'Station'
					: trimmed === DEFAULT_RELAY_URL
						? 'Relay'
						: 'Host'

			const result = await syncWithMeshHost({
				baseUrl: trimmed,
				label,
			})

			setLastResult({
				...result,
				at: Date.now(),
				hostUrl: trimmed,
				label,
			})

			// Optional: refresh wallet view (pull latest chain from central if online)
			if (onRefresh) onRefresh()
		} catch (e) {
			setError(e?.message || String(e))
		} finally {
			setSyncing(false)
		}
	}

	return (
		<div id="connections-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Connections</h1>
				<button className="btn" onClick={runSync} disabled={syncing}>
					{syncing ? 'Syncing...' : 'Sync Now'}
				</button>
			</div>

			<div className="card-grid">
				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Mesh Host</h3>
					</div>
					<div className="card-body">
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

						<div style={{ display: 'flex', gap: '0.75rem' }}>
							<button
								className="btn"
								type="button"
								onClick={() => setPreset(DEFAULT_RELAY_URL)}
								disabled={syncing}
							>
								Use Relay
							</button>

							<button
								className="btn"
								type="button"
								onClick={() => setPreset(DEFAULT_STATION_URL)}
								disabled={syncing}
							>
								Use Station
							</button>
						</div>

						<div style={{ marginTop: '1rem' }}>
							<div className="privacy-notice">
								Crisis: {crisis?.id || 'unknown'} (block key:{' '}
								{crisis?.block_public_key ? 'cached' : 'missing'})
							</div>
							<div className="privacy-notice">
								Station URL: {DEFAULT_STATION_URL}
							</div>
							<div className="privacy-notice">Relay URL: {DEFAULT_RELAY_URL}</div>
						</div>

						{error && <div className="error">{error}</div>}
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

						<div className="privacy-notice" style={{ marginTop: '0.75rem' }}>
							These are local-only counts. Syncing updates them using queued
							payloads and verified blocks.
						</div>
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-header">
					<h3 className="card-title">Last Sync Result</h3>
				</div>
				<div className="card-body">
					{!lastResult ? (
						<div className="privacy-notice">
							No sync run yet. Use “Sync Now”.
						</div>
					) : (
						<div>
							<div>
								Host: {lastResult.label} ({lastResult.hostUrl})
							</div>
							<div>
								Time:{' '}
								{new Date(lastResult.at).toLocaleString()}
							</div>
							<div>Sent queued to host: {lastResult.sentQueuedCount}</div>
							<div>Host blocks returned: {lastResult.hostBlocksCount}</div>
							<div>Host queued returned: {lastResult.hostQueuedCount}</div>
							<div>
								Host tip:{' '}
								{lastResult.hostTip?.block_index ?? 'n/a'}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
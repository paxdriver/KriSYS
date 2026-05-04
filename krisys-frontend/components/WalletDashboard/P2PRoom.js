// krisys-frontend/components/WalletDashboard/P2PRoom.js
'use client'

import { useState } from 'react'
import QRScanner from '../Scanner/QRScanner'
import { showTextQr } from '@/utils/qr'
import { useP2P } from '@/contexts/P2PContext'

export default function P2PRoom() {
	const {
		getConnectionsSnapshot,		// manual refresh button for the active connections
		fullSyncByConnDerivedTransportRole,	// manual sync on specific active connection
		disconnectById,	// manually close an active connection
		sendPingToConnection, // manually send ping to this active connection
		error,
		metrics,
		pushOnlyOnJoin,
		lastResult,
		setLastResult,
		logLines,
		setRemoteOfferInput,
		setRemoteAnswerInput,
		setSyncing,
		syncing,
	} = useP2P()

	const [scannerOpen, setScannerOpen] = useState(false)
	const [scanTarget, setScanTarget] = useState(null) // offer | answer | null
	
	const [connectionsSnapshot, setConnectionsSnapshot] = useState([])		// Holds manually refreshed connection snapshot
	// Manual refresh of connection registry snapshot
	const refreshConnections = () => {
		const snapshot = getConnectionsSnapshot()
		setConnectionsSnapshot(snapshot)
	}

	const showQr = async (text, title) => {
		if (!text || typeof text !== 'string') return
		await showTextQr({
			text,
			displayName: title,
			title,
			heading: title,
		})
	}

	const scanInto = (target) => {
		setScanTarget(target)
		setScannerOpen(true)
	}

	const onScanned = (text) => {
		setScannerOpen(false)

		if (scanTarget === 'offer') {
			setRemoteOfferInput(text)
		} else if (scanTarget === 'answer') {
			setRemoteAnswerInput(text)
		}

		setScanTarget(null)
	}

	const sendBytes = metrics?.send?.bytesSent ?? 0
	const recvBytes = metrics?.recv?.bytesReceived ?? 0
	const sendQueueDepth = metrics?.send?.queueDepth ?? 0
	const inflight = metrics?.recv?.inflight ?? 0

	return (
		<div className="card">
			<div className="card-header">
				<h3 className="card-title">P2P Room (WebRTC)</h3>
			</div>

			{/* THIS IS WHERE I WANT TO LIST OUR CONNECTIONS AND THEIR INDIVIDUAL STATUSES NOW */}
			<div className="card-body">
				<div className="privacy-notice" style={{ marginBottom: '8px' }}>
					{metrics ? (
						<>
							<br />
							Sent bytes: {sendBytes} | Recv bytes: {recvBytes} | Send
							queue: {sendQueueDepth} | Inflight: {inflight}
							<br />
							Join mode: {pushOnlyOnJoin ? 'push-only' : 'full-sync'}
						</>
					) : null}
				</div>

				<hr style={{ margin: '14px 0', opacity: 0.2 }} />
				
				{/* ACTIVE CONNECTIONS STATUSES */}
				<div style={{ marginBottom: '10px' }}>
					<button
						type="button"
						className="btn"
						onClick={refreshConnections}
					>
						Refresh Connections
					</button>
				</div>

				<div>
					<div style={{ fontWeight: 700, marginBottom: '6px' }}>
						Active Connections
					</div>

					{connectionsSnapshot.length === 0 ? (
						<div className="privacy-notice">
							No connections in registry.
						</div>
					) : (
						connectionsSnapshot.map((conn) => (
							<div
								key={conn.id}
								style={{
									border: '1px solid #ccc',
									padding: '8px',
									marginBottom: '8px',
								}}
							>
								{/* Disconnect this specific connection */}
								<button
									type="button"
									className="btn"
									style={{ marginTop: '6px', background: '#b33' }} // red-ish for clarity
									onClick={() => {
										setLastResult({
											at: Date.now(),
											type: 'disconnected',
											connId: conn.id,
											connObj: conn,
										})
										disconnectById(conn.id)
									}} // pass connection id
								>
									Disconnect
								</button>

								{/* SYNC THIS CONNECTION */}
								<button
									type="button"
									className="btn"
									style={{ marginTop: '6px' }}
									onClick={async () => {
										await fullSyncByConnDerivedTransportRole(conn.id)
										setLastResult({
											at: Date.now(),
											label: 'sync connection',
											hostUrl: 'TO-DO',
											type: 'manual-sync',
											connId: conn.id.toString(),
											connObj: JSON.stringify(conn, null, 2),
										})
									}}
								>
									Full Sync
								</button>

								{/* SEND PING TO THIS CONNECTION */}
								<button
									type="button"
									className="btn"
									style={{ marginTop: '6px' }}
									onClick={() => {
										sendPingToConnection(conn.id)
										setLastResult({
											at: Date.now(),
											label: 'sync connection',
											hostUrl: 'TO-DO',
											type: 'ping',
											connId: conn.id.toString(),
											connObj: JSON.stringify(conn, null, 2),
										})
									}}
								>
									Ping
								</button>
								
								{/* THIS CONNECTION'S DETAILS */}
								<div><strong>ID:</strong> {conn.id}</div>
								<div><strong>Role:</strong> {conn.transportRole}</div>
								<div><strong>Status:</strong> {conn.status}</div>
								<div><strong>RTCPeerConnection:</strong> {conn.connectionState}</div>
								<div><strong>ICE State:</strong> {conn.iceConnectionState}</div>
								<div><strong>Has DataChannel:</strong> {String(conn.hasDataChannel)}</div>
								<div><strong>Relay Poll:</strong> {String(conn.relayPollActive)}</div>
								<div><strong>Station Poll:</strong> {String(conn.stationPollActive)}</div>
								<div>
									<strong>Last Activity:</strong>{' '}
									{conn.lastActivity ? new Date(conn.lastActivity).toLocaleTimeString() : 'n/a'}
								</div>
							</div>
						))
					)}
				</div>

				{error && <div className="error">{error}</div>}

				{scannerOpen && (
					<QRScanner
						title="Scan WebRTC Room Code"
						onScan={onScanned}
						onClose={() => {
							setScannerOpen(false)
							setScanTarget(null)
						}}
					/>
				)}

				<hr style={{ margin: '14px 0', opacity: 0.2 }} />
					<div style={{ display: 'grid', gap: '14px' }}>
						<div>
							<div style={{ fontWeight: 700, marginBottom: '6px', textAlign:"center" }}>Log</div>
							<textarea
								className="form-input"
								rows="16"
								value={logLines.join('\n')}
								style={{fontSize: "10px" }}
								readOnly
							/>
						</div>
						<div className="privacy-notice">
							Logs show message metadata (type/id/chunks/bytes), not full payload
							contents.
						</div>
					</div>
			</div>
		</div>
	)
}
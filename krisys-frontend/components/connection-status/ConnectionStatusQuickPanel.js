// krisys-frontend/components/connection-status/ConnectionQuickPanel.js
'use client'
import React from 'react'

/*	ConnectionQuickPanel

	Purpose:
	- Presentational quick-view panel for current connections
	- Receives already-derived data from ConnectionStatusIndicator
	- Does NOT read P2P context directly
	- Does NOT compute indicator state
	- Renders:
		- summary text
		- hosting summary
		- active connection list
		- per-connection disconnect buttons
		- disconnect all button
		- open Connections page button

	This keeps responsibilities clean:
		- ConnectionStatusIndicator => smart wrapper / state source
		- ConnectionQuickPanel => presentational dropdown content
*/

/*
	Convert internal transport role values into readable labels.

	This keeps raw internal strings out of the UI.
*/
function getTransportLabel(transportRole) {
	if (transportRole === 'station_client') {
		return 'Station'
	}

	if (transportRole === 'relay_client') {
		return 'Relay'
	}

	if (transportRole === 'user_hosted_room_host') {
		return 'Hosting Room'
	}

	if (transportRole === 'user_hosted_room_peer') {
		return 'User Peer'
	}

	return 'Connection'
}

// Convert connection status into a readable label
function getStatusLabel(status) {
	if (status === 'connected') return 'Connected'
	else if (status === 'connecting') return 'Connecting'
	else if (status === 'closed') return 'Closed'
	else return 'Unknown'
}

export default function ConnectionQuickPanel({
	title = 'Connections', 		// Panel heading text
	activeConnections = [], 	// Already-filtered active connections from wrapper
	activeConnectionCount = 0, 	// Count used for summary text
	hasHosting = false, 		// Whether device is currently hosting a room
	hostedPeerCount = 0, 		// Number of peers attached to hosted room
	onDisconnectById, 			// Callback for one-row disconnect action
	onDisconnectAll, 			// Callback for global disconnect action
	onOpenConnectionsPage, 		// Callback to open the full page
}) {
	let summaryText = 'No active connections'

	if (hasHosting && hostedPeerCount > 0) {
		summaryText = `Hosting room with ${hostedPeerCount} peer${hostedPeerCount === 1 ? '' : 's'} connected`
	} 
	else if (hasHosting) {
		summaryText = 'Hosting room, waiting for peers'
	} 
	else if (activeConnectionCount > 0) {
		summaryText = `${activeConnectionCount} active connection${activeConnectionCount === 1 ? '' : 's'}`
	}

	return (
		/*	Outer panel container: // TODO Inline styles are used for now to get the behavior working before deciding where permanent CSS should live */
		<div
			role='dialog' // Announces this as an interactive panel.
			aria-label={title} // Accessibility label.
			style={{
				position: 'absolute', // Lets the parent anchor it near the icon.
				top: '100%', // Places it below the trigger area.
				right: 0, // Align to the right edge of the trigger wrapper.
				marginTop: '8px', // Small gap below the icon/button.
				width: '320px', // Compact but large enough for rows and actions.
				maxWidth: '90vw', // Prevent overflow on smaller screens.
				background: '#111827', // Dark panel background.
				color: '#f9fafb', // Light readable text.
				border: '1px solid #374151', // Subtle outline.
				borderRadius: '10px', // Soft corners.
				boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)', // Floating panel depth.
				padding: '12px', // Internal spacing.
				zIndex: 1000, // Keep above surrounding layout.
			}}
		>
			{/* Panel heading */}
			<div
				style={{
					fontSize: '14px',
					fontWeight: 700,
					marginBottom: '6px',
				}}
			>
				{title}
			</div>

			{/* Quick summary text */}
			<div
				style={{
					fontSize: '12px',
					color: '#d1d5db',
					marginBottom: '10px',
				}}
			>
				{summaryText}
			</div>

			{/* Optional hosting-specific notice. This helps keep hosting visually important for users to be aware of dangling live connections */}
			{hasHosting ? (
				<div
					style={{
						fontSize: '12px',
						color: '#fecaca',
						background: 'rgba(127, 29, 29, 0.35)',
						border: '1px solid rgba(239, 68, 68, 0.35)',
						borderRadius: '8px',
						padding: '8px',
						marginBottom: '10px',
					}}
				>
					Hosting is active on this device.
				</div>
			) : null}

			{/* Active connection list: If there are no active rows, show a quiet placeholder */}
			<div style={{ marginBottom: '12px' }}>
				{activeConnections.length === 0 ? (
					<div
						style={{
							fontSize: '12px',
							color: '#9ca3af',
							padding: '8px 0',
						}}
					>
						No live connections.
					</div>
				) : (
					activeConnections.map((conn) => {
						const transportLabel = getTransportLabel(
							conn?.transportRole
						)
						const statusLabel = getStatusLabel(conn?.status)
						const shortId = typeof conn?.id === 'string'
							? conn.id.slice(0, 8)
							: 'unknown'

						return (
							<div
								key={conn?.id || shortId}
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									gap: '10px',
									padding: '8px 0',
									borderTop: '1px solid rgba(255,255,255,0.06)',
								}}
							>
								{/*
									Left side: readable connection info.
								*/}
								<div style={{ minWidth: 0 }}>
									<div
										style={{
											fontSize: '13px',
											fontWeight: 600,
											color: '#f9fafb',
										}}
									>
										{transportLabel}
									</div>

									<div
										style={{
											fontSize: '11px',
											color: '#9ca3af',
											marginTop: '2px',
											wordBreak: 'break-all',
										}}
									>
										{statusLabel} · {shortId}
									</div>
								</div>

								{/*
									Right side: selective disconnect action.
								*/}
								<button
									type='button'
									onClick={() => {
										if (typeof onDisconnectById === 'function' && conn?.id) {
											onDisconnectById(conn.id)
										}
									}}
									style={{
										border: '1px solid #7f1d1d',
										background: '#991b1b',
										color: '#fff',
										borderRadius: '6px',
										padding: '6px 8px',
										fontSize: '11px',
										cursor: 'pointer',
										whiteSpace: 'nowrap',
									}}
								>
									Disconnect
								</button>
							</div>
						)
					})
				)}
			</div>

			{/*
				Footer actions.

				We separate quick interruption actions from navigation action.
			*/}
			<div
				style={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: '8px',
					marginTop: '6px',
				}}
			>
				<button
					type='button'
					onClick={() => {
						if (typeof onDisconnectAll === 'function') {
							onDisconnectAll()
						}
					}}
					style={{
						border: '1px solid #7f1d1d',
						background: '#b91c1c',
						color: '#fff',
						borderRadius: '8px',
						padding: '8px 10px',
						fontSize: '12px',
						fontWeight: 600,
						cursor: 'pointer',
					}}
				>
					Disconnect All
				</button>

				<button
					type='button'
					onClick={() => {
						if (typeof onOpenConnectionsPage === 'function') {
							onOpenConnectionsPage()
						}
					}}
					style={{
						border: '1px solid #374151',
						background: '#1f2937',
						color: '#f9fafb',
						borderRadius: '8px',
						padding: '8px 10px',
						fontSize: '12px',
						fontWeight: 600,
						cursor: 'pointer',
					}}
				>
					Open Connections
				</button>
			</div>
		</div>
	)
}

/* // TODO Later the wrapper should pass:
	- activeConnections
	- activeConnectionCount
	- hasHosting
	- hostedPeerCount
	- onDisconnectById
	- onDisconnectAll
	- onOpenConnectionsPage
*/
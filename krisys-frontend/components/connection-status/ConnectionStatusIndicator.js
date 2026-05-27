// krisys-frontend/components/ConnectionStatusIndicator.js
'use client'

import React, { useState, useMemo } from 'react'
import ConnectionIndicatorIcon from '../icons/ConnectionIndicatorIcon'
import ConnectionQuickPanel from './ConnectionStatusQuickPanel'
import { buildConnectionStatusSummary, buildIndicatorTitle, deriveIndicatorState } from './utils'
import { useP2P } from '@/contexts/P2PContext'

/* 	ConnectionStatusIndicator

	Purpose:
	- Smart wrapper around ConnectionIndicatorIcon
	- Reads live connection state from the P2P context
	- Derives one simple visual state for the icon
	- Does NOT yet open the quick panel
	- Does NOT yet implement click behavior

	This keeps responsibilities clean:
	- ConnectionIndicatorIcon => presentational only
	- ConnectionStatusIndicator => state derivation
*/

export default function ConnectionStatusIndicator({
	size = 28, 		// Allows parent layout to control icon size
	className = '', // Optional CSS class for outer wrapper
	titlePrefix = 'Connections', // Base title text; useful for later reuse
}) {
	// Read the live connection snapshot from the P2P provider... useMemo keeps the derived calculations readable
	const { getConnectionsSnapshot, disconnectAll, disconnectById } = useP2P()		// DEV NOTE: This memo recalculates on render. getConnectionsSnapshot() is cheap and the component is small
	
	const connections = useMemo(() => {
		return getConnectionsSnapshot()
	}, [getConnectionsSnapshot])

	const { 
		activeConnections, 
		activeConnectionCount,
		hostingConnection, 
		hasHosting,
		hostedPeerCount,} = useMemo(() => {
			return buildConnectionStatusSummary(connections)
		}, [connections])

	// Placeholder until the real global connections toggle exists.
	const connectionsEnabled = true

	const indicatorState = useMemo(() => {
		return deriveIndicatorState({
			connectionsEnabled,
			activeConnectionCount,
			hasHosting,
			hostedPeerCount,
		})
	}, [connectionsEnabled, activeConnectionCount, hasHosting, hostedPeerCount])

	// Build an accessible title string to help screen readers and also gives a useful hover title in dev
	const title = useMemo(() => {
		return buildIndicatorTitle({
			state: indicatorState,
			activeConnectionCount,
			hostedPeerCount,
			titlePrefix,
		})
	}, [indicatorState, activeConnectionCount, hostedPeerCount, titlePrefix])

	const [isConnectionDropdownListOpen, setIsConnectionsDropdownListOpen] = useState(false)	// toggle the summary panel of active connections
	
	const onOpenConnectionsPage = evt => {
		setIsConnectionsDropdownListOpen(false)	// close the summary panel...
		
		// IF isOpen is already true (clicked again after being clicked once to open the summary panel) 
		// 		-> navigate to the more detailed connections page route
		console.warn("DEV TODO: route ConnectionStatusIndicator to ConnectionsPage")
	}

	const onOpenConnectionsSummary = evt => {
		// IF isOpen is false, set it to true to render the connections summary panel
		if(!isConnectionDropdownListOpen) setIsConnectionsDropdownListOpen(true)
		else onOpenConnectionsPage()
	}

	return (
		// Wrapper div to keep the component layout-friendly
		<div className={className}
			title={title}
			aria-label={title}
		>
			<button className="btn-connection-status-icon"
				onClick={onOpenConnectionsSummary}
			>
				<ConnectionIndicatorIcon
					state={indicatorState} 	// Pass the one derived visual state
					size={size} 			// Pass through sizing
					title={title} 			// Keep icon accessibility aligned with wrapper
				/>
			</button>

			{ isConnectionDropdownListOpen && <ConnectionQuickPanel 
				activeConnectionCount = { activeConnectionCount }
				activeConnections = { activeConnections }
				hasHosting = { hasHosting }
				hostedPeerCount = { hostedPeerCount }
				onDisconnectAll = { disconnectAll }
				onDisconnectById = { disconnectById }
			/>}
		</div>
	)
}
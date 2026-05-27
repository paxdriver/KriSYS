// krisys-frontend/components/ConnectionStatusIndicator.js
'use client'

import React, { useMemo } from 'react'
import ConnectionIndicatorIcon from '../icons/ConnectionIndicatorIcon'
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

/*
	Count how many connection rows are actually active

	We treat "connected" as active
	Ignoring "connecting" for now, can use an animation later
*/
function getActiveConnectionCount(connections) {
	if (!Array.isArray(connections)) {
		return 0
	}

	return connections.filter((conn) => conn?.status === 'connected').length
}

/*	Detect whether the device is currently hosting a user room

	For now, we infer hosting from transportRole. Current P2P context uses 'user_hosted_room_host' for the local device acting as host
*/
function getHostingConnection(connections) {
	if (!Array.isArray(connections)) {
		return null
	}

	return (
		connections.find(
			(conn) =>
				conn?.transportRole === 'user_hosted_room_host' &&
				conn?.status === 'connected'
		) || null
	)
}

/*	DEV NOTE: TODO - This is a temporary heuristic until you expose explicit hosting/peer summary data in the context
	- For now infer this from active peer-role connections
	- P2P context uses 'user_hosted_room_peer' for peer-side room connections
*/
function getHostedPeerCount(connections) {
	// Count peers that are connected to the hosted room
	if (!Array.isArray(connections)) {
		return 0
	}

	return connections.filter(
		(conn) =>
			conn?.transportRole === 'user_hosted_room_peer' &&
			conn?.status === 'connected'
	).length
}

/*	Derive a single icon state from the available connection data

	Priority order:
	1. disabled
	2. hosting_active
	3. hosting_idle
	4. connected
	5. idle

	DEV NOTE: TODO - For now, "disabled" is not yet implemented in context, so we default to enabled
*/
function deriveIndicatorState({
	connectionsEnabled,
	activeConnectionCount,
	hasHostingConnection,
	hostedPeerCount,
}) {
	if (!connectionsEnabled) {
		return 'disabled'
	}

	if (hasHostingConnection && hostedPeerCount > 0) {
		return 'hosting_active'
	}

	if (hasHostingConnection) {
		return 'hosting_idle'
	}

	if (activeConnectionCount > 0) {
		return 'connected'
	}

	return 'idle'
}

export default function ConnectionStatusIndicator({
	size = 28, 		// Allows parent layout to control icon size
	className = '', // Optional CSS class for outer wrapper
	titlePrefix = 'Connections', // Base title text; useful for later reuse
}) {
	// Read the live connection snapshot from the P2P provider... useMemo keeps the derived calculations readable
	const { getConnectionsSnapshot } = useP2P()		// DEV NOTE: This memo recalculates on render. getConnectionsSnapshot() is cheap and the component is small
	
	const connections = useMemo(() => {
		return getConnectionsSnapshot()
	}, [getConnectionsSnapshot])

	// Total number of active connected rows.
	const activeConnectionCount = useMemo(() => {
		return getActiveConnectionCount(connections)
	}, [connections])

	// Whether this device is acting as a hosted room right now
	const hostingConnection = useMemo(() => {
		return getHostingConnection(connections)
	}, [connections])

	// Number of connected hosted-room peers
	const hostedPeerCount = useMemo(() => {
		return getHostedPeerCount(connections)
	}, [connections])

	/*	Placeholder for the upcoming global connections toggle

		For now:
		- true means the app is allowed to connect
		- later this should come from context/provider state		// DEV NOTE: TODO - SET THIS BASED ON P2P CONTEXT STATE VALUES
	*/
	const connectionsEnabled = true

	// Final icon state after applying the priority rules.
	const indicatorState = useMemo(() => {
		return deriveIndicatorState({
			connectionsEnabled,
			activeConnectionCount,
			hasHostingConnection: !!hostingConnection,
			hostedPeerCount,
		})
	}, [
		connectionsEnabled,
		activeConnectionCount,
		hostingConnection,
		hostedPeerCount,
	])

	// Build an accessible title string to help screen readers and also gives a useful hover title in dev
	const title = useMemo(() => {
		if (indicatorState === 'disabled') {
			return `${titlePrefix}: disabled`
		}

		if (indicatorState === 'hosting_active') {
			return `${titlePrefix}: hosting room with ${hostedPeerCount} peer${hostedPeerCount === 1 ? '' : 's'} connected`
		}

		if (indicatorState === 'hosting_idle') {
			return `${titlePrefix}: hosting room, waiting for peers`
		}

		if (indicatorState === 'connected') {
			return `${titlePrefix}: ${activeConnectionCount} active connection${activeConnectionCount === 1 ? '' : 's'}`
		}

		return `${titlePrefix}: no active connections`
	}, [indicatorState, hostedPeerCount, activeConnectionCount, titlePrefix])

	return (
		// Wrapper div to keep the component layout-friendly
		<div	// DEV NOTE: TODO - NOT yet clickable
			className={className}
			title={title}
			aria-label={title}
		>
			<ConnectionIndicatorIcon
				state={indicatorState} 	// Pass the one derived visual state
				size={size} 			// Pass through sizing
				title={title} 			// Keep icon accessibility aligned with wrapper
			/>
		</div>
	)
}
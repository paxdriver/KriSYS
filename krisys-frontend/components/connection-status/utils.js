// krisys-frontend/components/connection-status/utils.js
/*	Purpose:
	- Pure helper functions for the connection status feature.
	- No React usage.
	- No context usage.
	- No rendering.
	- No side effects.

	These helpers exist to keep:
	- ConnectionStatusIndicator.js small
	- panel rendering code clean
	- state derivation easy to test and edit
*/

/*	Return only connections whose status is exactly "connected"

	- The indicator should represent live active connections
	- We intentionally ignore "connecting" for the first version so the meaning stays simple and stable
*/
export function getActiveConnections(connections) {
	if (!Array.isArray(connections)) {
		return []
	}

	return connections.filter((conn) => conn?.status === 'connected')
}

export function getActiveConnectionCount(connections) {
	return getActiveConnections(connections).length 	// convenience helper for legibility
}

/*	Return the active hosted-room connection, if one exists

	Current transport role used by your P2P context "user_hosted_room_host"

	Returns:
	- the matching connection object
	- or null if none exists
*/
export function getHostingConnection(connections) {
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

// Return true if this device is currently hosting a room
// This keeps calling code more expressive than repeatedly checking for a non-null hosting connection.
export function hasHostingConnection(connections) {
	return !!getHostingConnection(connections)
}

/*	Count active peer rows associated with user-hosted room usage.

	Current transport role used by your P2P context:
	- "user_hosted_room_peer"

	Important note:
	- This is a temporary heuristic.
	- Later you may expose explicit hosted peer counts directly from the context.
*/
export function getHostedPeerCount(connections) {
	if (!Array.isArray(connections)) {
		return 0
	}

	return connections.filter(
		(conn) =>
			conn?.transportRole === 'user_hosted_room_peer' &&
			conn?.status === 'connected'
	).length
}

/*	Normalize whether connections are enabled

	TODO: defensive for now because the global on/off toggle does not exist yet. If a non-boolean value is passed, we default to true. That keeps the indicator logic stable until the real toggle is wired in
*/
export function normalizeConnectionsEnabled(value) {
	if (typeof value === 'boolean') {
		return value
	}

	return true
}

/*	Derive the single icon visual state from connection facts

	Priority order:
	1. disabled
	2. hosting_active
	3. hosting_idle
	4. connected
	5. idle

	Inputs:
	- connectionsEnabled: boolean-ish
	- activeConnectionCount: number
	- hasHosting: boolean
	- hostedPeerCount: number

	Returns one of:
	- "disabled"
	- "hosting_active"
	- "hosting_idle"
	- "connected"
	- "idle"
*/
export function deriveIndicatorState({
	connectionsEnabled,
	activeConnectionCount,
	hasHosting,
	hostedPeerCount,
}) {
	const enabled = normalizeConnectionsEnabled(connectionsEnabled)

	if (!enabled) {
		return 'disabled'
	}

	if (hasHosting && hostedPeerCount > 0) {
		return 'hosting_active'
	}

	if (hasHosting) {
		return 'hosting_idle'
	}

	if ((activeConnectionCount || 0) > 0) {
		return 'connected'
	}

	return 'idle'
}

/*
	Build a human-readable summary title for the current indicator state.

	This is useful for:
	- title attributes
	- aria-label values
	- quick summary text

	Inputs:
	- state: derived visual state
	- activeConnectionCount: number
	- hostedPeerCount: number
	- titlePrefix: optional string prefix, defaults to "Connections"
*/
export function buildIndicatorTitle({
	state,
	activeConnectionCount = 0,
	hostedPeerCount = 0,
	titlePrefix = 'Connections',
}) {
	if (state === 'disabled') {
		return `${titlePrefix}: disabled`
	}

	if (state === 'hosting_active') {
		return `${titlePrefix}: hosting room with ${hostedPeerCount} peer${hostedPeerCount === 1 ? '' : 's'} connected`
	}

	if (state === 'hosting_idle') {
		return `${titlePrefix}: hosting room, waiting for peers`
	}

	if (state === 'connected') {
		return `${titlePrefix}: ${activeConnectionCount} active connection${activeConnectionCount === 1 ? '' : 's'}`
	}

	return `${titlePrefix}: no active connections`
}

/*	Create a compact summary object for the connection-status feature

	This is optional convenience data so both the indicator and quick panel can consume one derived bundle instead of repeating the same calls

	Returned fields:
	- activeConnections
	- activeConnectionCount
	- hostingConnection
	- hasHosting
	- hostedPeerCount
*/
export function buildConnectionStatusSummary(connections) {
	const activeConnections = getActiveConnections(connections)
	const activeConnectionCount = activeConnections.length
	const hostingConnection = getHostingConnection(connections)
	const hasHosting = !!hostingConnection
	const hostedPeerCount = getHostedPeerCount(connections)

	return {
		activeConnections,
		activeConnectionCount,
		hostingConnection,
		hasHosting,
		hostedPeerCount,
	}
}
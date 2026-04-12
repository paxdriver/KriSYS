// krisys-frontend/contexts/UserHostedRoomContext.js
'use client'

/* P2PContext is the actual transport layer... this component should eventually manage:
	- Peer metadata
	- Host registry
	- Per-peer known inventory
	- Rebroadcast logic
	- Room mode (host / idle)
	- SOS broadcast logic
	- Chat messages
*/

import { createContext, useContext, useMemo, useState } from 'react'

const UserHostedRoomContext = createContext(null)

export function UserHostedRoomProvider({ children }) {
	// Whether this wallet is actively hosting a room
	const [isHosting, setIsHosting] = useState(false)

	const value = useMemo(() => {
		return {
			isHosting,
			startHosting: () => setIsHosting(true),
			stopHosting: () => setIsHosting(false),
		}
	}, [isHosting])

	return (
		<UserHostedRoomContext.Provider value={value}>
			{children}
		</UserHostedRoomContext.Provider>
	)
}

export function useUserHostedRoom() {
	const ctx = useContext(UserHostedRoomContext)
	if (!ctx) {
		throw new Error('useUserHostedRoom must be used inside UserHostedRoomProvider')
	}
	return ctx
}
// krisys-frontend/app/wallet/[familyId]/layout.js
// This is used to wrap the connections context provider around the wallet so established connections stay active while navigating the app from within a wallet, but are lost when changing wallets or closing the browser to ensure resources aren't running in the background wasting power unknowingly.
'use client'
import { P2PProvider } from '@/contexts/P2PContext'
export default function WalletLayout({ children }) {
	return (
		<P2PProvider>
			{children}
		</P2PProvider>
	)
}
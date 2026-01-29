// app/wallet/[familyId]/page.js
'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '../../../services/api'
import { disasterStorage } from '../../../services/localStorage'
import WalletDashboard from '../../../components/WalletDashboard'
import '../../../styles/wallet_dashboard.css'
import { filterCanonicalBlocks } from '@/services/blockVerifier'

// Helper function for getting data from blocks rather than wallet/:id/transactions endpoint
// DEV NOTE: This is ensuring we get canonical block data, and it includes alerts and sent messages now
// Allows for family check-in from one scan, alert broadcast to family instead of members, obfuscates number of individuals in family thus reducing some chain bloat over time

/* 	This helper derives wallet‑relevant transactions from verified blocks.

	IMPORTANT:
	- We never trust the server’s /wallet/:id/transactions endpoint.
	- We always derive visibility from canonical blocks.
	- This guarantees offline correctness and consistent UX.
*/

const deriveWalletTransactionsFromBlocks = (wallet, blocks) => {
	const memberAddresses = wallet?.members?.map((m) => m.address) || []
	const walletId = wallet?.family_id || null
	const derived = []

	for (const block of blocks || []) {
		const txList = block?.transactions || []

		for (const tx of txList) {
			if (!tx) continue

			// Provider alerts are global: every wallet sees them
			if (tx.type_field === 'alert') {
				derived.push(tx)
				continue
			}

			const fromMe = tx.station_address && memberAddresses.includes(tx.station_address)

			const toMember = Array.isArray(tx.related_addresses) && 
				tx.related_addresses.some((addr) => memberAddresses.includes(addr))

			const toWallet = walletId && Array.isArray(tx.related_addresses) &&
				tx.related_addresses.includes(walletId)

			if (fromMe || toMember || toWallet) {
				derived.push(tx)
			}
		}
	}

	return derived
}

export default function WalletDashboardPage() {
	/*	The wallet route gives us the familyId.
		This is *navigation state*, not storage state.
	*/
	const params = useParams()
	const familyId = typeof params?.familyId === 'string'
			? params.familyId
			: Array.isArray(params?.familyId)
			? params.familyId[0]
			: null

	/* crisisId is NOT derived from the URL, nor is it pulled from context provider used for connection persistence after login
		It is derived from pinned crisis metadata in local storage.

		This allows:
		- offline reloads
		- future native navigation
		- single‑crisis backend today, multi‑crisis later
	*/
	const crisisId = useMemo(() => {
		try {
			return disasterStorage.getCrisisMetadata()?.id || null
		} catch {
			return null
		}
	}, [])

	const [walletData, setWalletData] = useState(null)
	const [transactions, setTransactions] = useState([])
	const [loading, setLoading] = useState(true)

	/*
		This function loads *everything* the wallet page needs.

		Design principles:
		- Online path pins and refreshes all canonical data
		- Offline path reconstructs UI from cached, verified state
		- All localStorage writes are fully namespaced by crisisId + familyId
	*/
	const loadWalletData = useCallback(async () => {
		setLoading(true)

		// If either ID is missing, we cannot proceed. This is a *loading* state, not an error.
		if (!crisisId || !familyId) {
			setLoading(false)
			return
		}

		try {
			/* 1) Load wallet metadata from server (still required to know members, addresses, etc.) */
			const walletResponse = await api.getWallet(familyId)
			const wallet = walletResponse.data

			setWalletData(wallet)

			// Cache wallet metadata in WALLET domain
			disasterStorage.saveWalletData({
				crisisId,
				familyId,
				walletData: wallet,
			})

			/* 2) Load crisis metadata + blockchain in parallel */
			const [crisisRes, chainRes] = await Promise.all([
				api.getCrisisInfo(),
				api.getBlockchain(),
			])

			// Pin crisis metadata locally (sets active crisis pointer)
			if (crisisRes?.data?.block_public_key) {
				disasterStorage.saveCrisisMetadata(crisisRes.data)
			}

			const blockPublicKey = crisisRes?.data?.block_public_key
			const allBlocks = chainRes?.data || []

			/* 3) Verify blocks locally (signature + linkage) */
			const canonicalBlocks = blockPublicKey
				? await filterCanonicalBlocks(allBlocks, blockPublicKey)
				: []

			// Cache canonical blocks in SHARED domain
			if (canonicalBlocks.length > 0) {
				disasterStorage.saveBlockchain({
					crisisId,
					blocks: canonicalBlocks,
				})
			}

			/* 4) Derive wallet‑visible transactions from canonical blocks */
			const txs = deriveWalletTransactionsFromBlocks(
				wallet,
				canonicalBlocks
			)
			setTransactions(txs)

			/* 5) Update confirmed relay hashes and prune wallet queue */
			disasterStorage.syncConfirmedFromTransactions({
				crisisId,
				familyId,
				transactions: txs,
			})
		} catch (error) {
			console.error('Error loading wallet data (online path failed):', error)

			/* OFFLINE FALLBACK PATH

				We trust:
				- cached wallet metadata
				- cached canonical blocks
			*/
			const cachedWallet = disasterStorage.getWalletData({
				crisisId,
				familyId,
			})

			if (!cachedWallet) {
				setWalletData(null)
				setTransactions([])
				return
			}

			setWalletData(cachedWallet)

			const cachedBlocks =
				disasterStorage.getBlockchain({ crisisId }) || []

			const derivedTxs = deriveWalletTransactionsFromBlocks(
				cachedWallet,
				cachedBlocks
			)

			setTransactions(derivedTxs)

			disasterStorage.syncConfirmedFromTransactions({
				crisisId,
				familyId,
				transactions: derivedTxs,
			})
		} finally {
			setLoading(false)
		}
	}, [crisisId, familyId])

	useEffect(() => {
		loadWalletData()
	}, [loadWalletData])


	/*
		Rendering logic is intentionally simple:
		- loading → spinner
		- missing wallet → error
		- otherwise → dashboard
	*/
	if (loading) {
		return <div className="loading-page">Loading wallet data…</div>
	}
	if (!walletData) {
		return (
			<div className="error-page">
				Wallet not found (and no cached data available)
			</div>
		)
	}
	return (
		<WalletDashboard
			walletData={walletData}
			transactions={transactions}
			familyId={familyId}
			onRefresh={loadWalletData}
		/>
	)
}
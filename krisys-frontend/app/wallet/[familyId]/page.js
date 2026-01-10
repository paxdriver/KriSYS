// app/wallet/[familyId]/page.js
'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '../../../services/api'
import { disasterStorage } from '../../../services/localStorage'
import WalletDashboard from '../../../components/WalletDashboard'
import '../../../styles/wallet_dashboard.css'
import { filterCanonicalBlocks } from '@/services/blockVerifier'

// Helper function for getting data from blocks rather than wallet/:id/transactions endpoint
// DEV NOTE: This is ensuring we get canonical block data, and it includes alerts and sent messages now
const deriveWalletTransactionsFromBlocks = (wallet, blocks) => {
  const memberAddresses = wallet?.members?.map((m) => m.address) || []
  const derived = []

  for (const block of blocks || []) {
    const txList = block?.transactions || []

    for (const tx of txList) {
      if (!tx) continue

      // Alerts are global: every wallet should see them
      if (tx.type_field === 'alert') {
        derived.push(tx)
        continue
      }

      const fromMe =
        tx.station_address && memberAddresses.includes(tx.station_address)

      const toMe =
        Array.isArray(tx.related_addresses) &&
        tx.related_addresses.some((addr) => memberAddresses.includes(addr))

      if (fromMe || toMe) {
        derived.push(tx)
      }
    }
  }

  return derived
}

export default function WalletDashboardPage() {
  const params = useParams()
  const familyId = params.familyId

  const [walletData, setWalletData] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

const loadWalletData = useCallback(async () => {
  setLoading(true)

  try {
    // 1) Load wallet metadata (still needed)
    const walletResponse = await api.getWallet(familyId)
    const wallet = walletResponse.data
    setWalletData(wallet)
    disasterStorage.saveWalletData(familyId, wallet)

    // 2) Load crisis metadata (block_public_key) + chain in parallel
    const [crisisRes, chainRes] = await Promise.all([
      api.getCrisisInfo(),
      api.getBlockchain(),
    ])

    // Cache crisis metadata for offline verification
    if (crisisRes?.data?.block_public_key) disasterStorage.saveCrisisMetadata(crisisRes.data)

    const blockPublicKey = crisisRes?.data?.block_public_key
    const allBlocks = chainRes?.data || []

    // 3) Filter to canonical (signature-verified) blocks
    const canonicalBlocks = blockPublicKey ? await filterCanonicalBlocks(allBlocks, blockPublicKey) : []

    // Cache canonical blocks for offline use
    if (canonicalBlocks.length > 0) disasterStorage.saveBlockchain(canonicalBlocks)

    // 4) Derive wallet-relevant transactions from canonical blocks
    const txs = deriveWalletTransactionsFromBlocks(wallet, canonicalBlocks)
    setTransactions(txs)

    // 5) Mark relay_hashes from confirmed txs and prune queue
    disasterStorage.syncConfirmedFromTransactions(txs)
  } 
  catch (error) {
    console.error('Error loading wallet data (online path failed):', error)

    // Offline fallback: use cached wallet + cached canonical blocks
    const cachedWallet = disasterStorage.getWalletData(familyId)
    if (!cachedWallet) {
      setWalletData(null)
      setTransactions([])
      return
    }

    setWalletData(cachedWallet)

    const cachedBlocks = disasterStorage.getBlockchain() || []
    const derivedTxs = deriveWalletTransactionsFromBlocks(
      cachedWallet,
      cachedBlocks
    )
    setTransactions(derivedTxs)
    disasterStorage.syncConfirmedFromTransactions(derivedTxs)
  } 
  finally {
    setLoading(false)
  }
}, [familyId])

  useEffect(() => {
    loadWalletData()
  }, [loadWalletData])

  if (loading) {
    return <div className="loading-page">Loading wallet data...</div>
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
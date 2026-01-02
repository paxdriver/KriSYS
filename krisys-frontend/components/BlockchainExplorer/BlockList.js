// components/BlockchainExplorer/BlockList.js
'use client'

import { useState, useEffect } from 'react'
import { api } from '@/services/api'
import { disasterStorage } from '@/services/localStorage'
import { filterCanonicalBlocks } from '@/services/blockVerifier'

export default function BlockList() {
    const [blocks, setBlocks] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    useEffect(() => {
        const load = async () => {
            setLoading(true)
            setError(null)

            try {
                // ONLINE PATH: Fetch crisis metadata and full chain in parallel
                const [crisisRes, chainRes] = await Promise.all([
                    api.getCrisisInfo(),
                    api.getBlockchain(),
                ])
                
                const crisisData = crisisRes.data
                const blockPublicKey = crisisData.block_public_key
                const allBlocks = chainRes.data || []

                // Cache crisis metadata (including block_public_key) for offline use
                if (crisisData) {
                    disasterStorage.saveCrisisMetadata(crisisData)
                }

                // Only keep blocks whose signatures verify with the crisis key
                const canonicalBlocks = await filterCanonicalBlocks(
                    allBlocks,
                    blockPublicKey
                )

                if (canonicalBlocks.length !== allBlocks.length) {
                    console.warn(
                        `Discarded ${
                            allBlocks.length - canonicalBlocks.length
                        } unverified blocks`
                    )
                }

                setBlocks(canonicalBlocks)

                // Cache only canonical blocks offline
                if (canonicalBlocks.length > 0) {
                    disasterStorage.saveBlockchain(canonicalBlocks)
                }
            } catch (e) {
                console.error(
                    'Failed to load canonical blockchain from backend:',
                    e
                )

                // OFFLINE / ERROR FALLBACK: use locally cached canonical blocks
                const cachedBlocks = disasterStorage.getBlockchain() || []
                if (cachedBlocks.length > 0) {
                    console.log(
                        'Using cached blockchain from localStorage for offline access'
                    )
                    setBlocks(cachedBlocks)
                    // Optionally mark that we're in offline mode instead of a hard error
                    setError(null)
                } else {
                    setError('Failed to load blockchain')
                }
            } finally {
                setLoading(false)
            }
        }

        load()
    }, [])

    if (loading) {
        return <div className="loading">Loading blockchain...</div>
    }

    if (error) {
        return <div className="error">{error}</div>
    }

    if (!blocks || blocks.length === 0) {
        return <div>No blocks found</div>
    }

    return (
        <div className="card">
            <div className="card-header">
                <h3>Blockchain ({blocks.length} blocks)</h3>
            </div>
            <div className="card-body">
                {blocks
                    .slice()
                    .reverse()
                    .map((block) => (
                        <div key={block.block_index} className="block-item">
                            <div className="block-header">
                                <span className="block-index">
                                    Block #{block.block_index}
                                </span>
                                <span className="block-time">
                                    {new Date(
                                        block.timestamp * 1000
                                    ).toLocaleString()}
                                </span>
                            </div>
                            <div className="block-hash">{block.hash}</div>
                            <div className="block-transactions">
                                {block.transactions.length} transaction(s)
                            </div>
                        </div>
                    ))}
            </div>
        </div>
    )
}
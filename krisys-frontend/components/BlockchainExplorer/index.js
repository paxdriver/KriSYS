// components/BlockchainExplorer/index.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '../../services/api'
import { filterCanonicalBlocks } from '@/services/blockVerifier'
import '@/blockchain-explorer.css'

export default function BlockchainExplorer() {
    const [crisis, setCrisis] = useState(null)
    const [allBlocks, setAllBlocks] = useState([])
    const [filteredBlocks, setFilteredBlocks] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    const [searchTerm, setSearchTerm] = useState('')
    const [searchType, setSearchType] = useState('all') // 'all' | 'block' | 'transaction' | 'address'
    const [expandedBlocks, setExpandedBlocks] = useState({}) // block_index -> bool

    useEffect(() => {
        const loadData = async () => {
        setLoading(true)
        setError(null)

        try {
            const [crisisRes, chainRes] = await Promise.all([
            api.getCrisisInfo(),
            api.getBlockchain()
            ])

            const crisisData = crisisRes.data
            const blockPublicKey = crisisData.block_public_key
            const rawBlocks = chainRes.data || []

            // Only keep signature-verified blocks
            const canonicalBlocks = await filterCanonicalBlocks(
            rawBlocks,
            blockPublicKey
            )

            if (canonicalBlocks.length !== rawBlocks.length) {
            console.warn(
                `Discarded ${
                rawBlocks.length - canonicalBlocks.length
                } unverified blocks in explorer`
            )
            }

            setCrisis(crisisData)
            setAllBlocks(canonicalBlocks)
            setFilteredBlocks(canonicalBlocks)
            setExpandedBlocks({}) // start collapsed
        } catch (err) {
            console.error('Error loading explorer data:', err)
            setError('Failed to load blockchain data')
        } finally {
            setLoading(false)
        }
        }

        loadData()
    }, [])

    const handleSearch = (e) => {
        e.preventDefault()

        const term = searchTerm.trim()
        if (!term) {
        // Empty search → show entire canonical chain
        setFilteredBlocks(allBlocks)
        setExpandedBlocks({})
        return
        }

        let nextBlocks = []

        if (searchType === 'block') {
        const index = parseInt(term, 10)
        if (!Number.isNaN(index)) {
            nextBlocks = allBlocks.filter((b) => b.block_index === index)
        }
        } else if (searchType === 'transaction') {
        nextBlocks = allBlocks.filter((block) =>
            block.transactions.some((tx) =>
            String(tx.transaction_id).includes(term)
            )
        )
        } else if (searchType === 'address') {
        nextBlocks = allBlocks.filter((block) =>
            block.transactions.some((tx) => {
            if (String(tx.station_address).includes(term)) return true
            if (
                Array.isArray(tx.related_addresses) &&
                tx.related_addresses.some((addr) => String(addr).includes(term))
            ) {
                return true
            }
            return false
            })
        )
        } else {
        // 'all' (auto): simple text search across transaction_id, station_address, type_field
        const lower = term.toLowerCase()
        nextBlocks = allBlocks.filter((block) =>
            block.transactions.some((tx) => {
            const fields = [
                tx.transaction_id,
                tx.station_address,
                tx.type_field
            ]
            return fields.some((f) =>
                f ? String(f).toLowerCase().includes(lower) : false
            )
            })
        )
        }

        setFilteredBlocks(nextBlocks)
        setExpandedBlocks({})
    }

    const handleResetSearch = () => {
        setSearchTerm('')
        setSearchType('all')
        setFilteredBlocks(allBlocks)
        setExpandedBlocks({})
    }

    const toggleBlock = (blockIndex) => {
        setExpandedBlocks((prev) => ({
        ...prev,
        [blockIndex]: !prev[blockIndex]
        }))
    }

    const expandAll = () => {
        const map = {}
        filteredBlocks.forEach((b) => {
        map[b.block_index] = true
        })
        setExpandedBlocks(map)
    }

    const collapseAll = () => {
        setExpandedBlocks({})
    }

    return (
        <div className="explorer-container">
        <header className="explorer-header">
            <h1>KriSYS Blockchain Explorer</h1>

            {loading && <div>Loading crisis info...</div>}
            {error && <div className="error">{error}</div>}

            {crisis && (
            <div className="crisis-info">
                <h2>{crisis.name}</h2>
                <p>{crisis.organization}</p>

                {crisis.contact && (
                <p>
                    Contact:{' '}
                    <a href={`mailto:${crisis.contact}`}>{crisis.contact}</a>
                </p>
                )}

                {crisis.description && (
                <p>Description: {crisis.description}</p>
                )}

                {crisis.created_at && (
                <p>
                    Created:{' '}
                    {new Date(crisis.created_at).toLocaleString()}
                </p>
                )}
            </div>
            )}
        </header>

        <div className="explorer-content">
            {/* Search bar */}
            <form className="explorer-search" onSubmit={handleSearch}>
            <input
                type="text"
                className="explorer-input"
                placeholder="Search by block #, transaction ID, or address..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
            />

            <select
                className="explorer-select"
                value={searchType}
                onChange={(e) => setSearchType(e.target.value)}
            >
                <option value="all">Auto</option>
                <option value="block">Block index</option>
                <option value="transaction">Transaction ID</option>
                <option value="address">Address / Station</option>
            </select>

            <button type="submit" className="explorer-btn">
                Search
            </button>

            <button
                type="button"
                className="explorer-btn secondary"
                onClick={handleResetSearch}
                disabled={allBlocks.length === 0}
            >
                Reset
            </button>
            </form>

            {/* Expand/collapse controls */}
            <div className="explorer-controls">
            <span>
                Showing {filteredBlocks.length} block
                {filteredBlocks.length === 1 ? '' : 's'} (of{' '}
                {allBlocks.length} canonical)
            </span>
            <div className="explorer-controls-buttons">
                <button
                type="button"
                className="explorer-btn small"
                onClick={expandAll}
                disabled={filteredBlocks.length === 0}
                >
                Expand all
                </button>
                <button
                type="button"
                className="explorer-btn small"
                onClick={collapseAll}
                disabled={filteredBlocks.length === 0}
                >
                Collapse all
                </button>
            </div>
            </div>

            {/* Block list with collapsible details */}
            {loading ? (
            <div className="loading">Loading blockchain...</div>
            ) : !filteredBlocks || filteredBlocks.length === 0 ? (
            <div>No blocks found</div>
            ) : (
            <div className="card explorer-card">
                <div className="card-header">
                <h3>Blockchain</h3>
                </div>
                <div className="card-body">
                {filteredBlocks
                    .slice()
                    .reverse()
                    .map((block) => {
                    const isExpanded =
                        expandedBlocks[block.block_index] || false
                    const txCount = block.transactions.length

                    return (
                        <div
                        key={block.block_index}
                        className="block-item explorer-block"
                        >
                        <div className="block-header">
                            <div className="block-main">
                            <span className="block-index">
                                Block #{block.block_index}
                            </span>
                            <span className="block-time">
                                {new Date(
                                block.timestamp * 1000
                                ).toLocaleString()}
                            </span>
                            </div>
                            <div className="block-meta">
                            <span className="block-transactions">
                                {txCount} transaction
                                {txCount === 1 ? '' : 's'}
                            </span>
                            <button
                                type="button"
                                className="explorer-btn small"
                                onClick={() =>
                                toggleBlock(block.block_index)
                                }
                            >
                                {isExpanded ? 'Hide details' : 'View details'}
                            </button>
                            </div>
                        </div>

                        <div className="block-hash">
                            <span className="label">Hash:</span>{' '}
                            <code>{block.hash}</code>
                        </div>
                        <div className="block-hash">
                            <span className="label">Prev:</span>{' '}
                            <code>{block.previous_hash}</code>
                        </div>

                        {isExpanded && txCount > 0 && (
                            <div className="block-transactions-list">
                            {block.transactions.map((tx) => (
                                <div
                                key={tx.transaction_id}
                                className="transaction-item"
                                >
                                <div className="tx-header">
                                    <span className="tx-id">
                                    tx: {tx.transaction_id}
                                    </span>
                                    <span className="tx-type">
                                    type: {tx.type_field}
                                    </span>
                                </div>
                                <div className="tx-body">
                                    <div>
                                    station:{' '}
                                    <code>{tx.station_address}</code>
                                    </div>
                                    {Array.isArray(
                                    tx.related_addresses
                                    ) &&
                                    tx.related_addresses.length > 0 && (
                                        <div>
                                        related:{' '}
                                        {tx.related_addresses.map(
                                            (addr) => (
                                            <code
                                                key={addr}
                                                className="tx-address"
                                            >
                                                {addr}
                                            </code>
                                            )
                                        )}
                                        </div>
                                    )}
                                    <div>
                                    created:{' '}
                                    {new Date(
                                        tx.timestamp_created * 1000
                                    ).toLocaleString()}
                                    </div>
                                    <div>
                                    posted:{' '}
                                    {new Date(
                                        tx.timestamp_posted * 1000
                                    ).toLocaleString()}
                                    </div>
                                </div>
                                </div>
                            ))}
                            </div>
                        )}
                        </div>
                    )
                    })}
                </div>
            </div>
            )}
        </div>
        </div>
    )
}
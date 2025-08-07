// components/BlockchainExplorer/index.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '../../services/api'
import BlockList from './BlockList'
import WalletCreator from './WalletCreator'

export default function BlockchainExplorer() {
    const [blocks, setBlocks] = useState([])
    const [loading, setLoading] = useState(true)
    const [crisis, setCrisis] = useState(null)

    const loadData = async () => {
        try {
            setLoading(true)
            const [blocksRes, crisisRes] = await Promise.all([
                api.getBlockchain(),
                api.getCrisisInfo()
            ])
            setBlocks(blocksRes.data)
            setCrisis(crisisRes.data)
        } catch (error) {
            console.error('Error loading data:', error)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        loadData()
        const interval = setInterval(loadData, 30000)
        return () => clearInterval(interval)
    }, [])

    return (
        <div className="explorer-container">
            <header className="explorer-header">
                <h1>KriSYS Blockchain Explorer</h1>
                {crisis && (
                    <div className="crisis-info">
                        <h2>{crisis.name}</h2>
                        <p>{crisis.organization}</p>
                    </div>
                )}
            </header>
            
            <div className="explorer-content">
                <WalletCreator />
                <BlockList blocks={blocks} loading={loading} />
            </div>
        </div>
    )
}
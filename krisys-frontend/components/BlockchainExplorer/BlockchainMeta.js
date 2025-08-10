// components/BlockchainExplorer/BlockchainMeta.js
import { useState, useEffect } from 'react'
import { api } from '../../services/api'

export default function BlockchainMeta() {
    const [policy, setPolicy] = useState(null)
    const [recentAlerts, setRecentAlerts] = useState([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        loadBlockchainData()
    }, [])

    const loadBlockchainData = async () => {
        try {
            const [policyRes, blockchainRes] = await Promise.all([
                api.getCurrentPolicy(),
                api.getBlockchain()
            ])
            
            setPolicy(policyRes.data)
            
            // Extract recent alerts from blockchain
            const alerts = []
            blockchainRes.data.forEach(block => {
                block.transactions.forEach(tx => {
                    if (tx.type_field === 'alert') {
                        alerts.push(tx)
                    }
                })
            })
            
            setRecentAlerts(alerts.sort((a, b) => b.timestamp_posted - a.timestamp_posted).slice(0, 3))
            
        } catch (error) {
            console.error('Failed to load blockchain data:', error)
        } finally {
            setLoading(false)
        }
    }

    if (loading) {
        return <div>Loading blockchain metadata...</div>
    }

    return (
        <div className="blockchain-meta">
            {policy && (
                <div className="policy-info">
                    <h1>{policy.name}</h1>
                    <div className="policy-details">
                        <span>ID: {policy.id}</span>
                        <span>Org: {policy.organization}</span>
                        <span>Contact: {policy.contact}</span>
                    </div>
                    <p>{policy.description}</p>
                </div>
            )}
            
            {recentAlerts.length > 0 && (
                <div className="recent-alerts">
                    <h3>Recent Alerts</h3>
                    {recentAlerts.map(alert => (
                        <div key={alert.transaction_id} className="alert-item">
                            <div>{alert.message_data}</div>
                            <small>{new Date(alert.timestamp_posted * 1000).toLocaleString()}</small>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
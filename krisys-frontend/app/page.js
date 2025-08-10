// app/page.js
'use client'
import { useState } from 'react'
import BlockchainMeta from '../components/BlockchainExplorer/BlockchainMeta'
import WalletCreator from '../components/BlockchainExplorer/WalletCreator'
import BlockList from '../components/BlockchainExplorer/BlockList'
import DevTools from '../components/DevTools'
import '../styles/landing.css'
import '../styles/wallet_dashboard.css' // For card styles

export default function LandingPage() {
    const [refreshTrigger, setRefreshTrigger] = useState(0)

    const handleRefresh = () => {
        setRefreshTrigger(prev => prev + 1)
    }

    return (<>
        {process.env.NODE_ENV === 'development' && (
            <DevTools onRefresh={handleRefresh} />
        )}
        
        <div className="landing-container">
            <BlockchainMeta key={refreshTrigger} />
            
            <div className="landing-content">
                <div className="main-section">
                    <WalletCreator />
                </div>
                
                <div className="blockchain-section">
                    <BlockList key={refreshTrigger} />
                </div>
            </div>
        </div>
    </>)
}
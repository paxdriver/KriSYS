// app/page.js
'use client'
import { useState, useEffect } from 'react'
import { disasterStorage } from '@/services/localStorage'
import { api } from '@/services/api'
import BlockchainMeta from '../components/BlockchainExplorer/BlockchainMeta'
import WalletCreator from '../components/BlockchainExplorer/WalletCreator'
import BlockList from '../components/BlockchainExplorer/BlockList'
import DevTools from '../components/DevTools'
import '../styles/landing.css'
import '../styles/wallet_dashboard.css' // For card styles

export default function LandingPage() {
    const [refreshTrigger, setRefreshTrigger] = useState(0)
    const [ready, setReady] = useState(false)


    async function ensureActiveCrisis() {
        // 1) Check local pointer
        const existing = disasterStorage.getActiveCrisisId()
        if (existing) {
            return existing
        }
    
        // 2) Fetch from backend
        const res = await api.getCrisisInfo()
        const crisis = res?.data
        if (!crisis?.id) {
            throw new Error('Failed to bootstrap crisis')
        }
    
        // 3) Persist + set active
        disasterStorage.saveCrisisMetadata(crisis)
        disasterStorage.setActiveCrisisId(crisis.id)
    
        return crisis.id
    }


    // ------------ DEV NOTE: IMPORTANT --------------
    useEffect(() => {
		// DEV ONLY: cache blockchain master private key for DevTools
		if (process.env.NODE_ENV !== 'development') return

        let cancelled = false

        async function bootstrap() {
            try {
                await ensureActiveCrisis()
                if (!cancelled) {
                    setReady(true)
                }
            } catch (e) {
                console.error('Crisis bootstrap failed:', e)
            }
        }

        bootstrap()
        return () => { cancelled = true }

	}, [])
    // ------------ DEV NOTE: IMPORTANT --------------
    


    const handleRefresh = () => {
        setRefreshTrigger(prev => prev + 1)
    }

    if (!ready) return (<div>Loading ...</div>)

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
// components/DevTools/index.js
'use client'
import { useState, useEffect } from "react"
import { api } from "@/services/api"
import { disasterStorage } from "@/services/localStorage"
import './devtools.css'

export default function DevTools({ onRefresh }) {
    const [mining, setMining] = useState(false)
    const [isOnline, setIsOnline] = useState(true)
    const [queuedMessages, setQueuedMessages] = useState(0)
    const [rateLimitOverride, setRateLimitOverride] = useState(false)
    const [sending, setSending] = useState(false)

    // Update queued message count periodically
    useEffect(() => {
        const updateQueueCount = () => {
            const queue = disasterStorage.getMessageQueue()
            setQueuedMessages(queue.filter(msg => msg.status === 'pending').length)
        }

        updateQueueCount() // Initial count
        const interval = setInterval(updateQueueCount, 2000) // Update every 2 seconds
        return () => clearInterval(interval)
    }, [])

    // Check for existing rate limit override setting
    useEffect(() => {
        const override = localStorage.getItem('dev_rate_limit_override') === 'true'
        setRateLimitOverride(override)
    }, [])

    const adminProxy = async (endpoint, method = 'POST', body = null) => {
        try {
            const response = await fetch(`/api/admin?endpoint=${endpoint}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            })
            return await response.json()
        } catch (error) {
            throw new Error(`Admin request failed: ${error.message}`)
        }
    }

    const mineBlock = async () => {
        setMining(true)
        try {
            const result = await adminProxy('mine')
            if (result.message) {
                alert(`${result.message}`)
            } else {
                alert(`${result.error}`)
            }
            if (onRefresh) onRefresh()
        } catch (error) {
            alert(`Mining failed: ${error.message}`)
        } finally {
            setMining(false)
        }
    }

    const createAlert = async () => {
        const message = prompt('Enter emergency alert message:')
        if (!message) return
        
        const priority = prompt('Enter priority (1=highest, 5=lowest):', '1')
        if (!priority) return
        
        try {
            const result = await adminProxy('alert', 'POST', { 
                message, 
                priority: parseInt(priority) 
            })
            
            if (result.status === 'success') {
                alert('Emergency alert sent!')
            if (onRefresh) onRefresh()
            } else {
                alert(`Failed to send alert: ${result.error}`)
            }
        } catch (error) {
                alert(`Failed to send alert: ${error.message}`)
        }
    }

    const toggleNetworkStatus = () => {
        const newOnlineStatus = !isOnline
        setIsOnline(newOnlineStatus)
        
        if (newOnlineStatus) {
            // Going online - restore normal fetch
            if (window.originalFetch) {
                window.fetch = window.originalFetch
                delete window.originalFetch
            }
            delete window.KRISYS_OFFLINE_MODE
            alert('Network RESTORED - API calls will work normally')
        } 
        else {
            // Going offline - intercept fetch calls (only override if not already overridden)
            if (!window.originalFetch) window.originalFetch = window.fetch
            window.KRISYS_OFFLINE_MODE = true

            window.fetch = (url, options) => {
            // Allow internal Next.js API routes to work
            if (url.startsWith('/api/') || url.startsWith(window.location.origin)) {
                return window.originalFetch(url, options)
            }
            
            // Simulate failure for external API calls
            return Promise.reject(new Error('Simulated offline mode'))
        }
        }
    }

    const toggleRateLimitOverride = () => {
        const newOverride = !rateLimitOverride
        setRateLimitOverride(newOverride)
        localStorage.setItem('dev_rate_limit_override', newOverride.toString())
        
        // Also set it for API calls to pick up
        if (newOverride) {
            localStorage.setItem('dev_bypass_rate_limit', 'true')
            alert('Rate limiting DISABLED for rapid testing')
        } else {
            localStorage.removeItem('dev_bypass_rate_limit')
            alert('Rate limiting ENABLED (normal 10min intervals)')
        }
    }

    const processQueue = async () => {
        const queue = disasterStorage.getMessageQueue()

        // Only pending and not already confirmed
        const pending = queue.filter(
            (msg) =>
                msg.status === 'pending' &&
                !disasterStorage.isMessageConfirmed(msg.relay_hash)
        )
        
        if (pending.length === 0) {
            alert('No messages in queue')
            return
        }

        setSending(true)
        try {
            let sent = 0
            for (const msg of pending) {
                try {
                    await api.addTransaction(msg)
                    msg.status = 'sent'
                    msg.sentAt = Date.now()
                    sent++

                    // Mark this relay as confirmed on this device
                    if (msg.relay_hash) {
                        disasterStorage.markMessageConfirmed(msg.relay_hash, {
                            source: 'processQueue',
                            sentAt: msg.sentAt
                        })
                    }
                } catch (error) {
                    console.error('Failed to send queued message:', error)
                    // Don't break the loop, try to send remaining messages
                }
            }
            
            // Update queue in storage
            localStorage.setItem('krisys_message_queue', JSON.stringify(queue))

            // Remove any now-confirmed messages from the queue
            const newQueue = disasterStorage.pruneConfirmedFromQueue()
            setQueuedMessages(
                newQueue.filter((msg) => msg.status === 'pending').length
            )

            if (sent === pending.length) {
                alert(`Successfully sent all ${sent} queued messages!`)
            } else {
                alert(`Sent ${sent}/${pending.length} messages. ${pending.length - sent} failed.`)
            }
            
            if (onRefresh) onRefresh()
            
        } catch (error) {
            alert(`Queue processing failed: ${error.message}`)
        } finally {
            setSending(false)
        }
    }

    // DEV Utilities ->
    
    const handleExportSync = () => {
            try {
                const payload = disasterStorage.exportSyncPayload()
                console.log('KriSYS sync payload (object):', payload)
                console.log(
                    'KriSYS sync payload (JSON):',
                    JSON.stringify(payload, null, 2)
                )
                alert('Sync payload exported to console (see DevTools).')
            } catch (error) {
                console.error('Failed to export sync payload:', error)
                alert(`Failed to export sync payload: ${error.message}`)
            }
        }

    const handleImportSync = () => {
        const input = window.prompt('Paste sync payload JSON:')
        if (!input) return

        try {
            const payload = JSON.parse(input)
            console.log('Importing KriSYS sync payload:', payload)
            disasterStorage.importSyncPayload(payload)
            alert('Sync payload imported. Local queue and confirmations updated.')
            if (onRefresh) onRefresh()
        } catch (error) {
            console.error('Failed to import sync payload:', error)
            alert('Invalid JSON or import failed. See console for details.')
        }
    }

    const sendTestAlert = async () => {
        try {
            await api.adminAlert('TEST ALERT: Development emergency broadcast test', 1)
            alert('Test emergency alert sent!')
            if (onRefresh) onRefresh()
        } catch (error) {
            alert(`Test alert failed: ${error.message}`)
        }
    }
    // <-- DEV Utilities

    const clearStorage = () => {
        if (confirm('🗑️ Clear all local storage? This will log you out and clear all offline data.')) {
            disasterStorage.clearAll()
            localStorage.clear() // Clear everything including contacts
            window.location.reload()
        }
    }

    return (
        <div className="dev-tools">
            <div className="dev-tools-inner">
                <span className="dev-label">🔧 DEV TOOLS</span>
                
                <span className={`network-status ${isOnline ? 'online' : 'offline'}`}>
                    {isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}
                </span>
                
                <button 
                    className="dev-btn" 
                    onClick={mineBlock}
                    disabled={mining}
                    title="Force mine pending transactions into a new block"
                >
                    {mining ? '⏳' : '⛏️'} Mine Block
                </button>

                <button 
                    className={`dev-btn ${isOnline ? 'online' : 'offline'}`}
                    onClick={toggleNetworkStatus}
                    title="Simulate network connection/disconnection"
                >
                    {isOnline ? 'Go Offline' : 'Go Online'}
                </button>

                <button 
                    className={`dev-btn ${rateLimitOverride ? 'active' : ''}`}
                    onClick={toggleRateLimitOverride}
                    title="Override 10-minute rate limiting for rapid testing"
                >
                    {rateLimitOverride ? 'Rate Override ON' : 'Rate Limit ON'}
                </button>

                <button 
                    className="dev-btn"
                    onClick={processQueue}
                    disabled={queuedMessages === 0 || sending}
                    title="Send all queued messages (when back online)"
                >
                    {sending ? '⏳' : '📤'} Queue ({queuedMessages})
                </button>

                <button
                    className="dev-btn"
                    onClick={handleExportSync}
                    title="Log sync payload (queued + confirmed) to console"
                >
                    Export Sync
                </button>

                <button
                    className="dev-btn"
                    onClick={handleImportSync}
                    title="Import sync payload from pasted JSON"
                >
                    Import Sync
                </button>

                <button 
                    className="dev-btn test"
                    onClick={sendTestAlert}
                    title="Send test emergency alert to all wallets"
                >
                    🚨 Test Alert
                </button>

                <button 
                    className="dev-btn alert"
                    onClick={createAlert}
                    title="Create emergency alert"
                >
                    🚨 Create Alert
                </button>

                <button 
                    className="dev-btn"
                    onClick={onRefresh}
                    title="Refresh all wallet data and transactions"
                >
                    Refresh
                </button>

                <button 
                    className="dev-btn danger"
                    onClick={clearStorage}
                    title="Clear all local data and reload page"
                >
                    Reset All
                </button>
            </div>
        </div>
    )
}
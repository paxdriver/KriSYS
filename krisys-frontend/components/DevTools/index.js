// components/DevTools/index.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '@/services/api'
import { disasterStorage } from '@/services/localStorage'
import './devtools.css'

// Station URL for mesh sync and flush (local station backend)
const STATION_URL =
    process.env.NEXT_PUBLIC_STATION_URL || 'http://localhost:6001'

export default function DevTools({ onRefresh }) {
    const [mining, setMining] = useState(false)
    const [isOnline, setIsOnline] = useState(true)
    const [queuedMessages, setQueuedMessages] = useState(0)
    const [rateLimitOverride, setRateLimitOverride] = useState(false)
    const [sending, setSending] = useState(false)
    const [meshInfo, setMeshInfo] = useState(null)
    const [syncingStation, setSyncingStation] = useState(false)
    const [flushingStation, setFlushingStation] = useState(false)

    // Update queued message count periodically
    useEffect(() => {
        const updateQueueCount = () => {
            const queue = disasterStorage.getMessageQueue()
            setQueuedMessages(
                queue.filter((msg) => msg.status === 'pending').length
            )
        }

        updateQueueCount()
        const interval = setInterval(updateQueueCount, 2000)
        return () => clearInterval(interval)
    }, [])

    // Check for existing rate limit override setting
    useEffect(() => {
        const override =
            localStorage.getItem('dev_rate_limit_override') === 'true'
        setRateLimitOverride(override)
    }, [])

    // Periodically derive mesh/offline status from local storage
    useEffect(() => {
        const updateMeshInfo = () => {
            try {
                const crisis = disasterStorage.getCrisisMetadata()
                const blocks = disasterStorage.getBlockchain() || []
                const blockCount = Array.isArray(blocks)
                    ? blocks.length
                    : 0

                let firstIndex = null
                let lastIndex = null
                if (blockCount > 0) {
                    firstIndex = blocks[0].block_index
                    lastIndex =
                        blocks[blockCount - 1].block_index
                }

                const hasPrivateKey =
                    !!localStorage.getItem('krisys_private_key')

                setMeshInfo({
                    crisisId: crisis?.id || null,
                    hasBlockKey: !!crisis?.block_public_key,
                    blockCount,
                    firstIndex,
                    lastIndex,
                    hasPrivateKey
                })
            } catch (e) {
                console.error('Failed to derive mesh status:', e)
            }
        }

        updateMeshInfo()
        const interval = setInterval(updateMeshInfo, 3000)
        return () => clearInterval(interval)
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
        const mode = prompt(
            'Select action:\n1 = Broadcast emergency alert\n2 = Test station check-in',
            '1'
        )
        if (!mode) return

        // MODE 2: station check-in test (DEVELOPMENT)
        if (mode === '2') {
            const address = prompt('Enter wallet address to check in:')
            if (!address) return

            const stationChoice = prompt(
                'Select station:\n1 = STATION_001\n2 = HOSPITAL_SE_001',
                '1'
            )
            if (!stationChoice) return

            let stationId
            if (stationChoice === '1') {
                stationId = 'STATION_001'
            } else if (stationChoice === '2') {
                stationId = 'HOSPITAL_SE_001'
            } else {
                alert('Unknown station selection')
                return
            }

            const apiKey = prompt(
                `Enter API key for ${stationId} (DEV ONLY, from backend logs):`
            )
            if (!apiKey) return

            try {
                const result = await api.checkin(
                    address,
                    stationId,
                    apiKey
                )
                const data = result.data || result

                if (data.status === 'success') {
                    alert(
                        `Check-in OK:\n${data.message}\ntransaction_id: ${data.transaction_id}`
                    )
                    if (onRefresh) onRefresh()
                } else {
                    alert(
                        `Check-in failed: ${
                            data.error || JSON.stringify(data)
                        }`
                    )
                }
            } catch (error) {
                alert(`Check-in failed: ${error.message}`)
            }

            return
        }

        // DEFAULT: broadcast emergency alert
        const message = prompt('Enter emergency alert message:')
        if (!message) return

        const priority = prompt(
            'Enter priority (1=highest, 5=lowest):',
            '1'
        )
        if (!priority) return

        try {
            const result = await adminProxy('alert', 'POST', {
                message,
                priority: parseInt(priority, 10)
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

    // DEV ONLY - network status shim for testing in dev environment
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
        } else {
            // Going offline - intercept fetch calls (only override if not already overridden)
            if (!window.originalFetch) window.originalFetch = window.fetch
            window.KRISYS_OFFLINE_MODE = true

            window.fetch = (url, options) => {
                const u = typeof url === 'string' ? url : String(url)
                // Allow internal Next.js API routes to work
                if (
                    u.startsWith('/api/') ||
                    u.startsWith(window.location.origin) ||
                    u.startsWith(STATION_URL)
                ) {
                    return window.originalFetch(url, options)
                }

                // Simulate failure for external API calls (central, internet)
                return Promise.reject(
                    new Error('Simulated offline mode')
                )
            }
        }
    }

    const toggleRateLimitOverride = () => {
        const newOverride = !rateLimitOverride
        setRateLimitOverride(newOverride)
        localStorage.setItem(
            'dev_rate_limit_override',
            newOverride.toString()
        )

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

                    if (msg.relay_hash) {
                        disasterStorage.markMessageConfirmed(
                            msg.relay_hash,
                            {
                                source: 'processQueue',
                                sentAt: msg.sentAt
                            }
                        )
                    }
                } catch (error) {
                    console.error(
                        'Failed to send queued message:',
                        error
                    )
                }
            }

            localStorage.setItem(
                'krisys_message_queue',
                JSON.stringify(queue)
            )

            const newQueue = disasterStorage.pruneConfirmedFromQueue()
            setQueuedMessages(
                newQueue.filter(
                    (msg) => msg.status === 'pending'
                ).length
            )

            if (sent === pending.length) {
                alert(`Successfully sent all ${sent} queued messages!`)
            } else {
                alert(
                    `Sent ${sent}/${pending.length} messages. ${
                        pending.length - sent
                    } failed.`
                )
            }

            if (onRefresh) onRefresh()
        } catch (error) {
            alert(`Queue processing failed: ${error.message}`)
        } finally {
            setSending(false)
        }
    }

    // Station sync: send our payload to the station, merge its response back
    const handleStationSync = async () => {
        setSyncingStation(true)
        try {
            const payload = disasterStorage.exportSyncPayload()
            console.log(
                'Sending sync payload to station:',
                payload
            )

            const res = await fetch(`${STATION_URL}/mesh/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })

            if (!res.ok) {
                const text = await res.text()
                throw new Error(
                    `Station sync failed: ${res.status} ${text}`
                )
            }

            const stationPayload = await res.json()
            console.log(
                'Received station sync payload:',
                stationPayload
            )

            disasterStorage.importSyncPayload(stationPayload)

            alert('Station sync completed.')
            if (onRefresh) onRefresh()
        } catch (error) {
            console.error('Station sync error:', error)
            alert(`Station sync failed: ${error.message}`)
        } finally {
            setSyncingStation(false)
        }
    }

    // Station flush: ask station to push its queued messages to central
    const handleStationFlush = async () => {
        setFlushingStation(true)
        try {
            const res = await fetch(
                `${STATION_URL}/station/flush`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }
            )

            if (!res.ok) {
                const text = await res.text()
                throw new Error(
                    `Flush failed: ${res.status} ${text}`
                )
            }

            const data = await res.json()
            console.log('Station flush result:', data)

            alert(
                `Station flush: attempted ${data.attempted}, ` +
                    `success ${data.success}, failed ${data.failed}`
            )
        } catch (error) {
            console.error('Station flush error:', error)
            alert(`Station flush failed: ${error.message}`)
        } finally {
            setFlushingStation(false)
        }
    }

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
            console.error(
                'Failed to export sync payload:',
                error
            )
            alert(
                `Failed to export sync payload: ${error.message}`
            )
        }
    }

    const handleImportSync = async () => {
        const input = window.prompt('Paste sync payload JSON:')
        if (!input) return

        try {
            const payload = JSON.parse(input)
            console.log(
                'Importing KriSYS sync payload:',
                payload
            )
            disasterStorage.importSyncPayload(payload)
            alert(
                'Sync payload imported. Local queue, confirmations, and blocks updated.'
            )
            if (onRefresh) onRefresh()
        } catch (error) {
            console.error(
                'Failed to import sync payload:',
                error
            )
            alert(
                'Invalid JSON or import failed. See console for details.'
            )
        }
    }

    const sendTestAlert = async () => {
        try {
            await api.adminAlert(
                'TEST ALERT: Development emergency broadcast test',
                1
            )
            alert('Test emergency alert sent!')
            if (onRefresh) onRefresh()
        } catch (error) {
            alert(`Test alert failed: ${error.message}`)
        }
    }

    const clearStorage = () => {
        if (
            confirm(
                'Clear all local storage? This will log you out and clear all offline data.'
            )
        ) {
            disasterStorage.clearAll()
            localStorage.clear()
            window.location.reload()
        }
    }

    return (
        <div className="dev-tools">
            <div className="dev-tools-inner">
                <span className="dev-label">DEV TOOLS</span>

                <span
                    className={`network-status ${
                        isOnline ? 'online' : 'offline'
                    }`}
                >
                    {isOnline ? 'ONLINE' : 'OFFLINE'}
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
                    className={`dev-btn ${
                        isOnline ? 'online' : 'offline'
                    }`}
                    onClick={toggleNetworkStatus}
                    title="Simulate network connection/disconnection"
                >
                    {isOnline ? 'Go Offline' : 'Go Online'}
                </button>

                <button
                    className={`dev-btn ${
                        rateLimitOverride ? 'active' : ''
                    }`}
                    onClick={toggleRateLimitOverride}
                    title="Override 10-minute rate limiting for rapid testing"
                >
                    {rateLimitOverride
                        ? 'Rate Override ON'
                        : 'Rate Limit ON'}
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
                    title="Log sync payload (queued + confirmed + blocks) to console"
                >
                    Export Sync
                </button>

                <button
                    className="dev-btn"
                    onClick={handleStationSync}
                    disabled={syncingStation}
                    title={`Sync queued/confirmed state with station at ${STATION_URL}`}
                >
                    {syncingStation ? 'Syncing...' : 'Sync Station'}
                </button>

                <button
                    className="dev-btn"
                    onClick={handleStationFlush}
                    disabled={flushingStation}
                    title="Ask station to flush its queued messages to central backend"
                >
                    {flushingStation ? 'Flushing...' : 'Flush Station'}
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
                    Test Alert
                </button>

                <button
                    className="dev-btn alert"
                    onClick={createAlert}
                    title="Create emergency alert or test station check-in"
                >
                    Check-in
                </button>

                <br />
                <span style={{ margin: 'auto' }}>
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
                </span>

                {meshInfo && (
                    <div className="mesh-status">
                        <span>
                            Crisis:{' '}
                            {meshInfo.crisisId || 'unknown'}
                        </span>
                        <span>
                            Blocks:{' '}
                            {meshInfo.blockCount} (
                            {meshInfo.firstIndex ?? '-'} →{' '}
                            {meshInfo.lastIndex ?? '-'})
                        </span>
                        <span>
                            Block key:{' '}
                            {meshInfo.hasBlockKey ? 'yes' : 'no'}
                        </span>
                        <span>
                            Cached private key:{' '}
                            {meshInfo.hasPrivateKey ? 'yes' : 'no'}
                        </span>
                    </div>
                )}
            </div>
        </div>
    )
}
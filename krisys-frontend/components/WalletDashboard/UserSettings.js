// krisys-frontend/components/WalletDashboard/UserSettings.js

'use client'
import { useEffect, useState } from 'react'
import StorageMeter from './StorageMeter'
import { getStorageBreakdown } from '@/services/storageMetrics'

const STORAGE_LIMIT_KEY = 'krisys_storage_limit_bytes'
const DEFAULT_LIMIT = 4 * 1024 * 1024

export default function UserSettings() {
	const [limitBytes, setLimitBytes] = useState(DEFAULT_LIMIT)
	const [storage, setStorage] = useState(null)

	useEffect(() => {
		const saved = localStorage.getItem(STORAGE_LIMIT_KEY)
		if (saved) setLimitBytes(parseInt(saved, 10))
	}, [])

	useEffect(() => {
		localStorage.setItem(STORAGE_LIMIT_KEY, String(limitBytes))
	}, [limitBytes])

	useEffect(() => {
		const update = () => setStorage(getStorageBreakdown())
		update()
		const id = setInterval(update, 2000)
		return () => clearInterval(id)
	}, [])

	const mb = Math.round(limitBytes / (1024 * 1024))

	return (
		<div className="page">
			<div className="page-header">
				<h1 className="page-title">User Settings</h1>
			</div>

			<div className="card">
				<div className="card-header">
					<h3 className="card-title">Local Storage Usage</h3>
				</div>

				<div className="card-body">
					{storage && (
						<StorageMeter
							buckets={storage.buckets}
							totalBytes={storage.totalBytes}
							limitBytes={limitBytes}
						/>
					)}

					<div style={{ marginTop: '16px' }}>
						<label>Storage limit (MB)</label>

						<div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
							<input
								type="range"
								min={1}
								max={20}
								value={mb}
								onChange={(e) =>
									setLimitBytes(parseInt(e.target.value, 10) * 1024 * 1024)
								}
							/>

							<input
								type="number"
								min={1}
								max={20}
								value={mb}
								onChange={(e) =>
									setLimitBytes(parseInt(e.target.value, 10) * 1024 * 1024)
								}
								style={{ width: '80px' }}
							/>
						</div>

						<div style={{ fontSize: '0.75rem', marginTop: '6px', opacity: 0.7 }}>
							Used to simulate mobile storage limits. No pruning yet.
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
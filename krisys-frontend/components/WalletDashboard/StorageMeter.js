// krisys-frontend/components/WalletDashboard/StorageMeter.js
'use client'
export default function StorageMeter({ buckets, totalBytes, limitBytes }) {
	if (!limitBytes || limitBytes <= 0) return null

	const usedRatio = Math.min(totalBytes / limitBytes, 1)

	const segments = [
		{ key: 'blockchain', color: '#2563eb' },
		{ key: 'queue', color: '#16a34a' },
		{ key: 'confirmed', color: '#9333ea' },
		{ key: 'wallets', color: '#f59e0b' },
		{ key: 'keys', color: '#0d9488' },
		{ key: 'contacts', color: '#64748b' },
	]

	return (
		<div style={{ width: '100%' }}>
			<div
				style={{
					display: 'flex',
					height: '14px',
					width: '100%',
					background: '#e5e7eb',
					borderRadius: '6px',
					overflow: 'hidden',
				}}
			>
				{segments.map(({ key, color }) => {
					const bytes = buckets[key] || 0
					const pct = Math.min(bytes / limitBytes, 1) * 100

					if (pct <= 0) return null

					return (
						<div
							key={key}
							style={{
								width: `${pct}%`,
								background: color,
								transition: 'width 300ms ease',
							}}
						/>
					)
				})}

				{/* remaining space */}
				{usedRatio < 1 && (
					<div
						style={{
							flex: 1,
							background: 'transparent',
						}}
					/>
				)}
			</div>

			<div style={{ fontSize: '0.75rem', marginTop: '4px', opacity: 0.8 }}>
				{(totalBytes / (1024 * 1024)).toFixed(2)} MB /{' '}
				{(limitBytes / (1024 * 1024)).toFixed(1)} MB
			</div>
		</div>
	)
}
// krisys-frontend/components/DevTools/dev-cache-size.js
// GET SIZE OF LOCAL STORAGE
(() => {
	const bytes = Object.entries(localStorage).reduce(
		(total, [k, v]) => total + k.length + v.length,
		0
	)
	return {
		bytes,
		kb: (bytes / 1024).toFixed(2),
		mb: (bytes / (1024 * 1024)).toFixed(2),
	}
})()

// GET SIZE OF LOCAL STORAGE PER KEY
Object.entries(localStorage)
	.map(([k, v]) => ({
		key: k,
		bytes: k.length + v.length,
	}))
	.sort((a, b) => b.bytes - a.bytes)
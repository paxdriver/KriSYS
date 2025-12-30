// pages/api/admin.js
import fs from 'fs'
import path from 'path'

export default async function handler(req, res) {
  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    // Read master private key from file
    const possiblePaths = [
      path.join(process.cwd(), 'blockchain', 'master_private_key.asc'),
      path.join('/app', 'blockchain', 'master_private_key.asc'),
      path.join(process.cwd(), '..', 'blockchain', 'master_private_key.asc')
    ]

    let adminToken = null
    let usedPath = null

    for (const keyPath of possiblePaths) {
      console.log('Checking master_private_key.asc keypath at : ', keyPath, '...')
      if (fs.existsSync(keyPath)) {
        adminToken = fs.readFileSync(keyPath, 'utf8')
        usedPath = keyPath
        console.log('FOUND KEYPATH FOR DEVTOOLS COMMANDS AT: ', usedPath)
        break
      }
    }

    if (!adminToken) {
      console.error('❌ Admin key file not found in any expected location')
      return res.status(500).json({ 
          error: 'Admin key file not found',
          searchedPaths: possiblePaths
      })
    }

    // Base64 encode the PGP key for safe HTTP header transmission
    const encodedToken = Buffer.from(adminToken, 'utf8').toString('base64')

        // Extract endpoint from request
    const endpoint = req.query.endpoint
    // const backendUrl = `http://localhost:5000/admin/${endpoint}`
    const backendUrl = `http://backend:5000/admin/${endpoint}`
    
    console.log(`🔗 Forwarding ${req.method} request to: ${backendUrl}`)
    
    // Forward request to Flask with admin token
    const response = await fetch(backendUrl, {
        method: req.method,
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': encodedToken
        },
        body: req.body ? req.body : undefined
    })
    
    const data = await response.json()
    console.log(`📡 Backend response:`, data)
    
    res.status(response.status).json(data)
  } 

  catch (error) {
    console.error('❌ Admin proxy error:', error)
    res.status(500).json({ 
        error: error.message,
        details: 'Check server logs for more information'
    })
  }
}
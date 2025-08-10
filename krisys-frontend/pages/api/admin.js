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
    const privateKeyPath = path.join(process.cwd(), 'blockchain', 'master_private_key.asc')
    const adminToken = fs.readFileSync(privateKeyPath, 'utf8')
    
    // Extract endpoint from request
    const endpoint = req.query.endpoint
    const backendUrl = `http://localhost:5000/admin/${endpoint}`
    
    // Forward request to Flask with admin token
    const response = await fetch(backendUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken
      },
      body: req.body
    })
    
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}
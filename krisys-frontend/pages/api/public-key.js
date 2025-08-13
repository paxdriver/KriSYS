// pages/api/public-key.js
export default async function handler(req, res) {
  const { familyId } = req.query
  
  try {
    const response = await fetch(`${process.env.BACKEND_URL}/wallet/${familyId}/public-key`)
    const data = await response.json()
    res.status(response.status).json(data)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}
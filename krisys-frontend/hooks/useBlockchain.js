// hooks/useBlockchain.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '../services/api'

export const useBlockchain = () => {
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  
  const loadBlockchain = async () => {
    try {
      setLoading(true)
      const response = await api.getBlockchain()
      setBlocks(response.data)
    } catch (error) {
      console.error('Error loading blockchain:', error)
    } finally {
      setLoading(false)
    }
  }
  
  useEffect(() => {
    loadBlockchain()
    const interval = setInterval(loadBlockchain, 30000)
    return () => clearInterval(interval)
  }, [])
  
  return { blocks, loading, refresh: loadBlockchain }
}
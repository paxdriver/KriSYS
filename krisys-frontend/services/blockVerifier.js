// services/blockVerifier.js
import * as openpgp from 'openpgp'

function stableStringify(value) {
    if (value === null) return 'null'

    const t = typeof value

    if (t === 'string') return JSON.stringify(value)
    if (t === 'number') {
        if (!Number.isFinite(value)) return 'null'
        return String(value)
    }
    if (t === 'boolean') return value ? 'true' : 'false'

    if (Array.isArray(value)) {
        const items = value.map((v) => stableStringify(v)).join(',')
        return `[${items}]`
    }

    if (t === 'object') {
        const keys = Object.keys(value).sort()
        const pairs = keys.map((k) => {
            const v = value[k]
            return `${JSON.stringify(k)}:${stableStringify(v)}`
        })
        return `{${pairs.join(',')}}`
    }

    return 'null'
}

async function sha256Hex(text) {
    const enc = new TextEncoder()
    const bytes = enc.encode(text)

    const subtle = globalThis.crypto?.subtle
    if (subtle) {
        const digest = await subtle.digest('SHA-256', bytes)
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
    }

    // Fallback (if this ever runs in Node without WebCrypto)
    const nodeCrypto = await import('crypto')
    return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

export async function computeBlockHash(block) {
    const blockForHash = {
        block_index: block.block_index,
        timestamp: block.timestamp,
        transactions: block.transactions || [],
        previous_hash: block.previous_hash,
        nonce: block.nonce,
    }

    const canonicalJson = stableStringify(blockForHash)
    return sha256Hex(canonicalJson)
}



export async function verifyBlockSignature(block, blockPublicKeyArmored) {
    if (!block || !block.signature || !blockPublicKeyArmored) return false

    try {
        const publicKey = await openpgp.readKey({
            armoredKey: blockPublicKeyArmored,
        })

        const signature = await openpgp.readSignature({
            armoredSignature: block.signature,
        })

        // Must match Python sign_block() canonicalization (deterministic hash):
        // json.dumps({block_index, previous_hash, hash}, sort_keys=True,
        // separators=(',',':'))
        const headerObj = {
            block_index: block.block_index,
            previous_hash: block.previous_hash,
            hash: block.hash,
        }
        const headerJson = stableStringify(headerObj)

        const message = await openpgp.createMessage({ text: headerJson })

        const verificationResult = await openpgp.verify({
            message,
            signature,
            verificationKeys: publicKey,
        })

        const sig = verificationResult.signatures[0]
        if (!sig) return false

        try {
            await sig.verified
            return true
        } 
        catch {
            return false
        }
    } 
    catch (err) {
        console.error('Block signature verification failed:', err)
        return false
    }
}

export async function verifyBlockCanonical(block, blockPublicKeyArmored) {
	if (!block) return false

	try {
		const expectedHash = await computeBlockHash(block)
		if (expectedHash !== block.hash) {
			console.warn('Hash mismatch', {
				block_index: block.block_index,
				expectedHash,
				blockHash: block.hash,
			})
			return false
		}
	} catch (err) {
		console.error('Block hash recompute failed:', err)
		return false
	}

	const sigOk = await verifyBlockSignature(block, blockPublicKeyArmored)
	if (!sigOk) {
		console.warn('Signature invalid', { block_index: block.block_index })
	}
	return sigOk
}

// Return only canonical blocks (verified + linked). Stops at first invalid.
export async function filterCanonicalBlocks(blocks, blockPublicKeyArmored) {
    if (!Array.isArray(blocks) || !blockPublicKeyArmored) return []

    const sorted = [...blocks].sort((a, b) => {
        const ai = Number(a?.block_index)
        const bi = Number(b?.block_index)
        return ai - bi
    })

    const canonical = []

    for (const block of sorted) {
        const ok = await verifyBlockCanonical(block, blockPublicKeyArmored)
        if (!ok) break

        if (canonical.length === 0) {
            // Expect genesis in the full chain case
            if (block.block_index !== 0) break
            if (block.previous_hash !== '0') break
        } 
        else {
            const prev = canonical[canonical.length - 1]
            if (block.block_index !== prev.block_index + 1) break
            if (block.previous_hash !== prev.hash) break
        }

        canonical.push(block)
    }

    return canonical
}
// DEV NOTE: We treat the server’s signature as a detached PGP SIGNATURE over that exact header JSON
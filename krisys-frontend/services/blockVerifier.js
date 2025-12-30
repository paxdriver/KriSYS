// services/blockVerifier.js
import * as openpgp from 'openpgp'

export async function verifyBlockSignature(block, blockPublicKeyArmored) {
    if (!block || !block.signature || !blockPublicKeyArmored) {
        return false
    }

    try {
        const publicKey = await openpgp.readKey({
            armoredKey: blockPublicKeyArmored
        })

        const signature = await openpgp.readSignature({
            armoredSignature: block.signature
        })

        // Must exactly match Python's signed header:
        // json.dumps(
        //   {"block_index": block_index, "previous_hash": previous_hash, "hash": hash},
        //   sort_keys=True
        // )
        //
        // With sort_keys=True, keys are: block_index, hash, previous_hash.

        const headerObj = {
            block_index: block.block_index,
            hash: block.hash,
            previous_hash: block.previous_hash
        }

        const headerJson = JSON.stringify(headerObj)

        const message = await openpgp.createMessage({ text: headerJson })

        const verificationResult = await openpgp.verify({
            message,
            signature,
            verificationKeys: publicKey
        })

        const sig = verificationResult.signatures[0]
        if (!sig) return false

        try {
            await sig.verified // throws if invalid
            return true
        }
        catch { 
            return false 
        }
    }
    catch (error) {
        console.error('Block signature verification failed:', error)
        return false
    }
}

// Return only canonical blocks (those whose signatures verify)
export async function filterCanonicalBlocks(blocks, blockPublicKeyArmored) {
    if (!Array.isArray(blocks) || !blockPublicKeyArmored) return []

    const results = await Promise.all(
        blocks.map(async (block) => ({
            block,
            isVerified: await verifyBlockSignature(block, blockPublicKeyArmored)
        }))
    )

    return results.filter((r) => r.isVerified).map((r) => r.block)
}

// DEV NOTE: We treat the server’s signature as a detached PGP SIGNATURE over that exact header JSON
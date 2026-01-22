// /krisys-frontend/services/walletPublicKeyShare.js

function normalizeLineEndings(s) {
	return s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/* 

Public key share code v1 (plain text; QR-friendly): krisys:key:v1

    family_id=<familyId>
    crisis_id=<optional>
    -----BEGIN PGP PUBLIC KEY BLOCK-----
    ...
    -----END PGP PUBLIC KEY BLOCK-----

This is not a trust anchor; it’s a convenience for offline encryption of messages other people send. PGP encyrption is required for the transaction to ever get added to the blockchain and mined once the user comes back online.

*/

export function createPublicKeyShareCode({
	familyId,
	publicKeyArmored,
	crisisId = null,
}) {
	if (typeof familyId !== 'string' || !familyId.trim()) {
		throw new Error('createPublicKeyShareCode: familyId is required')
	}
	if (typeof publicKeyArmored !== 'string' || !publicKeyArmored.trim()) {
		throw new Error('createPublicKeyShareCode: publicKeyArmored is required')
	}

	const fid = familyId.trim()
	const key = normalizeLineEndings(publicKeyArmored.trim())

	// Minimal required structure check (not cryptographic validation)
	if (!key.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
		throw new Error('publicKeyArmored does not look like a PGP public key')
	}

	const lines = [
		'krisys:key:v1',
		`family_id=${fid}`,
		crisisId && typeof crisisId === 'string' ? `crisis_id=${crisisId}` : null,
		key,
	].filter(Boolean)

	return lines.join('\n')
}

export function parsePublicKeyShareCode(text) {
	if (typeof text !== 'string' || !text.trim()) {
		throw new Error('parsePublicKeyShareCode: missing text')
	}

	const raw = normalizeLineEndings(text.trim())

	// Allow pasting just a raw armored key (no wrapper)
	// In that case, we cannot know family_id, so we reject.
	if (raw.includes('BEGIN PGP PUBLIC KEY BLOCK') && !raw.startsWith('krisys:key:v1')) {
		throw new Error('Missing krisys:key:v1 header. Cannot determine family_id.')
	}

	const header = 'krisys:key:v1'
	if (!raw.startsWith(header)) {
		throw new Error('Invalid key share code prefix')
	}

	const lines = raw.split('\n')
	let familyId = null
	let crisisId = null

	for (const line of lines) {
		if (line.startsWith('family_id=')) {
			familyId = line.slice('family_id='.length).trim()
		}
		if (line.startsWith('crisis_id=')) {
			crisisId = line.slice('crisis_id='.length).trim()
		}
	}

	if (!familyId) {
		throw new Error('Key share code missing family_id')
	}

	const beginIdx = raw.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----')
	const endIdx = raw.indexOf('-----END PGP PUBLIC KEY BLOCK-----')
	if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
		throw new Error('Key share code missing armored PGP public key block')
	}

	const publicKeyArmored = raw
		.slice(beginIdx, endIdx + '-----END PGP PUBLIC KEY BLOCK-----'.length)
		.trim()

	return {
		familyId,
		crisisId: crisisId || null,
		publicKeyArmored,
	}
}
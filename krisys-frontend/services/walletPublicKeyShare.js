function normalizeLineEndings(s) {
	return s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

/*
Public key share code v1 (plain text; QR-friendly):

krisys:key:v1
family_id=<familyId>
crisis_id=<crisisId>
-----BEGIN PGP PUBLIC KEY BLOCK-----
...
-----END PGP PUBLIC KEY BLOCK-----
*/

export function createPublicKeyShareCode({
	familyId,
	publicKeyArmored,
	crisisId,
}) {
	if (typeof familyId !== 'string' || !familyId.trim()) {
		throw new Error('createPublicKeyShareCode: familyId is required')
	}
	if (typeof crisisId !== 'string' || !crisisId.trim()) {
		throw new Error('createPublicKeyShareCode: crisisId is required')
	}
	if (typeof publicKeyArmored !== 'string' || !publicKeyArmored.trim()) {
		throw new Error('createPublicKeyShareCode: publicKeyArmored is required')
	}

	const fid = familyId.trim()
	const cid = crisisId.trim()
	const key = normalizeLineEndings(publicKeyArmored.trim())

	if (!key.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
		throw new Error('publicKeyArmored does not look like a PGP public key')
	}

	return [
		'krisys:key:v1',
		`family_id=${fid}`,
		`crisis_id=${cid}`,
		key,
	].join('\n')
}

export function parsePublicKeyShareCode(text) {
	if (typeof text !== 'string' || !text.trim()) {
		throw new Error('parsePublicKeyShareCode: missing text')
	}

	const raw = normalizeLineEndings(text.trim())

	if (!raw.startsWith('krisys:key:v1')) {
		throw new Error('Invalid key share code prefix')
	}

	let familyId = null
	let crisisId = null

	for (const line of raw.split('\n')) {
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
	if (!crisisId) {
		throw new Error('Key share code missing crisis_id')
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
		crisisId,
		publicKeyArmored,
	}
}
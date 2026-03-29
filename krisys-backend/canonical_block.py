# krisys-backend/canonical_block.py
import hashlib  # used to compute SHA-256 of canonical JSON
import json  # used to build canonical JSON
from typing import Dict, Any  # typing for clearer contracts


def canonical_block_body_dict(block: Dict[str, Any]) -> Dict[str, Any]:
	"""
	Build the canonical block body dict used for hashing.

	This function expects a block dict that already contains:
		- block_index
		- timestamp
		- transactions (list of dicts)
		- previous_hash
		- nonce
	"""
	return {
		'block_index': int(block['block_index']),  # enforce int type
		'timestamp': int(block['timestamp']),  # enforce int type
		'transactions': block.get('transactions') or [],  # default to list
		'previous_hash': str(block['previous_hash']),  # enforce str type
		'nonce': int(block.get('nonce') or 0),  # enforce int type
	}


def canonical_block_body_json(block: Dict[str, Any]) -> str:
	"""
	Canonical JSON string for block body hashing.
	"""
	body = canonical_block_body_dict(block)  # build canonical body
	return json.dumps(  # return canonical JSON string
		body,
		sort_keys=True,  # deterministic key ordering
		separators=(',', ':'),  # no whitespace
		ensure_ascii=False,  # preserve UTF-8 chars
	)


def canonical_block_hash(block: Dict[str, Any]) -> str:
	"""
	Canonical SHA-256 hash of the block body JSON.
	"""
	body_json = canonical_block_body_json(block)  # canonical JSON string
	return hashlib.sha256(body_json.encode('utf-8')).hexdigest()  # hash UTF-8


def canonical_block_dict(
	block_index: int,
	timestamp: int,
	transactions: list,
	previous_hash: str,
	nonce: int,
	block_hash: str,
	signature: str | None,
) -> Dict[str, Any]:
	"""
	Canonical block dict used across HQ/station/relay storage.
	"""
	return {
		'block_index': int(block_index),  # enforce int type
		'timestamp': int(timestamp),  # enforce int type
		'transactions': transactions,  # already list of dicts
		'previous_hash': str(previous_hash),  # enforce str type
		'hash': str(block_hash),  # enforce str type
		'nonce': int(nonce),  # enforce int type
		'signature': signature,  # optional signature
	}
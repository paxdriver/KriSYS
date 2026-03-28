# krisys-backend/reconcile_local_chain.py
"""
Local Blockchain Reconciliation Utilities

This module provides deterministic, backend-only, reconciliation helper functions.

It is designed to be reused by:
	- HQ backend
	- Station server
	- Relay server

It does NOT:
	- Perform HTTP requests
	- Assume a specific DB schema
	- Mutate anything unless explicitly instructed via injected callbacks

Core Principles:
	- Validation is read-only.
	- Repair is explicit and minimal.
	- No trust of transport source.
	- Signature + hash(body) are authoritative.
"""
from typing import Callable, Optional, Dict, Any, List

# TYPE CONTRACTS (Injected Functions)

# Required injected callables:
# get_block_by_index(index: int) -> Optional[dict]
#     Returns block dict or None if not present.

# get_local_tip_index() -> int
#     Returns highest locally stored block index.

# recompute_block_hash(block: dict) -> Optional[str]
#     Deterministic SHA256 over canonical JSON body.

# verify_block_signature(block: dict) -> bool
#     Verifies detached PGP signature over canonical header.

# delete_blocks_from_index(index: int) -> None
#     Deletes blocks >= index.

# fetch_blocks_from_source(start_index: int, count: int) -> List[dict]
#     Returns sequential blocks from external source (station or HQ).

# store_block(block: dict) -> None
#     Persists a verified block.

# VALIDATION
def validate_local_chain_segment(
	get_block_by_index: Callable[[int], Optional[Dict[str, Any]]],
	get_local_tip_index: Callable[[], int],
	recompute_block_hash: Callable[[Dict[str, Any]], Optional[str]],
	verify_block_signature: Callable[[Dict[str, Any]], bool],
	start_index: int = 0,
) -> Dict[str, Any]:
	"""
	Sequentially validates local chain from start_index to tip.

	Returns:
		{
			"valid": bool,
			"first_invalid_index": Optional[int],
			"local_tip": int,
		}
	"""

	local_tip = get_local_tip_index()
	previous_hash: Optional[str] = None

	for index in range(start_index, local_tip + 1):
		block = get_block_by_index(index)

		if block is None:
			return {
				"valid": False,
				"first_invalid_index": index,
				"local_tip": local_tip,
			}

		# Recompute hash(body)
		expected_hash = recompute_block_hash(block)
		if not expected_hash or expected_hash != block.get("hash"):
			return {
				"valid": False,
				"first_invalid_index": index,
				"local_tip": local_tip,
			}

		# Verify signature(header)
		if not verify_block_signature(block):
			return {
				"valid": False,
				"first_invalid_index": index,
				"local_tip": local_tip,
			}

		# Verify linkage
		if index > 0:
			if block.get("previous_hash") != previous_hash:
				return {
					"valid": False,
					"first_invalid_index": index,
					"local_tip": local_tip,
				}

		previous_hash = block.get("hash")

	return {
		"valid": True,
		"first_invalid_index": None,
		"local_tip": local_tip,
	}


# REPAIR
def repair_local_chain_from(
	first_invalid_index: int,
	get_block_by_index: Callable[[int], Optional[Dict[str, Any]]],
	get_local_tip_index: Callable[[], int],
	recompute_block_hash: Callable[[Dict[str, Any]], Optional[str]],
	verify_block_signature: Callable[[Dict[str, Any]], bool],
	delete_blocks_from_index: Callable[[int], None],
	fetch_blocks_from_source: Callable[[int, int], List[Dict[str, Any]]],
	store_block: Callable[[Dict[str, Any]], None],
	safety_depth: int = 2,
	fetch_window: int = 50,
) -> Dict[str, Any]:
	"""
	Repairs local chain starting at first_invalid_index.

	Algorithm:
		1. Determine anchor_start = max(0, first_invalid_index - safety_depth)
		2. Validate local anchor blocks (0..anchor_start)
		3. Roll back blocks >= first_invalid_index
		4. Fetch suffix starting at anchor_start
		5. Fully validate fetched sequence
		6. Store only blocks >= first_invalid_index

	Returns:
		{
			"repaired": bool,
			"rolled_back_from": int,
			"new_tip": int,
		}
	"""

	local_tip = get_local_tip_index()

	# STEP 1 — Determine safe anchor
	anchor_start = max(0, first_invalid_index - safety_depth)

	# STEP 2 — Validate local anchor region (protect against corrupt N-1 or N-2)
	previous_hash: Optional[str] = None

	for index in range(0, anchor_start + 1):
		block = get_block_by_index(index)

		if block is None:
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": local_tip,
			}

		expected_hash = recompute_block_hash(block)
		if not expected_hash or expected_hash != block.get("hash"):
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": local_tip,
			}

		if not verify_block_signature(block):
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": local_tip,
			}

		if index > 0:
			if block.get("previous_hash") != previous_hash:
				return {
					"repaired": False,
					"rolled_back_from": first_invalid_index,
					"new_tip": local_tip,
				}

		previous_hash = block.get("hash")

	# STEP 3 — Roll back minimally
	delete_blocks_from_index(first_invalid_index)

	# STEP 4 — Fetch candidate suffix
	fetched_blocks = fetch_blocks_from_source(anchor_start, fetch_window)

	if not fetched_blocks:
		return {
			"repaired": False,
			"rolled_back_from": first_invalid_index,
			"new_tip": get_local_tip_index(),
		}

	# Ensure fetched_blocks sorted
	fetched_blocks = sorted(
		fetched_blocks,
		key=lambda b: b.get("block_index", -1),
	)

	# STEP 5 — Validate fetched chain continuity
	previous_hash = None

	for block in fetched_blocks:
		index = block.get("block_index")

		if index is None:
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": get_local_tip_index(),
			}

		expected_hash = recompute_block_hash(block)
		if not expected_hash or expected_hash != block.get("hash"):
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": get_local_tip_index(),
			}

		if not verify_block_signature(block):
			return {
				"repaired": False,
				"rolled_back_from": first_invalid_index,
				"new_tip": get_local_tip_index(),
			}

		if previous_hash is not None:
			if block.get("previous_hash") != previous_hash:
				return {
					"repaired": False,
					"rolled_back_from": first_invalid_index,
					"new_tip": get_local_tip_index(),
				}

		previous_hash = block.get("hash")

	# STEP 6 — Store validated blocks beyond rollback point
	for block in fetched_blocks:
		if block.get("block_index") >= first_invalid_index:
			store_block(block)

	return {
		"repaired": True,
		"rolled_back_from": first_invalid_index,
		"new_tip": get_local_tip_index(),
	}
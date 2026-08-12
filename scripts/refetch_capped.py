#!/usr/bin/env python3
"""Re-fetch wallets whose trade history hit the API's 5,500-row offset cap.

Uses the timestamp-cursor pagination now in fetch_data.fetch_wallet.
"""
import glob
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

import fetch_data


def needs_refetch(raw):
    trades = raw.get("trades", [])
    if len(trades) < 5400:
        return False
    oldest = min(t["timestamp"] for t in trades)
    return oldest > raw["cutoff"] + 3600  # capped before reaching the window edge


def main():
    todo = []
    for path in glob.glob(os.path.join(fetch_data.OUT_DIR, "wallet_*.json")):
        with open(path) as f:
            raw = json.load(f)
        if needs_refetch(raw):
            todo.append(raw["proxyWallet"])
    print(f"Re-fetching {len(todo)} capped wallets")

    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(fetch_data.fetch_wallet, w): w for w in todo}
        for fut in as_completed(futs):
            addr = futs[fut]
            try:
                data = fut.result()
            except Exception as e:  # noqa: BLE001
                print(f"  FAIL {addr}: {e}")
                continue
            out = os.path.join(fetch_data.OUT_DIR, f"wallet_{addr}.json")
            with open(out, "w") as f:
                json.dump(data, f)
            done += 1
            print(f"  [{done}/{len(todo)}] {addr}: {len(data['trades'])} trades"
                  f"{' TRUNCATED' if data['truncated'] else ''}")


if __name__ == "__main__":
    main()

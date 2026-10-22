"""Install the cancellation main-process patch without rebuilding the frontend.

Run only while Unhush is stopped. Existing frontend customizations are preserved.
"""

import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
import time


def install(archive: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    replacements = {
        "electron/main.cjs": (root / "electron/main.cjs").read_bytes(),
        "electron/dictationCancellation.cjs": (
            root / "electron/dictationCancellation.cjs"
        ).read_bytes(),
    }
    raw = archive.read_bytes()
    _, header_size, _, json_size = struct.unpack("<4I", raw[:16])
    tree = json.loads(raw[16 : 16 + json_size])
    base = 8 + header_size
    chunks = []
    offset = 0
    installed = set()

    for name in replacements:
        node = tree
        for part in name.split("/"):
            node = node.setdefault("files", {}).setdefault(part, {})

    def walk(node, prefix=""):
        nonlocal offset
        for name, entry in node.get("files", {}).items():
            full = prefix + name
            if "files" in entry:
                walk(entry, full + "/")
                continue
            if full in replacements:
                assert not entry.get("unpacked"), "Cannot patch an unpacked entry"
                data = replacements[full]
                installed.add(full)
                block_size = entry.get("integrity", {}).get("blockSize", 4194304)
                entry["integrity"] = {
                    "algorithm": "SHA256",
                    "hash": hashlib.sha256(data).hexdigest(),
                    "blockSize": block_size,
                    "blocks": [
                        hashlib.sha256(data[i : i + block_size]).hexdigest()
                        for i in range(0, len(data), block_size)
                    ],
                }
            elif "offset" in entry and not entry.get("unpacked"):
                start = base + int(entry["offset"])
                data = raw[start : start + entry["size"]]
            else:
                continue
            entry["offset"] = str(offset)
            entry["size"] = len(data)
            chunks.append(data)
            offset += len(data)

    walk(tree)
    assert installed == replacements.keys()
    metadata = json.dumps(tree, separators=(",", ":"), ensure_ascii=False).encode()
    payload = struct.pack("<I", len(metadata)) + metadata + b"\0" * (-len(metadata) % 4)
    header = struct.pack("<I", len(payload)) + payload
    backup = archive.with_name(f"app.asar.before-cancellation-{time.time_ns()}")
    shutil.copy2(archive, backup)
    temporary = archive.with_suffix(".asar.tmp")
    temporary.write_bytes(struct.pack("<II", 4, len(header)) + header + b"".join(chunks))
    temporary.chmod(archive.stat().st_mode)
    temporary.replace(archive)
    print(f"Cancellation patch installed. Backup: {backup}")


if __name__ == "__main__":
    install(Path(sys.argv[1]))

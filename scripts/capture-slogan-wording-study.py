#!/usr/bin/env python3
"""Offline comparison only; reuse the locked brand adapter without changing home."""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("capture-slogan-v2.py"))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
results = []
for literal in ("TheFirstAgentArtwork", "The_First_Agent_Artwork", "The First Agent Artwork"):
    capture.DISPLAY_TEXT = literal
    result = capture.capture()
    if " " in literal:
        words = []
        for word in literal.split():
            capture.DISPLAY_TEXT = word
            words.append(capture.capture())
        result["words"] = words
    else:
        result["words"] = []
    results.append(result)
print("// Generated offline by scripts/capture-slogan-wording-study.py; do not edit paths.")
print("export const SLOGAN_WORDING_CANDIDATES = " + json.dumps(results, separators=(",", ":")) + " as const;")

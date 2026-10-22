# -*- coding: utf-8 -*-
"""Flat-color background key for Minimax_00054 (solid blue backdrop, no
character). Unlike the green-screen character videos, this background is a
razor-flat, near-constant color (measured BGR ~(229,108,0), varying <1.2
across the whole 55-frame clip at guaranteed-empty corners) and the on-screen
tech/UI effects are themselves cyan-ish - close enough in HUE to the blue
background (8-18 degrees apart) that a hue-based key (the approach used for
the character videos) would not have enough margin and would eat into the
effects again. Since the background here has essentially zero variation and
the transition into every effect shape is a sharp 2-4px edge (verified by
sampling a scanline from background into an icon), a plain Euclidean color
distance from the measured flat reference cleanly separates the two: real
background sits at distance 0-2, even the faintest tapering edge of an
effect's own glow already sits at distance 16+, main effect colors sit at
45+. No despill is applied: because the background's own green channel is
far from zero (BGR ~(229,108,0), not a pure primary), the standard
"cap-to-average-of-other-two-channels" spill formula assumes a green/red-free
screen and instead painted a false green fringe onto every edge - the sharp
(2-4px) transition here doesn't carry meaningful spill to begin with, so
alpha-only keying without despill gave the cleanest result.
"""
import sys
import cv2
import numpy as np
from PIL import Image

REF_BGR = np.array([229.4, 108.0, 0.3], dtype=np.float32)
LOW = 6.0
HIGH = 20.0


def key_frame(bgr_path: str, out_path: str):
    img = cv2.imread(bgr_path, cv2.IMREAD_COLOR).astype(np.float32)
    dist = np.linalg.norm(img - REF_BGR, axis=2)

    t = np.clip((dist - LOW) / (HIGH - LOW), 0, 1)
    alpha = t * t * (3 - 2 * t)

    b, g, r = img[:, :, 0], img[:, :, 1], img[:, :, 2]

    out_rgb = np.stack([r, g, b], axis=-1)
    out = np.dstack([out_rgb, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)


if __name__ == "__main__":
    key_frame(sys.argv[1], sys.argv[2])

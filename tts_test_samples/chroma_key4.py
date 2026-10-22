# -*- coding: utf-8 -*-
"""HSV chroma key v4: v3 tightened the alpha falloff curve but kept the same
50-degree-wide hue tolerance as v2. Direct pixel sampling showed the special
effect graphics are themselves colored very close to the screen's green hue
(measured ~144-150 vs the screen's ~120-126) and heavily saturated (0.6-0.75),
so that wide tolerance scored them as "greenness" too and the sharper v3 curve
then snapped most of them to fully transparent. The actual chroma-key
background was measured to sit tightly at hue 120-126 / sat 0.95-1.0 across
the frame, so narrowing the hue tolerance to ~15 degrees cleanly separates
"is the screen" from "is a greenish effect that merely resembles it" - the
effect's hue distance (24-30) falls outside the tolerance and keeps full
alpha, while genuine background and its immediate blend stay inside it.
Despill (color-only, not alpha) still runs near the real background seam to
clean up any faint residual tint on edge pixels without touching their alpha.
"""
import sys
import cv2
import numpy as np
from PIL import Image

TARGET_HUE = 120
HUE_TOL = 15
LOW = 0.15
HIGH = 0.40


def key_frame(bgr_path: str, out_path: str):
    img = cv2.imread(bgr_path, cv2.IMREAD_COLOR)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[:, :, 0] * 2, hsv[:, :, 1] / 255.0, hsv[:, :, 2] / 255.0

    hue_dist = np.minimum(np.abs(h - TARGET_HUE), 360 - np.abs(h - TARGET_HUE))
    hue_score = np.clip(1 - hue_dist / HUE_TOL, 0, 1)
    sat_score = np.clip(s / 0.25, 0, 1)
    greenness = hue_score * sat_score

    t = np.clip((greenness - LOW) / (HIGH - LOW), 0, 1)
    smooth = t * t * (3 - 2 * t)
    alpha = 1 - smooth

    b, g, r = img[:, :, 0].astype(np.float32), img[:, :, 1].astype(np.float32), img[:, :, 2].astype(np.float32)
    background_like = (alpha < 0.5).astype(np.uint8) * 255
    near_seam = cv2.dilate(background_like, np.ones((7, 7), np.uint8), iterations=1) > 0
    cap = (r + b) / 2
    g_desp = np.where(near_seam & (g > cap), cap, g)

    out_rgb = np.stack([r, g_desp, b], axis=-1)
    out = np.dstack([out_rgb, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)


if __name__ == "__main__":
    key_frame(sys.argv[1], sys.argv[2])

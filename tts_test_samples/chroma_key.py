# -*- coding: utf-8 -*-
"""HSV-based green screen chroma key with soft edges and spill suppression.
Keys out saturated green background while preserving character + light-colored
special effects (which have low saturation, so they won't be mistaken for the
green background).
"""
import sys
import cv2
import numpy as np
from PIL import Image

TARGET_HUE = 120  # pure green in OpenCV's 0-179 hue range is 60; we use 0-360 below
SAT_MIN = 0.35  # only consider pixels reasonably saturated as "possibly background"


def key_frame(bgr_path: str, out_path: str):
    img = cv2.imread(bgr_path, cv2.IMREAD_COLOR)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, s, v = hsv[:, :, 0] * 2, hsv[:, :, 1] / 255.0, hsv[:, :, 2] / 255.0  # h -> 0-360

    hue_dist = np.minimum(np.abs(h - TARGET_HUE), 360 - np.abs(h - TARGET_HUE))

    # "greenness" = how strongly a pixel looks like saturated green background.
    # Falls off smoothly with hue distance and low saturation, so white/light
    # effects (low saturation) and non-green foreground colors stay untouched.
    hue_score = np.clip(1 - hue_dist / 40, 0, 1)
    sat_score = np.clip((s - SAT_MIN) / (1 - SAT_MIN), 0, 1)
    greenness = hue_score * sat_score

    alpha = np.clip(1 - greenness * 1.4, 0, 1)  # *1.4 pushes core background fully to 0

    b, g, r = img[:, :, 0].astype(np.float32), img[:, :, 1].astype(np.float32), img[:, :, 2].astype(np.float32)
    # Green-spill suppression on partially-keyed edge pixels: cap green channel
    # to not exceed the average of red/blue (standard greenscreen despill).
    edge_mask = (alpha > 0.02) & (alpha < 0.98)
    cap = (r + b) / 2
    g_desp = np.where(edge_mask & (g > cap), cap, g)

    out_rgb = np.stack([r, g_desp, b], axis=-1)
    out = np.dstack([out_rgb, alpha * 255]).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)


if __name__ == "__main__":
    key_frame(sys.argv[1], sys.argv[2])

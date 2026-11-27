"""
Is the plastic the boat's camera sees the SAME piece the drone found?

The drone's AI sends, with each find, a small crop of the item as the drone
saw it (the reference image), its class and its confidence. Near the GPS
point the boat's camera may see several things: the item itself, other
rubbish, a leaf, a reflection. Each candidate is scored against the target:

    score = W_LOOK  x appearance  (colour signature of the crop vs the reference)
          + W_CLASS x class       (same kind of plastic?)
          + W_CONF  x detector    (how sure the boat's AI is that it is plastic)

and only candidates scoring at least `match_threshold` count as the target.

Appearance is a colour signature: the item's pixels are separated from the
water around them (the crop's border is taken as the background), and their
hue / saturation / brightness histogram is compared. It works from any
viewing angle (the drone looks straight down, the boat at a low angle from
the side), costs a few milliseconds on a Pi Zero, and needs only Pillow.

The matcher is modular: `Matcher` is the interface (`signature(image)` and
`score(target, candidate)`), `ColourMatcher` is the one used today, and
`make_matcher(cfg)` picks it from `match_method`. A learned embedding (e.g. a
small CNN run in the app) can replace it later without touching the state
machine: the app can also send a ready-made `embedding` with each candidate.

Without Pillow, or without a reference image, appearance is left out and the
class and detector score decide (weights renormalised).
"""

import base64
import binascii
import io
import logging
import math

log = logging.getLogger("boat.match")

try:
    from PIL import Image
except ImportError:                       # the matcher still works on class + score
    Image = None

W_LOOK, W_CLASS, W_CONF = 0.60, 0.30, 0.10
SIG_SIZE = 40                             # crops are reduced to this before the histogram
H_BINS, S_BINS, V_BINS = 12, 3, 3
MAX_IMAGE_BYTES = 300_000

# Class names from the drone's AI and the boat's AI are folded onto a few kinds.
_KINDS = {
    "bottle": "bottle", "pet": "bottle",
    "bag": "bag", "wrapper": "bag", "film": "bag", "sachet": "bag", "packet": "bag",
    "cup": "cup", "glass": "cup",
    "container": "container", "box": "container", "tub": "container", "can": "container",
    "foam": "foam", "styrofoam": "foam", "thermocol": "foam",
}
_UNKNOWN = {"", "trash", "plastic", "item", "object", "other", "other plastic", "debris", "litter", "waste"}


def kind(label):
    """'plastic bottle' → 'bottle'; 'trash' / '' → None (unknown)."""
    s = str(label or "").strip().lower()
    if s in _UNKNOWN:
        return None
    for word, k in _KINDS.items():
        if word in s:
            return k
    return s.replace("plastic", "").strip() or None


def class_agreement(a, b):
    """1.0 same kind, 0.6 one of them unknown, 0.15 clearly different."""
    ka, kb = kind(a), kind(b)
    if ka is None or kb is None:
        return 0.6
    return 1.0 if ka == kb else 0.15


def decode_b64(data):
    """A base64 JPEG/PNG (optionally a data: URL) → bytes, or None."""
    if not data:
        return None
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    s = str(data)
    if s.startswith("data:"):
        s = s.split(",", 1)[-1]
    try:
        raw = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return None
    return raw


def open_image(raw, reduce_to=None):
    """JPEG/PNG bytes → RGB image. `reduce_to` (w, h): decode a JPEG at reduced
    scale straight away (JPEG DCT scaling — a 1280x720 frame in a few ms)."""
    if Image is None or not raw:
        return None
    try:
        img = Image.open(io.BytesIO(raw))
        if reduce_to and img.format == "JPEG":
            img.draft("RGB", reduce_to)
        return img.convert("RGB")
    except Exception:                     # corrupt / unsupported image
        return None


class Matcher:
    """The interface. `signature` turns an image into something `similarity` compares."""

    name = "none"

    def signature(self, img):
        return None

    def similarity(self, sig_a, sig_b):
        return None

    def score(self, ref_sig, ref_class, cand_sig, cand_class, cand_conf):
        """(score 0..1, parts). Parts that can't be judged are left out and the
        remaining weights renormalised."""
        parts = {"class": class_agreement(ref_class, cand_class)}
        if cand_conf is not None:
            try:
                parts["detector"] = max(0.0, min(1.0, float(cand_conf)))
            except (TypeError, ValueError):
                pass
        look = self.similarity(ref_sig, cand_sig) if ref_sig is not None and cand_sig is not None else None
        if look is not None:
            parts["look"] = look
        weights = {"look": W_LOOK, "class": W_CLASS, "detector": W_CONF}
        total = sum(weights[k] for k in parts)
        s = sum(weights[k] * v for k, v in parts.items()) / total if total else 0.0
        # A clearly different-looking item never matches on class alone, and
        # two look-alikes (white bottle, white bag) the AIs call different
        # things are probably different items.
        if look is not None and look < 0.25:
            s = min(s, look + 0.2)
        if parts["class"] < 0.5:
            s *= 0.75
        return round(s, 3), {k: round(v, 3) for k, v in parts.items()}


class ColourMatcher(Matcher):
    """Foreground colour histogram (hue x saturation x brightness) + mean colour."""

    name = "colour"

    def signature(self, img):
        if img is None:
            return None
        small = img.resize((SIG_SIZE, SIG_SIZE))
        px = list(small.getdata())
        hsv = list(small.convert("HSV").getdata())
        n = SIG_SIZE
        border = [px[i] for i in range(n)] + [px[(n - 1) * n + i] for i in range(n)] \
            + [px[i * n] for i in range(n)] + [px[i * n + n - 1] for i in range(n)]
        bg = tuple(sorted(c[k] for c in border)[len(border) // 2] for k in range(3))   # median colour
        dist = [math.dist(c, bg) for c in px]
        # Foreground: clearly unlike the water around it. If the crop is all
        # item (tight box), fall back to the middle of the crop.
        fg = [i for i, d in enumerate(dist) if d > 40]
        if len(fg) < len(px) * 0.04:
            c0, c1 = n // 4, n - n // 4
            fg = [y * n + x for y in range(c0, c1) for x in range(c0, c1)]
        hist = [0.0] * (H_BINS * S_BINS * V_BINS)
        for i in fg:
            h, s, v = hsv[i]
            hb = min(H_BINS - 1, h * H_BINS // 256)
            sb = min(S_BINS - 1, s * S_BINS // 256)
            vb = min(V_BINS - 1, v * V_BINS // 256)
            if sb == 0:
                hb = 0                    # greys/whites: hue means nothing
            hist[(hb * S_BINS + sb) * V_BINS + vb] += 1
        tot = sum(hist) or 1.0
        hist = [x / tot for x in hist]
        mean = tuple(sum(px[i][k] for i in fg) / len(fg) for k in range(3))
        return {"hist": hist, "mean": mean}

    def similarity(self, a, b):
        if not a or not b:
            return None
        inter = sum(min(x, y) for x, y in zip(a["hist"], b["hist"]))       # 0..1
        mean = max(0.0, 1.0 - math.dist(a["mean"], b["mean"]) / 200.0)    # 0..1
        return max(0.0, min(1.0, 0.6 * inter + 0.4 * mean))


MATCHERS = {"colour": ColourMatcher, "color": ColourMatcher, "none": Matcher}


def make_matcher(cfg):
    m = MATCHERS.get(str(cfg.get("match_method") or "colour").lower(), ColourMatcher)()
    if Image is None and m.name != "none":
        log.warning("Pillow is not installed: plastic is matched on its class and score only "
                    "(pip install pillow, or apt install python3-pil)")
    return m


def crop_box(frame_img, box, frame_w, frame_h, pad=0.35):
    """Cut a candidate's box (in the app's frame pixels) out of a frame image
    (possibly decoded at reduced scale), with some water around it."""
    if frame_img is None:
        return None
    try:
        x1, y1, x2, y2 = (float(box[k]) for k in ("x1", "y1", "x2", "y2"))
    except (KeyError, TypeError, ValueError):
        return None
    sx, sy = frame_img.width / float(frame_w), frame_img.height / float(frame_h)
    bw, bh = (x2 - x1), (y2 - y1)
    x1, x2 = (x1 - pad * bw) * sx, (x2 + pad * bw) * sx
    y1, y2 = (y1 - pad * bh) * sy, (y2 + pad * bh) * sy
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(frame_img.width, int(math.ceil(x2))), min(frame_img.height, int(math.ceil(y2)))
    if x2 - x1 < 3 or y2 - y1 < 3:
        return None
    return frame_img.crop((x1, y1, x2, y2))

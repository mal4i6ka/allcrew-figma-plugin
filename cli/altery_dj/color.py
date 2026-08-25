"""Colour literals as they appear in text — the Python half of a two-engine pair.

Mirror of src/tokens/remap/color-literal.ts and the OKLab maths in src/tokens/color.ts. The
plugin and this CLI both rewrite colours in a repository, and a mapping that produced one
result in Figma and another here would be worse than no tool at all — so the two are locked
to shared goldens under tests/fixtures/remap/ (src/tokens/remap/rewrite.test.ts on the TS
side, tests/test_cli.py on this one). Keep them in step.

Alpha is carried through untouched everywhere: a remap moves RGB, never transparency.
"""

from __future__ import annotations

import math
import re

NAMED_COLORS = {
    "aliceblue": "F0F8FF", "antiquewhite": "FAEBD7", "aqua": "00FFFF", "aquamarine": "7FFFD4",
    "azure": "F0FFFF", "beige": "F5F5DC", "bisque": "FFE4C4", "black": "000000",
    "blanchedalmond": "FFEBCD", "blue": "0000FF", "blueviolet": "8A2BE2", "brown": "A52A2A",
    "burlywood": "DEB887", "cadetblue": "5F9EA0", "chartreuse": "7FFF00", "chocolate": "D2691E",
    "coral": "FF7F50", "cornflowerblue": "6495ED", "cornsilk": "FFF8DC", "crimson": "DC143C",
    "cyan": "00FFFF", "darkblue": "00008B", "darkcyan": "008B8B", "darkgoldenrod": "B8860B",
    "darkgray": "A9A9A9", "darkgreen": "006400", "darkgrey": "A9A9A9", "darkkhaki": "BDB76B",
    "darkmagenta": "8B008B", "darkolivegreen": "556B2F", "darkorange": "FF8C00", "darkorchid": "9932CC",
    "darkred": "8B0000", "darksalmon": "E9967A", "darkseagreen": "8FBC8F", "darkslateblue": "483D8B",
    "darkslategray": "2F4F4F", "darkslategrey": "2F4F4F", "darkturquoise": "00CED1", "darkviolet": "9400D3",
    "deeppink": "FF1493", "deepskyblue": "00BFFF", "dimgray": "696969", "dimgrey": "696969",
    "dodgerblue": "1E90FF", "firebrick": "B22222", "floralwhite": "FFFAF0", "forestgreen": "228B22",
    "fuchsia": "FF00FF", "gainsboro": "DCDCDC", "ghostwhite": "F8F8FF", "gold": "FFD700",
    "goldenrod": "DAA520", "gray": "808080", "green": "008000", "greenyellow": "ADFF2F",
    "grey": "808080", "honeydew": "F0FFF0", "hotpink": "FF69B4", "indianred": "CD5C5C",
    "indigo": "4B0082", "ivory": "FFFFF0", "khaki": "F0E68C", "lavender": "E6E6FA",
    "lavenderblush": "FFF0F5", "lawngreen": "7CFC00", "lemonchiffon": "FFFACD", "lightblue": "ADD8E6",
    "lightcoral": "F08080", "lightcyan": "E0FFFF", "lightgoldenrodyellow": "FAFAD2", "lightgray": "D3D3D3",
    "lightgreen": "90EE90", "lightgrey": "D3D3D3", "lightpink": "FFB6C1", "lightsalmon": "FFA07A",
    "lightseagreen": "20B2AA", "lightskyblue": "87CEFA", "lightslategray": "778899", "lightslategrey": "778899",
    "lightsteelblue": "B0C4DE", "lightyellow": "FFFFE0", "lime": "00FF00", "limegreen": "32CD32",
    "linen": "FAF0E6", "magenta": "FF00FF", "maroon": "800000", "mediumaquamarine": "66CDAA",
    "mediumblue": "0000CD", "mediumorchid": "BA55D3", "mediumpurple": "9370DB", "mediumseagreen": "3CB371",
    "mediumslateblue": "7B68EE", "mediumspringgreen": "00FA9A", "mediumturquoise": "48D1CC", "mediumvioletred": "C71585",
    "midnightblue": "191970", "mintcream": "F5FFFA", "mistyrose": "FFE4E1", "moccasin": "FFE4B5",
    "navajowhite": "FFDEAD", "navy": "000080", "oldlace": "FDF5E6", "olive": "808000",
    "olivedrab": "6B8E23", "orange": "FFA500", "orangered": "FF4500", "orchid": "DA70D6",
    "palegoldenrod": "EEE8AA", "palegreen": "98FB98", "paleturquoise": "AFEEEE", "palevioletred": "DB7093",
    "papayawhip": "FFEFD5", "peachpuff": "FFDAB9", "peru": "CD853F", "pink": "FFC0CB",
    "plum": "DDA0DD", "powderblue": "B0E0E6", "purple": "800080", "rebeccapurple": "663399",
    "red": "FF0000", "rosybrown": "BC8F8F", "royalblue": "4169E1", "saddlebrown": "8B4513",
    "salmon": "FA8072", "sandybrown": "F4A460", "seagreen": "2E8B57", "seashell": "FFF5EE",
    "sienna": "A0522D", "silver": "C0C0C0", "skyblue": "87CEEB", "slateblue": "6A5ACD",
    "slategray": "708090", "slategrey": "708090", "snow": "FFFAFA", "springgreen": "00FF7F",
    "steelblue": "4682B4", "tan": "D2B48C", "teal": "008080", "thistle": "D8BFD8",
    "tomato": "FF6347", "turquoise": "40E0D0", "violet": "EE82EE", "wheat": "F5DEB3",
    "white": "FFFFFF", "whitesmoke": "F5F5F5", "yellow": "FFFF00", "yellowgreen": "9ACD32",
}


_NAMED_BY_HEX: dict[str, str] = {}
for _name in sorted(NAMED_COLORS):
    # First name wins, so `aqua` beats `cyan` and `gray` beats `grey` — the shorter, older
    # spelling is the one CSS authors reach for.
    _NAMED_BY_HEX.setdefault(NAMED_COLORS[_name], _name)


def clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


# ---------------------------------------------------------------- hex

_HEX_RE = re.compile(r"#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b")
_FUNC_RE = re.compile(r"\b(rgba?|hsla?|hwb|oklch|oklab)\(\s*([^()]*)\)", re.IGNORECASE)
_NAMED_RE = re.compile(r"(?<![\w-])([a-zA-Z]{3,20})(?![\w-])")


def parse_hex(text: str):
    """`#rgb` / `#rrggbb`, with or without the hash. Returns (r, g, b) in 0…1 or None."""
    hex_text = text.strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{3}", hex_text):
        return tuple(int(char * 2, 16) / 255 for char in hex_text)
    if re.fullmatch(r"[0-9a-fA-F]{6}", hex_text):
        return tuple(int(hex_text[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return None


def format_hex(rgb) -> str:
    return "#" + "".join(f"{round(clamp01(channel) * 255):02X}" for channel in rgb[:3])


def _hex_pair(value: float) -> str:
    return f"{round(clamp01(value) * 255):02X}"


def named_color_for(rgb):
    """The CSS name for an exact colour, when one exists."""
    return _NAMED_BY_HEX.get(format_hex(rgb)[1:])


# ---------------------------------------------------------------- OKLab

def _srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(value: float) -> float:
    return value * 12.92 if value <= 0.0031308 else 1.055 * (value ** (1 / 2.4)) - 0.055


def rgb_to_oklch(rgb):
    r, g, b = (_srgb_to_linear(clamp01(channel)) for channel in rgb[:3])
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    lightness = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    chroma = math.sqrt(a * a + bb * bb)
    # Hue is meaningless at zero chroma; report 0 so gray round-trips predictably.
    hue = 0.0 if chroma < 1e-7 else (math.degrees(math.atan2(bb, a)) + 360) % 360
    return lightness, chroma, hue


def _oklch_to_linear(l: float, c: float, h: float):
    radians = math.radians(h)
    a = c * math.cos(radians)
    b = c * math.sin(radians)
    l_ = l + 0.3963377774 * a + 0.2158037573 * b
    m_ = l - 0.1055613458 * a - 0.0638541728 * b
    s_ = l - 0.0894841775 * a - 1.2914855480 * b
    l3, m3, s3 = l_**3, m_**3, s_**3
    return (
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    )


_GAMUT_EPSILON = 1e-4


def _in_gamut(linear) -> bool:
    return all(-_GAMUT_EPSILON <= channel <= 1 + _GAMUT_EPSILON for channel in linear)


def max_chroma(l: float, h: float) -> float:
    """Largest chroma that still fits in sRGB at this lightness and hue."""
    if l <= 0 or l >= 1:
        return 0.0
    low, high = 0.0, 0.4
    if _in_gamut(_oklch_to_linear(l, high, h)):
        return high
    for _ in range(28):
        mid = (low + high) / 2
        if _in_gamut(_oklch_to_linear(l, mid, h)):
            low = mid
        else:
            high = mid
    return low


def oklch_to_rgb(l: float, c: float, h: float):
    """Chroma-reduction rather than per-channel clipping, so hue and lightness survive."""
    lightness = clamp01(l)
    chroma = c
    if not _in_gamut(_oklch_to_linear(lightness, chroma, h)):
        chroma = min(chroma, max_chroma(lightness, h))
    return tuple(clamp01(_linear_to_srgb(channel)) for channel in _oklch_to_linear(lightness, chroma, h))


def delta_e(first, second) -> float:
    """Perceptual distance on the scale the plugin snaps with — ~1 is just noticeable."""
    l1, c1, h1 = rgb_to_oklch(first)
    l2, c2, h2 = rgb_to_oklch(second)
    a1, b1 = c1 * math.cos(math.radians(h1)), c1 * math.sin(math.radians(h1))
    a2, b2 = c2 * math.cos(math.radians(h2)), c2 * math.sin(math.radians(h2))
    return 100 * math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)


# ---------------------------------------------------------------- hsl / hwb

def hsl_to_rgb(h: float, s: float, l: float):
    hue = ((h % 360) + 360) % 360 / 60
    chroma = (1 - abs(2 * l - 1)) * clamp01(s)
    second = chroma * (1 - abs((hue % 2) - 1))
    if hue < 1:
        triple = (chroma, second, 0.0)
    elif hue < 2:
        triple = (second, chroma, 0.0)
    elif hue < 3:
        triple = (0.0, chroma, second)
    elif hue < 4:
        triple = (0.0, second, chroma)
    elif hue < 5:
        triple = (second, 0.0, chroma)
    else:
        triple = (chroma, 0.0, second)
    match = clamp01(l) - chroma / 2
    return tuple(channel + match for channel in triple)


def rgb_to_hsl(rgb):
    r, g, b = (clamp01(channel) for channel in rgb[:3])
    high, low = max(r, g, b), min(r, g, b)
    lightness = (high + low) / 2
    delta = high - low
    if delta < 1e-9:
        return 0.0, 0.0, lightness
    saturation = delta / (1 - abs(2 * lightness - 1))
    if high == r:
        hue = 60 * (((g - b) / delta) % 6)
    elif high == g:
        hue = 60 * ((b - r) / delta + 2)
    else:
        hue = 60 * ((r - g) / delta + 4)
    return ((hue % 360) + 360) % 360, saturation, lightness


def hwb_to_rgb(h: float, w: float, b: float):
    total = w + b
    if total >= 1:
        gray = w / total
        return gray, gray, gray
    base = hsl_to_rgb(h, 1, 0.5)
    return tuple(channel * (1 - w - b) + w for channel in base)


def rgb_to_hwb(rgb):
    hue, _, _ = rgb_to_hsl(rgb)
    return hue, min(rgb[:3]), 1 - max(rgb[:3])


# ---------------------------------------------------------------- literals

def _js_round(value: float, places: int = 4) -> float:
    """JavaScript's Math.round, not Python's.

    Python rounds halves to even and JS rounds them up, so `round(0.5)` is 0 here and 1 there.
    Every number this module writes into a file has to match the TS engine's byte for byte.
    """
    factor = 10**places
    scaled = value * factor
    return math.floor(scaled + 0.5) / factor


def _number(text: str) -> str:
    """Renders a float the way JS does: no trailing `.0`, no exponent for these ranges."""
    if text == int(text):
        return str(int(text))
    return repr(text)


def _parse_component(raw: str):
    text = raw.strip()
    if text == "":
        return None
    percent = text.endswith("%")
    try:
        value = float(text[:-1] if percent else text)
    except ValueError:
        return None
    return value, percent


def _split_arguments(body: str) -> list[str]:
    parts = body.split("/")
    head = [piece for piece in re.split(r"[\s,]+", parts[0].strip()) if piece]
    tail = ["/".join(parts[1:]).strip()] if len(parts) > 1 else []
    return head + tail


def _parse_functional(kind: str, body: str):
    parts = [_parse_component(piece) for piece in _split_arguments(body)]
    if len(parts) < 3 or any(part is None for part in parts[:3]):
        return None
    first, second, third = parts[0], parts[1], parts[2]
    fourth = parts[3] if len(parts) > 3 else None
    alpha = clamp01(fourth[0] / 100 if fourth[1] else fourth[0]) if fourth else 1.0

    if kind == "rgb":
        def channel(part):
            return clamp01(part[0] / 100 if part[1] else part[0] / 255)
        return (channel(first), channel(second), channel(third), alpha)

    def ratio(part, full):
        return part[0] / 100 if part[1] else part[0] / full

    if kind == "hsl":
        return hsl_to_rgb(first[0], ratio(second, 1), ratio(third, 1)) + (alpha,)
    if kind == "hwb":
        return hwb_to_rgb(first[0], ratio(second, 1), ratio(third, 1)) + (alpha,)
    if kind == "oklch":
        chroma = (second[0] / 100) * 0.4 if second[1] else second[0]
        return oklch_to_rgb(ratio(first, 1), chroma, third[0]) + (alpha,)

    a = (second[0] / 100) * 0.4 if second[1] else second[0]
    b = (third[0] / 100) * 0.4 if third[1] else third[0]
    chroma = math.sqrt(a * a + b * b)
    hue = 0.0 if chroma < 1e-9 else (math.degrees(math.atan2(b, a)) + 360) % 360
    return oklch_to_rgb(ratio(first, 1), chroma, hue) + (alpha,)


def _parse_hex_literal(digits: str):
    if len(digits) in (3, 6):
        rgb = parse_hex(digits)
        return (rgb + (1.0,), "hex3" if len(digits) == 3 else "hex6") if rgb else None
    short = len(digits) == 4
    if not short and len(digits) != 8:
        return None
    full = "".join(char * 2 for char in digits) if short else digits
    rgb = parse_hex(full[:6])
    if not rgb:
        return None
    return rgb + (int(full[6:8], 16) / 255,), ("hex4" if short else "hex8")


def _in_value_position(text: str, start: int, end: int) -> bool:
    """Half the CSS colour names are ordinary English words, so a keyword only counts where a
    value goes: inside a quoted string, or after a `:` on the same line. Comment lines never."""
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    quoted_tight = before in ('"', "'") and after == before

    # A name followed by a colon is a key or an argument label, never a value — `green:` in a
    # Swift `UIColor(red:green:blue:)` call, `"#f4f4f4":` in a JSON example.
    probe = end + 1 if quoted_tight else end
    while probe < len(text) and text[probe] in " \t":
        probe += 1
    if probe < len(text) and text[probe] == ":":
        return False

    if quoted_tight:
        return True

    line_start = text.rfind("\n", 0, start) + 1
    head = text[line_start:start]
    if "//" in head or head.lstrip().startswith("*"):
        return False

    # A word inside a string literal is prose too — `content: "tan looks like linen"` —
    # unless the string is exactly the word, which the tight-quotes case above accepted.
    if head.count("'") % 2 == 1 or head.count('"') % 2 == 1:
        return False

    for index in range(start - 1, line_start - 1, -1):
        character = text[index]
        if character == ":":
            return True
        if character in ";{}":
            return False
    return False


_COMMENT_RE = re.compile(r"/\*.*?\*/|<!--.*?-->", re.DOTALL)


def _comment_spans(text: str) -> list[tuple[int, int]]:
    """`/* … */` and `<!-- … -->` spans — nothing inside them is a colour to rewrite."""
    return [(match.start(), match.end()) for match in _COMMENT_RE.finditer(text)]


def find_color_literals(text: str) -> list[dict]:
    """Every colour literal in `text`, in source order."""
    found: list[dict] = []
    comments = _comment_spans(text)

    def commented(start: int) -> bool:
        return any(begin <= start < finish for begin, finish in comments)

    for match in _HEX_RE.finditer(text):
        parsed = _parse_hex_literal(match.group(1))
        if not parsed:
            continue
        rgba, notation = parsed
        found.append({"rgba": rgba, "notation": notation, "source": match.group(0),
                      "start": match.start(), "end": match.end()})

    for match in _FUNC_RE.finditer(text):
        name = match.group(1).lower()
        kind = "rgb" if name.startswith("rgb") else "hsl" if name.startswith("hsl") else name
        rgba = _parse_functional(kind, match.group(2))
        if not rgba:
            continue
        found.append({"rgba": rgba, "notation": kind, "source": match.group(0),
                      "start": match.start(), "end": match.end()})

    for match in _NAMED_RE.finditer(text):
        hex_value = NAMED_COLORS.get(match.group(1).lower())
        if hex_value is None:
            continue
        if not _in_value_position(text, match.start(), match.end()):
            continue
        rgb = parse_hex(hex_value)
        if not rgb:
            continue
        found.append({"rgba": rgb + (1.0,), "notation": "named", "source": match.group(0),
                      "start": match.start(), "end": match.end()})

    found = [literal for literal in found if not commented(literal["start"])]
    found.sort(key=lambda literal: literal["start"])
    return found


def format_color_literal(rgba, notation: str) -> str:
    """Writes `rgba` back in the notation the original was written in."""
    opaque = rgba[3] >= 1 - 1e-6

    if notation in ("hex3", "hex6"):
        return format_hex(rgba) if opaque else format_hex(rgba) + _hex_pair(rgba[3])
    if notation in ("hex4", "hex8"):
        return format_hex(rgba) + _hex_pair(rgba[3])
    if notation == "rgb":
        parts = [str(round(clamp01(channel) * 255)) for channel in rgba[:3]]
        body = ", ".join(parts)
        return f"rgb({body})" if opaque else f"rgba({body}, {_number(_js_round(rgba[3]))})"
    if notation == "hsl":
        h, s, l = rgb_to_hsl(rgba)
        body = ", ".join([_number(_js_round(h, 2)), f"{_number(_js_round(s * 100, 2))}%",
                          f"{_number(_js_round(l * 100, 2))}%"])
        return f"hsl({body})" if opaque else f"hsla({body}, {_number(_js_round(rgba[3]))})"
    if notation == "hwb":
        h, w, b = rgb_to_hwb(rgba)
        body = f"{_number(_js_round(h, 2))} {_number(_js_round(w * 100, 2))}% {_number(_js_round(b * 100, 2))}%"
        return f"hwb({body})" if opaque else f"hwb({body} / {_number(_js_round(rgba[3]))})"
    if notation == "oklch":
        l, c, h = rgb_to_oklch(rgba)
        body = f"{_number(_js_round(l, 4))} {_number(_js_round(c, 4))} {_number(_js_round(h, 2))}"
        return f"oklch({body})" if opaque else f"oklch({body} / {_number(_js_round(rgba[3]))})"
    if notation == "oklab":
        l, c, h = rgb_to_oklch(rgba)
        radians = math.radians(h)
        body = (f"{_number(_js_round(l, 4))} {_number(_js_round(c * math.cos(radians), 4))} "
                f"{_number(_js_round(c * math.sin(radians), 4))}")
        return f"oklab({body})" if opaque else f"oklab({body} / {_number(_js_round(rgba[3]))})"

    # named: a keyword can only be replaced by a keyword when one exists for the new colour.
    name = named_color_for(rgba) if opaque else None
    if name:
        return name
    return format_hex(rgba) if opaque else format_hex(rgba) + _hex_pair(rgba[3])

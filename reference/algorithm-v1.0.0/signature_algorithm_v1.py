#!/usr/bin/env python3
"""Signature Field v1: deterministic X-handle + gr0k_raw -> scalable SVG generator."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
from pathlib import Path


ALGORITHM_VERSION = "1.0.0"
HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,15}$")
RANDOM_NAMESPACE = "signature-field"
RANDOM_SCHEME = "sha256-labeled-u53"

SETTINGS = {
    "canvas": {
        "width": 420,
        "height": 420,
        "background": "#f4e7c7",
        "ink": "#000000",
        "text_x": 210,
        "text_y": 399,
        "text_size_px": 10,
        "text_weight": 200,
        "text_font_family": "-apple-system, system-ui, Segoe UI, sans-serif",
    },
    "geometry": {
        "point_distribution": "average",
        "random_point_height": True,
        "line_start_x": 60,
        "line_end_x": 360,
        "short_text_span_denominator": 4,
        "handle_rotation_degrees": [-45, 45],
        "handle_length_px": [10, 90],
        "point_y_shift_px": [-30, 30],
        "angle_smoothing_weights": [1, 2, 1],
        "centering_samples_per_segment": 64,
    },
    "serial": {
        "nine_pulse_height_px": 40,
        "baseline_height_ratio": 0.5,
        "width_weight_range": [0.2, 1.0],
        "width_weight_scope": "digit_character",
        "y_scope": "x-handle-digits",
        "height_scope": "x-handle-digits",
        "digit_spacing": "per_digit_weight_normalized_spacing",
        "pulse_handle_spacing_factor": 0.28,
        "transition_weight_factor": 0.6,
    },
    "gr0k": {
        "default_raw": 22,
        "rotation_max_degrees": 10,
        "handle_length_max_ratio": 0.20,
        "y_max_px": 5,
        "gap_weight_max_ratio": 0.50,
        "serial_width_max_ratio": 0.20,
        "serial_height_max_ratio": 0.20,
    },
    "stroke": {
        "base_weight_px": 4,
        "uppercase_extra_weight_px": 10,
        "underscore_max_weight_px": 0.15,
        "weight_easing": "smoothstep",
    },
    "path": {
        "mode": "variable_bezier_outline",
        "coordinate_decimals": 2,
    },
}

CANONICAL_WIDTH = SETTINGS["canvas"]["width"]
CANONICAL_HEIGHT = SETTINGS["canvas"]["height"]
DEFAULT_OUTPUT_WIDTH = 1080
DEFAULT_OUTPUT_HEIGHT = 1080
SIGNATURE_CHARACTER_LIMIT = 15
REFERENCE_CURVE_SPAN = SETTINGS["geometry"]["line_end_x"] - SETTINGS["geometry"]["line_start_x"]
REFERENCE_SEGMENT_WIDTH = REFERENCE_CURVE_SPAN / (SIGNATURE_CHARACTER_LIMIT - 1)
REFERENCE_HORIZONTAL_MARGIN = SETTINGS["geometry"]["line_start_x"]


def reusable_text_curve_layout(character_count: int) -> dict[str, float | int | bool]:
    """Return the canonical layout policy for non-Signature text reuse.

    Signature generation remains limited to 1–15 X-handle characters. An
    external text-to-curve consumer may call this function for longer text.
    After 15 characters, it must keep the 15-character reference segment width
    and expand the curve span, canonical canvas width, and proportional output
    width. This prevents extra anchors from being compressed into 420 units.
    """
    if character_count < 1:
        raise ValueError("character_count must be at least 1")

    is_extended = character_count > SIGNATURE_CHARACTER_LIMIT
    curve_span = (
        REFERENCE_SEGMENT_WIDTH * (character_count - 1)
        if is_extended
        else REFERENCE_CURVE_SPAN
    )
    canonical_width = (
        curve_span + 2 * REFERENCE_HORIZONTAL_MARGIN
        if is_extended
        else CANONICAL_WIDTH
    )
    proportional_output_width = round(
        DEFAULT_OUTPUT_HEIGHT * canonical_width / CANONICAL_HEIGHT
    )
    return {
        "extended": is_extended,
        "character_count": character_count,
        "reference_character_limit": SIGNATURE_CHARACTER_LIMIT,
        "segment_width": REFERENCE_SEGMENT_WIDTH,
        "curve_span": curve_span,
        "canonical_width": canonical_width,
        "canonical_height": CANONICAL_HEIGHT,
        "proportional_output_width": proportional_output_width,
        "proportional_output_height": DEFAULT_OUTPUT_HEIGHT,
    }


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_to_unit_float(scope: dict, parameter: str) -> float:
    payload = canonical_json({
        "namespace": RANDOM_NAMESPACE,
        "parameter": parameter,
        "scheme": RANDOM_SCHEME,
        "scope": scope,
    }).encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    first_32 = int.from_bytes(digest[0:4], "big")
    next_21 = int.from_bytes(digest[4:8], "big") >> 11
    return (first_32 * 2**21 + next_21) / 2**53


def variant_signed(scope: dict, parameter: str, gr0k_raw: int) -> float:
    variant_scope = dict(scope)
    variant_scope["gr0k_raw"] = gr0k_raw
    return 2 * hash_to_unit_float(variant_scope, f"gr0k/{parameter}") - 1


def map_range(unit: float, minimum: float, maximum: float) -> float:
    return minimum + unit * (maximum - minimum)


def is_uppercase(character: str) -> bool:
    return "A" <= character <= "Z"


def is_serial_digit(character: str) -> bool:
    return "0" <= character <= "9"


def character_scope(character: str) -> dict:
    return {"kind": "x-handle-character", "value": character}


def seeded_values(characters: list[str], gr0k_raw: int) -> list[dict]:
    geometry = SETTINGS["geometry"]
    variation = SETTINGS["gr0k"]
    rotation_min, rotation_max = geometry["handle_rotation_degrees"]
    length_min, length_max = geometry["handle_length_px"]
    y_min, y_max = geometry["point_y_shift_px"]
    values = []
    for character in characters:
        scope = character_scope(character)
        incoming = map_range(hash_to_unit_float(scope, "incoming-handle-length"), length_min, length_max)
        outgoing = map_range(hash_to_unit_float(scope, "outgoing-handle-length"), length_min, length_max)
        values.append({
            "angle": math.radians(map_range(hash_to_unit_float(scope, "handle-angle"), rotation_min, rotation_max)),
            "angle_delta": math.radians(
                variant_signed(scope, "handle-angle", gr0k_raw) * variation["rotation_max_degrees"]
            ),
            "incoming_length": incoming * (
                1 + variant_signed(scope, "incoming-handle-length", gr0k_raw)
                * variation["handle_length_max_ratio"]
            ),
            "outgoing_length": outgoing * (
                1 + variant_signed(scope, "outgoing-handle-length", gr0k_raw)
                * variation["handle_length_max_ratio"]
            ),
            "canonical_y_shift": map_range(hash_to_unit_float(scope, "point-y-shift"), y_min, y_max),
            "gr0k_y_shift": (
                variant_signed(scope, "point-y", gr0k_raw) * variation["y_max_px"]
            ),
        })
    return values


def pair_gap_weight(left: str, right: str, gr0k_raw: int) -> float:
    scope = {
        "kind": "ordered-x-handle-character-pair",
        "left": character_scope(left),
        "right": character_scope(right),
    }
    canonical = 1.0  # Frozen point_distribution = average.
    return canonical * (
        1 + variant_signed(scope, "point-gap", gr0k_raw)
        * SETTINGS["gr0k"]["gap_weight_max_ratio"]
    )


def smooth_canonical_angles_with_neighbor_weights(raw: list[dict]) -> list[float]:
    count = len(raw)
    result = []
    for index, value in enumerate(raw):
        previous = raw[max(0, index - 1)]["angle"]
        following = raw[min(count - 1, index + 1)]["angle"]
        result.append((previous + 2 * value["angle"] + following) / 4 + value["angle_delta"])
    return result


def identity_point(character: str, index: int, x: float, raw: list[dict], angles: list[float]) -> dict:
    center = SETTINGS["canvas"]["width"] / 2
    y_shift = raw[index]["canonical_y_shift"] + raw[index]["gr0k_y_shift"]
    anchor = [x, center + y_shift]
    direction = [math.cos(angles[index]), math.sin(angles[index])]
    incoming_length = raw[index]["incoming_length"]
    outgoing_length = raw[index]["outgoing_length"]
    return {
        "character": character,
        "uppercase": is_uppercase(character),
        "serial_tail": False,
        "anchor": anchor,
        "incoming": [
            anchor[0] - direction[0] * incoming_length,
            anchor[1] - direction[1] * incoming_length,
        ],
        "outgoing": [
            anchor[0] + direction[0] * outgoing_length,
            anchor[1] + direction[1] * outgoing_length,
        ],
    }


def serial_point(character: str, x: float, y: float, incoming: float, outgoing: float) -> dict:
    return {
        "character": character,
        "uppercase": False,
        "serial_tail": True,
        "anchor": [x, y],
        "incoming": [x - incoming, y],
        "outgoing": [x + outgoing, y],
    }


def center_geometry(points: list[dict]) -> list[dict]:
    center = SETTINGS["canvas"]["width"] / 2
    xs = [coordinate for point in points for coordinate in (
        point["anchor"][0], point["incoming"][0], point["outgoing"][0]
    )]
    shift_x = center - (min(xs) + max(xs)) / 2
    return [shift_point_x(point, shift_x) for point in points]


def shift_point_x(point: dict, shift_x: float) -> dict:
    shifted = dict(point)
    shifted["anchor"] = [point["anchor"][0] + shift_x, point["anchor"][1]]
    shifted["incoming"] = [point["incoming"][0] + shift_x, point["incoming"][1]]
    shifted["outgoing"] = [point["outgoing"][0] + shift_x, point["outgoing"][1]]
    return shifted


def geometry_for(handle: str, gr0k_raw: int) -> list[dict]:
    characters = list(handle)
    count = len(characters)
    raw = seeded_values(characters, gr0k_raw)
    angles = smooth_canonical_angles_with_neighbor_weights(raw)
    serial_flags = [is_serial_digit(character) for character in characters]
    serial_count = sum(serial_flags)
    geometry = SETTINGS["geometry"]
    serial = SETTINGS["serial"]
    variation = SETTINGS["gr0k"]
    center = SETTINGS["canvas"]["width"] / 2
    line_span = geometry["line_end_x"] - geometry["line_start_x"]
    target_span = line_span * count / geometry["short_text_span_denominator"] if count <= 3 else line_span
    target_start = center - target_span / 2
    target_end = center + target_span / 2

    if serial_count == 0:
        if count == 1:
            return center_geometry([
                identity_point(characters[0], 0, target_start, raw, angles),
                identity_point(characters[0], 0, target_end, raw, angles),
            ])
        gap_weights = [pair_gap_weight(characters[i], characters[i + 1], gr0k_raw) for i in range(count - 1)]
        gap_total = sum(gap_weights)
        gaps = [target_span * weight / gap_total for weight in gap_weights]
        positions = [target_start]
        for gap in gaps:
            positions.append(positions[-1] + gap)
        return center_geometry([
            identity_point(character, index, positions[index], raw, angles)
            for index, character in enumerate(characters)
        ])

    digits_value = "".join(character for character in characters if is_serial_digit(character))
    digits_scope = {"kind": "x-handle-digits", "value": digits_value}
    y_min, y_max = geometry["point_y_shift_px"]
    canonical_digits_y_shift = map_range(
        hash_to_unit_float(digits_scope, "point-y-shift"), y_min, y_max
    )
    digits_y_shift = canonical_digits_y_shift + (
        variant_signed(digits_scope, "point-y", gr0k_raw) * variation["y_max_px"]
    )

    flexible_boundaries = []
    transition_boundaries = []
    for index in range(count - 1):
        if serial_flags[index] != serial_flags[index + 1]:
            transition_boundaries.append(index)
        if not serial_flags[index] and not serial_flags[index + 1]:
            flexible_boundaries.append(index)

    flexible_weights = [
        pair_gap_weight(characters[index], characters[index + 1], gr0k_raw)
        for index in flexible_boundaries
    ]
    serial_width_weights: dict[int, float] = {}
    for index, character in enumerate(characters):
        if not serial_flags[index]:
            continue
        digit_scope = character_scope(character)
        serial_width_weights[index] = map_range(
            hash_to_unit_float(digit_scope, "serial-width-weight"),
            serial["width_weight_range"][0],
            serial["width_weight_range"][1],
        ) * (
            1 + variant_signed(digit_scope, "serial-width", gr0k_raw)
            * variation["serial_width_max_ratio"]
        )
    variant_serial_max_height = serial["nine_pulse_height_px"] * (
        1 + variant_signed(digits_scope, "serial-height", gr0k_raw)
        * variation["serial_height_max_ratio"]
    )
    transition_weights = {
        boundary: serial_width_weights[boundary if serial_flags[boundary] else boundary + 1]
        * serial["transition_weight_factor"]
        for boundary in transition_boundaries
    }
    layout_weight_total = (
        sum(serial_width_weights.values())
        + sum(transition_weights.values())
        + sum(flexible_weights)
    )
    layout_scale = target_span / layout_weight_total if layout_weight_total > 0 else 0
    transition_advance = {
        boundary: weight * layout_scale
        for boundary, weight in transition_weights.items()
    }
    flexible_advance = {
        boundary: flexible_weights[weight_index] * layout_scale
        for weight_index, boundary in enumerate(flexible_boundaries)
    }
    cursor_x = target_start
    points: list[dict] = []

    for index, character in enumerate(characters):
        if serial_flags[index]:
            serial_spacing = serial_width_weights[index] * layout_scale
            pulse_handle = serial_spacing * serial["pulse_handle_spacing_factor"]
            baseline_y = center + variant_serial_max_height * serial["baseline_height_ratio"] + digits_y_shift
            if index == 0 or not serial_flags[index - 1]:
                points.append(serial_point(character, cursor_x, baseline_y, pulse_handle, pulse_handle))
            pulse_height = int(character) / 9 * variant_serial_max_height
            points.append(serial_point(
                character,
                cursor_x + serial_spacing / 2,
                baseline_y - pulse_height,
                pulse_handle,
                pulse_handle,
            ))
            cursor_x += serial_spacing
            points.append(serial_point(character, cursor_x, baseline_y, pulse_handle, pulse_handle))
            if index < count - 1 and not serial_flags[index + 1]:
                cursor_x += transition_advance[index]
        else:
            points.append(identity_point(character, index, cursor_x, raw, angles))
            if index < count - 1:
                cursor_x += transition_advance[index] if serial_flags[index + 1] else flexible_advance.get(index, 0)

    return center_geometry(points)


def cubic_point(p0: list[float], p1: list[float], p2: list[float], p3: list[float], t: float) -> list[float]:
    u = 1 - t
    return [
        u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
    ]


def cubic_derivative(p0: list[float], p1: list[float], p2: list[float], p3: list[float], t: float) -> list[float]:
    u = 1 - t
    return [
        3 * u**2 * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t**2 * (p3[0] - p2[0]),
        3 * u**2 * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t**2 * (p3[1] - p2[1]),
    ]


def smoothstep(t: float) -> float:
    return t * t * (3 - 2 * t)


def weight_at(point: dict) -> float:
    stroke = SETTINGS["stroke"]
    base = stroke["base_weight_px"]
    if point["serial_tail"]:
        return base
    if point["character"] == "_":
        return min(base, stroke["underscore_max_weight_px"])
    return base + (stroke["uppercase_extra_weight_px"] if point["uppercase"] else 0)


def width_between(current: dict, following: dict, t: float) -> float:
    start = weight_at(current)
    end = weight_at(following)
    return start + (end - start) * smoothstep(t)


def offset_point(current: dict, following: dict, t: float, side: int) -> list[float]:
    position = cubic_point(
        current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
    )
    derivative = cubic_derivative(
        current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
    )
    length = math.hypot(derivative[0], derivative[1]) or 1
    normal = [-derivative[1] / length, derivative[0] / length]
    half_width = width_between(current, following, t) / 2
    return [
        position[0] + normal[0] * half_width * side,
        position[1] + normal[1] * half_width * side,
    ]


def center_points_for_outline(points: list[dict]) -> list[dict]:
    if len(points) < 2:
        return points
    samples = SETTINGS["geometry"]["centering_samples_per_segment"]
    minimum_x = math.inf
    maximum_x = -math.inf
    for index in range(len(points) - 1):
        current, following = points[index], points[index + 1]
        for sample in range(samples + 1):
            t = sample / samples
            outer = offset_point(current, following, t, 1)
            inner = offset_point(current, following, t, -1)
            minimum_x = min(minimum_x, outer[0], inner[0])
            maximum_x = max(maximum_x, outer[0], inner[0])
    center = SETTINGS["canvas"]["width"] / 2
    shift_x = center - (minimum_x + maximum_x) / 2
    return [shift_point_x(point, shift_x) for point in points]


def cubic_through_thirds(start: list[float], one_third: list[float], two_thirds: list[float], end: list[float]):
    first = [27 * one_third[0] - 8 * start[0] - end[0], 27 * one_third[1] - 8 * start[1] - end[1]]
    second = [27 * two_thirds[0] - start[0] - 8 * end[0], 27 * two_thirds[1] - start[1] - 8 * end[1]]
    return (
        [(2 * first[0] - second[0]) / 18, (2 * first[1] - second[1]) / 18],
        [(2 * second[0] - first[0]) / 18, (2 * second[1] - first[1]) / 18],
    )


def pair(point: list[float]) -> str:
    def coordinate(value: float) -> str:
        if abs(value) < 0.005:
            value = 0
        return f"{value:.2f}"
    return f"{coordinate(point[0])},{coordinate(point[1])}"


def bezier_variable_width_path(points: list[dict]) -> str:
    if len(points) < 2:
        return ""
    last_segment = len(points) - 2
    first_outer = offset_point(points[0], points[1], 0, 1)
    path = f"M{pair(first_outer)}"
    for index in range(last_segment + 1):
        current, following = points[index], points[index + 1]
        start = offset_point(current, following, 0, 1)
        one_third = offset_point(current, following, 1 / 3, 1)
        two_thirds = offset_point(current, following, 2 / 3, 1)
        end = offset_point(current, following, 1, 1)
        control_1, control_2 = cubic_through_thirds(start, one_third, two_thirds, end)
        path += f"C{pair(control_1)} {pair(control_2)} {pair(end)}"
    final_inner = offset_point(points[last_segment], points[last_segment + 1], 1, -1)
    path += f"L{pair(final_inner)}"
    for index in range(last_segment, -1, -1):
        current, following = points[index], points[index + 1]
        start = offset_point(current, following, 0, -1)
        one_third = offset_point(current, following, 1 / 3, -1)
        two_thirds = offset_point(current, following, 2 / 3, -1)
        end = offset_point(current, following, 1, -1)
        control_1, control_2 = cubic_through_thirds(start, one_third, two_thirds, end)
        path += f"C{pair(control_2)} {pair(control_1)} {pair(start)}"
    return path + "Z"


def xml_number(value: float) -> str:
    numeric = float(value)
    return str(int(numeric)) if numeric.is_integer() else str(numeric)


def compose_sized_svg(
    path_element: str,
    displayed_handle: str,
    output_width: int,
    output_height: int,
) -> str:
    """Place unchanged canonical artwork into any requested output size."""
    if output_width <= 0 or output_height <= 0:
        raise ValueError("output width and height must be positive integers")

    canvas = SETTINGS["canvas"]
    namespace = 'xmlns="http://www.w3.org/2000/svg"'
    size_attributes = f'width="{output_width}" height="{output_height}"'

    def handle_text(x: float, y: float, size: float) -> str:
        return (
            f'<text x="{xml_number(x)}" y="{xml_number(y)}" '
            f'font-size="{xml_number(size)}" font-weight="{xml_number(canvas["text_weight"])}" '
            f'dominant-baseline="middle" fill="{canvas["ink"]}" text-anchor="middle" '
            f'font-family="{html.escape(canvas["text_font_family"], quote=True)}">'
            f'{html.escape(displayed_handle)}</text>'
        )

    if output_width * CANONICAL_HEIGHT == output_height * CANONICAL_WIDTH:
        text_element = handle_text(canvas["text_x"], canvas["text_y"], canvas["text_size_px"])
        return (
            f'<svg viewBox="0 0 {CANONICAL_WIDTH} {CANONICAL_HEIGHT}" {namespace} {size_attributes}>'
            f'<rect x="0" y="0" width="{CANONICAL_WIDTH}" height="{CANONICAL_HEIGHT}" '
            f'fill="{canvas["background"]}"/>{path_element}{text_element}</svg>'
        )

    scale = min(output_width / CANONICAL_WIDTH, output_height / CANONICAL_HEIGHT)
    offset_x = (output_width - CANONICAL_WIDTH * scale) / 2
    offset_y = (output_height - CANONICAL_HEIGHT * scale) / 2
    transform = (
        f'translate({xml_number(offset_x)} {xml_number(offset_y)}) '
        f'scale({xml_number(scale)})'
    )
    text_element = handle_text(
        output_width / 2,
        output_height * 0.95,
        canvas["text_size_px"] * scale,
    )
    return (
        f'<svg viewBox="0 0 {output_width} {output_height}" {namespace} {size_attributes}>'
        f'<rect x="0" y="0" width="{output_width}" height="{output_height}" '
        f'fill="{canvas["background"]}"/>'
        f'<g transform="{transform}">{path_element}</g>{text_element}</svg>'
    )


def generate_svg(
    handle: str,
    gr0k_raw: int,
    output_width: int = DEFAULT_OUTPUT_WIDTH,
    output_height: int = DEFAULT_OUTPUT_HEIGHT,
) -> str:
    if not HANDLE_PATTERN.fullmatch(handle):
        raise ValueError("handle must match ^[A-Za-z0-9_]{1,15}$ and must not include @")
    if not 1 <= gr0k_raw <= 100:
        raise ValueError("gr0k_raw must be an integer in [1, 100]")
    canvas = SETTINGS["canvas"]
    points = center_points_for_outline(geometry_for(handle, gr0k_raw))
    path_data = bezier_variable_width_path(points)
    path_element = f'<path d="{path_data}" fill="{canvas["ink"]}" stroke="none"/>'
    displayed_handle = "@" + handle
    return compose_sized_svg(
        path_element,
        displayed_handle,
        output_width,
        output_height,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate one deterministic Signature Field SVG.")
    parser.add_argument("handle", help="X handle without the leading @")
    parser.add_argument("--gr0k-raw", type=int, default=SETTINGS["gr0k"]["default_raw"])
    parser.add_argument("--width", type=int, default=DEFAULT_OUTPUT_WIDTH, help="Output width in pixels")
    parser.add_argument("--height", type=int, default=DEFAULT_OUTPUT_HEIGHT, help="Output height in pixels")
    parser.add_argument("--output", type=Path, help="Write SVG to this file; otherwise print raw SVG")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        svg = generate_svg(args.handle, args.gr0k_raw, args.width, args.height)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if args.output:
        args.output.write_text(svg, encoding="utf-8")
    else:
        print(svg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

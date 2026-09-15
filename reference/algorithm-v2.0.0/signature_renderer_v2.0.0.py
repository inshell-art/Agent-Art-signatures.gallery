#!/usr/bin/env python3
"""Signature Renderer v2.0.0: deterministic X-handle + MBTI -> SVG."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
from pathlib import Path


ALGORITHM_VERSION = "2.0.0"
HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9_]{1,15}$")
MBTI_PATTERN = re.compile(r"^[EI][SN][TF][JP]$")
RANDOM_NAMESPACE = "signature-field"
RANDOM_SCHEME = "sha256-labeled-u53"

CANONICAL_WIDTH = 420
CANONICAL_HEIGHT = 420
CANONICAL_CENTER = 210
DEFAULT_OUTPUT_WIDTH = 1080
DEFAULT_OUTPUT_HEIGHT = 1080

LIGHT_COLOR = "#f4e7c7"
DARK_COLOR = "#000000"

SHARED_SETTINGS = {
    "curve_span_px": 300,
    "short_text_span_denominator": 4,
    "stroke_weight_px": 5,
    "uppercase_extra_weight_px": 10,
    "digit_nine_height_px": 60,
    "equal_digit_width_weight": 1.0,
    "digit_baseline_height_ratio": 0.5,
    "digit_transition_weight_factor": 0.6,
    "underscore_stroke_weight_px": 0,
    "underscore_width_weight_range": [1.0, 2.0],
    "underscore_point_y_shift_px": [0, 50],
    "centering_samples_per_segment": 64,
    "coordinate_decimals": 2,
    "sampled_outline_target_samples": 240,
    "sampled_outline_min_samples_per_segment": 8,
    "sampled_outline_max_samples_per_segment": 32,
    "text_x": 210,
    "text_y": 399,
    "text_size_px": 10,
    "text_weight": 200,
    "text_font_family": "-apple-system, system-ui, Segoe UI, sans-serif",
}

MBTI_POLES = {
    "E": {
        "background": LIGHT_COLOR,
        "ink": DARK_COLOR,
    },
    "I": {
        "background": DARK_COLOR,
        "ink": LIGHT_COLOR,
    },
    "S": {
        "handle_rotation_degrees": [-180, 180],
        "handle_length_px": [10, 40],
        "neighbor_smoothing": 0.10,
        "handle_balance": 0.10,
        "digit_pulse_handle_spacing_factor": 0.10,
    },
    "N": {
        "handle_rotation_degrees": [-180, 180],
        "handle_length_px": [10, 120],
        "neighbor_smoothing": 0.50,
        "handle_balance": 0.50,
        "digit_pulse_handle_spacing_factor": 0.30,
    },
    "T": {
        "path_mode": "variable_sampled_outline",
        "outline_command": "L",
    },
    "F": {
        "path_mode": "variable_bezier_outline",
        "outline_command": "C",
    },
    "J": {
        "point_distribution": "average",
        "gap_weight_range": [1.0, 1.0],
        "point_y_shift_px": [-20, 20],
        "point_y_contrast_exponent": 1.0,
    },
    "P": {
        "point_distribution": "random",
        "gap_weight_range": [0.45, 1.55],
        "point_y_shift_px": [-40, 40],
        "point_y_contrast_exponent": 3.0,
    },
}


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_to_unit_float(scope: dict, parameter: str) -> float:
    """Return the first 53 SHA-256 bits as a deterministic value in [0, 1)."""
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


def map_range(unit_value: float, minimum: float, maximum: float) -> float:
    return minimum + unit_value * (maximum - minimum)


def profile_for_mbti(mbti_type: str) -> dict:
    mbti_type = mbti_type.upper()
    if not MBTI_PATTERN.fullmatch(mbti_type):
        raise ValueError("mbti must match ^[EI][SN][TF][JP]$")

    energy = MBTI_POLES[mbti_type[0]]
    information = MBTI_POLES[mbti_type[1]]
    decision = MBTI_POLES[mbti_type[2]]
    rhythm = MBTI_POLES[mbti_type[3]]
    return {
        "type": mbti_type,
        "background": energy["background"],
        "ink": energy["ink"],
        "curve_span": SHARED_SETTINGS["curve_span_px"],
        "base_weight": SHARED_SETTINGS["stroke_weight_px"],
        "uppercase_extra_weight": SHARED_SETTINGS["uppercase_extra_weight_px"],
        "serial_max_height": SHARED_SETTINGS["digit_nine_height_px"],
        "serial_width_base": SHARED_SETTINGS["equal_digit_width_weight"],
        "rotation_range": information["handle_rotation_degrees"],
        "handle_length_range": information["handle_length_px"],
        "neighbor_smoothing": information["neighbor_smoothing"],
        "handle_balance": information["handle_balance"],
        "serial_pulse_handle_factor": information["digit_pulse_handle_spacing_factor"],
        "path_mode": decision["path_mode"],
        "outline_command": decision["outline_command"],
        "point_distribution": rhythm["point_distribution"],
        "gap_range": rhythm["gap_weight_range"],
        "y_range": rhythm["point_y_shift_px"],
        "y_contrast": rhythm["point_y_contrast_exponent"],
        "underscore_width_range": SHARED_SETTINGS["underscore_width_weight_range"],
        "underscore_y_range": SHARED_SETTINGS["underscore_point_y_shift_px"],
    }


def map_point_y(unit_value: float, profile: dict) -> float:
    if profile["y_contrast"] <= 1:
        return map_range(unit_value, *profile["y_range"])

    signed_unit = unit_value * 2 - 1
    magnitude = abs(signed_unit)
    raised_magnitude = magnitude ** profile["y_contrast"]
    raised_inverse = (1 - magnitude) ** profile["y_contrast"]
    contrasted_magnitude = raised_magnitude / (raised_magnitude + raised_inverse)
    extent = max(abs(profile["y_range"][0]), abs(profile["y_range"][1]))
    sign = -1 if signed_unit < 0 else 1 if signed_unit > 0 else 0
    return sign * extent * contrasted_magnitude


def is_uppercase(character: str) -> bool:
    return "A" <= character <= "Z"


def is_serial_digit(character: str) -> bool:
    return "0" <= character <= "9"


def character_scope(character: str) -> dict:
    return {"kind": "x-handle-character", "value": character}


def seeded_values(characters: list[str], profile: dict) -> list[dict]:
    values = []
    for character in characters:
        scope = character_scope(character)
        incoming_raw = map_range(
            hash_to_unit_float(scope, "incoming-handle-length"),
            *profile["handle_length_range"],
        )
        outgoing_raw = map_range(
            hash_to_unit_float(scope, "outgoing-handle-length"),
            *profile["handle_length_range"],
        )
        mean_length = (incoming_raw + outgoing_raw) / 2
        balance = profile["handle_balance"]
        if character == "_":
            underscore_scope = {"kind": "x-handle-underscore", "value": "_"}
            canonical_y_shift = map_range(
                hash_to_unit_float(underscore_scope, "point-y-shift"),
                *profile["underscore_y_range"],
            )
        else:
            canonical_y_shift = map_point_y(
                hash_to_unit_float(scope, "point-y-shift"),
                profile,
            )
        values.append({
            "angle": math.radians(map_range(
                hash_to_unit_float(scope, "handle-angle"),
                *profile["rotation_range"],
            )),
            "incoming_length": incoming_raw * (1 - balance) + mean_length * balance,
            "outgoing_length": outgoing_raw * (1 - balance) + mean_length * balance,
            "canonical_y_shift": canonical_y_shift,
        })
    return values


def underscore_width_weight(profile: dict) -> float:
    scope = {"kind": "x-handle-underscore", "value": "_"}
    return map_range(
        hash_to_unit_float(scope, "width-weight"),
        *profile["underscore_width_range"],
    )


def pair_gap_weight(left_character: str, right_character: str, profile: dict) -> float:
    scope = {
        "kind": "ordered-x-handle-character-pair",
        "left": character_scope(left_character),
        "right": character_scope(right_character),
    }
    return map_range(
        hash_to_unit_float(scope, "point-gap-weight"),
        *profile["gap_range"],
    )


def non_serial_gap_weight(left_character: str, right_character: str, profile: dict) -> float:
    if left_character == "_" or right_character == "_":
        return underscore_width_weight(profile)
    return pair_gap_weight(left_character, right_character, profile)


def smooth_canonical_angles_with_neighbor_weights(raw: list[dict], smoothing: float) -> list[float]:
    count = len(raw)
    smoothed = []
    for index, value in enumerate(raw):
        previous = raw[max(0, index - 1)]["angle"]
        following = raw[min(count - 1, index + 1)]["angle"]
        neighbor_average = (previous + following) / 2
        smoothed.append(value["angle"] * (1 - smoothing) + neighbor_average * smoothing)
    return smoothed


def identity_point(
    character: str,
    index: int,
    x: float,
    raw: list[dict],
    smoothed_angles: list[float],
) -> dict:
    y_shift = raw[index]["canonical_y_shift"]
    anchor = [x, CANONICAL_CENTER + y_shift]
    angle = smoothed_angles[index]
    direction = [math.cos(angle), math.sin(angle)]
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


def shift_point_x(point: dict, shift_x: float) -> dict:
    shifted = dict(point)
    shifted["anchor"] = [point["anchor"][0] + shift_x, point["anchor"][1]]
    shifted["incoming"] = [point["incoming"][0] + shift_x, point["incoming"][1]]
    shifted["outgoing"] = [point["outgoing"][0] + shift_x, point["outgoing"][1]]
    return shifted


def center_geometry(points: list[dict]) -> list[dict]:
    x_values = [
        coordinate
        for point in points
        for coordinate in (point["anchor"][0], point["incoming"][0], point["outgoing"][0])
    ]
    geometry_center = (min(x_values) + max(x_values)) / 2
    shift_x = CANONICAL_CENTER - geometry_center
    return [shift_point_x(point, shift_x) for point in points]


def geometry_for(handle: str, profile: dict) -> list[dict]:
    characters = list(handle)
    count = len(characters)
    raw = seeded_values(characters, profile)
    smoothed_angles = smooth_canonical_angles_with_neighbor_weights(
        raw,
        profile["neighbor_smoothing"],
    )
    serial_flags = [is_serial_digit(character) for character in characters]
    has_serial_digits = any(serial_flags)
    line_span = profile["curve_span"]
    target_span = (
        line_span * count / SHARED_SETTINGS["short_text_span_denominator"]
        if count <= 3
        else line_span
    )
    target_start = CANONICAL_CENTER - target_span / 2
    target_end = CANONICAL_CENTER + target_span / 2

    if not has_serial_digits:
        if count == 1:
            return center_geometry([
                identity_point(characters[0], 0, target_start, raw, smoothed_angles),
                identity_point(characters[0], 0, target_end, raw, smoothed_angles),
            ])
        gap_weights = [
            non_serial_gap_weight(characters[index], characters[index + 1], profile)
            for index in range(count - 1)
        ]
        gap_total = sum(gap_weights)
        gaps = [target_span * weight / gap_total for weight in gap_weights]
        positions = [target_start]
        for gap in gaps:
            positions.append(positions[-1] + gap)
        return center_geometry([
            identity_point(character, index, positions[index], raw, smoothed_angles)
            for index, character in enumerate(characters)
        ])

    digits_value = "".join(character for character in characters if is_serial_digit(character))
    digits_scope = {"kind": "x-handle-digits", "value": digits_value}
    digits_y_shift = map_point_y(
        hash_to_unit_float(digits_scope, "point-y-shift"),
        profile,
    )

    flexible_boundaries = []
    transition_boundaries = []
    for index in range(count - 1):
        if serial_flags[index] != serial_flags[index + 1]:
            transition_boundaries.append(index)
        if not serial_flags[index] and not serial_flags[index + 1]:
            flexible_boundaries.append(index)

    flexible_weights = [
        non_serial_gap_weight(characters[index], characters[index + 1], profile)
        for index in flexible_boundaries
    ]
    serial_width_weights = {
        index: profile["serial_width_base"]
        for index in range(count)
        if serial_flags[index]
    }
    transition_weights = {}
    for boundary in transition_boundaries:
        digit_index = boundary if serial_flags[boundary] else boundary + 1
        non_digit_index = boundary + 1 if serial_flags[boundary] else boundary
        digit_weight = serial_width_weights[digit_index]
        transition_weight = (
            (digit_weight + underscore_width_weight(profile)) / 2
            if characters[non_digit_index] == "_"
            else digit_weight
        )
        transition_weights[boundary] = (
            transition_weight * SHARED_SETTINGS["digit_transition_weight_factor"]
        )

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
    serial_max_height = profile["serial_max_height"]
    for index, character in enumerate(characters):
        if serial_flags[index]:
            serial_spacing = serial_width_weights[index] * layout_scale
            pulse_handle = serial_spacing * profile["serial_pulse_handle_factor"]
            serial_run_baseline_y = (
                CANONICAL_CENTER
                + serial_max_height * SHARED_SETTINGS["digit_baseline_height_ratio"]
                + digits_y_shift
            )
            if index == 0 or not serial_flags[index - 1]:
                points.append(serial_point(
                    character,
                    cursor_x,
                    serial_run_baseline_y,
                    pulse_handle,
                    pulse_handle,
                ))
            pulse_height = int(character) / 9 * serial_max_height
            points.append(serial_point(
                character,
                cursor_x + serial_spacing / 2,
                serial_run_baseline_y - pulse_height,
                pulse_handle,
                pulse_handle,
            ))
            cursor_x += serial_spacing
            points.append(serial_point(
                character,
                cursor_x,
                serial_run_baseline_y,
                pulse_handle,
                pulse_handle,
            ))
            if index < count - 1 and not serial_flags[index + 1]:
                cursor_x += transition_advance[index]
        else:
            points.append(identity_point(
                character,
                index,
                cursor_x,
                raw,
                smoothed_angles,
            ))
            if index < count - 1:
                cursor_x += (
                    transition_advance[index]
                    if serial_flags[index + 1]
                    else flexible_advance.get(index, 0)
                )

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


def weight_at(point: dict, profile: dict) -> float:
    if point["character"] == "_":
        return SHARED_SETTINGS["underscore_stroke_weight_px"]
    if point["serial_tail"] or is_serial_digit(point["character"]):
        return profile["base_weight"]
    return profile["base_weight"] + (
        profile["uppercase_extra_weight"] if point["uppercase"] else 0
    )


def width_between(current: dict, following: dict, t: float, profile: dict) -> float:
    start_weight = weight_at(current, profile)
    end_weight = weight_at(following, profile)
    return start_weight + (end_weight - start_weight) * smoothstep(t)


def offset_point(current: dict, following: dict, t: float, side: int, profile: dict) -> list[float]:
    position = cubic_point(
        current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
    )
    derivative = cubic_derivative(
        current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
    )
    length = math.hypot(derivative[0], derivative[1]) or 1
    normal = [-derivative[1] / length, derivative[0] / length]
    half_width = width_between(current, following, t, profile) / 2
    return [
        position[0] + normal[0] * half_width * side,
        position[1] + normal[1] * half_width * side,
    ]


def center_points_for_outline(points: list[dict], profile: dict) -> list[dict]:
    if len(points) < 2:
        return points
    samples = SHARED_SETTINGS["centering_samples_per_segment"]
    minimum_x = math.inf
    maximum_x = -math.inf
    for index in range(len(points) - 1):
        current, following = points[index], points[index + 1]
        for sample in range(samples + 1):
            t = sample / samples
            outer = offset_point(current, following, t, 1, profile)
            inner = offset_point(current, following, t, -1, profile)
            minimum_x = min(minimum_x, outer[0], inner[0])
            maximum_x = max(maximum_x, outer[0], inner[0])
    shift_x = CANONICAL_CENTER - (minimum_x + maximum_x) / 2
    return [shift_point_x(point, shift_x) for point in points]


def coordinate(value: float) -> str:
    if abs(value) < 0.005:
        value = 0
    return f"{value:.{SHARED_SETTINGS['coordinate_decimals']}f}"


def pair(point: list[float]) -> str:
    return f"{coordinate(point[0])},{coordinate(point[1])}"


def sampled_variable_width_path(points: list[dict], profile: dict) -> str:
    if len(points) < 2:
        return ""
    outer: list[list[float]] = []
    inner: list[list[float]] = []
    samples_per_segment = max(
        SHARED_SETTINGS["sampled_outline_min_samples_per_segment"],
        min(
            SHARED_SETTINGS["sampled_outline_max_samples_per_segment"],
            math.ceil(SHARED_SETTINGS["sampled_outline_target_samples"] / len(points)),
        ),
    )

    def sample_segment(current: dict, following: dict, t: float) -> None:
        position = cubic_point(
            current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
        )
        derivative = cubic_derivative(
            current["anchor"], current["outgoing"], following["incoming"], following["anchor"], t
        )
        length = math.hypot(derivative[0], derivative[1]) or 1
        normal = [-derivative[1] / length, derivative[0] / length]
        half_width = width_between(current, following, t, profile) / 2
        outer.append([
            position[0] + normal[0] * half_width,
            position[1] + normal[1] * half_width,
        ])
        inner.append([
            position[0] - normal[0] * half_width,
            position[1] - normal[1] * half_width,
        ])

    for index in range(len(points) - 1):
        current, following = points[index], points[index + 1]
        for sample in range(samples_per_segment):
            sample_segment(current, following, sample / samples_per_segment)
    sample_segment(points[-2], points[-1], 1)
    return "M" + "L".join(map(pair, outer)) + "L" + "L".join(map(pair, reversed(inner))) + "Z"


def cubic_through_thirds(
    start: list[float],
    one_third: list[float],
    two_thirds: list[float],
    end: list[float],
) -> tuple[list[float], list[float]]:
    first = [
        27 * one_third[0] - 8 * start[0] - end[0],
        27 * one_third[1] - 8 * start[1] - end[1],
    ]
    second = [
        27 * two_thirds[0] - start[0] - 8 * end[0],
        27 * two_thirds[1] - start[1] - 8 * end[1],
    ]
    return (
        [(2 * first[0] - second[0]) / 18, (2 * first[1] - second[1]) / 18],
        [(2 * second[0] - first[0]) / 18, (2 * second[1] - first[1]) / 18],
    )


def bezier_variable_width_path(points: list[dict], profile: dict) -> str:
    if len(points) < 2:
        return ""
    last_segment = len(points) - 2
    first_outer = offset_point(points[0], points[1], 0, 1, profile)
    path = f"M{pair(first_outer)}"
    for index in range(last_segment + 1):
        current, following = points[index], points[index + 1]
        start = offset_point(current, following, 0, 1, profile)
        one_third = offset_point(current, following, 1 / 3, 1, profile)
        two_thirds = offset_point(current, following, 2 / 3, 1, profile)
        end = offset_point(current, following, 1, 1, profile)
        control_1, control_2 = cubic_through_thirds(start, one_third, two_thirds, end)
        path += f"C{pair(control_1)} {pair(control_2)} {pair(end)}"
    final_inner = offset_point(points[last_segment], points[last_segment + 1], 1, -1, profile)
    path += f"L{pair(final_inner)}"
    for index in range(last_segment, -1, -1):
        current, following = points[index], points[index + 1]
        start = offset_point(current, following, 0, -1, profile)
        one_third = offset_point(current, following, 1 / 3, -1, profile)
        two_thirds = offset_point(current, following, 2 / 3, -1, profile)
        end = offset_point(current, following, 1, -1, profile)
        control_1, control_2 = cubic_through_thirds(start, one_third, two_thirds, end)
        path += f"C{pair(control_2)} {pair(control_1)} {pair(start)}"
    return path + "Z"


def xml_number(value: float) -> str:
    numeric = float(value)
    return str(int(numeric)) if numeric.is_integer() else str(numeric)


def handle_text(displayed_handle: str, x: float, y: float, size: float, ink: str) -> str:
    return (
        f'<text x="{xml_number(x)}" y="{xml_number(y)}" '
        f'font-size="{xml_number(size)}" font-weight="{SHARED_SETTINGS["text_weight"]}" '
        f'dominant-baseline="middle" fill="{ink}" text-anchor="middle" '
        f'font-family="{html.escape(SHARED_SETTINGS["text_font_family"], quote=True)}">'
        f'{html.escape(displayed_handle)}</text>'
    )


def compose_sized_svg(
    path_element: str,
    displayed_handle: str,
    profile: dict,
    output_width: int,
    output_height: int,
) -> str:
    if output_width <= 0 or output_height <= 0:
        raise ValueError("output width and height must be positive integers")

    namespace = 'xmlns="http://www.w3.org/2000/svg"'
    size_attributes = f'width="{output_width}" height="{output_height}"'
    background = profile["background"]
    ink = profile["ink"]

    if output_width * CANONICAL_HEIGHT == output_height * CANONICAL_WIDTH:
        text_element = handle_text(
            displayed_handle,
            SHARED_SETTINGS["text_x"],
            SHARED_SETTINGS["text_y"],
            SHARED_SETTINGS["text_size_px"],
            ink,
        )
        return (
            f'<svg viewBox="0 0 {CANONICAL_WIDTH} {CANONICAL_HEIGHT}" {namespace} {size_attributes}>'
            f'<rect x="0" y="0" width="{CANONICAL_WIDTH}" height="{CANONICAL_HEIGHT}" '
            f'fill="{background}"/>{path_element}{text_element}</svg>'
        )

    scale = min(output_width / CANONICAL_WIDTH, output_height / CANONICAL_HEIGHT)
    offset_x = (output_width - CANONICAL_WIDTH * scale) / 2
    offset_y = (output_height - CANONICAL_HEIGHT * scale) / 2
    transform = (
        f'translate({xml_number(offset_x)} {xml_number(offset_y)}) '
        f'scale({xml_number(scale)})'
    )
    text_element = handle_text(
        displayed_handle,
        output_width / 2,
        output_height * 0.95,
        SHARED_SETTINGS["text_size_px"] * scale,
        ink,
    )
    return (
        f'<svg viewBox="0 0 {output_width} {output_height}" {namespace} {size_attributes}>'
        f'<rect x="0" y="0" width="{output_width}" height="{output_height}" '
        f'fill="{background}"/>'
        f'<g transform="{transform}">{path_element}</g>{text_element}</svg>'
    )


def generate_svg(
    handle: str,
    mbti_type: str,
    output_width: int = DEFAULT_OUTPUT_WIDTH,
    output_height: int = DEFAULT_OUTPUT_HEIGHT,
) -> str:
    if not HANDLE_PATTERN.fullmatch(handle):
        raise ValueError("handle must match ^[A-Za-z0-9_]{1,15}$ and must not include @")
    profile = profile_for_mbti(mbti_type)
    points = center_points_for_outline(geometry_for(handle, profile), profile)
    if profile["path_mode"] == "variable_bezier_outline":
        path_data = bezier_variable_width_path(points, profile)
    else:
        path_data = sampled_variable_width_path(points, profile)
    path_element = f'<path d="{path_data}" fill="{profile["ink"]}" stroke="none"/>'
    return compose_sized_svg(
        path_element,
        "@" + handle,
        profile,
        output_width,
        output_height,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate one deterministic Signature v2.0.0 MBTI SVG."
    )
    parser.add_argument("handle", help="X handle without the leading @")
    parser.add_argument("--mbti", default="INFP", help="MBTI type matching ^[EI][SN][TF][JP]$")
    parser.add_argument("--width", type=int, default=DEFAULT_OUTPUT_WIDTH, help="Output width in pixels")
    parser.add_argument("--height", type=int, default=DEFAULT_OUTPUT_HEIGHT, help="Output height in pixels")
    parser.add_argument("--output", type=Path, help="Write SVG to this file; otherwise print raw SVG")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        svg = generate_svg(args.handle, args.mbti, args.width, args.height)
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

"""A minimal protobuf wire-format reader, for MEXC's `.pb` market streams.

MEXC replaced its JSON push with protobuf on `wbs-api.mexc.com`. The proper
production path is `protoc` against MEXC's published `.proto` files — see
`docs/ARCHITECTURE.md`. This module exists so the engine is not *blocked* on
that step, and so the wire can be inspected when a generated stub disagrees
with what the venue is actually sending.

The wire format itself is unambiguous and needs no schema: every field is
`(field_number << 3) | wire_type` followed by a varint, a fixed 32/64-bit
value, or a length-delimited blob. `decode(buf)` returns
`{field_number: [values]}` where length-delimited fields stay as raw `bytes` —
the caller decides whether a blob is a nested message or a string.

What *does* need a schema is which field number means "asks". Those live in
`MEXC_FIELDS` below with a one-line provenance note each, and
`engine.venues.mexc` validates its decode before trusting it: if the strings in
a depth item do not parse as floats, the frame is dropped and counted rather
than fed into a book.
"""
from __future__ import annotations

from typing import Any

__all__ = ["decode", "read_varint", "as_str", "as_message", "ProtobufError"]


class ProtobufError(ValueError):
    pass


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    """Base-128 varint at `pos`; returns (value, new_pos)."""
    result = 0
    shift = 0
    n = len(buf)
    while pos < n:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7
        if shift > 70:
            raise ProtobufError("varint too long")
    raise ProtobufError("truncated varint")


def decode(buf: bytes, max_fields: int = 4096) -> dict[int, list[Any]]:
    """Parse one protobuf message into {field_number: [values]}.

    Repeated fields naturally accumulate into the list. Unknown fields are kept
    rather than skipped, which is what makes this useful for inspecting a
    stream whose schema has drifted.
    """
    out: dict[int, list[Any]] = {}
    pos = 0
    n = len(buf)
    count = 0
    while pos < n:
        count += 1
        if count > max_fields:
            raise ProtobufError("too many fields; not a protobuf message")
        key, pos = read_varint(buf, pos)
        field_no, wire = key >> 3, key & 0x07
        if field_no == 0:
            raise ProtobufError("field number 0")
        if wire == 0:
            val, pos = read_varint(buf, pos)
        elif wire == 1:
            if pos + 8 > n:
                raise ProtobufError("truncated 64-bit field")
            val = buf[pos:pos + 8]
            pos += 8
        elif wire == 2:
            length, pos = read_varint(buf, pos)
            if pos + length > n:
                raise ProtobufError("truncated length-delimited field")
            val = buf[pos:pos + length]
            pos += length
        elif wire == 5:
            if pos + 4 > n:
                raise ProtobufError("truncated 32-bit field")
            val = buf[pos:pos + 4]
            pos += 4
        elif wire in (3, 4):
            raise ProtobufError("deprecated group encoding")
        else:
            raise ProtobufError(f"bad wire type {wire}")
        out.setdefault(field_no, []).append(val)
    return out


def as_str(values: list[Any] | None, index: int = 0, default: str = "") -> str:
    if not values or index >= len(values):
        return default
    v = values[index]
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except UnicodeDecodeError:
            return default
    return str(v)


def as_int(values: list[Any] | None, index: int = 0, default: int = 0) -> int:
    if not values or index >= len(values):
        return default
    v = values[index]
    if isinstance(v, int):
        return v
    if isinstance(v, bytes):
        try:
            return int(v.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return default
    return default


def as_message(values: list[Any] | None, index: int = 0) -> dict[int, list[Any]]:
    if not values or index >= len(values):
        return {}
    v = values[index]
    if not isinstance(v, bytes):
        return {}
    try:
        return decode(v)
    except ProtobufError:
        return {}

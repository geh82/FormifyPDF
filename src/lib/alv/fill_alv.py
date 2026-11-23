#!/usr/bin/env python3
"""
Official ALV PDF Population Engine (PyMuPDF / fitz)

Populates the official South African ALV blank PDF using field_map.json and
validated JSON input, preserving all original printed text, lines, boxes, and
page dimensions, and verifies the resulting PDF before exiting.

Usage:
  python3 src/lib/alv/fill_alv.py --in input.json --out output.pdf
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = SCRIPT_DIR / "ALV_blank.pdf"
DEFAULT_FIELD_MAP = SCRIPT_DIR / "field_map.json"

INK_COLOR = (0.06, 0.10, 0.20)  # Dark archival navy-black ink
X_MARK_COLOR = (0.05, 0.18, 0.45)


def flatten_payload(data: Any, prefix: str = "") -> dict[str, Any]:
    """Flatten nested dict keys into dot-notation paths matching field_map.json."""
    out: dict[str, Any] = {}
    if not isinstance(data, dict):
        return out
    for k, v in data.items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict):
            out.update(flatten_payload(v, key))
        else:
            out[key] = v
    return out


def normalize_text(value: Any, uppercase: bool = True) -> str:
    if value is None:
        return ""
    s = str(value).replace("\r", " ").replace("\n", " ").strip()
    if uppercase:
        s = s.upper()
    return s


def draw_char_in_cell(
    page: fitz.Page,
    rect_coords: list[float],
    ch: str,
    fontname: str = "helv",
    fontsize: float = 9.5,
) -> None:
    if not ch or ch == " ":
        return
    x0, y0, x1, y1 = rect_coords
    cell_rect = fitz.Rect(x0, y0, x1, y1)
    cell_w = cell_rect.width
    cell_h = cell_rect.height

    # Scale font size proportionally for narrower boxes (e.g. half-width date slots)
    effective_size = fontsize
    if cell_w < 11.2:
        effective_size = min(fontsize, max(7.5, cell_w * 0.72))

    text_w = fitz.get_text_length(ch, fontname=fontname, fontsize=effective_size)
    while text_w > cell_w - 1.8 and effective_size > 6.0:
        effective_size -= 0.5
        text_w = fitz.get_text_length(ch, fontname=fontname, fontsize=effective_size)

    x_pos = x0 + (cell_w - text_w) / 2.0
    # Baseline centered vertically inside the cell
    y_pos = y0 + (cell_h + effective_size * 0.72) / 2.0
    if cell_h >= 18.0:
        # Taller date boxes (2:0 : : :) align printed text slightly above center
        y_pos = y0 + 13.8
    page.insert_text(
        fitz.Point(x_pos, y_pos),
        ch,
        fontname=fontname,
        fontsize=effective_size,
        color=INK_COLOR,
        overlay=True,
    )


def draw_x_mark(page: fitz.Page, rect_coords: list[float]) -> None:
    """
    Draw a crisp, unmistakable 'X' selection mark inside the chosen box while
    keeping the underlying printed English/Afrikaans label legible.
    """
    x0, y0, x1, y1 = rect_coords
    w = x1 - x0
    h = y1 - y0
    inset_x = max(5.0, min(14.0, w * 0.16))
    inset_y = max(3.5, h * 0.18)

    shape = page.new_shape()
    shape.draw_line(fitz.Point(x0 + inset_x, y0 + inset_y), fitz.Point(x1 - inset_x, y1 - inset_y))
    shape.draw_line(fitz.Point(x1 - inset_x, y0 + inset_y), fitz.Point(x0 + inset_x, y1 - inset_y))
    shape.finish(color=X_MARK_COLOR, width=1.8, stroke_opacity=0.48, lineCap=1)
    shape.commit(overlay=True)


def draw_free_text(
    page: fitz.Page,
    rect_coords: list[float],
    text: str,
    max_chars: int,
    fontname: str = "helv",
    fontsize: float = 9.0,
) -> None:
    if not text:
        return
    if len(text) > max_chars:
        raise ValueError(f"Text '{text}' exceeds maximum capacity of {max_chars} characters")
    x0, y0, x1, y1 = rect_coords
    avail_w = x1 - x0 - 4.0
    eff_size = fontsize
    while fitz.get_text_length(text, fontname=fontname, fontsize=eff_size) > avail_w and eff_size > 6.5:
        eff_size -= 0.5
    # Position cleanly just above the dotted Place line
    baseline_y = y1 - 5.2
    page.insert_text(
        fitz.Point(x0 + 3.0, baseline_y),
        text,
        fontname=fontname,
        fontsize=eff_size,
        color=INK_COLOR,
        overlay=True,
    )


def populate_acroform_widgets_if_present(doc: fitz.Document, flat_data: dict[str, Any], field_map: dict[str, Any]) -> bool:
    """
    If the PDF contains AcroForm widgets matching mapped widgetNames, populate
    and flatten them directly. Returns True if AcroForm mode was used.
    """
    widgets_by_name: dict[str, tuple[fitz.Page, fitz.Widget]] = {}
    for page in doc:
        for w in page.widgets():
            if w.field_name:
                widgets_by_name[w.field_name] = (page, w)

    if not widgets_by_name:
        return False

    fields = field_map.get("fields", {})
    matched_any = False
    for fkey, spec in fields.items():
        widget_names = spec.get("widgetNames")
        if not widget_names or fkey not in flat_data:
            continue
        matched_any = True
        val = flat_data[fkey]
        if spec["kind"] in ("char_cells", "date_cells"):
            text = normalize_text(val, uppercase=spec.get("uppercase", True))
            if len(text) > len(widget_names):
                raise ValueError(f"Field '{fkey}' length ({len(text)}) exceeds capacity ({len(widget_names)})")
            for idx, wname in enumerate(widget_names):
                if wname in widgets_by_name:
                    _, w = widgets_by_name[wname]
                    w.field_value = text[idx] if idx < len(text) else ""
                    w.update()

    if matched_any:
        # Flatten AcroForm annotations into static page content
        if hasattr(doc, "bake"):
            doc.bake()
        else:
            for page in doc:
                for w in list(page.widgets()):
                    page.delete_widget(w)
    return matched_any


def fill_alv_pdf(
    input_json_path: Path,
    output_pdf_path: Path,
    template_pdf_path: Path = DEFAULT_TEMPLATE,
    field_map_path: Path = DEFAULT_FIELD_MAP,
) -> dict[str, Any]:
    if not template_pdf_path.exists():
        raise FileNotFoundError(f"Official blank ALV PDF not found at {template_pdf_path}")
    if not field_map_path.exists():
        raise FileNotFoundError(f"Field map not found at {field_map_path}")
    if not input_json_path.exists():
        raise FileNotFoundError(f"Input JSON file not found at {input_json_path}")

    with input_json_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise ValueError("Input JSON root must be an object")

    with field_map_path.open("r", encoding="utf-8") as f:
        field_map = json.load(f)

    fields: dict[str, Any] = field_map.get("fields", {})
    if not fields:
        raise ValueError("field_map.json contains no mapped fields")

    doc = fitz.open(str(template_pdf_path))
    expected_pages = len(field_map.get("pageSizes", [])) or 2
    if len(doc) != expected_pages:
        raise ValueError(f"Template PDF has {len(doc)} pages; expected {expected_pages}")

    flat_data = flatten_payload(payload)

    # First check if AcroForm widgets are present and mapped
    used_acroform = populate_acroform_widgets_if_present(doc, flat_data, field_map)

    populated_fields: list[str] = []
    unmapped_keys: list[str] = []

    if not used_acroform:
        # Validate no unknown non-metadata keys are silently ignored
        allowed_meta = {"sameAsPostal", "hasOrganisationProxy", "hasOrganisationRepresentative", "signatoryName"}
        for k, v in flat_data.items():
            if k not in fields and k.split(".")[-1] not in allowed_meta and k not in allowed_meta:
                if v not in (None, "", False):
                    unmapped_keys.append(k)

        if unmapped_keys:
            raise ValueError(f"Unmapped input fields encountered: {', '.join(unmapped_keys)}")

        for fkey, spec in fields.items():
            if fkey not in flat_data:
                continue
            raw_val = flat_data[fkey]
            if raw_val is None or raw_val == "":
                continue

            page_idx = int(spec["page"]) - 1
            if page_idx < 0 or page_idx >= len(doc):
                raise ValueError(f"Invalid page index {page_idx + 1} for field {fkey}")
            page = doc[page_idx]
            kind = spec["kind"]

            if kind in ("char_cells", "date_cells"):
                text = normalize_text(raw_val, uppercase=spec.get("uppercase", True))
                if not text:
                    continue
                cells = spec["cells"]
                capacity = len(cells)
                if len(text) > capacity:
                    raise ValueError(
                        f"Field '{fkey}' value '{text}' ({len(text)} chars) exceeds PDF box capacity ({capacity} cells)"
                    )
                align = spec.get("align", "left")
                if align == "right":
                    padded = text.rjust(capacity, " ")
                else:
                    padded = text.ljust(capacity, " ")
                for idx, ch in enumerate(padded):
                    draw_char_in_cell(page, cells[idx], ch)
                populated_fields.append(fkey)

            elif kind == "selection_box":
                if isinstance(raw_val, bool):
                    if not raw_val:
                        continue
                    key_val = "true"
                else:
                    key_val = str(raw_val).strip()
                options = spec["options"]
                if key_val not in options:
                    raise ValueError(
                        f"Invalid option '{key_val}' for selection field '{fkey}'. Allowed: {list(options.keys())}"
                    )
                draw_x_mark(page, options[key_val]["rect"])
                populated_fields.append(fkey)

            elif kind == "free_text":
                text = normalize_text(raw_val, uppercase=spec.get("uppercase", True))
                if not text:
                    continue
                draw_free_text(page, spec["rect"], text, int(spec.get("maxChars", 32)))
                populated_fields.append(fkey)

            else:
                raise ValueError(f"Unsupported field kind '{kind}' for '{fkey}'")

    output_pdf_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(output_pdf_path), garbage=4, deflate=True)
    doc.close()

    # Post-save verification
    if not output_pdf_path.exists():
        raise RuntimeError(f"Output PDF was not created at {output_pdf_path}")
    file_bytes = output_pdf_path.read_bytes()
    if len(file_bytes) == 0 or not file_bytes.startswith(b"%PDF-"):
        raise RuntimeError("Generated output file is not a valid non-empty PDF")

    verify_doc = fitz.open(str(output_pdf_path))
    if len(verify_doc) != expected_pages:
        verify_doc.close()
        raise RuntimeError(f"Output PDF page count mismatch: got {len(verify_doc)}, expected {expected_pages}")
    page_rects = [[round(p.rect.width, 2), round(p.rect.height, 2)] for p in verify_doc]
    verify_doc.close()

    return {
        "ok": True,
        "output": str(output_pdf_path),
        "bytes": len(file_bytes),
        "pages": expected_pages,
        "pageSizes": page_rects,
        "populatedFieldCount": len(populated_fields),
        "populatedFields": populated_fields,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Populate official South African ALV PDF")
    parser.add_argument("--in", dest="input_path", required=True, help="Path to validated JSON input")
    parser.add_argument("--out", dest="output_path", required=True, help="Path to output PDF")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="Path to ALV_blank.pdf")
    parser.add_argument("--map", default=str(DEFAULT_FIELD_MAP), help="Path to field_map.json")
    args = parser.parse_args()

    try:
        summary = fill_alv_pdf(
            input_json_path=Path(args.input_path),
            output_pdf_path=Path(args.output_path),
            template_pdf_path=Path(args.template),
            field_map_path=Path(args.map),
        )
        print(json.dumps(summary))
        return 0
    except Exception as exc:
        print(f"ALV PDF generation error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

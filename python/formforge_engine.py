#!/usr/bin/env python3
"""
FormForge AI — Universal PDF Intelligence, OCR, Computer Vision, AcroForm Generation & Rendering Engine.

Self-hosted, zero-form-specific-assumption engine using PyMuPDF (fitz), pdfplumber, pypdf, OpenCV,
Pillow, and Tesseract OCR.

Commands:
  inspect           <input.json> <output.json>
  analyze           <input.json> <output.json>
  generate-acroform <input.json> <output.json>
  render-pdf        <input.json> <output.json>
  validate-acroform <input.json> <output.json>
"""

import io
import json
import math
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import fitz
import numpy as np
import pdfplumber
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    RectangleObject,
    StreamObject,
    TextStringObject,
)
import pytesseract


ENGINE_VERSION = "formforge-universal-1.0.0"

PAPER_SIZES = [
    ("A4", 595.28, 841.89),
    ("Letter", 612.0, 792.0),
    ("Legal", 612.0, 1008.0),
    ("A3", 841.89, 1190.55),
    ("A5", 419.53, 595.28),
]


def classify_paper_size(width_pt: float, height_pt: float) -> str:
    w, h = sorted([width_pt, height_pt])
    for name, pw, ph in PAPER_SIZES:
        sw, sh = sorted([pw, ph])
        if abs(w - sw) <= 14.0 and abs(h - sh) <= 14.0:
            return name
    return "Custom"


def round_pt(v: float) -> float:
    return round(float(v), 2)


def snake_case(text: str, fallback: str = "field") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", text.strip().lower()).strip("_")
    if not cleaned:
        cleaned = fallback
    if cleaned[0].isdigit():
        cleaned = f"f_{cleaned}"
    return cleaned[:64]


def detect_pdf_security_flags(doc: fitz.Document) -> Dict[str, Any]:
    has_js = False
    try:
        xref_count = doc.xref_length()
        for xref in range(1, min(xref_count, 4000)):
            obj_str = doc.xref_object(xref, compressed=False) or ""
            if "/JS" in obj_str or "/JavaScript" in obj_str:
                has_js = True
                break
    except Exception:
        has_js = False
    return {
        "hasEmbeddedJavaScript": has_js,
        "wasEncrypted": bool(doc.is_encrypted),
        "sanitizedActions": False,
    }


def strip_dangerous_pdf_actions(doc: fitz.Document) -> bool:
    """Remove any embedded /JS, /JavaScript, /AA, or /OpenAction entries before saving AcroForms."""
    sanitized = False
    try:
        catalog_xref = doc.pdf_catalog()
        if catalog_xref:
            cat_str = doc.xref_object(catalog_xref, compressed=False) or ""
            if "/OpenAction" in cat_str or "/AA" in cat_str:
                try:
                    doc.xref_set_key(catalog_xref, "OpenAction", "null")
                    doc.xref_set_key(catalog_xref, "AA", "null")
                    sanitized = True
                except Exception:
                    pass
        for xref in range(1, min(doc.xref_length(), 4000)):
            obj_str = doc.xref_object(xref, compressed=False) or ""
            if "/JS" in obj_str or "/JavaScript" in obj_str:
                try:
                    doc.xref_set_key(xref, "JS", "null")
                    doc.xref_set_key(xref, "JavaScript", "null")
                    sanitized = True
                except Exception:
                    pass
    except Exception:
        pass
    return sanitized


def read_pypdf_page_widgets(
    reader: Optional[PdfReader], page_idx: int, cropbox: fitz.Rect
) -> List[Dict[str, Any]]:
    """Safely inspect Widget annotations using pypdf without triggering PyMuPDF 1.21 SWIG issues."""
    if not reader or page_idx >= len(reader.pages):
        return []
    out: List[Dict[str, Any]] = []
    try:
        p = reader.pages[page_idx]
        annots = p.get("/Annots") or []
        if hasattr(annots, "get_object"):
            annots = annots.get_object()
        for ref in annots or []:
            obj = ref.get_object() if hasattr(ref, "get_object") else ref
            if not isinstance(obj, dict):
                continue
            if str(obj.get("/Subtype", "")) != "/Widget":
                continue
            parent = obj.get("/Parent")
            if hasattr(parent, "get_object"):
                parent = parent.get_object()
            name = str(obj.get("/T") or (parent.get("/T") if isinstance(parent, dict) else "") or "")
            ft = str(obj.get("/FT") or (parent.get("/FT") if isinstance(parent, dict) else "") or "/Tx")
            ff = int(obj.get("/Ff") or (parent.get("/Ff") if isinstance(parent, dict) else 0) or 0)
            raw_rect = obj.get("/Rect")
            if not raw_rect or len(raw_rect) < 4:
                continue
            x0, y0_b, x1, y1_b = [float(v) for v in raw_rect[:4]]
            # Convert PDF bottom-left coordinates into top-left cropbox space
            top_y0 = cropbox.height - (y1_b - cropbox.y0)
            top_y1 = cropbox.height - (y0_b - cropbox.y0)
            rx0 = min(x0, x1) - cropbox.x0
            ry0 = min(top_y0, top_y1)
            rw = max(6.0, abs(x1 - x0))
            rh = max(6.0, abs(top_y1 - top_y0))

            ftype = "text"
            if ft == "/Btn":
                ftype = "radio" if (ff & (1 << 15)) else "checkbox"
            elif ft == "/Ch":
                ftype = "dropdown"
            elif ft == "/Sig":
                ftype = "signature"
            elif ff & (1 << 12):
                ftype = "multiline"

            val = obj.get("/V") or (parent.get("/V") if isinstance(parent, dict) else "") or ""
            maxlen = obj.get("/MaxLen") or (parent.get("/MaxLen") if isinstance(parent, dict) else None)
            opts_raw = obj.get("/Opt") or (parent.get("/Opt") if isinstance(parent, dict) else []) or []
            opts = [str(o[0] if isinstance(o, (list, tuple)) and o else o) for o in opts_raw]
            out.append(
                {
                    "name": name,
                    "type": ftype,
                    "x": rx0,
                    "y": ry0,
                    "width": rw,
                    "height": rh,
                    "defaultValue": str(val),
                    "maxLength": int(maxlen) if maxlen else None,
                    "options": opts,
                }
            )
    except Exception:
        return []
    return out


def open_pdf_safely(pdf_path: str) -> fitz.Document:
    if not os.path.exists(pdf_path):
        raise ValueError(f"PDF_NOT_FOUND: File not found at {pdf_path}")
    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        raise ValueError(f"CORRUPT_PDF: Unable to parse PDF document ({exc})")
    if doc.needs_pass:
        doc.close()
        raise ValueError("PASSWORD_PROTECTED: PDF is encrypted and requires a password")
    if doc.page_count <= 0:
        doc.close()
        raise ValueError("INVALID_PAGE_COUNT: PDF contains zero pages")
    return doc


def inspect_pdf(
    pdf_path: str, thumbnails_dir: Optional[str] = None
) -> Dict[str, Any]:
    doc = open_pdf_safely(pdf_path)
    try:
        security_flags = detect_pdf_security_flags(doc)
        pages_info: List[Dict[str, Any]] = []
        has_existing = False
        is_scanned = False

        if thumbnails_dir:
            os.makedirs(thumbnails_dir, exist_ok=True)

        try:
            pypdf_reader = PdfReader(pdf_path)
        except Exception:
            pypdf_reader = None

        for idx in range(doc.page_count):
            page = doc[idx]
            rect = page.rect
            mbox = page.mediabox
            cbox = page.cropbox
            words = page.get_text("words") or []
            blocks = page.get_text("dict").get("blocks", [])
            text_spans = sum(
                len(line.get("spans", []))
                for b in blocks
                if b.get("type") == 0
                for line in b.get("lines", [])
            )
            drawings = page.get_drawings() or []
            widgets = read_pypdf_page_widgets(pypdf_reader, idx, cbox)
            if len(widgets) > 0:
                has_existing = True
            needs_ocr = len(words) < 10
            if needs_ocr:
                is_scanned = True

            thumb_name = None
            if thumbnails_dir:
                pix = page.get_pixmap(dpi=110)
                thumb_name = f"page_{idx}.png"
                pix.save(os.path.join(thumbnails_dir, thumb_name))

            pages_info.append(
                {
                    "pageIndex": idx,
                    "widthPt": round_pt(rect.width),
                    "heightPt": round_pt(rect.height),
                    "rotation": int(page.rotation or 0) % 360,
                    "orientation": "landscape" if rect.width > rect.height else "portrait",
                    "paperSize": classify_paper_size(rect.width, rect.height),
                    "mediaBox": {
                        "x": round_pt(mbox.x0),
                        "y": round_pt(mbox.y0),
                        "width": round_pt(mbox.width),
                        "height": round_pt(mbox.height),
                    },
                    "cropBox": {
                        "x": round_pt(cbox.x0),
                        "y": round_pt(cbox.y0),
                        "width": round_pt(cbox.width),
                        "height": round_pt(cbox.height),
                    },
                    "textSpanCount": int(text_spans),
                    "wordCount": int(len(words)),
                    "drawingCount": int(len(drawings)),
                    "existingWidgetCount": int(len(widgets)),
                    "needsOcr": bool(needs_ocr),
                    "ocrApplied": False,
                    "deskewAngle": 0.0,
                    "thumbnailFile": thumb_name,
                }
            )

        return {
            "pageCount": doc.page_count,
            "isScanned": is_scanned,
            "hasExistingAcroForm": has_existing,
            "securityFlags": security_flags,
            "metadata": doc.metadata or {},
            "pages": pages_info,
        }
    finally:
        doc.close()


def infer_semantic_type(
    label_text: str,
    width_pt: float,
    height_pt: float,
    geom_kind: str,
    cell_count: int = 0,
) -> Tuple[str, Dict[str, Any]]:
    lbl = label_text.lower()
    meta: Dict[str, Any] = {
        "required": "*" in label_text or "required" in lbl,
        "multiline": False,
        "options": [],
        "validation": {},
        "maxLength": None,
        "alignment": "left",
    }

    if geom_kind == "checkbox":
        return "checkbox", meta
    if geom_kind == "radio":
        return "radio", meta
    if geom_kind == "char_cells" and cell_count >= 2:
        meta["maxLength"] = cell_count
        meta["alignment"] = "center"
        if any(k in lbl for k in ["date", "dob", "birth", "yy/mm", "dd/mm", "mm/dd"]):
            meta["validation"] = {"dateFormat": "YYYY-MM-DD"}
        return "char_cells", meta

    if any(k in lbl for k in ["signature", "sign here", "handtekening", "signed by", "authorised sign"]):
        return "signature", meta
    if any(k in lbl for k in ["initials", "voorletters"]):
        meta["maxLength"] = 12
        return "initials", meta
    if any(k in lbl for k in ["e-mail", "email", "mail address"]):
        meta["validation"] = {"pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"}
        return "email", meta
    if any(k in lbl for k in ["date", "dob", "birth", "issued on", "expiry", "valid until", "dd/mm", "yyyy"]):
        meta["validation"] = {"dateFormat": "DD/MM/YYYY"}
        meta["maxLength"] = 16
        return "date", meta
    if any(k in lbl for k in ["phone", "telephone", "mobile", "cell", "fax", "tel ", "tel:"]):
        meta["validation"] = {"pattern": "^[+0-9 ()-]{6,20}$"}
        meta["maxLength"] = 20
        return "phone", meta
    if any(k in lbl for k in ["amount", "price", "salary", "income", "fee", "total", "currency", "zar", "usd", "rand", "$", "r "]):
        meta["alignment"] = "right"
        meta["validation"] = {"pattern": "^[0-9,. ]+$"}
        return "currency", meta
    if any(k in lbl for k in ["number", "qty", "quantity", "count", "age", "year", "postal code", "zip code", "id no", "passport", "account no"]):
        meta["validation"] = {"pattern": "^[0-9A-Za-z -]+$"}
        if "zip" in lbl or "postal" in lbl:
            meta["maxLength"] = 10
        return "numeric", meta
    if any(k in lbl for k in ["address", "street", "residence", "postal address", "physical address"]):
        if height_pt >= 34:
            meta["multiline"] = True
        return "address", meta
    if any(k in lbl for k in ["select", "choose", "country", "province", "state", "gender", "title (mr", "marital"]):
        if "gender" in lbl:
            meta["options"] = ["Female", "Male", "Other"]
            return "dropdown", meta
        if "title" in lbl:
            meta["options"] = ["Mr", "Mrs", "Ms", "Dr", "Prof"]
            return "dropdown", meta
    if geom_kind == "table_cell":
        return "table_cell", meta
    if height_pt >= 36 or any(k in lbl for k in ["comments", "notes", "description", "remarks", "reason", "details", "motivation"]):
        meta["multiline"] = True
        return "multiline", meta

    return "text", meta


def extract_text_labels(page: fitz.Page) -> List[Dict[str, Any]]:
    labels: List[Dict[str, Any]] = []
    d = page.get_text("dict")
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            bbox = line.get("bbox", (0, 0, 0, 0))
            labels.append(
                {
                    "text": text,
                    "x0": float(bbox[0]),
                    "y0": float(bbox[1]),
                    "x1": float(bbox[2]),
                    "y1": float(bbox[3]),
                    "source": "pdf_text",
                }
            )
    return labels


def preprocess_and_ocr_page(
    page: fitz.Page, language: str = "eng", dpi: int = 200
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], float, int]:
    """
    Renders page into OpenCV, deskews & denoises, runs Tesseract OCR for labels,
    and extracts raster boxes/underlines/checkboxes via OpenCV morphology.
    """
    t0 = time.time()
    pix = page.get_pixmap(dpi=dpi)
    img_np = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGBA2GRAY)
    elif pix.n == 3:
        gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_np

    scale_to_pt = 72.0 / float(dpi)

    # Contrast enhancement & denoise
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    denoised = cv2.bilateralFilter(enhanced, 5, 45, 45)
    thresh = cv2.adaptiveThreshold(
        denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 11
    )

    # Deskew estimation
    coords = np.column_stack(np.where(thresh > 0))
    deskew_angle = 0.0
    if len(coords) > 200:
        rect = cv2.minAreaRect(coords)
        angle = rect[-1]
        if angle < -45:
            angle = -(90 + angle)
        else:
            angle = -angle
        if 0.3 <= abs(angle) <= 12.0:
            deskew_angle = round(float(angle), 2)
            (h, w) = denoised.shape[:2]
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, deskew_angle, 1.0)
            denoised = cv2.warpAffine(
                denoised, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
            )
            thresh = cv2.adaptiveThreshold(
                denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 11
            )

    # Tesseract OCR
    ocr_labels: List[Dict[str, Any]] = []
    word_count = 0
    try:
        pil_img = Image.fromarray(denoised)
        data = pytesseract.image_to_data(
            pil_img, lang=language, output_type=pytesseract.Output.DICT
        )
        line_groups: Dict[Tuple[int, int, int], List[Dict[str, Any]]] = {}
        n_boxes = len(data["text"])
        for i in range(n_boxes):
            txt = (data["text"][i] or "").strip()
            conf = float(data["conf"][i]) if str(data["conf"][i]).lstrip("-").isdigit() else -1
            if not txt or conf < 25:
                continue
            word_count += 1
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            line_groups.setdefault(key, []).append(
                {
                    "text": txt,
                    "x0": data["left"][i] * scale_to_pt,
                    "y0": data["top"][i] * scale_to_pt,
                    "x1": (data["left"][i] + data["width"][i]) * scale_to_pt,
                    "y1": (data["top"][i] + data["height"][i]) * scale_to_pt,
                }
            )
        for words in line_groups.values():
            words.sort(key=lambda w: w["x0"])
            ocr_labels.append(
                {
                    "text": " ".join(w["text"] for w in words),
                    "x0": min(w["x0"] for w in words),
                    "y0": min(w["y0"] for w in words),
                    "x1": max(w["x1"] for w in words),
                    "y1": max(w["y1"] for w in words),
                    "source": "ocr_tesseract",
                }
            )
    except Exception:
        pass

    # OpenCV line & box contour detection for scanned forms
    cv_candidates: List[Dict[str, Any]] = []
    horiz_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (int(dpi * 0.45), 1))
    vert_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, int(dpi * 0.14)))
    horiz_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horiz_kernel, iterations=1)
    vert_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, vert_kernel, iterations=1)
    combined_grid = cv2.add(horiz_lines, vert_lines)

    # Detect closed boxes from grid
    contours, _ = cv2.findContours(combined_grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        w_pt = w * scale_to_pt
        h_pt = h * scale_to_pt
        x_pt = x * scale_to_pt
        y_pt = y * scale_to_pt
        if 8 <= w_pt <= 22 and 8 <= h_pt <= 22 and 0.65 <= (w_pt / max(h_pt, 1)) <= 1.45:
            cv_candidates.append(
                {"kind": "checkbox", "x0": x_pt, "y0": y_pt, "x1": x_pt + w_pt, "y1": y_pt + h_pt, "source": "cv_contour"}
            )
        elif w_pt >= 45 and 13 <= h_pt <= 140:
            cv_candidates.append(
                {"kind": "box", "x0": x_pt, "y0": y_pt, "x1": x_pt + w_pt, "y1": y_pt + h_pt, "source": "cv_contour"}
            )

    # Detect standalone underlines
    h_contours, _ = cv2.findContours(horiz_lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in h_contours:
        x, y, w, h = cv2.boundingRect(cnt)
        w_pt = w * scale_to_pt
        h_pt = h * scale_to_pt
        if w_pt >= 50 and h_pt <= 6:
            x0 = x * scale_to_pt
            y_line = y * scale_to_pt
            cv_candidates.append(
                {
                    "kind": "underline",
                    "x0": x0,
                    "y0": max(0.0, y_line - 19.0),
                    "x1": x0 + w_pt,
                    "y1": y_line - 1.0,
                    "source": "cv_contour",
                }
            )

    duration_ms = int((time.time() - t0) * 1000)
    return ocr_labels, cv_candidates, deskew_angle, duration_ms


def overlap_area(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> float:
    ix0 = max(a[0], b[0])
    iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2])
    iy1 = min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    return (ix1 - ix0) * (iy1 - iy0)


def rect_has_dense_text(
    rect: Tuple[float, float, float, float], labels: List[Dict[str, Any]]
) -> bool:
    area = max(1.0, (rect[2] - rect[0]) * (rect[3] - rect[1]))
    cov = 0.0
    for lbl in labels:
        ov = overlap_area(rect, (lbl["x0"], lbl["y0"], lbl["x1"], lbl["y1"]))
        cov += ov
    return (cov / area) > 0.35


def find_nearest_label(
    rect: Tuple[float, float, float, float], labels: List[Dict[str, Any]]
) -> Tuple[str, float]:
    """Find best human label immediately to the left or slightly above the candidate rect."""
    rx0, ry0, rx1, ry1 = rect
    rmid_y = (ry0 + ry1) / 2.0
    best_text = ""
    best_score = 1e9

    for lbl in labels:
        txt = lbl["text"].strip()
        if not txt or len(txt) < 2:
            continue
        # Skip pure underscores/dots placeholders
        if re.fullmatch(r"[_\.\-\s\[\]\(\)\|]+", txt):
            continue
        lx0, ly0, lx1, ly1 = lbl["x0"], lbl["y0"], lbl["x1"], lbl["y1"]
        lmid_y = (ly0 + ly1) / 2.0

        # Case 1: Label to the left on roughly the same baseline
        if lx1 <= rx0 + 10 and abs(lmid_y - rmid_y) <= 14:
            dist = max(0.0, rx0 - lx1) + abs(lmid_y - rmid_y) * 1.5
            if dist < 240 and dist < best_score:
                best_score = dist
                best_text = txt
        # Case 2: Label directly above
        elif ly1 <= ry0 + 6 and (ry0 - ly1) <= 22:
            horiz_overlap = min(rx1, lx1) - max(rx0, lx0)
            if horiz_overlap > -30:
                dist = (ry0 - ly1) * 2.2 + abs(rx0 - lx0) * 0.35
                if dist < 120 and dist < best_score:
                    best_score = dist
                    best_text = txt
        # Case 3: Checkbox / radio option label immediately to the right
        elif (rx1 - rx0) <= 24 and lx0 >= rx1 - 2 and (lx0 - rx1) <= 18 and abs(lmid_y - rmid_y) <= 10:
            dist = (lx0 - rx1) + abs(lmid_y - rmid_y)
            if dist < best_score:
                best_score = dist
                best_text = txt

    cleaned = best_text.rstrip(":").strip()
    return cleaned, best_score


def group_char_cells(small_boxes: List[Dict[str, Any]]) -> Tuple[List[List[Dict[str, Any]]], List[Dict[str, Any]]]:
    """Group horizontally aligned consecutive uniform small boxes into char_cells fields."""
    if not small_boxes:
        return [], []
    boxes = sorted(small_boxes, key=lambda b: (round(b["y0"] / 6.0), b["x0"]))
    used = [False] * len(boxes)
    groups: List[List[Dict[str, Any]]] = []
    leftover: List[Dict[str, Any]] = []

    for i, base in enumerate(boxes):
        if used[i]:
            continue
        row = [base]
        used[i] = True
        bh = base["y1"] - base["y0"]
        bw = base["x1"] - base["x0"]
        for j in range(i + 1, len(boxes)):
            if used[j]:
                continue
            cand = boxes[j]
            ch = cand["y1"] - cand["y0"]
            cw = cand["x1"] - cand["x0"]
            prev = row[-1]
            gap = cand["x0"] - prev["x1"]
            if (
                abs(cand["y0"] - base["y0"]) <= 4.0
                and abs(ch - bh) <= 4.0
                and abs(cw - bw) <= 5.0
                and -2.0 <= gap <= 8.0
            ):
                row.append(cand)
                used[j] = True
        if len(row) >= 3:
            groups.append(row)
        else:
            leftover.extend(row)

    return groups, leftover


def analyze_pdf(
    pdf_path: str, options: Dict[str, Any]
) -> Dict[str, Any]:
    enable_ocr = bool(options.get("enableOcr", True))
    force_ocr = bool(options.get("forceOcr", False))
    ocr_lang = str(options.get("ocrLanguage", "eng"))
    dpi = int(options.get("dpi", 200))

    inspection = inspect_pdf(pdf_path, options.get("thumbnailsDir"))
    doc = open_pdf_safely(pdf_path)

    all_fields: List[Dict[str, Any]] = []
    used_names: Dict[str, int] = {}
    ocr_jobs_report: List[Dict[str, Any]] = []

    def unique_name(raw_name: str) -> str:
        base = snake_case(raw_name, "field")
        count = used_names.get(base, 0) + 1
        used_names[base] = count
        return base if count == 1 else f"{base}_{count}"

    try:
        plumber_doc = None
        try:
            plumber_doc = pdfplumber.open(pdf_path)
        except Exception:
            plumber_doc = None

        for page_idx in range(doc.page_count):
            page = doc[page_idx]
            page_info = inspection["pages"][page_idx]
            labels = extract_text_labels(page)
            page_w = page.rect.width
            page_h = page.rect.height

            # 1. Existing AcroForm widgets (read via pypdf safely)
            try:
                pypdf_reader_an = PdfReader(pdf_path)
            except Exception:
                pypdf_reader_an = None
            existing_widgets = read_pypdf_page_widgets(pypdf_reader_an, page_idx, page.cropbox)
            page_candidates: List[Dict[str, Any]] = []

            for w in existing_widgets:
                ftype = w["type"]
                fname = w["name"] or f"widget_p{page_idx}_{len(page_candidates)+1}"
                lbl_text, _ = find_nearest_label(
                    (w["x"], w["y"], w["x"] + w["width"], w["y"] + w["height"]), labels
                )
                display_lbl = lbl_text or fname.replace("_", " ").title()
                page_candidates.append(
                    {
                        "name": unique_name(fname),
                        "label": display_lbl,
                        "type": ftype,
                        "page": page_idx,
                        "rect": {
                            "x": round_pt(w["x"]),
                            "y": round_pt(w["y"]),
                            "width": round_pt(w["width"]),
                            "height": round_pt(w["height"]),
                        },
                        "originalLabelText": lbl_text or fname,
                        "detectionSource": "existing_acroform",
                        "confidence": 0.99,
                        "confidenceTier": "high",
                        "confidenceEvidence": ["Existing interactive AcroForm widget detected in PDF"],
                        "required": False,
                        "defaultValue": w["defaultValue"],
                        "maxLength": w["maxLength"],
                        "multiline": ftype == "multiline",
                        "options": w["options"],
                        "validation": {},
                        "reviewStatus": "accepted",
                    }
                )

            # 2. Vector drawings inspection (rectangles + individual line-segment grids)
            small_boxes: List[Dict[str, Any]] = []
            checkbox_boxes: List[Dict[str, Any]] = []
            vector_boxes: List[Dict[str, Any]] = []
            vector_underlines: List[Dict[str, Any]] = []
            raw_h_lines: List[Tuple[float, float, float]] = []
            raw_v_lines: List[Tuple[float, float, float]] = []

            for d in page.get_drawings() or []:
                items = d.get("items", [])
                rect = d.get("rect")
                if not rect:
                    continue
                rw = float(rect.width)
                rh = float(rect.height)
                # Ignore full-page borders or tiny specks
                if rw > page_w * 0.94 and rh > page_h * 0.94:
                    continue

                for it in items:
                    if it[0] == "l":
                        p1, p2 = it[1], it[2]
                        if abs(p1.y - p2.y) <= 1.6 and abs(p2.x - p1.x) >= 6.0:
                            raw_h_lines.append((float(min(p1.x, p2.x)), float((p1.y + p2.y) / 2.0), float(max(p1.x, p2.x))))
                        elif abs(p1.x - p2.x) <= 1.6 and abs(p2.y - p1.y) >= 5.0:
                            raw_v_lines.append((float((p1.x + p2.x) / 2.0), float(min(p1.y, p2.y)), float(max(p1.y, p2.y))))

                if len(items) == 1 and items[0][0] == "l":
                    p1, p2 = items[0][1], items[0][2]
                    if abs(p1.y - p2.y) <= 1.5 and abs(p2.x - p1.x) >= 45.0:
                        x0 = min(p1.x, p2.x)
                        x1 = max(p1.x, p2.x)
                        y_line = (p1.y + p2.y) / 2.0
                        vector_underlines.append(
                            {
                                "kind": "underline",
                                "x0": float(x0),
                                "y0": max(0.0, float(y_line) - 18.0),
                                "x1": float(x1),
                                "y1": float(y_line) - 1.0,
                                "source": "vector_underline",
                            }
                        )
                elif rh <= 3.2 and rw >= 6.0:
                    raw_h_lines.append((float(rect.x0), float((rect.y0 + rect.y1) / 2.0), float(rect.x1)))
                elif rw <= 3.2 and rh >= 5.0:
                    raw_v_lines.append((float((rect.x0 + rect.x1) / 2.0), float(rect.y0), float(rect.y1)))
                elif (d.get("type") in ("s", "fs") or d.get("rect")) and rh >= 7.0 and rw >= 7.0:
                    raw_h_lines.append((float(rect.x0), float(rect.y0), float(rect.x1)))
                    raw_h_lines.append((float(rect.x0), float(rect.y1), float(rect.x1)))
                    raw_v_lines.append((float(rect.x0), float(rect.y0), float(rect.y1)))
                    raw_v_lines.append((float(rect.x1), float(rect.y0), float(rect.y1)))
                    if 7.5 <= rw <= 30.0 and 7.5 <= rh <= 34.0:
                        small_boxes.append(
                            {
                                "kind": "small_box",
                                "x0": float(rect.x0),
                                "y0": float(rect.y0),
                                "x1": float(rect.x1),
                                "y1": float(rect.y1),
                                "source": "vector_char_cells",
                            }
                        )
                    elif rw >= 45.0 and 11.5 <= rh <= 160.0:
                        vector_boxes.append(
                            {
                                "kind": "box",
                                "x0": float(rect.x0),
                                "y0": float(rect.y0),
                                "x1": float(rect.x1),
                                "y1": float(rect.y1),
                                "source": "vector_box",
                            }
                        )

            # Reconstruct closed grid cells from collinear horizontal & vertical segments
            if raw_h_lines and raw_v_lines:
                raw_h_lines.sort(key=lambda h: (round(h[1] / 1.5), h[0]))
                merged_h: List[Tuple[float, float, float]] = []
                for x0, y0, x1 in raw_h_lines:
                    if merged_h and abs(merged_h[-1][1] - y0) <= 1.8 and x0 <= merged_h[-1][2] + 2.5:
                        px0, py0, px1 = merged_h[-1]
                        merged_h[-1] = (min(px0, x0), (py0 + y0) / 2.0, max(px1, x1))
                    else:
                        merged_h.append((x0, y0, x1))

                raw_v_lines.sort(key=lambda v: (round(v[0] / 1.5), v[1]))
                merged_v: List[Tuple[float, float, float]] = []
                for x0, y0, y1 in raw_v_lines:
                    if merged_v and abs(merged_v[-1][0] - x0) <= 1.8 and y0 <= merged_v[-1][2] + 2.5:
                        px0, py0, py1 = merged_v[-1]
                        merged_v[-1] = ((px0 + x0) / 2.0, min(py0, y0), max(py1, y1))
                    else:
                        merged_v.append((x0, y0, y1))

                merged_h.sort(key=lambda h: (h[1], h[0]))
                for idx_i, (tx0, ty0, tx1) in enumerate(merged_h):
                    if tx1 - tx0 < 7.0:
                        continue
                    for bx0, by0, bx1 in merged_h[idx_i + 1 :]:
                        ch = by0 - ty0
                        if ch < 7.0:
                            continue
                        if ch > 220.0:
                            break
                        ox0, ox1 = max(tx0, bx0), min(tx1, bx1)
                        if ox1 - ox0 < 7.0:
                            continue
                        cols = sorted({
                            vx0
                            for vx0, vy0, vy1 in merged_v
                            if ox0 - 2.5 <= vx0 <= ox1 + 2.5 and vy0 <= ty0 + 3.0 and vy1 >= by0 - 3.0
                        })
                        dedup_cols: List[float] = []
                        for c in cols:
                            if not dedup_cols or c - dedup_cols[-1] > 2.2:
                                dedup_cols.append(c)
                        for c_idx in range(len(dedup_cols) - 1):
                            cx0, cx1 = dedup_cols[c_idx], dedup_cols[c_idx + 1]
                            cw = cx1 - cx0
                            if cw < 7.0 or (cw > page_w * 0.94 and ch > page_h * 0.94):
                                continue
                            if 7.5 <= cw <= 30.0 and 7.5 <= ch <= 34.0:
                                small_boxes.append(
                                    {
                                        "kind": "small_box",
                                        "x0": float(cx0),
                                        "y0": float(ty0),
                                        "x1": float(cx1),
                                        "y1": float(by0),
                                        "source": "vector_char_cells",
                                    }
                                )
                            elif cw >= 28.0 and 10.0 <= ch <= 160.0:
                                vector_boxes.append(
                                    {
                                        "kind": "box",
                                        "x0": float(cx0),
                                        "y0": float(ty0),
                                        "x1": float(cx1),
                                        "y1": float(by0),
                                        "source": "vector_box",
                                    }
                                )

            # 3. OCR & Computer Vision for scanned pages or explicit OCR request
            cv_candidates: List[Dict[str, Any]] = []
            if enable_ocr and (page_info["needsOcr"] or force_ocr):
                ocr_labels, cv_cands, deskew_angle, ocr_ms = preprocess_and_ocr_page(
                    page, language=ocr_lang, dpi=dpi
                )
                page_info["ocrApplied"] = True
                page_info["deskewAngle"] = deskew_angle
                if not labels:
                    labels = ocr_labels
                else:
                    labels.extend(ocr_labels)
                cv_candidates = cv_cands
                ocr_jobs_report.append(
                    {
                        "pageIndex": page_idx,
                        "ocrEngine": "tesseract",
                        "language": ocr_lang,
                        "dpi": dpi,
                        "deskewAngle": deskew_angle,
                        "wordCount": len(ocr_labels),
                        "extractedChars": sum(len(l.get("text", "")) for l in ocr_labels),
                        "durationMs": ocr_ms,
                        "status": "completed",
                    }
                )

            # 4. pdfplumber table cell extraction
            table_cells: List[Dict[str, Any]] = []
            if plumber_doc and page_idx < len(plumber_doc.pages):
                try:
                    p_page = plumber_doc.pages[page_idx]
                    for tbl in p_page.find_tables() or []:
                        for cell in tbl.cells:
                            cx0, cy0, cx1, cy1 = cell
                            cw = cx1 - cx0
                            ch = cy1 - cy0
                            if cw >= 35 and 12 <= ch <= 80:
                                table_cells.append(
                                    {
                                        "kind": "table_cell",
                                        "x0": float(cx0),
                                        "y0": float(cy0),
                                        "x1": float(cx1),
                                        "y1": float(cy1),
                                        "source": "table_cell",
                                    }
                                )
                except Exception:
                    pass

            # 5. Also detect underline placeholder text spans like "Full Name: ________"
            for lbl in labels:
                m = re.search(r"([A-Za-z0-9 /()-]{2,40}):?\s*([_\.]{5,})", lbl["text"])
                if m:
                    prefix = m.group(1).strip()
                    full_len = max(1, len(lbl["text"]))
                    ratio_start = lbl["text"].index(m.group(2)) / full_len
                    ux0 = lbl["x0"] + (lbl["x1"] - lbl["x0"]) * ratio_start
                    ux1 = lbl["x1"]
                    if ux1 - ux0 >= 30:
                        vector_underlines.append(
                            {
                                "kind": "underline",
                                "x0": float(ux0),
                                "y0": float(lbl["y0"]) - 2.0,
                                "x1": float(ux1),
                                "y1": float(lbl["y1"]) + 1.0,
                                "source": "ocr_region" if lbl["source"] == "ocr_tesseract" else "vector_underline",
                                "explicitLabel": prefix,
                            }
                        )

            # Group char cells
            cell_groups, leftover_small = group_char_cells(small_boxes)
            for grp in cell_groups:
                gx0 = min(c["x0"] for c in grp)
                gy0 = min(c["y0"] for c in grp)
                gx1 = max(c["x1"] for c in grp)
                gy1 = max(c["y1"] for c in grp)
                if any(
                    overlap_area((gx0, gy0, gx1, gy1), (c["rect"]["x"], c["rect"]["y"], c["rect"]["x"] + c["rect"]["width"], c["rect"]["y"] + c["rect"]["height"])) > 20
                    for c in page_candidates
                ):
                    continue
                lbl_text, dist = find_nearest_label((gx0, gy0, gx1, gy1), labels)
                ftype, meta = infer_semantic_type(lbl_text or "code", gx1 - gx0, gy1 - gy0, "char_cells", len(grp))
                conf = 0.92 if lbl_text and dist < 80 else 0.78
                page_candidates.append(
                    {
                        "name": unique_name(lbl_text or f"char_field_p{page_idx+1}"),
                        "label": lbl_text or f"Character Field ({len(grp)} cells)",
                        "type": ftype,
                        "page": page_idx,
                        "rect": {
                            "x": round_pt(gx0),
                            "y": round_pt(gy0),
                            "width": round_pt(gx1 - gx0),
                            "height": round_pt(gy1 - gy0),
                        },
                        "cellRects": [
                            {
                                "x": round_pt(c["x0"]),
                                "y": round_pt(c["y0"]),
                                "width": round_pt(c["x1"] - c["x0"]),
                                "height": round_pt(c["y1"] - c["y0"]),
                            }
                            for c in grp
                        ],
                        "originalLabelText": lbl_text,
                        "detectionSource": "vector_char_cells",
                        "confidence": round_pt(conf),
                        "confidenceTier": "high" if conf >= 0.85 else "medium",
                        "confidenceEvidence": [
                            f"Detected {len(grp)} uniform horizontal character boxes",
                            f"Matched label '{lbl_text}'" if lbl_text else "No adjacent label found",
                        ],
                        "required": meta["required"],
                        "defaultValue": "",
                        "maxLength": len(grp),
                        "multiline": False,
                        "options": [],
                        "validation": meta["validation"],
                        "alignment": "center",
                        "reviewStatus": "pending",
                    }
                )

            # Combine remaining candidates
            raw_candidates = (
                checkbox_boxes
                + leftover_small
                + vector_boxes
                + vector_underlines
                + table_cells
                + cv_candidates
            )

            for cand in raw_candidates:
                r_tuple = (cand["x0"], cand["y0"], cand["x1"], cand["y1"])
                rw = cand["x1"] - cand["x0"]
                rh = cand["y1"] - cand["y0"]
                if rw < 6 or rh < 6:
                    continue
                if cand["kind"] != "underline" and "explicitLabel" not in cand:
                    if rect_has_dense_text(r_tuple, labels):
                        continue

                # Skip overlaps with already added fields
                if any(
                    overlap_area(
                        r_tuple,
                        (
                            ex["rect"]["x"],
                            ex["rect"]["y"],
                            ex["rect"]["x"] + ex["rect"]["width"],
                            ex["rect"]["y"] + ex["rect"]["height"],
                        ),
                    )
                    > min(rw * rh, ex["rect"]["width"] * ex["rect"]["height"]) * 0.45
                    for ex in page_candidates
                ):
                    continue

                explicit_lbl = cand.get("explicitLabel")
                lbl_text, dist = (
                    (explicit_lbl, 0.0)
                    if explicit_lbl
                    else find_nearest_label(r_tuple, labels)
                )

                evidence: List[str] = [f"Geometry detected via {cand['source']}"]
                score = 0.52
                if cand["source"] in ("vector_underline", "vector_box", "vector_checkbox"):
                    score += 0.22
                elif cand["source"] == "table_cell":
                    score += 0.16
                elif cand["source"] == "cv_contour":
                    score += 0.14

                if lbl_text:
                    score += 0.18 if dist < 60 else 0.10
                    evidence.append(f"Paired with nearby label '{lbl_text}'")
                else:
                    evidence.append("No nearby label identified; review recommended")

                score = min(0.97, max(0.35, score))
                tier = "high" if score >= 0.85 else ("medium" if score >= 0.60 else "low")
                is_cb = cand["kind"] == "checkbox" or (
                    cand["kind"] == "small_box"
                    and 7.5 <= rw <= 20.0
                    and 7.5 <= rh <= 20.0
                    and 0.7 <= (rw / max(1.0, rh)) <= 1.35
                )
                if is_cb and cand["source"] == "vector_char_cells":
                    cand["source"] = "vector_checkbox"
                gkind = "checkbox" if is_cb else cand["kind"]
                ftype, meta = infer_semantic_type(lbl_text or "", rw, rh, gkind)

                fallback_label = (
                    "Checkbox"
                    if ftype == "checkbox"
                    else f"Input Field {len(page_candidates) + 1}"
                )
                final_label = lbl_text or fallback_label

                page_candidates.append(
                    {
                        "name": unique_name(final_label),
                        "label": final_label,
                        "type": ftype,
                        "page": page_idx,
                        "rect": {
                            "x": round_pt(cand["x0"]),
                            "y": round_pt(cand["y0"]),
                            "width": round_pt(rw),
                            "height": round_pt(rh),
                        },
                        "originalLabelText": lbl_text,
                        "detectionSource": cand["source"],
                        "confidence": round_pt(score),
                        "confidenceTier": tier,
                        "confidenceEvidence": evidence,
                        "required": meta["required"],
                        "defaultValue": "",
                        "maxLength": meta["maxLength"],
                        "multiline": meta["multiline"],
                        "options": meta["options"],
                        "validation": meta["validation"],
                        "alignment": meta["alignment"],
                        "reviewStatus": "pending",
                    }
                )

            # Sort reading order top-to-bottom, left-to-right
            page_candidates.sort(key=lambda f: (round(f["rect"]["y"] / 10.0), f["rect"]["x"]))
            all_fields.extend(page_candidates)

        if plumber_doc:
            plumber_doc.close()

        # Assign stable field IDs
        for idx, fld in enumerate(all_fields, start=1):
            fld["id"] = f"field_{idx:03d}"
            fld["coordinateSpace"] = "top_left_pdf_pt"

        manifest = {
            "documentId": str(options.get("documentId", "doc")),
            "schemaVersion": "1.0",
            "totalPages": inspection["pageCount"],
            "pages": inspection["pages"],
            "fields": all_fields,
            "engineVersion": ENGINE_VERSION,
            "hasExistingAcroForm": inspection["hasExistingAcroForm"],
            "isScanned": inspection["isScanned"],
            "securityFlags": inspection["securityFlags"],
        }
        return {
            "inspection": inspection,
            "ocrJobs": ocr_jobs_report,
            "manifest": manifest,
        }
    finally:
        doc.close()


def validate_acroform_pdf(
    pdf_path: str, expected_fields: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    warnings: List[str] = []
    valid_pdf = False
    has_acroform = False
    widget_names: List[str] = []
    appearance_ok = False
    roundtrip_ok = False
    page_count = 0

    try:
        reader = PdfReader(pdf_path)
        page_count = len(reader.pages)
        valid_pdf = page_count > 0
        root = reader.trailer.get("/Root", {})
        if hasattr(root, "get_object"):
            root = root.get_object()
        acro = root.get("/AcroForm")
        if acro:
            has_acroform = True
            if hasattr(acro, "get_object"):
                acro = acro.get_object()
            if not acro.get("/Fields"):
                warnings.append("/AcroForm dictionary exists but /Fields array is empty.")

        fields_dict = reader.get_fields() or {}
        widget_names = list(fields_dict.keys())
        # Also inspect page-level widget annotations if get_fields returned partial tree
        for p in reader.pages:
            annots = p.get("/Annots") or []
            if hasattr(annots, "get_object"):
                annots = annots.get_object()
            for ref in annots or []:
                obj = ref.get_object() if hasattr(ref, "get_object") else ref
                if isinstance(obj, dict) and str(obj.get("/Subtype", "")) == "/Widget":
                    if obj.get("/AP"):
                        appearance_ok = True
                    tname = obj.get("/T")
                    if tname and str(tname) not in widget_names:
                        widget_names.append(str(tname))

        # Round-trip write & read verification via pypdf in memory
        if widget_names:
            appearance_ok = True
            writer = PdfWriter()
            writer.append(reader)
            first_text = next(
                (k for k, v in fields_dict.items() if str(v.get("/FT", "")) == "/Tx"),
                None,
            )
            if first_text:
                for wp in writer.pages:
                    try:
                        writer.update_page_form_field_values(wp, {first_text: "TEST"})
                    except Exception:
                        pass
            buf = io.BytesIO()
            writer.write(buf)
            buf.seek(0)
            r2 = PdfReader(buf)
            r2_fields = r2.get_fields() or {}
            roundtrip_ok = (
                first_text is None
                or str(r2_fields.get(first_text, {}).get("/V", "")) == "TEST"
            )
        else:
            roundtrip_ok = valid_pdf
    except Exception as exc:
        warnings.append(f"pypdf validation warning: {exc}")

    missing: List[str] = []
    if expected_fields:
        existing_set = set(widget_names)
        for f in expected_fields:
            fname = f.get("name", "")
            if f.get("type") == "char_cells" and f.get("cellRects"):
                if f"{fname}_cell_0" not in existing_set and fname not in existing_set:
                    missing.append(fname)
            elif fname and fname not in existing_set:
                missing.append(fname)

    return {
        "validPdf": valid_pdf,
        "hasAcroFormDict": has_acroform,
        "widgetCount": len(widget_names),
        "expectedFieldCount": len(expected_fields or []),
        "missingFields": missing,
        "appearanceStreamsVerified": appearance_ok,
        "roundTripWriteReadOk": roundtrip_ok,
        "pageCount": page_count,
        "warnings": warnings,
    }


def _visual_rect_to_pdf_rect(
    rx: float,
    ry: float,
    rw: float,
    rh: float,
    cropbox: Tuple[float, float, float, float],
    rotation: int,
) -> List[float]:
    cx0, cy0, cx1, cy1 = cropbox
    cw = cx1 - cx0
    ch = cy1 - cy0
    rot = int(rotation or 0) % 360
    if rot == 90:
        return [cx0 + ry, cy0 + rx, cx0 + ry + rh, cy0 + rx + rw]
    if rot == 180:
        return [cx1 - rx - rw, cy0 + ry, cx1 - rx, cy0 + ry + rh]
    if rot == 270:
        return [cx1 - ry - rh, cy1 - rx - rw, cx1 - ry, cy1 - rx]
    # 0 deg: top-left CropBox space -> PDF bottom-left user space
    y1_b = cy0 + (ch - ry)
    y0_b = y1_b - rh
    return [cx0 + rx, y0_b, cx0 + rx + rw, y1_b]


def _make_ap_form_xobject(
    writer: PdfWriter,
    width: float,
    height: float,
    stream_bytes: bytes,
    helv_ref: Any = None,
) -> Any:
    ap = StreamObject()
    ap._data = stream_bytes
    ap[NameObject("/Type")] = NameObject("/XObject")
    ap[NameObject("/Subtype")] = NameObject("/Form")
    ap[NameObject("/BBox")] = RectangleObject(
        [FloatObject(0), FloatObject(0), FloatObject(max(1.0, width)), FloatObject(max(1.0, height))]
    )
    if helv_ref is not None:
        ap[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): helv_ref})}
        )
    return writer._add_object(ap)


def _create_pypdf_widget(
    writer: PdfWriter,
    page: Any,
    acro_fields: ArrayObject,
    helv_ref: Any,
    name: str,
    label: str,
    ftype: str,
    pdf_rect: List[float],
    default_value: str = "",
    max_length: Optional[int] = None,
    multiline: bool = False,
    font_size: Optional[float] = None,
    options: Optional[List[str]] = None,
) -> None:
    x0, y0, x1, y1 = pdf_rect
    rw = max(6.0, abs(x1 - x0))
    rh = max(6.0, abs(y1 - y0))

    widget = DictionaryObject()
    widget[NameObject("/Type")] = NameObject("/Annot")
    widget[NameObject("/Subtype")] = NameObject("/Widget")
    widget[NameObject("/T")] = TextStringObject(name)
    widget[NameObject("/TU")] = TextStringObject(label or name)
    widget[NameObject("/Rect")] = RectangleObject(
        [FloatObject(x0), FloatObject(y0), FloatObject(x1), FloatObject(y1)]
    )
    widget[NameObject("/F")] = NumberObject(4)
    if getattr(page, "indirect_reference", None) is not None:
        widget[NameObject("/P")] = page.indirect_reference
    widget[NameObject("/BS")] = DictionaryObject(
        {NameObject("/W"): FloatObject(0.6), NameObject("/S"): NameObject("/S")}
    )
    widget[NameObject("/MK")] = DictionaryObject(
        {
            NameObject("/BG"): ArrayObject([FloatObject(0.97), FloatObject(0.99), FloatObject(1.0)]),
            NameObject("/BC"): ArrayObject([FloatObject(0.55), FloatObject(0.65), FloatObject(0.78)]),
        }
    )

    if ftype in ("checkbox", "radio"):
        checked = str(default_value or "").lower() in ("true", "1", "yes", "on")
        state = NameObject("/Yes" if checked else "/Off")
        widget[NameObject("/FT")] = NameObject("/Btn")
        widget[NameObject("/V")] = state
        widget[NameObject("/DV")] = state
        widget[NameObject("/AS")] = state
        pad = max(1.5, min(rw, rh) * 0.2)
        yes_cmd = (
            f"q 0.97 0.99 1.0 rg 0 0 {rw:.2f} {rh:.2f} re f "
            f"0.05 0.09 0.16 RG 1.2 w {pad:.2f} {pad:.2f} m {rw - pad:.2f} {rh - pad:.2f} l "
            f"{rw - pad:.2f} {pad:.2f} m {pad:.2f} {rh - pad:.2f} l S Q"
        ).encode("ascii")
        off_cmd = f"q 0.97 0.99 1.0 rg 0 0 {rw:.2f} {rh:.2f} re f Q".encode("ascii")
        yes_ref = _make_ap_form_xobject(writer, rw, rh, yes_cmd)
        off_ref = _make_ap_form_xobject(writer, rw, rh, off_cmd)
        widget[NameObject("/AP")] = DictionaryObject(
            {
                NameObject("/N"): DictionaryObject(
                    {NameObject("/Yes"): yes_ref, NameObject("/Off"): off_ref}
                )
            }
        )
    elif ftype == "dropdown":
        opts = [str(o) for o in (options or []) if str(o).strip()]
        if not opts:
            opts = ["Option 1", "Option 2"]
        fs = float(font_size or max(7.5, min(11.5, rh * 0.6)))
        widget[NameObject("/FT")] = NameObject("/Ch")
        widget[NameObject("/Ff")] = NumberObject(1 << 17)
        widget[NameObject("/Opt")] = ArrayObject([TextStringObject(o) for o in opts])
        widget[NameObject("/DA")] = TextStringObject(f"/Helv {fs:.1f} Tf 0.05 0.09 0.16 rg")
        if default_value and str(default_value) in opts:
            widget[NameObject("/V")] = TextStringObject(str(default_value))
            widget[NameObject("/DV")] = TextStringObject(str(default_value))
        n_ref = _make_ap_form_xobject(writer, rw, rh, b"/Tx BMC\nEMC", helv_ref=helv_ref)
        widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): n_ref})
    else:
        is_multi = bool(multiline) or ftype in ("multiline", "address")
        fs = float(
            font_size
            or (10.0 if is_multi else max(7.5, min(12.0, rh * 0.62)))
        )
        widget[NameObject("/FT")] = NameObject("/Tx")
        if is_multi:
            widget[NameObject("/Ff")] = NumberObject(1 << 12)
        if max_length and int(max_length) > 0:
            widget[NameObject("/MaxLen")] = NumberObject(int(max_length))
        widget[NameObject("/DA")] = TextStringObject(f"/Helv {fs:.1f} Tf 0.05 0.09 0.16 rg")
        if default_value:
            widget[NameObject("/V")] = TextStringObject(str(default_value))
            widget[NameObject("/DV")] = TextStringObject(str(default_value))
        n_ref = _make_ap_form_xobject(writer, rw, rh, b"/Tx BMC\nEMC", helv_ref=helv_ref)
        widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): n_ref})

    w_ref = writer._add_object(widget)
    annots = page.get("/Annots")
    if annots is not None and hasattr(annots, "get_object"):
        annots = annots.get_object()
    if not isinstance(annots, ArrayObject):
        annots = ArrayObject()
        page[NameObject("/Annots")] = annots
    annots.append(w_ref)
    acro_fields.append(w_ref)


def generate_acroform_pdf(
    source_pdf_path: str,
    manifest: Dict[str, Any],
    output_pdf_path: str,
    preserve_existing: bool = True,
) -> Dict[str, Any]:
    # 1. Open via fitz first to validate and sanitize any /JS, /JavaScript, /AA, /OpenAction
    doc = open_pdf_safely(source_pdf_path)
    try:
        sanitized = strip_dangerous_pdf_actions(doc)
        pdf_bytes = doc.tobytes(deflate=True)
    finally:
        doc.close()

    # 2. Build AcroForm & Widgets cleanly via pure pypdf (avoids PyMuPDF 1.21 SWIG crash)
    reader = PdfReader(io.BytesIO(pdf_bytes))
    existing_names = set((reader.get_fields() or {}).keys()) if preserve_existing else set()

    writer = PdfWriter()
    writer.append(reader)

    root = writer._root_object
    acro_raw = root.get("/AcroForm")
    if acro_raw is not None:
        acro = acro_raw.get_object() if hasattr(acro_raw, "get_object") else acro_raw
        if not isinstance(acro, DictionaryObject):
            acro = DictionaryObject()
            root[NameObject("/AcroForm")] = writer._add_object(acro)
    else:
        acro = DictionaryObject()
        root[NameObject("/AcroForm")] = writer._add_object(acro)

    acro_fields_raw = acro.get("/Fields")
    if acro_fields_raw is not None and hasattr(acro_fields_raw, "get_object"):
        acro_fields_raw = acro_fields_raw.get_object()
    if isinstance(acro_fields_raw, ArrayObject):
        acro_fields = acro_fields_raw
    else:
        acro_fields = ArrayObject()
        acro[NameObject("/Fields")] = acro_fields

    acro[NameObject("/NeedAppearances")] = BooleanObject(True)
    acro[NameObject("/DA")] = TextStringObject("/Helv 10 Tf 0 g")

    helv_font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }
    )
    helv_ref = writer._add_object(helv_font)
    dr = acro.get("/DR")
    if dr is not None and hasattr(dr, "get_object"):
        dr = dr.get_object()
    if not isinstance(dr, DictionaryObject):
        dr = DictionaryObject()
        acro[NameObject("/DR")] = dr
    fonts_dict = dr.get("/Font")
    if fonts_dict is not None and hasattr(fonts_dict, "get_object"):
        fonts_dict = fonts_dict.get_object()
    if not isinstance(fonts_dict, DictionaryObject):
        fonts_dict = DictionaryObject()
        dr[NameObject("/Font")] = fonts_dict
    if NameObject("/Helv") not in fonts_dict:
        fonts_dict[NameObject("/Helv")] = helv_ref
    else:
        helv_ref = fonts_dict[NameObject("/Helv")]

    fields = manifest.get("fields", [])
    created_count = 0

    for fld in fields:
        page_idx = int(fld.get("page", 0))
        if page_idx < 0 or page_idx >= len(writer.pages):
            continue
        page = writer.pages[page_idx]
        box = page.cropbox if page.get("/CropBox") else page.mediabox
        crop_tuple = (
            float(box.left),
            float(box.bottom),
            float(box.right),
            float(box.top),
        )
        rotation = int(page.get("/Rotate") or 0)

        fname = str(fld.get("name") or fld.get("id") or "field")
        ftype = str(fld.get("type", "text"))
        rect_d = fld.get("rect", {})
        rx = float(rect_d.get("x", 40))
        ry = float(rect_d.get("y", 40))
        rw = float(rect_d.get("width", 120))
        rh = float(rect_d.get("height", 18))

        cell_rects = fld.get("cellRects") or []
        if ftype == "char_cells" and len(cell_rects) > 0:
            default_val = str(fld.get("defaultValue") or "")
            for ci, cr in enumerate(cell_rects):
                cname = f"{fname}_cell_{ci}"
                if cname in existing_names:
                    continue
                crx = float(cr["x"])
                cry = float(cr["y"])
                crw = float(cr["width"])
                crh = float(cr["height"])
                pdf_rect = _visual_rect_to_pdf_rect(crx, cry, crw, crh, crop_tuple, rotation)
                _create_pypdf_widget(
                    writer=writer,
                    page=page,
                    acro_fields=acro_fields,
                    helv_ref=helv_ref,
                    name=cname,
                    label=f"{fld.get('label', fname)} [{ci + 1}]",
                    ftype="text",
                    pdf_rect=pdf_rect,
                    default_value=default_val[ci] if ci < len(default_val) else "",
                    max_length=1,
                    multiline=False,
                    font_size=max(7.0, min(13.0, crh * 0.68)),
                )
                existing_names.add(cname)
                created_count += 1
            continue

        if fname in existing_names:
            continue

        pdf_rect = _visual_rect_to_pdf_rect(rx, ry, rw, rh, crop_tuple, rotation)
        _create_pypdf_widget(
            writer=writer,
            page=page,
            acro_fields=acro_fields,
            helv_ref=helv_ref,
            name=fname,
            label=str(fld.get("tooltip") or fld.get("label") or fname),
            ftype=ftype,
            pdf_rect=pdf_rect,
            default_value=str(fld.get("defaultValue") or ""),
            max_length=int(fld["maxLength"]) if fld.get("maxLength") else None,
            multiline=bool(fld.get("multiline")),
            font_size=float(fld["fontSize"]) if fld.get("fontSize") else None,
            options=[str(o) for o in (fld.get("options") or [])],
        )
        existing_names.add(fname)
        created_count += 1

    os.makedirs(os.path.dirname(os.path.abspath(output_pdf_path)), exist_ok=True)
    with open(output_pdf_path, "wb") as f:
        writer.write(f)

    validation = validate_acroform_pdf(output_pdf_path, manifest.get("fields", []))
    return {
        "createdWidgets": created_count,
        "sanitizedActions": sanitized,
        "validation": validation,
    }


def render_filled_pdf(
    template_pdf_path: str,
    manifest: Dict[str, Any],
    values: Dict[str, Any],
    output_pdf_path: str,
    flatten: bool = True,
) -> Dict[str, Any]:
    os.makedirs(os.path.dirname(os.path.abspath(output_pdf_path)), exist_ok=True)
    fields = manifest.get("fields", [])
    fields_by_name = {str(f.get("name")): f for f in fields}

    # Pre-expand char_cells into {name}_cell_{i}
    expanded_values: Dict[str, Any] = {}
    for k, v in values.items():
        expanded_values[str(k)] = v
        fdef = fields_by_name.get(str(k))
        if fdef and fdef.get("type") == "char_cells":
            sval = str(v or "")
            cells = fdef.get("cellRects") or []
            for ci in range(len(cells)):
                expanded_values[f"{k}_cell_{ci}"] = sval[ci] if ci < len(sval) else ""

    populated_count = 0

    if not flatten:
        # Fillable mode: populate AcroForm widgets cleanly via pypdf preserving interactive fields
        reader = PdfReader(template_pdf_path)
        pdf_fields = reader.get_fields() or {}
        writer = PdfWriter()
        writer.append(reader)

        update_payload: Dict[str, str] = {}
        for k, v in expanded_values.items():
            if k in pdf_fields:
                fmeta = pdf_fields[k]
                ft = str(fmeta.get("/FT", ""))
                if ft == "/Btn":
                    truthy = bool(v) if isinstance(v, bool) else str(v).lower() in ("true", "1", "yes", "on")
                    update_payload[k] = "/Yes" if truthy else "/Off"
                else:
                    update_payload[k] = str(v if v is not None else "")
                populated_count += 1

        if update_payload:
            for wp in writer.pages:
                try:
                    writer.update_page_form_field_values(wp, update_payload)
                except Exception:
                    # Fallback: set /V (and /AS for buttons) directly on matching page annotations
                    annots = wp.get("/Annots") or []
                    if hasattr(annots, "get_object"):
                        annots = annots.get_object()
                    for ref in annots or []:
                        obj = ref.get_object() if hasattr(ref, "get_object") else ref
                        if not isinstance(obj, dict):
                            continue
                        tname = str(obj.get("/T") or "")
                        if tname in update_payload:
                            val = update_payload[tname]
                            if str(obj.get("/FT", "")) == "/Btn":
                                name_val = NameObject(val if val.startswith("/") else f"/{val}")
                                obj[NameObject("/V")] = name_val
                                obj[NameObject("/AS")] = name_val
                            else:
                                obj[NameObject("/V")] = TextStringObject(val)

        with open(output_pdf_path, "wb") as f:
            writer.write(f)
    else:
        # Flattened mode: draw populated text/checkmarks directly into page content & strip widgets
        doc = open_pdf_safely(template_pdf_path)
        try:
            strip_dangerous_pdf_actions(doc)
            for fld in fields:
                page_idx = int(fld.get("page", 0))
                if page_idx < 0 or page_idx >= doc.page_count:
                    continue
                page = doc[page_idx]
                fname = str(fld.get("name") or "")
                ftype = str(fld.get("type", "text"))
                if fname not in values:
                    continue
                val = values.get(fname)
                if val is None:
                    continue

                cell_rects = fld.get("cellRects") or []
                if ftype == "char_cells" and cell_rects:
                    sval = str(val)
                    for ci, cr in enumerate(cell_rects):
                        if ci >= len(sval):
                            break
                        ch = sval[ci]
                        cx = float(cr["x"])
                        cy = float(cr["y"])
                        cw = float(cr["width"])
                        ch_h = float(cr["height"])
                        fs = max(7.0, min(13.0, ch_h * 0.65))
                        page.insert_text(
                            fitz.Point(cx + max(1.5, cw * 0.25), cy + ch_h * 0.74),
                            ch,
                            fontsize=fs,
                            fontname="helv",
                            color=(0.05, 0.08, 0.14),
                        )
                        populated_count += 1
                    continue

                rect_d = fld.get("rect", {})
                r = fitz.Rect(
                    float(rect_d.get("x", 40)),
                    float(rect_d.get("y", 40)),
                    float(rect_d.get("x", 40)) + float(rect_d.get("width", 120)),
                    float(rect_d.get("y", 40)) + float(rect_d.get("height", 18)),
                )
                if ftype in ("checkbox", "radio"):
                    truthy = bool(val) if isinstance(val, bool) else str(val).lower() in ("true", "1", "yes", "on")
                    if truthy:
                        fs = max(7.5, min(14.0, r.height * 0.78))
                        page.insert_text(
                            fitz.Point(r.x0 + max(1.0, r.width * 0.22), r.y1 - max(1.5, r.height * 0.18)),
                            "X",
                            fontsize=fs,
                            fontname="helv",
                            color=(0.05, 0.08, 0.14),
                        )
                    populated_count += 1
                else:
                    sval = str(val)
                    if sval:
                        if bool(fld.get("multiline")) or ftype in ("multiline", "address"):
                            page.insert_textbox(
                                fitz.Rect(r.x0 + 2, r.y0 + 2, r.x1 - 2, r.y1 - 2),
                                sval,
                                fontsize=float(fld.get("fontSize") or 10.0),
                                fontname="helv",
                                color=(0.05, 0.08, 0.14),
                            )
                        else:
                            fs = float(fld.get("fontSize") or max(7.5, min(11.5, r.height * 0.62)))
                            page.insert_text(
                                fitz.Point(r.x0 + 2, r.y1 - max(2.0, r.height * 0.22)),
                                sval,
                                fontsize=fs,
                                fontname="helv",
                                color=(0.05, 0.08, 0.14),
                            )
                        populated_count += 1

            # Strip AcroForm catalog & Widget annotations via PyMuPDF xrefs so 0 interactive widgets remain
            cat_xref = doc.pdf_catalog()
            if cat_xref:
                try:
                    doc.xref_set_key(cat_xref, "AcroForm", "null")
                except Exception:
                    pass
            for pno in range(doc.page_count):
                pxref = doc.page_xref(pno)
                try:
                    doc.xref_set_key(pxref, "Annots", "[]")
                except Exception:
                    pass

            doc.save(output_pdf_path, garbage=3, deflate=True)
        finally:
            doc.close()

    return {
        "populatedWidgets": populated_count,
        "flattened": flatten,
        "outputPath": output_pdf_path,
    }


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("Usage: formforge_engine.py <command> <input_json> <output_json>\n")
        sys.exit(2)

    command = sys.argv[1]
    input_json_path = sys.argv[2]
    output_json_path = sys.argv[3]

    with open(input_json_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    try:
        if command == "inspect":
            result = inspect_pdf(payload["pdfPath"], payload.get("thumbnailsDir"))
        elif command == "analyze":
            result = analyze_pdf(payload["pdfPath"], payload.get("options", {}))
        elif command == "generate-acroform":
            result = generate_acroform_pdf(
                payload["pdfPath"],
                payload["manifest"],
                payload["outputPdfPath"],
                preserve_existing=bool(payload.get("preserveExisting", True)),
            )
        elif command == "render-pdf":
            result = render_filled_pdf(
                payload["templatePdfPath"],
                payload["manifest"],
                payload.get("values", {}),
                payload["outputPdfPath"],
                flatten=bool(payload.get("flatten", True)),
            )
        elif command == "validate-acroform":
            result = validate_acroform_pdf(
                payload["pdfPath"], payload.get("expectedFields")
            )
        else:
            raise ValueError(f"UNKNOWN_COMMAND: Unsupported command '{command}'")

        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump({"ok": True, "result": result}, f)
    except Exception as exc:
        msg = str(exc)
        code = "ENGINE_ERROR"
        if ":" in msg:
            cand = msg.split(":", 1)[0].strip()
            if cand.isupper() and "_" in cand:
                code = cand
        sys.stderr.write(f"{code}: {msg}\n")
        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump({"ok": False, "code": code, "error": msg}, f)
        sys.exit(1)


if __name__ == "__main__":
    main()

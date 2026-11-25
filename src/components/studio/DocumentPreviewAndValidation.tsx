import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileCheck2,
  Play,
  ShieldCheck,
} from "lucide-react";
import type {
  AcroFormValidationReport,
  DetectedFormField,
  FieldManifest,
} from "../../lib/formifypdf/types.ts";
import type { StudioApiClient } from "./studio-api.ts";

if (typeof window !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
}

interface PreviewProps {
  api: StudioApiClient;
  documentId: string;
  documentTitle: string;
  templateId?: string | null;
  templateStatus?: string | null;
  canApprove: boolean;
  onApproved?: () => void;
}

function PdfCanvasPane({
  title,
  pdfBytes,
  pageIndex,
  scale,
}: {
  title: string;
  pdfBytes: Uint8Array | null;
  pageIndex: number;
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let doc: pdfjsLib.PDFDocumentProxy | null = null;
    if (!pdfBytes) return;

    (async () => {
      try {
        setRenderError(null);
        loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
        doc = await loadingTask.promise;
        if (cancelled) return;
        const page = await doc.getPage(Math.min(pageIndex + 1, doc.numPages));
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      } catch (err) {
        if (!cancelled) {
          setRenderError(err instanceof Error ? err.message : "Preview unavailable");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (doc) {
        void Promise.resolve(doc.cleanup?.()).catch(() => {});
      }
      if (loadingTask) {
        void Promise.resolve(loadingTask.destroy?.()).catch(() => {});
      }
    };
  }, [pdfBytes, pageIndex, scale]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-3.5 py-2 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-900">{title}</span>
        {pdfBytes && (
          <span className="text-[11px] text-slate-500 tabular-nums">
            {(pdfBytes.byteLength / 1024).toFixed(1)} KB
          </span>
        )}
      </div>
      <div className="p-3 bg-slate-100 overflow-auto max-h-[540px] flex justify-center">
        {!pdfBytes ? (
          <p className="py-12 text-xs text-slate-500">No PDF loaded in this pane yet.</p>
        ) : renderError ? (
          <p className="py-12 text-xs text-slate-600">{renderError}</p>
        ) : (
          <canvas ref={canvasRef} className="bg-white border border-slate-300 shadow-sm" />
        )}
      </div>
    </div>
  );
}

export function DocumentPreviewAndValidation({
  api,
  documentId,
  documentTitle,
  templateId,
  templateStatus,
  canApprove,
  onApproved,
}: PreviewProps) {
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [acroBytes, setAcroBytes] = useState<Uint8Array | null>(null);
  const [testFillBytes, setTestFillBytes] = useState<Uint8Array | null>(null);

  const [manifest, setManifest] = useState<FieldManifest | null>(null);
  const [validation, setValidation] = useState<AcroFormValidationReport | null>(null);
  const [sampleValues, setSampleValues] = useState<Record<string, unknown>>({});

  const [pageIndex, setPageIndex] = useState(0);
  const [scale, setScale] = useState(0.85);
  const [activeCompare, setActiveCompare] = useState<"acroform" | "test_fill">("acroform");

  const [structuralChecked, setStructuralChecked] = useState(false);
  const [visualChecked, setVisualChecked] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setTestFillBytes(null);

    (async () => {
      try {
        const [docDetail, manRes, srcPdf] = await Promise.all([
          api.json<{
            ok: boolean;
            latestAsset?: { validation_report_json?: string | null };
          }>(`/api/v1/documents/${documentId}`),
          api.json<{ ok: boolean; manifest: FieldManifest }>(
            `/api/v1/documents/${documentId}/manifest`
          ),
          api.fetchPdfBytes(`/api/v1/documents/${documentId}/pdf`),
        ]);
        if (!active) return;

        setManifest(manRes.manifest);
        setSourceBytes(srcPdf);

        // Initialize default sample values
        const initVals: Record<string, unknown> = {};
        for (const f of manRes.manifest.fields) {
          initVals[f.name] = f.defaultValue || (f.type === "checkbox" ? false : "");
        }
        setSampleValues(initVals);

        if (docDetail.latestAsset?.validation_report_json) {
          setValidation(
            JSON.parse(docDetail.latestAsset.validation_report_json) as AcroFormValidationReport
          );
        }

        try {
          const acPdf = await api.fetchPdfBytes(`/api/v1/documents/${documentId}/acroform-pdf`);
          if (active) setAcroBytes(acPdf);
        } catch {
          if (active) setAcroBytes(null);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load validation context");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [api, documentId]);

  const populateSampleDefaults = () => {
    if (!manifest) return;
    const next: Record<string, unknown> = {};
    for (const f of manifest.fields) {
      if (f.type === "checkbox") next[f.name] = true;
      else if (f.type === "date") next[f.name] = "20261122";
      else if (f.type === "email") next[f.name] = "applicant@example.co.za";
      else if (f.type === "phone") next[f.name] = "0825550199";
      else if (f.type === "numeric" || f.type === "currency") next[f.name] = "12500";
      else if (f.type === "char_cells") {
        const len = f.maxLength || f.cellRects?.length || 8;
        next[f.name] = "AB1234567890".slice(0, len);
      } else if (f.type === "dropdown" && f.options.length > 0) {
        next[f.name] = f.options[0];
      } else {
        next[f.name] = `Sample ${f.label.slice(0, 18)}`;
      }
    }
    setSampleValues(next);
  };

  const handleRunTestFill = async (flatten: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const bytes = await api.renderTestPdf(documentId, sampleValues, flatten);
      setTestFillBytes(bytes);
      setActiveCompare("test_fill");
      setMessage(
        `Sample PDF rendered (${flatten ? "flattened" : "fillable"} mode, ${(bytes.byteLength / 1024).toFixed(1)} KB).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test-fill render failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadAcroForm = async () => {
    setBusy(true);
    setError(null);
    try {
      const slug =
        documentTitle
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "document";
      const file = await api.fetchFileWithFilename(
        `/api/v1/documents/${documentId}/acroform-pdf?disposition=attachment`,
        `${slug}-fillable-acroform.pdf`
      );
      const blobUrl = URL.createObjectURL(
        new Blob([file.bytes.slice()], { type: file.contentType })
      );
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download AcroForm PDF");
    } finally {
      setBusy(false);
    }
  };

  const handleApproveTemplate = async () => {
    if (!templateId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.json(`/api/v1/templates/${templateId}/approve`, {
        method: "POST",
        body: JSON.stringify({
          structuralVerified: structuralChecked,
          visualVerified: visualChecked,
          notes: approvalNotes,
        }),
      });
      setMessage("Template version approved and locked for Engine B document generation.");
      onApproved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        Loading side-by-side PDF comparison & structural validation report...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Visual Comparison & Validation — {documentTitle}
          </h3>
          <p className="text-xs text-slate-500">
            Inspect original layout fidelity alongside generated AcroForm widgets and test-fill renders.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pageIndex <= 0}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-slate-700 tabular-nums">
            Page {pageIndex + 1} / {manifest?.totalPages || 1}
          </span>
          <button
            type="button"
            disabled={pageIndex >= (manifest?.totalPages || 1) - 1}
            onClick={() =>
              setPageIndex((p) => Math.min((manifest?.totalPages || 1) - 1, p + 1))
            }
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <select
            aria-label="Preview zoom"
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
          >
            <option value={0.65}>65%</option>
            <option value={0.85}>85%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>

          <button
            type="button"
            onClick={() => setActiveCompare("acroform")}
            className={`rounded px-2.5 py-1 text-xs font-medium border ${
              activeCompare === "acroform"
                ? "border-emerald-800 bg-emerald-50 text-emerald-900"
                : "border-slate-200 bg-white text-slate-700"
            }`}
          >
            Blank AcroForm
          </button>
          <button
            type="button"
            disabled={!testFillBytes}
            onClick={() => setActiveCompare("test_fill")}
            className={`rounded px-2.5 py-1 text-xs font-medium border disabled:opacity-40 ${
              activeCompare === "test_fill"
                ? "border-emerald-800 bg-emerald-50 text-emerald-900"
                : "border-slate-200 bg-white text-slate-700"
            }`}
          >
            Sample Fill Result
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleDownloadAcroForm()}
            className="inline-flex items-center gap-1.5 rounded bg-emerald-900 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download AcroForm
          </button>
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-900">
          {message}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-800"
        >
          {error}
        </div>
      )}

      {/* Side-by-Side PDF Canvases */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PdfCanvasPane
          title="1. Original Source PDF"
          pdfBytes={sourceBytes}
          pageIndex={pageIndex}
          scale={scale}
        />
        <PdfCanvasPane
          title={
            activeCompare === "test_fill"
              ? "2. Sample-Filled Output PDF"
              : "2. Generated AcroForm PDF"
          }
          pdfBytes={activeCompare === "test_fill" ? testFillBytes : acroBytes}
          pageIndex={pageIndex}
          scale={scale}
        />
      </div>

      {/* Structural Validation Report + Sample Fill Tester */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Validation Checklist Card */}
        <div className="lg:col-span-5 rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <FileCheck2 className="h-4 w-4 text-emerald-900" />
            <h4 className="text-sm font-semibold text-slate-900">
              Structural AcroForm Validation
            </h4>
          </div>

          {!validation ? (
            <p className="text-xs text-slate-500">
              No AcroForm validation report yet. Click Regenerate AcroForm in Field Editor first.
            </p>
          ) : (
            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-600">Valid PDF Structure</dt>
                <dd className="font-medium text-slate-900 inline-flex items-center gap-1">
                  {validation.validPdf ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                      <span>Passed</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-700" />
                      <span>Failed</span>
                    </>
                  )}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-600">/AcroForm Catalog Dictionary</dt>
                <dd className="font-medium text-slate-900">
                  {validation.hasAcroFormDict ? "Present" : "Vector Overlay Mode"}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-600">Widget Annotations / Expected Fields</dt>
                <dd className="font-mono tabular-nums font-medium text-slate-900">
                  {validation.widgetCount} / {validation.expectedFieldCount}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-600">/AP Appearance Streams</dt>
                <dd className="font-medium text-slate-900">
                  {validation.appearanceStreamsVerified ? "Verified" : "Unverified"}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-600">Round-Trip Write & Read Check</dt>
                <dd className="font-medium text-slate-900">
                  {validation.roundTripWriteReadOk ? "Passed" : "Pending"}
                </dd>
              </div>
              {validation.visualVerification && (
                <>
                  <div className="py-2 flex items-center justify-between">
                    <dt className="text-slate-600">Visual Widget Alignment</dt>
                    <dd className="font-mono tabular-nums font-medium text-slate-900 inline-flex items-center gap-1">
                      {validation.visualVerification.passed ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                      )}
                      <span>
                        {validation.visualVerification.alignedCount}/
                        {validation.visualVerification.checkedWidgets} (mean IoU{" "}
                        {validation.visualVerification.meanIoU.toFixed(2)})
                      </span>
                    </dd>
                  </div>
                  <div className="py-2 flex items-center justify-between">
                    <dt className="text-slate-600">Comb Grids / Min IoU</dt>
                    <dd className="font-mono tabular-nums font-medium text-slate-900">
                      {validation.visualVerification.combFieldCount} comb · min{" "}
                      {validation.visualVerification.minIoU.toFixed(2)}
                    </dd>
                  </div>
                  {(validation.visualVerification.misplacedFields.length > 0 ||
                    validation.visualVerification.oversizedFields.length > 0 ||
                    validation.visualVerification.undersizedFields.length > 0 ||
                    validation.visualVerification.overlappingWidgetPairs.length > 0 ||
                    validation.visualVerification.duplicateWidgetNames.length > 0) && (
                    <div className="py-2 text-[11px] text-amber-800 bg-amber-50 rounded px-2.5 mt-1 space-y-0.5">
                      <p className="font-semibold">Visual Alignment Warnings</p>
                      <p>{validation.visualVerification.summary}</p>
                    </div>
                  )}
                </>
              )}
            </dl>
          )}

          {/* Formal Template Approval Card */}
          {templateId && (
            <div className="border-t border-slate-200 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-900 inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-emerald-900" />
                  Template Approval Gate
                </span>
                <span className="text-[11px] font-medium text-slate-600 uppercase">
                  {templateStatus || "in_review"}
                </span>
              </div>

              {canApprove && templateStatus !== "approved" && (
                <>
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={structuralChecked}
                      onChange={(e) => setStructuralChecked(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I confirm AcroForm structure, widget types, and round-trip checks passed.</span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={visualChecked}
                      onChange={(e) => setVisualChecked(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I visually verified sample-fill alignment in both panes above.</span>
                  </label>
                  <input
                    type="text"
                    value={approvalNotes}
                    onChange={(e) => setApprovalNotes(e.target.value)}
                    placeholder="Reviewer sign-off notes (optional)"
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
                  />
                  <button
                    type="button"
                    disabled={busy || !structuralChecked || !visualChecked}
                    onClick={handleApproveTemplate}
                    className="w-full rounded-md bg-emerald-900 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
                  >
                    Approve & Lock Template Version
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Interactive Sample-Fill Tester */}
        <div className="lg:col-span-7 rounded-lg border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Sample-Fill Verification Tester
              </h4>
              <p className="text-xs text-slate-500">
                Test populating fields with real data and inspect output text positioning before approval.
              </p>
            </div>
            <button
              type="button"
              onClick={populateSampleDefaults}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Auto-Fill Test Values
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto pr-1">
            {(manifest?.fields || []).map((f: DetectedFormField) => (
              <div key={f.id} className="text-xs">
                <label className="block font-medium text-slate-700 mb-1 truncate">
                  {f.label}{" "}
                  <span className="font-mono text-[10px] text-slate-400">({f.type})</span>
                </label>
                {f.type === "checkbox" ? (
                  <label className="inline-flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={Boolean(sampleValues[f.name])}
                      onChange={(e) =>
                        setSampleValues((prev) => ({ ...prev, [f.name]: e.target.checked }))
                      }
                    />
                    <span>Checked</span>
                  </label>
                ) : f.type === "dropdown" && f.options.length > 0 ? (
                  <select
                    value={String(sampleValues[f.name] ?? "")}
                    onChange={(e) =>
                      setSampleValues((prev) => ({ ...prev, [f.name]: e.target.value }))
                    }
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                  >
                    <option value="">-- Select --</option>
                    {f.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={String(sampleValues[f.name] ?? "")}
                    onChange={(e) =>
                      setSampleValues((prev) => ({ ...prev, [f.name]: e.target.value }))
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleRunTestFill(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-800"
            >
              <Play className="h-3.5 w-3.5" />
              Test Flattened Render
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleRunTestFill(false)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50"
            >
              <Eye className="h-3.5 w-3.5" />
              Test Fillable AcroForm Render
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Download,
  FileArchive,
  FileCheck2,
  FileText,
  Layers,
  Lock,
  ScanText,
  Sparkles,
  Unlock,
  Upload,
} from "lucide-react";
import {
  matchPricingTierForPages,
  type PricingTierRecord,
} from "./studio/studio-api.ts";

if (typeof window !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
}

interface PublicToggles {
  normalUpload: boolean;
  normalDownload: boolean;
  topTierZipUpload: boolean;
  topTierZipDownload: boolean;
}

interface PublicConversionState {
  id: string;
  documentId: string;
  jobId: string | null;
  sourceType: "pdf" | "zip" | string;
  archiveFilename: string | null;
  originalFilename: string;
  title: string;
  pageCount: number;
  fieldCount: number;
  widgetCount: number;
  acroformByteSize: number;
  paid: boolean;
  paidTierId: string | null;
  paidTierName: string | null;
  paidAmountCents: number | null;
  job: {
    id: string;
    stage: string;
    progress_pct: number;
    status: string;
    error_message?: string | null;
  } | null;
}

function formatCurrency(priceCents: number): string {
  const safe = Number.isFinite(priceCents) ? priceCents : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatStageLabel(stage: string): string {
  switch (stage) {
    case "queued":
      return "Queued for PDF analysis";
    case "inspecting":
      return "Inspecting page geometry and boxes";
    case "ocr":
      return "Running OCR and layout detection";
    case "detecting":
      return "Detecting form fields and character grids";
    case "generating_acroform":
      return "Building interactive AcroForm widgets";
    case "completed":
      return "Fillable AcroForm ready";
    case "failed":
      return "Conversion failed";
    default:
      return stage ? stage.replace(/_/g, " ") : "Processing PDF";
  }
}

function parseDownloadFilename(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return utf8Match[1].trim();
    }
  }
  const quotedOrPlain = disposition.match(/filename\s*=\s*['"]?([^'";]+)['"]?/i);
  if (quotedOrPlain?.[1]) {
    return quotedOrPlain[1].trim();
  }
  return fallback;
}

function PdfPreviewFrame({
  pdfBytes,
  filename,
  pageCount,
}: {
  pdfBytes: Uint8Array | null;
  filename: string;
  pageCount: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [numPages, setNumPages] = useState(Math.max(1, pageCount));
  const [scale, setScale] = useState(1);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    setPageIndex(0);
    setNumPages(Math.max(1, pageCount));
  }, [pdfBytes, pageCount]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let doc: pdfjsLib.PDFDocumentProxy | null = null;
    if (!pdfBytes) return;

    (async () => {
      try {
        setRendering(true);
        setRenderError(null);
        loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
        doc = await loadingTask.promise;
        if (cancelled) return;
        setNumPages(doc.numPages || Math.max(1, pageCount));
        const safeIndex = Math.min(pageIndex + 1, doc.numPages);
        const page = await doc.getPage(safeIndex);
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
          setRenderError(err instanceof Error ? err.message : "Interactive preview frame loaded");
        }
      } finally {
        if (!cancelled) {
          setRendering(false);
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
  }, [pdfBytes, pageIndex, scale, pageCount]);

  return (
    <div
      aria-label="Converted fillable PDF preview"
      className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm"
    >
      <div className="bg-slate-900 text-white px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-tight text-white truncate">
            Converted Fillable PDF Preview
          </p>
          <p className="text-[11px] text-slate-300 truncate">{filename}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            aria-label="Previous page"
            disabled={pageIndex <= 0}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            className="rounded border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="text-xs font-mono tabular-nums text-slate-200 px-1">
            Page {pageIndex + 1} / {numPages}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={pageIndex >= numPages - 1}
            onClick={() => setPageIndex((p) => Math.min(numPages - 1, p + 1))}
            className="rounded border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <select
            aria-label="Preview zoom"
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100"
          >
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>
        </div>
      </div>

      <div className="bg-slate-100 p-4 sm:p-6 min-h-[420px] max-h-[620px] overflow-auto flex flex-col items-center justify-center">
        {!pdfBytes ? (
          <div className="py-12 text-center text-xs text-slate-500">
            Preparing on-screen preview of your converted fillable PDF...
          </div>
        ) : renderError ? (
          <div className="max-w-sm rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm space-y-2">
            <FileCheck2 className="h-8 w-8 text-emerald-900 mx-auto" aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-900">{filename}</p>
            <p className="text-xs text-slate-600">
              Fillable AcroForm PDF generated ({formatBytes(pdfBytes.byteLength)}, {numPages}{" "}
              {numPages === 1 ? "page" : "pages"}).
            </p>
          </div>
        ) : (
          <div className="relative">
            {rendering && (
              <div className="mb-2 text-center text-[11px] text-slate-500">
                Rendering page {pageIndex + 1}...
              </div>
            )}
            <canvas
              ref={canvasRef}
              className="bg-white border border-slate-300 shadow-md rounded-sm"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function PublicLandingConverter() {
  const pdfInputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);

  const [pricingTiers, setPricingTiers] = useState<PricingTierRecord[]>([]);
  const [toggles, setToggles] = useState<PublicToggles>({
    normalUpload: true,
    normalDownload: true,
    topTierZipUpload: false,
    topTierZipDownload: false,
  });
  const [configError, setConfigError] = useState<string | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedMode, setSelectedMode] = useState<"pdf" | "zip" | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [converting, setConverting] = useState(false);
  const [convertStage, setConvertStage] = useState<string | null>(null);
  const [convertPct, setConvertPct] = useState<number>(0);

  const [conversionId, setConversionId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [conversion, setConversion] = useState<PublicConversionState | null>(null);
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);

  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [downloadingType, setDownloadingType] = useState<"pdf" | "zip" | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const loadPublicConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/public/config");
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        toggles?: PublicToggles;
        pricingTiers?: PricingTierRecord[];
      } | null;
      if (res.ok && data?.ok) {
        if (data.toggles) setToggles(data.toggles);
        if (Array.isArray(data.pricingTiers)) setPricingTiers(data.pricingTiers);
      }
    } catch {
      setConfigError("Unable to load current pricing tiers.");
    }
  }, []);

  useEffect(() => {
    void loadPublicConfig();
  }, [loadPublicConfig]);

  const scrollToWorkspace = () => {
    workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetConversionState = () => {
    setConversionId(null);
    setAccessToken(null);
    setConversion(null);
    setPreviewBytes(null);
    setUploadProgress(null);
    setConvertStage(null);
    setConvertPct(0);
    setStatusNotice(null);
    setErrorMsg(null);
  };

  const handleSelectPdfFile = (file: File | null) => {
    if (!file) return;
    resetConversionState();
    setSelectedFile(file);
    setSelectedMode("pdf");
  };

  const handleSelectZipFile = (file: File | null) => {
    if (!file) return;
    resetConversionState();
    setSelectedFile(file);
    setSelectedMode("zip");
  };

  const fetchPreviewBytes = useCallback(async (convId: string, token: string) => {
    try {
      const res = await fetch(`/api/v1/public/conversions/${convId}/preview`, {
        headers: { "x-conversion-token": token },
      });
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      setPreviewBytes(buf);
    } catch {
      // Non-fatal preview load fallback
    }
  }, []);

  const uploadWithXhr = (
    endpoint: string,
    file: File
  ): Promise<{
    ok: boolean;
    conversionId: string;
    accessToken: string;
    jobId: string;
  }> => {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint);
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
            resolve(data);
          } else {
            reject(new Error(data.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error("Invalid server upload response."));
        }
      };
      xhr.onerror = () => reject(new Error("Network error while uploading file."));
      xhr.send(form);
    });
  };

  const handleConvert = async () => {
    if (!selectedFile || !selectedMode) return;
    setErrorMsg(null);
    setStatusNotice(null);
    setConverting(true);
    setUploadProgress(0);
    setConvertStage("Uploading file");
    setConvertPct(5);
    setPreviewBytes(null);
    setConversion(null);

    try {
      const endpoint =
        selectedMode === "zip" ? "/api/v1/public/zip-upload" : "/api/v1/public/documents";
      const uploaded = await uploadWithXhr(endpoint, selectedFile);
      setConversionId(uploaded.conversionId);
      setAccessToken(uploaded.accessToken);
      setUploadProgress(100);
      setConvertStage("queued");
      setConvertPct(10);

      // Poll until the analysis & AcroForm generation job completes
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        const statusRes = await fetch(`/api/v1/public/conversions/${uploaded.conversionId}`, {
          headers: { "x-conversion-token": uploaded.accessToken },
        });
        const statusData = (await statusRes.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          conversion?: PublicConversionState;
          pricingTiers?: PricingTierRecord[];
          toggles?: PublicToggles;
        } | null;

        if (!statusRes.ok || !statusData?.ok || !statusData.conversion) {
          throw new Error(statusData?.error || "Unable to retrieve conversion status.");
        }

        if (Array.isArray(statusData.pricingTiers)) {
          setPricingTiers(statusData.pricingTiers);
        }
        if (statusData.toggles) {
          setToggles(statusData.toggles);
        }

        const conv = statusData.conversion;
        const jobStatus = conv.job?.status || "completed";
        setConvertStage(conv.job?.stage || jobStatus);
        setConvertPct(conv.job?.progress_pct ?? 100);

        if (jobStatus === "failed") {
          throw new Error(conv.job?.error_message || "PDF conversion failed.");
        }

        if (jobStatus === "completed") {
          setConversion(conv);
          setConvertPct(100);
          setConverting(false);
          await fetchPreviewBytes(uploaded.conversionId, uploaded.accessToken);
          return;
        }
      }

      throw new Error("Conversion timed out while processing the document.");
    } catch (err) {
      setConverting(false);
      setErrorMsg(err instanceof Error ? err.message : "Conversion failed.");
    }
  };

  const matchedTier = conversion
    ? matchPricingTierForPages(conversion.pageCount, pricingTiers)
    : null;

  const handleConfirmPayment = async () => {
    if (!conversion || !conversionId || !accessToken || !matchedTier) return;
    setErrorMsg(null);
    setStatusNotice(null);
    setCheckoutBusy(true);
    try {
      const res = await fetch(`/api/v1/public/conversions/${conversionId}/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-conversion-token": accessToken,
        },
        body: JSON.stringify({ tierId: matchedTier.id }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        paid?: boolean;
        tier?: PricingTierRecord;
      } | null;

      if (!res.ok || !data?.ok || !data.paid) {
        throw new Error(data?.error || "Payment confirmation failed.");
      }

      setConversion((prev) =>
        prev
          ? {
              ...prev,
              paid: true,
              paidTierId: data.tier?.id ?? matchedTier.id,
              paidTierName: data.tier?.name ?? matchedTier.name,
              paidAmountCents: data.tier?.price_cents ?? matchedTier.price_cents,
            }
          : prev
      );
      setStatusNotice(
        `Payment confirmed for ${matchedTier.name} (${formatCurrency(matchedTier.price_cents)}). Downloads are now unlocked.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Payment confirmation failed.");
    } finally {
      setCheckoutBusy(false);
    }
  };

  const handleDownloadFile = async (kind: "pdf" | "zip") => {
    if (!conversion || !conversionId || !accessToken || !conversion.paid) return;
    setErrorMsg(null);
    setDownloadingType(kind);
    try {
      const endpoint =
        kind === "zip"
          ? `/api/v1/public/conversions/${conversionId}/zip-download`
          : `/api/v1/public/conversions/${conversionId}/download`;
      const res = await fetch(endpoint, {
        headers: { "x-conversion-token": accessToken },
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error || `Download failed (${res.status})`);
      }

      const contentType =
        res.headers.get("content-type") ||
        (kind === "zip" ? "application/zip" : "application/pdf");
      const fallbackName =
        kind === "zip"
          ? `${conversion.title || "formifypdf"}-fillable-bundle.zip`
          : `${conversion.title || "formifypdf"}-fillable-acroform.pdf`;
      const filename = parseDownloadFilename(res.headers.get("content-disposition"), fallbackName);

      const bytes = new Uint8Array(await res.arrayBuffer());
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to download file.");
    } finally {
      setDownloadingType(null);
    }
  };

  return (
    <div id="top" className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Navigation Bar — 3 clean zones, no admin links or tabs */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            FormifyPDF
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600"
          >
            <a
              href="#how-it-works"
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              How It Works
            </a>
            <a
              href="#capabilities"
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Capabilities
            </a>
            <a
              href="#pricing"
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Pricing
            </a>
            <a
              href="#convert-workspace"
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Convert
            </a>
          </nav>

          <button
            type="button"
            onClick={scrollToWorkspace}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-900 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0"
          >
            <span>Start Converting</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero & Value Proposition */}
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            <div className="lg:col-span-7 space-y-5">
              <p className="text-xs font-medium tracking-wide uppercase text-emerald-900">
                AcroForm Automation · Digital &amp; Scanned Forms · Page-Tier Pricing
              </p>

              <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-slate-900 leading-[1.1] [text-wrap:balance]">
                Turn Static PDFs &amp; Form Bundles Into Fillable AcroForms
              </h1>

              <p className="text-base sm:text-lg text-slate-600 leading-relaxed max-w-2xl">
                Upload any non-fillable PDF or ZIP form package. FormifyPDF detects text inputs,
                checkboxes, and character comb grids automatically, presents your converted
                fillable PDF right on screen, and unlocks instant downloads by transparent page tier.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={scrollToWorkspace}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-900 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-800 transition-colors shadow-sm whitespace-nowrap"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>Upload &amp; Convert Your Form</span>
                </button>
                <a
                  href="#pricing"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  <span>See Page Pricing</span>
                </a>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Three-Step Client Workflow
                </p>
                <ol className="space-y-4">
                  <li className="flex items-start gap-3.5">
                    <span className="h-7 w-7 rounded-md bg-emerald-900 text-white text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      01
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Upload PDF or ZIP Bundle
                      </p>
                      <p className="text-xs text-slate-600 leading-relaxed mt-0.5">
                        Select a single PDF document or a multi-asset ZIP archive directly in your
                        browser.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3.5">
                    <span className="h-7 w-7 rounded-md bg-slate-900 text-white text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      02
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Convert &amp; Preview Live on Screen
                      </p>
                      <p className="text-xs text-slate-600 leading-relaxed mt-0.5">
                        Inspect every page, detected field count, and matched page pricing tier
                        before paying.
                      </p>
                    </div>
                  </li>
                  <li className="flex items-start gap-3.5">
                    <span className="h-7 w-7 rounded-md bg-amber-600 text-white text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      03
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Pay Matched Tier to Unlock Downloads
                      </p>
                      <p className="text-xs text-slate-600 leading-relaxed mt-0.5">
                        Confirm checkout for your document page count to unlock PDF and ZIP
                        downloads immediately.
                      </p>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* Client Conversion Workspace */}
        <section
          id="convert-workspace"
          ref={workspaceRef}
          className="mx-auto max-w-6xl px-4 sm:px-6 py-12 space-y-8"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
                Conversion Workspace
              </p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
                Upload Your PDF or ZIP Archive
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Choose a file to convert into an interactive AcroForm PDF and preview it immediately.
              </p>
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-700" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}

          {statusNotice && (
            <div className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <CheckCircle2
                className="h-4 w-4 shrink-0 mt-0.5 text-emerald-700"
                aria-hidden="true"
              />
              <span>{statusNotice}</span>
            </div>
          )}

          {/* Upload & Convert Card */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              const dropped = e.dataTransfer.files?.[0];
              if (!dropped) return;
              if (dropped.name.toLowerCase().endsWith(".zip")) {
                handleSelectZipFile(dropped);
              } else {
                handleSelectPdfFile(dropped);
              }
            }}
            className={`rounded-xl border-2 border-dashed bg-white p-6 sm:p-8 transition-colors ${
              dragActive ? "border-emerald-800 bg-emerald-50/40" : "border-slate-300"
            }`}
          >
            <input
              ref={pdfInputRef}
              id="public-pdf-upload"
              type="file"
              accept=".pdf,application/pdf"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                handleSelectPdfFile(f);
              }}
            />
            <input
              ref={zipInputRef}
              id="public-zip-upload"
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                handleSelectZipFile(f);
              }}
            />

            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => pdfInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                  >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    <span>Upload</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => zipInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap"
                  >
                    <FileArchive className="h-4 w-4 text-emerald-900" aria-hidden="true" />
                    <span>ZIP Upload</span>
                  </button>
                </div>

                <p className="text-xs text-slate-500">
                  Drag and drop a <span className="font-medium text-slate-700">.pdf</span> form or{" "}
                  <span className="font-medium text-slate-700">.zip</span> archive here, or choose an
                  upload option above.
                </p>

                {selectedFile && (
                  <div className="inline-flex flex-wrap items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">
                    {selectedMode === "zip" ? (
                      <FileArchive className="h-4 w-4 text-emerald-900 shrink-0" aria-hidden="true" />
                    ) : (
                      <FileText className="h-4 w-4 text-emerald-900 shrink-0" aria-hidden="true" />
                    )}
                    <span className="font-semibold text-slate-900">{selectedFile.name}</span>
                    <span className="text-slate-400">·</span>
                    <span className="font-mono tabular-nums text-slate-600">
                      {formatBytes(selectedFile.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFile(null);
                        setSelectedMode(null);
                        resetConversionState();
                      }}
                      className="text-slate-500 hover:text-slate-900 underline ml-1"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              <div className="shrink-0">
                <button
                  type="button"
                  disabled={!selectedFile || converting}
                  onClick={() => void handleConvert()}
                  className="w-full lg:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-900 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-45 disabled:cursor-not-allowed transition-colors shadow-sm whitespace-nowrap"
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  <span>{converting ? "Converting..." : "Convert to Fillable PDF"}</span>
                </button>
              </div>
            </div>

            {/* Live Upload & Conversion Progress */}
            {converting && (
              <div className="mt-6 pt-5 border-t border-slate-200 space-y-2.5">
                <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                  <span>{formatStageLabel(convertStage || "processing")}</span>
                  <span className="font-mono tabular-nums">
                    {uploadProgress !== null && uploadProgress < 100
                      ? `Upload ${uploadProgress}%`
                      : `${convertPct}%`}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-emerald-800 transition-all duration-300"
                    style={{
                      width: `${Math.max(
                        8,
                        uploadProgress !== null && uploadProgress < 100 ? uploadProgress : convertPct
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Converted Fillable PDF On-Screen Presentation + Summary + Locked Downloads & Pay CTA */}
          {conversion && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left 7 cols: Neatly Framed On-Screen PDF Preview */}
              <div className="lg:col-span-7">
                <PdfPreviewFrame
                  pdfBytes={previewBytes}
                  filename={conversion.archiveFilename || conversion.originalFilename}
                  pageCount={conversion.pageCount}
                />
              </div>

              {/* Right 5 cols: Document Summary, Pricing Match, Checkout CTA & Locked/Unlocked Downloads */}
              <div className="lg:col-span-5 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
                        Conversion Ready
                      </p>
                      <h3 className="mt-0.5 text-lg font-bold text-slate-900 break-words">
                        {conversion.archiveFilename || conversion.originalFilename}
                      </h3>
                    </div>
                  </div>

                  <dl className="divide-y divide-slate-100 text-sm">
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <dt className="text-slate-600">Source Type</dt>
                      <dd className="font-medium text-slate-900">
                        {conversion.sourceType === "zip" ? "ZIP Form Bundle" : "PDF Document"}
                      </dd>
                    </div>
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <dt className="text-slate-600">Page Count</dt>
                      <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                        {conversion.pageCount} {conversion.pageCount === 1 ? "page" : "pages"}
                      </dd>
                    </div>
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <dt className="text-slate-600">Detected Fields &amp; Widgets</dt>
                      <dd className="font-mono font-medium text-slate-900 tabular-nums">
                        {conversion.fieldCount} fields · {conversion.widgetCount} widgets
                      </dd>
                    </div>
                    <div className="py-2.5 flex items-center justify-between gap-3">
                      <dt className="text-slate-600">Matched Pricing Tier</dt>
                      <dd className="text-right">
                        {matchedTier ? (
                          <span className="font-semibold text-slate-900">
                            {matchedTier.name} —{" "}
                            <span className="font-mono tabular-nums text-emerald-900">
                              {formatCurrency(matchedTier.price_cents)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-slate-500">Standard Tier</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>

                {/* Pay-to-Unlock Call to Action Card */}
                {!conversion.paid ? (
                  <div className="rounded-xl border border-amber-300 bg-amber-50/80 p-5 space-y-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <div className="rounded-lg bg-amber-100 p-2 text-amber-800 shrink-0">
                        <Lock className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-sm font-bold text-slate-900">
                          Unlock Your Fillable PDF &amp; ZIP Downloads
                        </h4>
                        <p className="text-xs text-slate-700 leading-relaxed">
                          Your interactive PDF preview is ready. Complete payment for your{" "}
                          <span className="font-semibold">
                            {matchedTier ? matchedTier.name : `${conversion.pageCount}-page tier`}
                          </span>{" "}
                          ({conversion.pageCount}{" "}
                          {conversion.pageCount === 1 ? "page" : "pages"}) to unlock immediate file
                          downloads.
                        </p>
                      </div>
                    </div>

                    {matchedTier && (
                      <div className="rounded-lg border border-amber-200 bg-white px-4 py-3 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-semibold text-slate-900">{matchedTier.name}</p>
                          <p className="text-[11px] text-slate-500 tabular-nums">
                            Covers up to {matchedTier.max_pages} pages · {conversion.pageCount}{" "}
                            detected
                          </p>
                        </div>
                        <p className="text-xl font-bold font-mono tabular-nums text-slate-900">
                          {formatCurrency(matchedTier.price_cents)}
                        </p>
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={checkoutBusy || !matchedTier}
                      onClick={() => void handleConfirmPayment()}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-900 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      <CreditCard className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {checkoutBusy
                          ? "Confirming Payment..."
                          : matchedTier
                          ? `Pay ${formatCurrency(matchedTier.price_cents)} to Unlock Downloads`
                          : "Confirm Payment to Unlock"}
                      </span>
                    </button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 flex items-start gap-3">
                    <Unlock className="h-5 w-5 text-emerald-800 shrink-0 mt-0.5" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-bold text-emerald-950">
                        Payment Confirmed · Downloads Unlocked
                      </p>
                      <p className="text-xs text-emerald-900 mt-0.5">
                        {conversion.paidTierName || matchedTier?.name} (
                        {formatCurrency(
                          conversion.paidAmountCents ?? matchedTier?.price_cents ?? 0
                        )}
                        ) confirmed. You can download your files below.
                      </p>
                    </div>
                  </div>
                )}

                {/* Download & ZIP Download Buttons — Locked until Payment Confirmed */}
                <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Export Files
                    </p>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600">
                      {conversion.paid ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                          <span className="text-emerald-800">Unlocked</span>
                        </>
                      ) : (
                        <>
                          <Lock className="h-3.5 w-3.5 text-amber-700" aria-hidden="true" />
                          <span className="text-amber-800">Locked until paid</span>
                        </>
                      )}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={!conversion.paid || downloadingType !== null}
                      aria-disabled={!conversion.paid}
                      onClick={() => void handleDownloadFile("pdf")}
                      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                        conversion.paid
                          ? "bg-emerald-900 text-white hover:bg-emerald-800"
                          : "border border-slate-300 bg-slate-100 text-slate-500 cursor-not-allowed"
                      }`}
                    >
                      {conversion.paid ? (
                        <Download className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Lock className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{downloadingType === "pdf" ? "Downloading..." : "Download"}</span>
                    </button>

                    <button
                      type="button"
                      disabled={!conversion.paid || downloadingType !== null}
                      aria-disabled={!conversion.paid}
                      onClick={() => void handleDownloadFile("zip")}
                      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap ${
                        conversion.paid
                          ? "border border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
                          : "border border-slate-300 bg-slate-100 text-slate-500 cursor-not-allowed"
                      }`}
                    >
                      {conversion.paid ? (
                        <FileArchive className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Lock className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span>{downloadingType === "zip" ? "Packaging..." : "ZIP Download"}</span>
                    </button>
                  </div>

                  {!conversion.paid && (
                    <p className="text-[11px] text-slate-500">
                      Both Download and ZIP Download remain locked until checkout is confirmed for
                      the matched page tier.
                    </p>
                  )}
                  {conversion.paid && (!toggles.normalDownload || !toggles.topTierZipDownload) && (
                    <p className="text-[11px] text-slate-500">
                      Availability of individual export formats follows workspace download settings.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* How It Works & Capabilities */}
        <section id="how-it-works" className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-14 space-y-10">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
                How FormifyPDF Works
              </p>
              <h2 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
                Precision AcroForm Detection Without Manual Recreations
              </h2>
            </div>

            <div id="capabilities" className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 space-y-2.5">
                <ScanText className="h-5 w-5 text-emerald-900" aria-hidden="true" />
                <h3 className="text-base font-bold text-slate-900">
                  Digital &amp; Scanned Field Detection
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Analyzes vector underlines, table cells, checkboxes, radio clusters, and scanned
                  paper forms with deskewing and OCR fallback.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 space-y-2.5">
                <Layers className="h-5 w-5 text-emerald-900" aria-hidden="true" />
                <h3 className="text-base font-bold text-slate-900">
                  Character Comb Grids &amp; Multi-Page Fidelity
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Preserves fixed-width date and ID character boxes, mixed paper sizes, CropBox
                  offsets, and rotated pages seamlessly.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-6 space-y-2.5">
                <FileArchive className="h-5 w-5 text-emerald-900" aria-hidden="true" />
                <h3 className="text-base font-bold text-slate-900">
                  Single PDFs &amp; ZIP Form Bundles
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Upload individual PDFs or structured ZIP packages, verify the converted result in
                  our framed viewer, and export clean AcroForms.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Transparent Page-Based Pricing Tiers */}
        <section id="pricing" className="border-t border-slate-200 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-14 space-y-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
                  Transparent Pricing
                </p>
                <h2 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
                  Simple Page-Based Tiers
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Preview your converted fillable PDF on screen first — only pay for the tier that
                  matches your document page count.
                </p>
              </div>
            </div>

            {configError && (
              <p className="text-xs text-slate-500">{configError}</p>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {pricingTiers.map((tier) => (
                <div
                  key={tier.id}
                  className="rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between space-y-5 shadow-sm"
                >
                  <div className="space-y-2">
                    <p className="text-xs font-mono uppercase tracking-wider text-slate-500">
                      Up to {tier.max_pages} pages
                    </p>
                    <h3 className="text-lg font-bold text-slate-900">{tier.name}</h3>
                    <p className="text-3xl font-bold font-mono tabular-nums text-emerald-900">
                      {formatCurrency(tier.price_cents)}
                    </p>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      Convert and preview documents up to {tier.max_pages} pages, then unlock PDF
                      and ZIP downloads.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={scrollToWorkspace}
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 transition-colors"
                  >
                    Convert With This Tier
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span className="font-semibold text-slate-700">FormifyPDF</span>
          <span>AcroForm PDF Conversion &amp; Form Intelligence</span>
        </div>
      </footer>
    </div>
  );
}

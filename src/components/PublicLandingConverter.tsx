import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Download,
  FileArchive,
  FileCheck2,
  FileText,
  Lock,
  Mail,
  Menu,
  ShieldCheck,
  Sparkles,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import { BrandWordmark } from "./BrandMark.tsx";
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

type InfoModalTopic = "privacy" | "terms" | "security" | "acroform" | null;
type QuotePlanType = "over_60" | "enterprise_bulk";

const FAQ_ITEMS = [
  {
    question: "Which PDF and archive formats does FormifyPDF accept?",
    answer:
      "You can upload single static PDF forms (digital vector forms or scanned flat PDFs) using Upload, or structured form archives using ZIP Upload. FormifyPDF detects underlines, table cells, checkboxes, radio groups, and fixed character comb grids across multi-page documents.",
  },
  {
    question: "How does page-based pricing work before payment?",
    answer:
      "Upload and conversion run first at no upfront charge. FormifyPDF inspects your document, displays the live fillable AcroForm preview right on screen alongside detected field counts, and matches your exact page count to the lowest active pricing tier before asking for checkout.",
  },
  {
    question: "Can I verify my converted form before paying to download?",
    answer:
      "Yes. Every conversion renders inside the on-screen preview viewer with page navigation and zoom controls so you can review the output and field summary before unlocking Download or ZIP Download.",
  },
  {
    question: "Do exported AcroForms work in standard desktop and browser PDF readers?",
    answer:
      "Yes. Converted files follow standard ISO 32000-1 AcroForm specifications, making text fields, comb boxes, and checkboxes fillable in Adobe Acrobat, macOS Preview, Chrome, Edge, and Firefox without proprietary plugins.",
  },
];

const INFO_MODAL_CONTENT: Record<
  Exclude<InfoModalTopic, null>,
  { title: string; subtitle: string; paragraphs: string[] }
> = {
  privacy: {
    title: "Privacy Policy",
    subtitle: "formifypdf.com · Effective 2026",
    paragraphs: [
      "FormifyPDF processes uploaded PDF documents and ZIP archives solely to detect form geometry, generate interactive AcroForm fields, render your on-screen preview, and deliver purchased downloads.",
      "Uploaded source documents and converted outputs are isolated by per-conversion access tokens and are never used to train external models or shared with third-party data brokers.",
      "For privacy requests or data removal inquiries, contact support@formifypdf.com with your conversion reference.",
    ],
  },
  terms: {
    title: "Terms of Service",
    subtitle: "formifypdf.com · Commercial Usage Terms",
    paragraphs: [
      "By uploading documents to FormifyPDF, you confirm that you hold the rights or authorization required to process and convert those forms into fillable AcroForm PDFs.",
      "Pricing is calculated transparently from the detected document page count matched against active page tiers displayed prior to checkout confirmation.",
      "Once payment is confirmed for a conversion, both PDF Download and ZIP Download unlock immediately for that converted item.",
    ],
  },
  security: {
    title: "Security & Document Handling",
    subtitle: "formifypdf.com · Upload & Checkout Protection",
    paragraphs: [
      "All uploads, preview streams, checkout requests, and file downloads on formifypdf.com operate over encrypted transport and verify per-session conversion tokens server-side.",
      "ZIP archives undergo strict archive path validation to guard against traversal or malformed entries before conversion begins.",
      "Download endpoints remain strictly locked server-side until tier payment is verified for the matching conversion record.",
    ],
  },
  acroform: {
    title: "AcroForm Technical Standard",
    subtitle: "ISO 32000-1 Interactive Form Output",
    paragraphs: [
      "FormifyPDF preserves original typography, line work, CropBox bounds, and page rotations while embedding native /AcroForm widget dictionaries.",
      "Fixed-width numeric boxes such as dates, account numbers, and tax identifiers are constructed with MaxLen and comb formatting so typed characters align cleanly cell by cell.",
      "Every export is tested for compatibility across modern desktop PDF viewers and web browser PDF engines.",
    ],
  },
};

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
      <div className="bg-[#0F1916] text-white px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-emerald-950">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-tight text-white truncate">
            Converted Fillable PDF Preview
          </p>
          <p className="text-[11px] text-emerald-200/80 truncate">{filename}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            aria-label="Previous page"
            disabled={pageIndex <= 0}
            onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
            className="rounded border border-white/15 bg-white/10 p-1.5 text-slate-100 hover:bg-white/20 disabled:opacity-35 transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="text-xs font-mono tabular-nums text-slate-200 px-1.5 whitespace-nowrap">
            Page {pageIndex + 1} / {numPages}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={pageIndex >= numPages - 1}
            onClick={() => setPageIndex((p) => Math.min(numPages - 1, p + 1))}
            className="rounded border border-white/15 bg-white/10 p-1.5 text-slate-100 hover:bg-white/20 disabled:opacity-35 transition-colors"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <select
            aria-label="Preview zoom"
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="rounded border border-white/15 bg-[#152520] px-2 py-1 text-xs text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
            <option value={1.25}>125%</option>
          </select>
        </div>
      </div>

      <div className="bg-[#EEF1EF] p-4 sm:p-6 min-h-[430px] max-h-[640px] overflow-auto flex flex-col items-center justify-center">
        {!pdfBytes ? (
          <div className="py-12 text-center text-xs text-slate-600">
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

function HeroConversionShowcase({ onStartConverting }: { onStartConverting: () => void }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-200 bg-[#0F1916] px-5 py-3 flex items-center justify-between text-xs">
        <span className="font-mono font-medium text-emerald-300">
          What FormifyPDF Does · Example
        </span>
        <span className="font-mono text-slate-300">No Sign-In Required</span>
      </div>

      {/* Clear Before -> After Read-Only Illustration */}
      <div className="p-5 sm:p-6 bg-[#FAFBF9] border-b border-slate-200 space-y-4">
        <div className="flex items-center justify-between text-[11px] font-medium text-slate-500">
          <span>Illustration Only (Upload Your File Below)</span>
          <span className="font-mono text-emerald-900 font-semibold">Before → After</span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
          <div className="p-3.5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs">
            <div>
              <p className="text-[11px] text-slate-500 mb-1">Static PDF Line</p>
              <div className="h-6 border-b border-dashed border-slate-400 flex items-end pb-1 font-mono text-[11px] text-slate-400">
                ____________
              </div>
            </div>
            <ArrowRight className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-[11px] font-medium text-emerald-900 mb-1">Text Field Widget</p>
              <div className="h-6 rounded border border-emerald-800/40 bg-emerald-50/60 px-2 flex items-center text-[11px] font-medium text-emerald-950">
                Typeable Box
              </div>
            </div>
          </div>

          <div className="p-3.5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs">
            <div>
              <p className="text-[11px] text-slate-500 mb-1">Flat Printed Box</p>
              <div className="h-6 flex items-center gap-2 text-slate-500">
                <span className="h-4 w-4 border border-slate-400 bg-white inline-block" />
                <span className="text-[11px]">Unclickable ink</span>
              </div>
            </div>
            <ArrowRight className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-[11px] font-medium text-emerald-900 mb-1">Checkbox Widget</p>
              <div className="h-6 flex items-center gap-2 text-emerald-950 font-medium">
                <span className="h-4 w-4 rounded-xs border border-emerald-900 bg-emerald-900 text-white inline-flex items-center justify-center">
                  <Check className="h-2.5 w-2.5" aria-hidden="true" />
                </span>
                <span className="text-[11px]">Interactive check</span>
              </div>
            </div>
          </div>

          <div className="p-3.5 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs">
            <div>
              <p className="text-[11px] text-slate-500 mb-1">Plain Grid Boxes</p>
              <div className="flex items-center gap-1 font-mono text-[10px] text-slate-400">
                {["Y", "Y", "M", "M", "D", "D"].map((ch, idx) => (
                  <span
                    key={idx}
                    className="h-6 w-5 border border-slate-300 bg-slate-50 flex items-center justify-center"
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
            <ArrowRight className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-[11px] font-medium text-emerald-900 mb-1">Comb Date Field</p>
              <div className="flex items-center gap-1 font-mono text-[10px] font-semibold text-emerald-950 tabular-nums">
                {["2", "6", "1", "1", "2", "5"].map((ch, idx) => (
                  <span
                    key={idx}
                    className="h-6 w-5 rounded-xs border border-emerald-800/40 bg-emerald-50/70 flex items-center justify-center"
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Clear 3-Step Workflow Index */}
      <div className="bg-white px-5 py-3 space-y-2">
        <ol className="divide-y divide-slate-100">
          <li className="py-2 flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-900">
              <span className="font-mono text-emerald-900 mr-2">01.</span>
              Upload PDF or ZIP Bundle Below
            </span>
            <span className="text-slate-500 shrink-0">No login needed</span>
          </li>
          <li className="py-2 flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-900">
              <span className="font-mono text-emerald-900 mr-2">02.</span>
              Preview Live Fillable PDF &amp; Tier
            </span>
            <span className="text-slate-500 shrink-0">Verify before paying</span>
          </li>
          <li className="py-2 flex items-center justify-between gap-3 text-xs">
            <span className="font-semibold text-slate-900">
              <span className="font-mono text-amber-700 mr-2">03.</span>
              Pay Matched Tier &amp; Download
            </span>
            <span className="text-slate-500 shrink-0">PDF &amp; ZIP unlock</span>
          </li>
        </ol>
        <div className="pt-1 border-t border-slate-100 flex items-center justify-between text-xs">
          <span className="text-slate-500">Ready with your document?</span>
          <button
            type="button"
            onClick={onStartConverting}
            className="inline-flex items-center gap-1 font-semibold text-emerald-900 hover:underline underline-offset-4"
          >
            <span>Go to Upload Box</span>
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);
  const [activeInfoModal, setActiveInfoModal] = useState<InfoModalTopic>(null);
  const [quoteModalPlan, setQuoteModalPlan] = useState<QuotePlanType | null>(null);
  const [quoteEmail, setQuoteEmail] = useState("");
  const [quoteOrg, setQuoteOrg] = useState("");
  const [quoteVolume, setQuoteVolume] = useState("");
  const [quoteNotes, setQuoteNotes] = useState("");
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteSubmitted, setQuoteSubmitted] = useState(false);

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

  useEffect(() => {
    if (!activeInfoModal && !quoteModalPlan) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveInfoModal(null);
        setQuoteModalPlan(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeInfoModal, quoteModalPlan]);

  const openQuoteModal = (
    plan: QuotePlanType,
    prefillVolume = "",
    prefillNotes = ""
  ) => {
    setQuoteModalPlan(plan);
    setQuoteVolume(prefillVolume);
    setQuoteNotes(prefillNotes);
    setQuoteError(null);
    setQuoteSubmitted(false);
  };

  const handleQuoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = quoteEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setQuoteError("Please enter a valid business or personal email address.");
      return;
    }
    setQuoteError(null);
    setQuoteSubmitted(true);
  };

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

  const modalData = activeInfoModal ? INFO_MODAL_CONTENT[activeInfoModal] : null;

  return (
    <div id="top" className="min-h-screen flex flex-col bg-[#F7F8F7] text-slate-900">
      {/* Top Bar Contract: 3 zones (Wordmark — 5 concise single-line links — 1 primary CTA) */}
      <header className="sticky top-0 z-30 border-t-2 border-t-emerald-900 border-b border-slate-200/90 bg-white/95 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-[68px] flex items-center justify-between gap-8">
          <a
            href="#top"
            aria-label="FormifyPDF home"
            className="whitespace-nowrap shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800 rounded-md"
          >
            <BrandWordmark size={28} />
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600"
          >
            <a
              href="#convert-workspace"
              className="py-1 hover:text-slate-900 hover:underline underline-offset-8 decoration-emerald-800/80 decoration-2 transition-colors whitespace-nowrap shrink-0"
            >
              Convert
            </a>
            <a
              href="#capabilities"
              className="py-1 hover:text-slate-900 hover:underline underline-offset-8 decoration-emerald-800/80 decoration-2 transition-colors whitespace-nowrap shrink-0"
            >
              Capabilities
            </a>
            <a
              href="#how-it-works"
              className="py-1 hover:text-slate-900 hover:underline underline-offset-8 decoration-emerald-800/80 decoration-2 transition-colors whitespace-nowrap shrink-0"
            >
              How It Works
            </a>
            <a
              href="#pricing"
              className="py-1 hover:text-slate-900 hover:underline underline-offset-8 decoration-emerald-800/80 decoration-2 transition-colors whitespace-nowrap shrink-0"
            >
              Pricing
            </a>
            <a
              href="#faq"
              className="py-1 hover:text-slate-900 hover:underline underline-offset-8 decoration-emerald-800/80 decoration-2 transition-colors whitespace-nowrap shrink-0"
            >
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                scrollToWorkspace();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-900 px-4 py-2 text-xs sm:text-sm font-semibold text-white hover:bg-emerald-800 transition-colors shadow-xs whitespace-nowrap shrink-0"
            >
              <span>Start Converting</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="md:hidden inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2.5 text-slate-700 hover:bg-slate-50"
            >
              {mobileMenuOpen ? (
                <X className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Menu className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <nav
            aria-label="Mobile navigation"
            className="md:hidden border-t border-slate-200 bg-white px-4 py-3 flex flex-col gap-1 text-sm font-medium text-slate-700"
          >
            <a
              href="#convert-workspace"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md px-3 py-2.5 hover:bg-slate-50 hover:text-slate-900"
            >
              Convert
            </a>
            <a
              href="#capabilities"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md px-3 py-2.5 hover:bg-slate-50 hover:text-slate-900"
            >
              Capabilities
            </a>
            <a
              href="#how-it-works"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md px-3 py-2.5 hover:bg-slate-50 hover:text-slate-900"
            >
              How It Works
            </a>
            <a
              href="#pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md px-3 py-2.5 hover:bg-slate-50 hover:text-slate-900"
            >
              Pricing
            </a>
            <a
              href="#faq"
              onClick={() => setMobileMenuOpen(false)}
              className="rounded-md px-3 py-2.5 hover:bg-slate-50 hover:text-slate-900"
            >
              FAQ
            </a>
          </nav>
        )}
      </header>

      <main className="flex-1">
        {/* Hero Section — Editorial Headline + Interactive AcroForm Specimen */}
        <section className="relative border-b border-slate-200 bg-white overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(#cbd5e1_0.85px,transparent_0.85px)] [background-size:24px_24px] opacity-40"
          />
          <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            <div className="lg:col-span-7 space-y-6">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-emerald-900">
                <span className="font-semibold">formifypdf.com</span>
                <span aria-hidden="true" className="text-slate-400">
                  ·
                </span>
                <span>Automated AcroForm Engine</span>
                <span aria-hidden="true" className="text-slate-400">
                  ·
                </span>
                <span>Page-Tier Pricing</span>
              </div>

              <h1 className="text-3xl sm:text-[2.75rem] lg:text-[3.15rem] font-bold tracking-tight text-slate-900 leading-[1.07] [text-wrap:balance]">
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
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-900 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-800 transition-colors shadow-sm whitespace-nowrap shrink-0"
                >
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  <span>Upload &amp; Convert Your Form</span>
                </button>
                <a
                  href="#pricing"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>See Page Pricing</span>
                </a>
              </div>

              <div className="pt-4 border-t border-slate-200/80 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                <div>
                  <p className="font-semibold text-slate-900">ISO 32000-1 AcroForms</p>
                  <p className="text-slate-500 mt-0.5">Standard PDF reader compatibility</p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">Comb &amp; Checkbox Grids</p>
                  <p className="text-slate-500 mt-0.5">Digital vector &amp; scanned deskew OCR</p>
                </div>
                <div>
                  <p className="font-semibold text-slate-900">Live Preview First</p>
                  <p className="text-slate-500 mt-0.5">Inspect every page before payment</p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5">
              <HeroConversionShowcase onStartConverting={scrollToWorkspace} />
            </div>
          </div>
        </section>

        {/* Client Conversion Workspace */}
        <section
          id="convert-workspace"
          ref={workspaceRef}
          className="mx-auto max-w-6xl px-4 sm:px-6 py-14 space-y-8"
        >
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-wide text-emerald-900">
                Conversion Workspace
              </p>
              <h2 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
                Upload Your PDF or ZIP Archive
              </h2>
              <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
                Choose a single document or form package to convert into an interactive AcroForm PDF
                and inspect the result on screen immediately.
              </p>
            </div>
            <p className="text-xs text-slate-500 font-medium">
              Supports single PDFs · Structured ZIP bundles
            </p>
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

          {/* Upload & Convert Stationery Intake Tray */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
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
              className={`rounded-xl border border-dashed p-6 sm:p-8 transition-colors ${
                dragActive
                  ? "border-emerald-800 bg-emerald-50/40"
                  : "border-slate-300 bg-[#FAFBFB]"
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
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Upload className="h-4 w-4" aria-hidden="true" />
                      <span>Upload</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => zipInputRef.current?.click()}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      <FileArchive className="h-4 w-4 text-emerald-900" aria-hidden="true" />
                      <span>ZIP Upload</span>
                    </button>
                  </div>

                  <p className="text-xs text-slate-600">
                    Drag and drop a <span className="font-semibold text-slate-800">.pdf</span> form or{" "}
                    <span className="font-semibold text-slate-800">.zip</span> archive here, or choose an
                    upload option above.
                  </p>

                  {selectedFile && (
                    <div className="inline-flex flex-wrap items-center gap-2.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800">
                      {selectedMode === "zip" ? (
                        <FileArchive className="h-4 w-4 text-emerald-900 shrink-0" aria-hidden="true" />
                      ) : (
                        <FileText className="h-4 w-4 text-emerald-900 shrink-0" aria-hidden="true" />
                      )}
                      <span className="font-semibold text-slate-900">{selectedFile.name}</span>
                      <span className="text-slate-400" aria-hidden="true">
                        ·
                      </span>
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
                    className="w-full lg:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-900 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-45 disabled:cursor-not-allowed transition-colors shadow-sm whitespace-nowrap shrink-0"
                  >
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    <span>{converting ? "Converting..." : "Convert to Fillable PDF"}</span>
                  </button>
                </div>
              </div>

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
                          uploadProgress !== null && uploadProgress < 100
                            ? uploadProgress
                            : convertPct
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Converted Fillable PDF On-Screen Presentation + Summary + Locked Downloads & Pay CTA */}
          {conversion && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7">
                <PdfPreviewFrame
                  pdfBytes={previewBytes}
                  filename={conversion.archiveFilename || conversion.originalFilename}
                  pageCount={conversion.pageCount}
                />
              </div>

              <div className="lg:col-span-5 space-y-5">
                <div className="rounded-xl border border-slate-200 border-t-2 border-t-emerald-900 bg-white p-5 space-y-4 shadow-sm">
                  <div>
                    <p className="text-xs font-semibold text-emerald-900">
                      Conversion Ready
                    </p>
                    <h3 className="mt-0.5 text-lg font-bold text-slate-900 break-words">
                      {conversion.archiveFilename || conversion.originalFilename}
                    </h3>
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
                          <span className="font-semibold text-amber-800">
                            Above 60 pages — Custom price
                          </span>
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>

                {!conversion.paid ? (
                  matchedTier ? (
                    <div className="rounded-xl border border-amber-300/90 bg-white p-5 space-y-4 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-amber-100 p-2 text-amber-800 shrink-0">
                          <Lock className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="space-y-1">
                          <h4 className="text-sm font-bold text-slate-900">
                            Unlock Your Fillable PDF &amp; ZIP Downloads
                          </h4>
                          <p className="text-xs text-slate-600 leading-relaxed">
                            Your interactive PDF preview is ready. Complete payment for your{" "}
                            <span className="font-semibold text-slate-900">{matchedTier.name}</span>{" "}
                            ({conversion.pageCount}{" "}
                            {conversion.pageCount === 1 ? "page" : "pages"}) to unlock immediate
                            file downloads.
                          </p>
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-200 bg-[#F7F8F7] px-4 py-3 flex items-center justify-between">
                        <div>
                          <p className="text-xs font-semibold text-slate-900">{matchedTier.name}</p>
                          <p className="text-[11px] text-slate-500 tabular-nums">
                            Covers up to {matchedTier.max_pages} pages · {conversion.pageCount}{" "}
                            detected
                          </p>
                        </div>
                        <p className="text-xl font-bold font-mono tabular-nums text-emerald-900">
                          {formatCurrency(matchedTier.price_cents)}
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={checkoutBusy}
                        onClick={() => void handleConfirmPayment()}
                        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-900 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 transition-colors shadow-sm"
                      >
                        <CreditCard className="h-4 w-4" aria-hidden="true" />
                        <span>
                          {checkoutBusy
                            ? "Confirming Payment..."
                            : `Pay ${formatCurrency(matchedTier.price_cents)} to Unlock Downloads`}
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-amber-300/90 bg-white p-5 space-y-4 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-amber-100 p-2 text-amber-800 shrink-0">
                          <Building2 className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="space-y-1">
                          <h4 className="text-sm font-bold text-slate-900">
                            Above 60 Pages — Custom Price Required
                          </h4>
                          <p className="text-xs text-slate-600 leading-relaxed">
                            This document has{" "}
                            <span className="font-semibold text-slate-900">
                              {conversion.pageCount} pages
                            </span>
                            , which exceeds the 60-page standard tier. Reach out for custom pricing
                            for this file or recurring business volume.
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          openQuoteModal(
                            "over_60",
                            `${conversion.pageCount} pages`,
                            `Converted file: ${conversion.archiveFilename || conversion.originalFilename} (${conversion.pageCount} pages)`
                          )
                        }
                        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 transition-colors shadow-sm"
                      >
                        <Mail className="h-4 w-4" aria-hidden="true" />
                        <span>Reach Out for Custom Price</span>
                      </button>
                    </div>
                  )
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

                <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-600">Export Files</p>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
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

        {/* Capabilities Bento Grid & Editorial Workflow */}
        <section id="capabilities" className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 space-y-12">
            <div id="how-it-works" className="max-w-2xl space-y-2">
              <p className="text-xs font-semibold text-emerald-900">
                Engine Architecture · formifypdf.com
              </p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
                Precision AcroForm Detection Without Manual Recreation
              </h2>
              <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
                Built for tax, legal, compliance, HR, and operational forms—preserving exact print
                geometry while inserting crisp interactive fields.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Bento Card 1 (Marquee): 7 columns */}
              <div className="lg:col-span-7 rounded-2xl border border-slate-200 bg-[#FAFBF9] p-6 sm:p-8 flex flex-col justify-between gap-6">
                <div className="space-y-2.5">
                  <p className="text-xs font-mono font-semibold text-emerald-900">
                    01. Vector &amp; Scanned Field Detection
                  </p>
                  <h3 className="text-xl font-bold text-slate-900">
                    Underlines, Table Cells, Checkboxes &amp; Radio Groups
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed max-w-xl">
                    Fuses PDF vector path extraction with deskewed raster OCR so both clean
                    digital exports and scanned paper documents receive accurately aligned form
                    widgets without overlapping surrounding labels.
                  </p>
                </div>

                {/* Inline Field Mapping Schematic */}
                <div className="rounded-xl border border-slate-200 bg-white p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div className="space-y-1.5">
                    <span className="text-slate-500">Full Name</span>
                    <div className="h-7 rounded border border-emerald-800/40 bg-emerald-50/40 px-2 flex items-center text-slate-700 font-medium">
                      Text Input
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-slate-500">Filing Status</span>
                    <div className="h-7 flex items-center gap-3 text-slate-700 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-3.5 w-3.5 rounded-xs border border-emerald-900 bg-emerald-900" />
                        Active
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-3.5 w-3.5 rounded-xs border border-slate-400 bg-white" />
                        Exempt
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-slate-500">Account Code</span>
                    <div className="flex items-center gap-1 font-mono font-semibold tabular-nums">
                      {["0", "4", "8", "2", "9"].map((n, idx) => (
                        <span
                          key={idx}
                          className="h-7 w-6 rounded-xs border border-emerald-800/40 bg-emerald-50/40 flex items-center justify-center text-slate-900"
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Bento Card 2: 5 columns */}
              <div className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 flex flex-col justify-between gap-6">
                <div className="space-y-2.5">
                  <p className="text-xs font-mono font-semibold text-emerald-900">
                    02. Multi-Page Geometry &amp; Comb Grids
                  </p>
                  <h3 className="text-xl font-bold text-slate-900">
                    Exact Character Grids, CropBoxes &amp; Rotations
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Preserves fixed-width date and tax ID character boxes, mixed portrait and
                    landscape pages, and CropBox offsets across every page.
                  </p>
                </div>

                <dl className="border-t border-slate-100 pt-4 grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <dt className="text-slate-500">Output Standard</dt>
                    <dd className="mt-1 font-mono font-semibold text-slate-900">ISO 32000-1</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Character Grids</dt>
                    <dd className="mt-1 font-mono font-semibold text-emerald-900">Comb MaxLen</dd>
                  </div>
                </dl>
              </div>

              {/* Bento Card 3: 5 columns */}
              <div className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 flex flex-col justify-between gap-6">
                <div className="space-y-2.5">
                  <p className="text-xs font-mono font-semibold text-emerald-900">
                    03. Single PDFs &amp; ZIP Archives
                  </p>
                  <h3 className="text-xl font-bold text-slate-900">
                    Flexible Document &amp; Bundle Intake
                  </h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Upload an individual form or a structured ZIP archive. Download your finished
                    interactive PDF or complete fillable bundle right after checkout.
                  </p>
                </div>

                <div className="border-t border-slate-100 pt-4 flex items-center justify-between text-xs text-slate-600">
                  <span className="font-medium text-slate-900">.PDF &amp; .ZIP Intake</span>
                  <span>Path-confined extraction</span>
                </div>
              </div>

              {/* Bento Card 4: 7 columns */}
              <div className="lg:col-span-7 rounded-2xl border border-slate-200 bg-[#0F1916] text-white p-6 sm:p-8 flex flex-col justify-between gap-6">
                <div className="space-y-2.5">
                  <p className="text-xs font-mono font-semibold text-emerald-400">
                    04. Live Verification Before Payment
                  </p>
                  <h3 className="text-xl font-bold text-white">
                    Inspect Every Page On Screen Prior to Checkout
                  </h3>
                  <p className="text-sm text-slate-300 leading-relaxed max-w-xl">
                    Never purchase a conversion blind. Review your rendered fillable PDF canvas,
                    page count, and detected field summary first—then confirm only the tier matched
                    to your page count.
                  </p>
                </div>

                <div className="border-t border-white/10 pt-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                  <span className="inline-flex items-center gap-2 text-emerald-300 font-medium">
                    <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Zero-obligation on-screen preview</span>
                  </span>
                  <button
                    type="button"
                    onClick={scrollToWorkspace}
                    className="inline-flex items-center gap-1.5 text-white font-semibold hover:text-emerald-300 transition-colors"
                  >
                    <span>Convert a document now</span>
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Transparent Page-Based Pricing Tiers + Custom 60+ & Bulk/Enterprise Plans */}
        <section id="pricing" className="border-t border-slate-200 bg-[#F7F8F7]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 space-y-10">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold text-emerald-900">
                  Transparent Pricing
                </p>
                <h2 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
                  Simple Page-Based Tiers &amp; Business Plans
                </h2>
                <p className="mt-1.5 text-sm text-slate-600">
                  Preview your converted fillable PDF on screen first — pay only for your page count
                  tier, or reach out for 60+ page documents and ongoing bulk volume.
                </p>
              </div>
              <p className="text-xs font-medium text-slate-500">
                Single conversions up to 60 pages · Custom &amp; recurring business options
              </p>
            </div>

            {configError && <p className="text-xs text-slate-500">{configError}</p>}

            {/* Standard Per-Document Tiers (up to 15, 30, 45, 60 pages) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {pricingTiers.map((tier) => (
                <div
                  key={tier.id}
                  className="rounded-xl border border-slate-200 border-t-2 border-t-emerald-900 bg-white p-6 flex flex-col justify-between space-y-6 shadow-sm"
                >
                  <div className="space-y-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-base font-bold text-slate-900">{tier.name}</h3>
                      <span className="text-xs font-mono text-slate-500 tabular-nums">
                        {tier.max_pages}p max
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <p className="text-3xl font-bold font-mono tabular-nums text-emerald-900">
                        {formatCurrency(tier.price_cents)}
                      </p>
                      <span className="text-xs text-slate-500">per document</span>
                    </div>
                    <ul className="space-y-2.5 pt-3 border-t border-slate-100 text-xs text-slate-600">
                      <li className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
                        <span>Up to {tier.max_pages} pages per submission</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
                        <span>Live AcroForm preview first</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="h-3.5 w-3.5 text-emerald-800 shrink-0" aria-hidden="true" />
                        <span>Instant PDF &amp; ZIP unlock</span>
                      </li>
                    </ul>
                  </div>

                  <button
                    type="button"
                    onClick={scrollToWorkspace}
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-colors"
                  >
                    Convert With This Tier
                  </button>
                </div>
              ))}
            </div>

            {/* Framed High-Page & Business / Recurring Plans */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* Above 60 Pages — Custom Price */}
              <div className="lg:col-span-5 rounded-2xl border border-slate-200 border-t-2 border-t-amber-600 bg-white p-7 flex flex-col justify-between space-y-6 shadow-sm">
                <div className="space-y-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-semibold text-amber-800">Large Documents</p>
                    <span className="text-xs font-mono text-slate-500 tabular-nums">61+ pages</span>
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">Above 60 Pages</h3>
                    <div className="mt-2 flex items-baseline gap-2">
                      <p className="text-2xl font-bold font-mono text-slate-900">Custom Price</p>
                      <span className="text-xs text-slate-500">per document</span>
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Converting long regulatory packets, multi-part manuals, or high-page legal
                    filings? Reach out for a fast quote tailored to your page count.
                  </p>
                  <ul className="space-y-2 pt-3 border-t border-slate-100 text-xs text-slate-600">
                    <li className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                      <span>61+ page packets &amp; multi-section books</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                      <span>Comb grids, tables &amp; rotated CropBox preservation</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-amber-700 shrink-0" aria-hidden="true" />
                      <span>On-screen preview before final delivery</span>
                    </li>
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => openQuoteModal("over_60", "61+ pages")}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-900 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-900 hover:text-white transition-colors"
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  <span>Reach Out for Custom Price</span>
                </button>
              </div>

              {/* Bulk, Enterprise & Ongoing Recurring Conversions */}
              <div className="lg:col-span-7 rounded-2xl border border-emerald-950 bg-[#0F1916] text-white p-7 flex flex-col justify-between space-y-6 shadow-sm">
                <div className="space-y-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-semibold text-emerald-400">
                      Bulk · Enterprise · Ongoing &amp; Recurring
                    </p>
                    <span className="text-xs font-mono text-slate-300">formifypdf.com</span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-4">
                    <h3 className="text-xl sm:text-2xl font-bold text-white">
                      Bulk, Business &amp; Recurring Conversions
                    </h3>
                    <p className="text-lg font-bold font-mono text-emerald-300">
                      Custom Business Plan
                    </p>
                  </div>
                  <p className="text-sm text-slate-300 leading-relaxed max-w-2xl">
                    Built for organizations, operations teams, and businesses handling bulk batches
                    or ongoing recurring PDF-to-AcroForm conversions each month.
                  </p>

                  <div className="pt-4 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-200">
                    <div className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                      <span>Ongoing &amp; recurring conversion cadence</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                      <span>Bulk multi-form PDF &amp; ZIP batches</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                      <span>Custom template tuning &amp; priority support</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                      <span>Consolidated commercial invoicing</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
                  <button
                    type="button"
                    onClick={() => openQuoteModal("enterprise_bulk", "Ongoing / Bulk monthly volume")}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors shadow-xs whitespace-nowrap"
                  >
                    <Building2 className="h-4 w-4" aria-hidden="true" />
                    <span>Request Bulk &amp; Recurring Quote</span>
                  </button>
                  <a
                    href="mailto:support@formifypdf.com?subject=Bulk%20%26%20Enterprise%20AcroForm%20Inquiry"
                    className="text-xs font-medium text-emerald-300 hover:text-white hover:underline underline-offset-4"
                  >
                    Or email support@formifypdf.com
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Frequently Asked Questions */}
        <section id="faq" className="border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 grid grid-cols-1 lg:grid-cols-12 gap-10">
            <div className="lg:col-span-4 space-y-3">
              <p className="text-xs font-semibold text-emerald-900">Questions &amp; Answers</p>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
                Everything You Need Before Converting
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                Need help with high-volume forms or custom document templates? Reach our team at{" "}
                <a
                  href="mailto:support@formifypdf.com"
                  className="font-semibold text-emerald-900 hover:underline underline-offset-4"
                >
                  support@formifypdf.com
                </a>
                .
              </p>
            </div>

            <div className="lg:col-span-8 divide-y divide-slate-200 border-t border-b border-slate-200">
              {FAQ_ITEMS.map((item, idx) => {
                const isOpen = openFaqIndex === idx;
                return (
                  <div key={item.question} className="py-4">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                      className="w-full flex items-center justify-between gap-4 text-left py-1 text-sm sm:text-base font-semibold text-slate-900 hover:text-emerald-900 transition-colors"
                    >
                      <span>{item.question}</span>
                      <ChevronDown
                        className={`h-4 w-4 text-slate-500 shrink-0 transition-transform duration-200 ${
                          isOpen ? "rotate-180 text-emerald-900" : ""
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                    {isOpen && (
                      <p className="mt-2.5 pr-6 text-sm text-slate-600 leading-relaxed">
                        {item.answer}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>

      {/* Commercial Footer for formifypdf.com with Socials, Product Links & Legal Documentation */}
      <footer className="bg-[#0B1613] text-slate-300 border-t border-emerald-950">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 pb-10">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-10 pb-12 border-b border-white/10">
            {/* Brand & Socials Column */}
            <div className="lg:col-span-4 space-y-4">
              <a
                href="#top"
                aria-label="FormifyPDF back to top"
                className="inline-flex focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded-md"
              >
                <BrandWordmark size={26} variant="dark" />
              </a>

              <p className="text-sm text-slate-300 leading-relaxed max-w-sm">
                Commercial AcroForm PDF conversion for static forms and ZIP bundles. Built at{" "}
                <a
                  href="https://formifypdf.com"
                  className="text-white font-medium hover:text-emerald-300 underline underline-offset-4"
                >
                  formifypdf.com
                </a>{" "}
                with instant on-screen verification and page-based pricing.
              </p>

              <div className="flex items-center gap-2 text-xs text-slate-300">
                <Mail className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                <a
                  href="mailto:support@formifypdf.com"
                  className="hover:text-white transition-colors"
                >
                  support@formifypdf.com
                </a>
              </div>

              {/* Social Links */}
              <div className="pt-2">
                <p className="text-xs font-semibold text-white mb-3">Follow FormifyPDF</p>
                <div className="flex items-center gap-2.5">
                  <a
                    href="https://x.com/formifypdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="FormifyPDF on X"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-200 hover:bg-emerald-900 hover:border-emerald-700 hover:text-white transition-colors"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                    </svg>
                  </a>

                  <a
                    href="https://www.linkedin.com/company/formifypdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="FormifyPDF on LinkedIn"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-200 hover:bg-emerald-900 hover:border-emerald-700 hover:text-white transition-colors"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
                    </svg>
                  </a>

                  <a
                    href="https://github.com/formifypdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="FormifyPDF on GitHub"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-200 hover:bg-emerald-900 hover:border-emerald-700 hover:text-white transition-colors"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                  </a>

                  <a
                    href="https://www.youtube.com/@formifypdf"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="FormifyPDF on YouTube"
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-slate-200 hover:bg-emerald-900 hover:border-emerald-700 hover:text-white transition-colors"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                    </svg>
                  </a>
                </div>
              </div>
            </div>

            {/* Product Links */}
            <div className="lg:col-span-3 space-y-3">
              <h3 className="text-sm font-semibold text-white">Product</h3>
              <ul className="space-y-2.5 text-sm text-slate-300">
                <li>
                  <a
                    href="#convert-workspace"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    PDF &amp; ZIP Converter
                  </a>
                </li>
                <li>
                  <a
                    href="#capabilities"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Detection Capabilities
                  </a>
                </li>
                <li>
                  <a
                    href="#how-it-works"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    How It Works
                  </a>
                </li>
                <li>
                  <a
                    href="#pricing"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Page-Tier Pricing
                  </a>
                </li>
                <li>
                  <a
                    href="#faq"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Questions &amp; Answers
                  </a>
                </li>
              </ul>
            </div>

            {/* Specifications & Trust */}
            <div className="lg:col-span-3 space-y-3">
              <h3 className="text-sm font-semibold text-white">Standards &amp; Security</h3>
              <ul className="space-y-2.5 text-sm text-slate-300">
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveInfoModal("acroform")}
                    className="text-left hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    AcroForm Specification
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveInfoModal("security")}
                    className="text-left hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Security &amp; Document Handling
                  </button>
                </li>
                <li>
                  <a
                    href="mailto:support@formifypdf.com"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Enterprise Support
                  </a>
                </li>
              </ul>
            </div>

            {/* Legal */}
            <div className="lg:col-span-2 space-y-3">
              <h3 className="text-sm font-semibold text-white">Legal</h3>
              <ul className="space-y-2.5 text-sm text-slate-300">
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveInfoModal("privacy")}
                    className="text-left hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Privacy Policy
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => setActiveInfoModal("terms")}
                    className="text-left hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    Terms of Service
                  </button>
                </li>
                <li>
                  <a
                    href="https://formifypdf.com"
                    className="hover:text-white hover:underline underline-offset-4 transition-colors"
                  >
                    formifypdf.com
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="pt-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-slate-400">
            <p>© 2026 FormifyPDF · formifypdf.com · All rights reserved.</p>
            <p className="font-mono text-[11px] text-slate-400">
              ISO 32000-1 AcroForm Output · Encrypted Upload &amp; Checkout
            </p>
          </div>
        </div>
      </footer>

      {/* Policy & Specification Modal */}
      {modalData && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="info-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          onClick={() => setActiveInfoModal(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-6 py-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-mono text-emerald-900">{modalData.subtitle}</p>
                <h3 id="info-modal-title" className="text-lg font-bold text-slate-900 mt-0.5">
                  {modalData.title}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => setActiveInfoModal(null)}
                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-3 text-sm text-slate-600 leading-relaxed">
              {modalData.paragraphs.map((p, idx) => (
                <p key={idx}>{p}</p>
              ))}
            </div>
            <div className="border-t border-slate-200 bg-slate-50 px-6 py-3.5 flex items-center justify-between text-xs">
              <span className="text-slate-500">formifypdf.com</span>
              <button
                type="button"
                onClick={() => setActiveInfoModal(null)}
                className="rounded-lg bg-emerald-900 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Custom 60+ Pages & Bulk/Enterprise Inquiry Modal */}
      {quoteModalPlan && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="quote-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          onClick={() => setQuoteModalPlan(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-6 py-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-mono text-emerald-900">
                  formifypdf.com · Custom &amp; Business Pricing
                </p>
                <h3 id="quote-modal-title" className="text-lg font-bold text-slate-900 mt-0.5">
                  {quoteModalPlan === "over_60"
                    ? "Request Custom Quote (Above 60 Pages)"
                    : "Bulk, Enterprise & Recurring Plan"}
                </h3>
              </div>
              <button
                type="button"
                aria-label="Close quote dialog"
                onClick={() => setQuoteModalPlan(null)}
                className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {quoteSubmitted ? (
              <div className="p-6 space-y-4">
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <CheckCircle2 className="h-5 w-5 text-emerald-800 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="space-y-1 text-sm text-emerald-950">
                    <p className="font-bold">Quote Details Prepared for {quoteEmail.trim()}</p>
                    <p className="text-xs text-emerald-900 leading-relaxed">
                      Send your inquiry directly via email below to reach our FormifyPDF commercial
                      team at support@formifypdf.com.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <a
                    href={`mailto:support@formifypdf.com?subject=${encodeURIComponent(
                      quoteModalPlan === "over_60"
                        ? "FormifyPDF Custom Quote (60+ Pages)"
                        : "FormifyPDF Bulk & Recurring Business Inquiry"
                    )}&body=${encodeURIComponent(
                      `Plan: ${
                        quoteModalPlan === "over_60"
                          ? "Above 60 Pages"
                          : "Bulk, Enterprise & Recurring Conversions"
                      } | Email: ${quoteEmail.trim()} | Organization: ${
                        quoteOrg.trim() || "N/A"
                      } | Volume/Pages: ${quoteVolume.trim() || "N/A"} | Notes: ${
                        quoteNotes.trim() || "N/A"
                      }`
                    )}`}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
                  >
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    <span>Email support@formifypdf.com</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setQuoteModalPlan(null)}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleQuoteSubmit} className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setQuoteModalPlan("over_60")}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      quoteModalPlan === "over_60"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Above 60 Pages
                  </button>
                  <button
                    type="button"
                    onClick={() => setQuoteModalPlan("enterprise_bulk")}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                      quoteModalPlan === "enterprise_bulk"
                        ? "bg-white text-slate-900 shadow-xs"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Bulk &amp; Recurring
                  </button>
                </div>

                {quoteError && (
                  <p role="alert" className="text-xs font-medium text-rose-700">
                    {quoteError}
                  </p>
                )}

                <div className="space-y-1">
                  <label htmlFor="quote-email" className="block text-xs font-semibold text-slate-700">
                    Work or Contact Email
                  </label>
                  <input
                    id="quote-email"
                    type="email"
                    required
                    value={quoteEmail}
                    onChange={(e) => setQuoteEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-emerald-900"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label htmlFor="quote-org" className="block text-xs font-semibold text-slate-700">
                      Company / Organization
                    </label>
                    <input
                      id="quote-org"
                      type="text"
                      value={quoteOrg}
                      onChange={(e) => setQuoteOrg(e.target.value)}
                      placeholder="Optional"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-emerald-900"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="quote-volume" className="block text-xs font-semibold text-slate-700">
                      {quoteModalPlan === "over_60" ? "Estimated Pages" : "Monthly Volume"}
                    </label>
                    <input
                      id="quote-volume"
                      type="text"
                      value={quoteVolume}
                      onChange={(e) => setQuoteVolume(e.target.value)}
                      placeholder={quoteModalPlan === "over_60" ? "e.g. 95 pages" : "e.g. 150 forms/mo"}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-emerald-900"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label htmlFor="quote-notes" className="block text-xs font-semibold text-slate-700">
                    Project Notes
                  </label>
                  <textarea
                    id="quote-notes"
                    rows={3}
                    value={quoteNotes}
                    onChange={(e) => setQuoteNotes(e.target.value)}
                    placeholder="Tell us about your documents, frequency, or delivery requirements."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-emerald-900"
                  />
                </div>

                <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
                  <span className="text-xs text-slate-500">support@formifypdf.com</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setQuoteModalPlan(null)}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="rounded-lg bg-emerald-900 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
                    >
                      Continue Quote Request
                    </button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

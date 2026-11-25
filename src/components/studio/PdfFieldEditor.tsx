import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyStart,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FilePlus2,
  Maximize2,
  MousePointer,
  PlusSquare,
  Redo2,
  RefreshCw,
  RotateCw,
  Save,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  getEffectivePageSizePt,
  pdfRectToViewportPx,
  roundPt,
  viewportPxToPdfRect,
} from "../../lib/formifypdf/coordinate.ts";
import type {
  ConfidenceTier,
  DetectedFormField,
  FieldManifest,
  FormifyFieldType,
  PdfRect,
  ReviewStatus,
} from "../../lib/formifypdf/types.ts";
import type { StudioApiClient } from "./studio-api.ts";

if (typeof window !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
}

const ALL_FIELD_TYPES: FormifyFieldType[] = [
  "text",
  "multiline",
  "numeric",
  "currency",
  "date",
  "email",
  "phone",
  "address",
  "checkbox",
  "radio",
  "dropdown",
  "signature",
  "initials",
  "table_cell",
  "char_cells",
  "repeating_group",
];

interface PdfFieldEditorProps {
  api: StudioApiClient;
  documentId: string;
  documentTitle: string;
  canEdit: boolean;
  onManifestSaved?: (manifest: FieldManifest) => void;
  onAcroFormGenerated?: (validation: Record<string, unknown>) => void;
  onTemplateCreated?: (templateId: string) => void;
}

interface DragState {
  mode: "move" | "resize" | "draw";
  fieldId?: string;
  startClientX: number;
  startClientY: number;
  initialPx?: { left: number; top: number; width: number; height: number };
  currentDrawPx?: { left: number; top: number; width: number; height: number };
}

export function PdfFieldEditor({
  api,
  documentId,
  documentTitle,
  canEdit,
  onManifestSaved,
  onAcroFormGenerated,
  onTemplateCreated,
}: PdfFieldEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  const [manifest, setManifest] = useState<FieldManifest | null>(null);
  const [fields, setFields] = useState<DetectedFormField[]>([]);
  const [undoStack, setUndoStack] = useState<DetectedFormField[][]>([]);
  const [redoStack, setRedoStack] = useState<DetectedFormField[][]>([]);

  const [currentPage, setCurrentPage] = useState(0);
  const [zoom, setZoom] = useState(1.15);
  const [viewRotation, setViewRotation] = useState<0 | 90 | 180 | 270>(0);
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | ConfidenceTier>("all");
  const [toolMode, setToolMode] = useState<"select" | "draw">("select");

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [canvasDimPx, setCanvasDimPx] = useState<{ width: number; height: number }>({
    width: 684,
    height: 968,
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Create template quick drawer
  const [showTplForm, setShowTplForm] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplCategory, setTplCategory] = useState("General");
  const [tplPolicy, setTplPolicy] = useState<"flattened" | "fillable" | "both">("flattened");

  // Load manifest + PDF binary
  useEffect(() => {
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    setStatusMsg(null);

    (async () => {
      try {
        const [manRes, pdfBytes] = await Promise.all([
          api.json<{ ok: boolean; manifest: FieldManifest }>(
            `/api/v1/documents/${documentId}/manifest`
          ),
          api.fetchPdfBytes(`/api/v1/documents/${documentId}/pdf`),
        ]);
        if (!active) return;
        setManifest(manRes.manifest);
        setFields(manRes.manifest.fields || []);
        setUndoStack([]);
        setRedoStack([]);
        setDirty(false);
        setCurrentPage(0);
        setSelectedIds(manRes.manifest.fields[0] ? [manRes.manifest.fields[0].id] : []);
        setTplName(manRes.manifest.templateName || documentTitle || "Untitled Template");

        // Load PDF.js document
        try {
          if (pdfDocRef.current) {
            await Promise.resolve(pdfDocRef.current.cleanup?.()).catch(() => {});
            pdfDocRef.current = null;
          }
          if (loadingTaskRef.current) {
            await Promise.resolve(loadingTaskRef.current.destroy?.()).catch(() => {});
            loadingTaskRef.current = null;
          }
          const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
          loadingTaskRef.current = loadingTask;
          const doc = await loadingTask.promise;
          if (!active) {
            await Promise.resolve(doc.cleanup?.()).catch(() => {});
            await Promise.resolve(loadingTask.destroy?.()).catch(() => {});
            return;
          }
          pdfDocRef.current = doc;
        } catch (pdfErr) {
          // Non-fatal in headless test environments without Canvas 2D
          console.warn("[PdfFieldEditor] PDF.js render skipped:", pdfErr);
        }
      } catch (err) {
        if (active) {
          setErrorMsg(err instanceof Error ? err.message : "Failed to load document manifest");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore
        }
      }
      if (pdfDocRef.current) {
        void Promise.resolve(pdfDocRef.current.cleanup?.()).catch(() => {});
        pdfDocRef.current = null;
      }
      if (loadingTaskRef.current) {
        void Promise.resolve(loadingTaskRef.current.destroy?.()).catch(() => {});
        loadingTaskRef.current = null;
      }
    };
  }, [api, documentId, documentTitle]);

  const activePageInfo = useMemo(() => {
    if (!manifest) return { widthPt: 595.28, heightPt: 841.89, rotation: 0 as const };
    return (
      manifest.pages[currentPage] || {
        widthPt: 595.28,
        heightPt: 841.89,
        rotation: 0 as const,
      }
    );
  }, [manifest, currentPage]);

  const effectiveSizePt = useMemo(
    () => getEffectivePageSizePt(activePageInfo, viewRotation),
    [activePageInfo, viewRotation]
  );

  // Render active PDF.js page onto canvas
  useEffect(() => {
    let cancelled = false;
    const renderPage = async () => {
      const targetCssWidth = Math.round(effectiveSizePt.widthPt * zoom);
      const targetCssHeight = Math.round(effectiveSizePt.heightPt * zoom);
      setCanvasDimPx({ width: targetCssWidth, height: targetCssHeight });

      const doc = pdfDocRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;

      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }
        const page = await doc.getPage(currentPage + 1);
        if (cancelled) return;

        const baseRotation = (page.rotate + viewRotation) % 360;
        const viewport = page.getViewport({ scale: zoom, rotation: baseRotation });
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;
        setCanvasDimPx({
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        });

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = page.render({ canvasContext: ctx, viewport, canvas });
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        // Ignore cancelled renders
      }
    };
    void renderPage();
    return () => {
      cancelled = true;
    };
  }, [currentPage, zoom, viewRotation, effectiveSizePt, loading]);

  const pushUndoSnapshot = useCallback(
    (prev: DetectedFormField[]) => {
      setUndoStack((s) => [...s.slice(-24), prev]);
      setRedoStack([]);
      setDirty(true);
    },
    []
  );

  const commitFields = useCallback(
    (updater: (prev: DetectedFormField[]) => DetectedFormField[], recordUndo = true) => {
      setFields((prev) => {
        if (recordUndo) {
          setUndoStack((s) => [...s.slice(-24), prev]);
          setRedoStack([]);
        }
        setDirty(true);
        return updater(prev);
      });
    },
    []
  );

  const handleUndo = useCallback(() => {
    setUndoStack((u) => {
      if (u.length === 0) return u;
      const prev = u[u.length - 1];
      setRedoStack((r) => [...r, fields]);
      setFields(prev);
      setDirty(true);
      return u.slice(0, -1);
    });
  }, [fields]);

  const handleRedo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const next = r[r.length - 1];
      setUndoStack((u) => [...u, fields]);
      setFields(next);
      setDirty(true);
      return r.slice(0, -1);
    });
  }, [fields]);

  const primarySelectedField = useMemo(
    () => fields.find((f) => f.id === selectedIds[0]) || null,
    [fields, selectedIds]
  );

  const pageFields = useMemo(
    () =>
      fields.filter((f) => {
        if (f.page !== currentPage) return false;
        if (confidenceFilter !== "all" && f.confidenceTier !== confidenceFilter) return false;
        return true;
      }),
    [fields, currentPage, confidenceFilter]
  );

  // Keyboard shortcuts (Ctrl+Z, Ctrl+Y, Arrow nudge, Delete)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (!canEdit || selectedIds.length === 0) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        commitFields((prev) => prev.filter((f) => !selectedIds.includes(f.id)));
        setSelectedIds([]);
        return;
      }

      const step = e.shiftKey ? 5 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      if (dx !== 0 || dy !== 0) {
        e.preventDefault();
        commitFields((prev) =>
          prev.map((f) =>
            selectedIds.includes(f.id)
              ? {
                  ...f,
                  reviewStatus: "edited",
                  rect: {
                    ...f.rect,
                    x: roundPt(Math.max(0, f.rect.x + dx)),
                    y: roundPt(Math.max(0, f.rect.y + dy)),
                  },
                }
              : f
          )
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEdit, selectedIds, commitFields, handleUndo, handleRedo]);

  // Overlay mouse handlers
  const handleOverlayMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragState || !canEdit) return;
    const dx = e.clientX - dragState.startClientX;
    const dy = e.clientY - dragState.startClientY;

    if (dragState.mode === "draw") {
      const containerRect = e.currentTarget.getBoundingClientRect();
      const curX = e.clientX - containerRect.left;
      const curY = e.clientY - containerRect.top;
      const startX = dragState.startClientX - containerRect.left;
      const startY = dragState.startClientY - containerRect.top;
      setDragState({
        ...dragState,
        currentDrawPx: {
          left: Math.min(startX, curX),
          top: Math.min(startY, curY),
          width: Math.max(8, Math.abs(curX - startX)),
          height: Math.max(8, Math.abs(curY - startY)),
        },
      });
      return;
    }

    if (!dragState.initialPx || !dragState.fieldId) return;
    const nextPx =
      dragState.mode === "move"
        ? {
            ...dragState.initialPx,
            left: dragState.initialPx.left + dx,
            top: dragState.initialPx.top + dy,
          }
        : {
            ...dragState.initialPx,
            width: Math.max(12, dragState.initialPx.width + dx),
            height: Math.max(10, dragState.initialPx.height + dy),
          };

    const nextPdfRect = viewportPxToPdfRect(
      nextPx,
      zoom,
      activePageInfo.widthPt,
      activePageInfo.heightPt,
      viewRotation
    );

    setFields((prev) =>
      prev.map((f) =>
        f.id === dragState.fieldId
          ? { ...f, rect: nextPdfRect, reviewStatus: "edited" }
          : f
      )
    );
    setDirty(true);
  };

  const handleOverlayMouseUp = () => {
    if (!dragState) return;
    if (dragState.mode === "draw" && dragState.currentDrawPx) {
      const { width, height } = dragState.currentDrawPx;
      if (width >= 10 && height >= 8) {
        const pdfRect = viewportPxToPdfRect(
          dragState.currentDrawPx,
          zoom,
          activePageInfo.widthPt,
          activePageInfo.heightPt,
          viewRotation
        );
        const idx = fields.length + 1;
        const newField: DetectedFormField = {
          id: `fld_manual_${Date.now().toString(36)}`,
          name: `custom_field_${idx}`,
          label: `Custom Field ${idx}`,
          type: "text",
          page: currentPage,
          rect: pdfRect,
          coordinateSpace: "top_left_pdf_pt",
          originalLabelText: "",
          detectionSource: "manual",
          confidence: 1,
          confidenceTier: "high",
          confidenceEvidence: ["Manually drawn in visual field editor"],
          required: false,
          defaultValue: "",
          multiline: false,
          options: [],
          validation: {},
          tooltip: "",
          fontSize: 10,
          alignment: "left",
          reviewStatus: "edited",
        };
        commitFields((prev) => [...prev, newField]);
        setSelectedIds([newField.id]);
        setToolMode("select");
      }
    }
    setDragState(null);
  };

  const handleCanvasMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (toolMode !== "draw" || !canEdit) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragState({
      mode: "draw",
      startClientX: e.clientX,
      startClientY: e.clientY,
      currentDrawPx: {
        left: e.clientX - rect.left,
        top: e.clientY - rect.top,
        width: 2,
        height: 2,
      },
    });
  };

  const updateSelectedField = (patch: Partial<DetectedFormField>) => {
    if (!primarySelectedField || !canEdit) return;
    commitFields((prev) =>
      prev.map((f) =>
        f.id === primarySelectedField.id
          ? {
              ...f,
              ...patch,
              reviewStatus: patch.reviewStatus ?? "edited",
            }
          : f
      )
    );
  };

  const handleDuplicateSelected = () => {
    if (!primarySelectedField || !canEdit) return;
    const copy: DetectedFormField = {
      ...primarySelectedField,
      id: `fld_copy_${Date.now().toString(36)}`,
      name: `${primarySelectedField.name}_copy`,
      label: `${primarySelectedField.label} (Copy)`,
      rect: {
        ...primarySelectedField.rect,
        y: roundPt(
          Math.min(
            activePageInfo.heightPt - primarySelectedField.rect.height,
            primarySelectedField.rect.y + 18
          )
        ),
      },
      reviewStatus: "edited",
    };
    commitFields((prev) => [...prev, copy]);
    setSelectedIds([copy.id]);
  };

  const handleAlignSelected = (axis: "left" | "top") => {
    if (selectedIds.length < 2 || !canEdit) return;
    const targets = fields.filter((f) => selectedIds.includes(f.id));
    const anchorVal =
      axis === "left"
        ? Math.min(...targets.map((f) => f.rect.x))
        : Math.min(...targets.map((f) => f.rect.y));
    commitFields((prev) =>
      prev.map((f) =>
        selectedIds.includes(f.id)
          ? {
              ...f,
              rect:
                axis === "left"
                  ? { ...f.rect, x: anchorVal }
                  : { ...f.rect, y: anchorVal },
              reviewStatus: "edited",
            }
          : f
      )
    );
  };

  const handleSaveManifest = async (): Promise<FieldManifest | null> => {
    if (!manifest) return null;
    setSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await api.json<{
        ok: boolean;
        versionNumber: number;
        manifest: FieldManifest;
      }>(`/api/v1/documents/${documentId}/manifest`, {
        method: "PUT",
        body: JSON.stringify({
          templateName: manifest.templateName || documentTitle,
          fields,
        }),
      });
      setManifest(res.manifest);
      setDirty(false);
      setStatusMsg(`Saved FieldManifest v${res.versionNumber} (${fields.length} fields).`);
      onManifestSaved?.(res.manifest);
      return res.manifest;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to save manifest");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadAcroForm = async () => {
    if (dirty) {
      const saved = await handleSaveManifest();
      if (!saved) return;
      await handleGenerateAcroForm();
    }
    setErrorMsg(null);
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
      setErrorMsg(err instanceof Error ? err.message : "Failed to download AcroForm PDF");
    }
  };

  const handleGenerateAcroForm = async () => {
    if (dirty) {
      const saved = await handleSaveManifest();
      if (!saved) return;
    }
    setGenerating(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await api.json<{
        ok: boolean;
        createdWidgets: number;
        validation: Record<string, unknown>;
      }>(`/api/v1/documents/${documentId}/generate-acroform`, {
        method: "POST",
      });
      setStatusMsg(
        `AcroForm generated (${res.createdWidgets} widgets verified with appearance streams).`
      );
      onAcroFormGenerated?.(res.validation);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "AcroForm generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateTemplate = async () => {
    if (dirty) {
      const saved = await handleSaveManifest();
      if (!saved) return;
    }
    setGenerating(true);
    setErrorMsg(null);
    try {
      const res = await api.json<{ ok: boolean; templateId: string }>("/api/v1/templates", {
        method: "POST",
        body: JSON.stringify({
          documentId,
          name: tplName.trim() || documentTitle,
          description: `Generated from ${documentTitle}`,
          category: tplCategory,
          tags: ["pdf-converted"],
          outputPolicy: tplPolicy,
        }),
      });
      setShowTplForm(false);
      setStatusMsg(`Template created (${res.templateId}). Ready for validation & approval.`);
      onTemplateCreated?.(res.templateId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to create template");
    } finally {
      setGenerating(false);
    }
  };

  const handleFitWidth = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const avail = Math.max(320, el.clientWidth - 48);
    setZoom(Math.round((avail / effectiveSizePt.widthPt) * 100) / 100);
  };

  const handleFitPage = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const zw = (Math.max(320, el.clientWidth - 48)) / effectiveSizePt.widthPt;
    const zh = 620 / effectiveSizePt.heightPt;
    setZoom(Math.round(Math.min(zw, zh) * 100) / 100);
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-10 text-center text-sm text-slate-600">
        Loading PDF canvas and field manifest...
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        {errorMsg || "Document has not been analyzed yet. Upload or run analysis first."}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={currentPage <= 0}
            onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
            aria-label="Previous PDF page"
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium text-slate-700 tabular-nums px-1">
            Page {currentPage + 1} / {manifest.totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage >= manifest.totalPages - 1}
            onClick={() => setCurrentPage((p) => Math.min(manifest.totalPages - 1, p + 1))}
            aria-label="Next PDF page"
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <span className="text-slate-300 mx-1">|</span>

          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))}
            aria-label="Zoom out"
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="text-xs font-mono text-slate-700 tabular-nums w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.15) * 100) / 100))}
            aria-label="Zoom in"
            className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleFitWidth}
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            Fit Width
          </button>
          <button
            type="button"
            onClick={handleFitPage}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Fit Page
          </button>
          <button
            type="button"
            onClick={() => setViewRotation((r) => (((r + 90) % 360) as 0 | 90 | 180 | 270))}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {viewRotation}°
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter confidence"
            value={confidenceFilter}
            onChange={(e) => setConfidenceFilter(e.target.value as "all" | ConfidenceTier)}
            className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700"
          >
            <option value="all">All Confidence ({fields.length})</option>
            <option value="high">
              High ({fields.filter((f) => f.confidenceTier === "high").length})
            </option>
            <option value="medium">
              Medium ({fields.filter((f) => f.confidenceTier === "medium").length})
            </option>
            <option value="low">
              Low ({fields.filter((f) => f.confidenceTier === "low").length})
            </option>
          </select>

          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setToolMode("select")}
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  toolMode === "select"
                    ? "border-emerald-800 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                <MousePointer className="h-3.5 w-3.5" />
                Select
              </button>
              <button
                type="button"
                onClick={() => setToolMode("draw")}
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                  toolMode === "draw"
                    ? "border-emerald-800 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                <PlusSquare className="h-3.5 w-3.5" />
                Draw Field
              </button>
              <button
                type="button"
                disabled={undoStack.length === 0}
                onClick={handleUndo}
                title="Undo (Ctrl+Z)"
                className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={redoStack.length === 0}
                onClick={handleRedo}
                title="Redo (Ctrl+Y)"
                className="rounded border border-slate-200 p-1.5 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-medium text-slate-900">{documentTitle}</span>
          <span>·</span>
          <span className="tabular-nums">{fields.length} total fields</span>
          <span>·</span>
          <span className="tabular-nums">
            {activePageInfo.widthPt.toFixed(0)} × {activePageInfo.heightPt.toFixed(0)} pt
          </span>
          {dirty && (
            <>
              <span>·</span>
              <span className="font-medium text-amber-700">Unsaved edits</span>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedIds.length >= 2 && canEdit && (
            <>
              <button
                type="button"
                onClick={() => handleAlignSelected("left")}
                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              >
                <AlignHorizontalJustifyStart className="h-3.5 w-3.5" />
                Align Left
              </button>
              <button
                type="button"
                onClick={() => handleAlignSelected("top")}
                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              >
                <AlignVerticalJustifyStart className="h-3.5 w-3.5" />
                Align Top
              </button>
            </>
          )}
          {canEdit && (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveManifest}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "Saving..." : "Save Manifest"}
              </button>
              <button
                type="button"
                disabled={generating}
                onClick={handleGenerateAcroForm}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`} />
                {generating ? "Generating..." : "Regenerate AcroForm"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadAcroForm()}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Download AcroForm
              </button>
              <button
                type="button"
                onClick={() => setShowTplForm((s) => !s)}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-800 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 whitespace-nowrap"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
                Save as Template
              </button>
            </>
          )}
          {!canEdit && (
            <button
              type="button"
              onClick={() => void handleDownloadAcroForm()}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download AcroForm
            </button>
          )}
        </div>
      </div>

      {statusMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-900">
          {statusMsg}
        </div>
      )}
      {errorMsg && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2 text-xs text-red-800"
        >
          {errorMsg}
        </div>
      )}

      {showTplForm && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Template Name
            </label>
            <input
              type="text"
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Category
            </label>
            <input
              type="text"
              value={tplCategory}
              onChange={(e) => setTplCategory(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-900 w-36"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Customer Output Policy
            </label>
            <select
              value={tplPolicy}
              onChange={(e) =>
                setTplPolicy(e.target.value as "flattened" | "fillable" | "both")
              }
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 bg-white"
            >
              <option value="flattened">Flattened Only (Recommended)</option>
              <option value="both">Flattened + Fillable</option>
              <option value="fillable">Fillable Only</option>
            </select>
          </div>
          <button
            type="button"
            disabled={generating}
            onClick={handleCreateTemplate}
            className="rounded-md bg-emerald-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
          >
            Create Template
          </button>
        </div>
      )}

      {/* Main Split Workspace: Left PDF Canvas + Right Field Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* PDF.js Canvas + Interactive Field Overlays */}
        <div
          ref={scrollContainerRef}
          className="lg:col-span-8 rounded-lg border border-slate-200 bg-slate-100 p-4 overflow-auto max-h-[760px]"
        >
          <div
            className={`relative mx-auto bg-white shadow-sm border border-slate-300 select-none ${
              toolMode === "draw" ? "cursor-crosshair" : "cursor-default"
            }`}
            style={{ width: `${canvasDimPx.width}px`, height: `${canvasDimPx.height}px` }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleOverlayMouseMove}
            onMouseUp={handleOverlayMouseUp}
            onMouseLeave={handleOverlayMouseUp}
          >
            <canvas ref={canvasRef} className="block pointer-events-none" />

            {/* Field Bounding Overlays */}
            {pageFields.map((field) => {
              const px = pdfRectToViewportPx(
                field.rect,
                zoom,
                activePageInfo.widthPt,
                activePageInfo.heightPt,
                viewRotation
              );
              const isSelected = selectedIds.includes(field.id);
              const borderClass =
                isSelected
                  ? "border-2 border-emerald-700 bg-emerald-500/15 ring-2 ring-emerald-700/25 z-20"
                  : field.confidenceTier === "high"
                  ? "border border-emerald-600/80 bg-emerald-500/10 hover:bg-emerald-500/20 z-10"
                  : field.confidenceTier === "medium"
                  ? "border border-amber-600/80 bg-amber-400/15 hover:bg-amber-400/25 z-10"
                  : "border border-rose-600/80 bg-rose-500/15 hover:bg-rose-500/25 z-10";

              return (
                <div
                  key={field.id}
                  style={{
                    left: `${px.left}px`,
                    top: `${px.top}px`,
                    width: `${px.width}px`,
                    height: `${px.height}px`,
                  }}
                  onMouseDown={(e) => {
                    if (toolMode === "draw") return;
                    e.stopPropagation();
                    if (e.shiftKey) {
                      setSelectedIds((ids) =>
                        ids.includes(field.id) ? ids : [...ids, field.id]
                      );
                    } else {
                      setSelectedIds([field.id]);
                    }
                    if (canEdit) {
                      pushUndoSnapshot(fields);
                      setDragState({
                        mode: "move",
                        fieldId: field.id,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        initialPx: px,
                      });
                    }
                  }}
                  title={`${field.label} (${field.type}) — ${(field.confidence * 100).toFixed(0)}% confidence`}
                  className={`absolute transition-colors ${borderClass} ${
                    canEdit && toolMode === "select" ? "cursor-move" : ""
                  }`}
                >
                  {isSelected && (
                    <span className="absolute -top-4 left-0 bg-emerald-900 text-white text-[10px] leading-none px-1 py-0.5 rounded-t whitespace-nowrap pointer-events-none">
                      {field.name}
                    </span>
                  )}

                  {/* Render inner cell dividers for char_cells fields */}
                  {field.type === "char_cells" &&
                    field.cellRects &&
                    field.cellRects.length > 1 &&
                    field.cellRects.map((cell, idx) => {
                      const cpx = pdfRectToViewportPx(
                        cell,
                        zoom,
                        activePageInfo.widthPt,
                        activePageInfo.heightPt,
                        viewRotation
                      );
                      return (
                        <span
                          key={idx}
                          style={{
                            left: `${cpx.left - px.left}px`,
                            top: `${cpx.top - px.top}px`,
                            width: `${cpx.width}px`,
                            height: `${cpx.height}px`,
                          }}
                          className="absolute border border-dashed border-emerald-700/60 pointer-events-none"
                        />
                      );
                    })}

                  {/* Bottom-right resize handle */}
                  {isSelected && canEdit && toolMode === "select" && (
                    <div
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        pushUndoSnapshot(fields);
                        setDragState({
                          mode: "resize",
                          fieldId: field.id,
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          initialPx: px,
                        });
                      }}
                      className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-sm bg-emerald-900 border border-white cursor-se-resize"
                    />
                  )}
                </div>
              );
            })}

            {/* Live Draw Rect Preview */}
            {dragState?.mode === "draw" && dragState.currentDrawPx && (
              <div
                style={{
                  left: `${dragState.currentDrawPx.left}px`,
                  top: `${dragState.currentDrawPx.top}px`,
                  width: `${dragState.currentDrawPx.width}px`,
                  height: `${dragState.currentDrawPx.height}px`,
                }}
                className="absolute border-2 border-dashed border-emerald-800 bg-emerald-500/15 pointer-events-none z-30"
              />
            )}
          </div>
        </div>

        {/* Right Side: Field List + Property Inspector */}
        <div className="lg:col-span-4 space-y-4">
          {/* Selected Field Property Panel */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-900">
                Field Properties
              </h3>
              {primarySelectedField && canEdit && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleDuplicateSelected}
                    title="Duplicate Field"
                    className="rounded border border-slate-200 p-1 text-slate-600 hover:bg-slate-50"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      commitFields((prev) =>
                        prev.filter((f) => f.id !== primarySelectedField.id)
                      );
                      setSelectedIds([]);
                    }}
                    title="Delete Field"
                    className="rounded border border-slate-200 p-1 text-rose-700 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {!primarySelectedField ? (
              <p className="py-6 text-xs text-slate-500 text-center">
                Click any bounding box on the PDF or choose a field below to edit properties.
              </p>
            ) : (
              <div className="mt-3 space-y-3 text-xs">
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>Source: {primarySelectedField.detectionSource}</span>
                  <span className="tabular-nums font-medium text-slate-700">
                    {(primarySelectedField.confidence * 100).toFixed(0)}% ({primarySelectedField.confidenceTier})
                  </span>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Field Key Name (AcroForm ID)
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    value={primarySelectedField.name}
                    onChange={(e) =>
                      updateSelectedField({
                        name: e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "_"),
                      })
                    }
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-slate-900"
                  />
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Display Label
                  </label>
                  <input
                    type="text"
                    disabled={!canEdit}
                    value={primarySelectedField.label}
                    onChange={(e) => updateSelectedField({ label: e.target.value })}
                    className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Semantic Type
                    </label>
                    <select
                      disabled={!canEdit}
                      value={primarySelectedField.type}
                      onChange={(e) =>
                        updateSelectedField({
                          type: e.target.value as FormifyFieldType,
                          multiline: e.target.value === "multiline",
                        })
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                    >
                      {ALL_FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Review Status
                    </label>
                    <select
                      disabled={!canEdit}
                      value={primarySelectedField.reviewStatus}
                      onChange={(e) =>
                        updateSelectedField({
                          reviewStatus: e.target.value as ReviewStatus,
                        })
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                    >
                      <option value="pending">pending</option>
                      <option value="accepted">accepted</option>
                      <option value="edited">edited</option>
                      <option value="rejected">rejected</option>
                    </select>
                  </div>
                </div>

                {/* Canonical PDF Rect in Points */}
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Coordinates (Top-Left PDF pt)
                  </label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(["x", "y", "width", "height"] as const).map((k) => (
                      <div key={k}>
                        <span className="block text-[10px] text-slate-500 uppercase">{k}</span>
                        <input
                          type="number"
                          step="0.5"
                          disabled={!canEdit}
                          value={primarySelectedField.rect[k]}
                          onChange={(e) => {
                            const val = Number(e.target.value) || 0;
                            const nextRect: PdfRect = {
                              ...primarySelectedField.rect,
                              [k]: roundPt(val),
                            };
                            updateSelectedField({ rect: nextRect });
                          }}
                          className="w-full rounded border border-slate-300 px-1.5 py-1 font-mono text-[11px] tabular-nums"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Type-specific helpers */}
                {(primarySelectedField.type === "dropdown" ||
                  primarySelectedField.type === "radio") && (
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Options (comma-separated)
                    </label>
                    <input
                      type="text"
                      disabled={!canEdit}
                      value={primarySelectedField.options.join(", ")}
                      onChange={(e) =>
                        updateSelectedField({
                          options: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="Option A, Option B, Option C"
                      className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-slate-900"
                    />
                  </div>
                )}

                {primarySelectedField.type === "char_cells" && (
                  <div className="rounded border border-slate-200 bg-slate-50 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">
                        Character Cells ({primarySelectedField.cellRects?.length || 0})
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => {
                            const count = primarySelectedField.maxLength || 10;
                            const { x, y, width, height } = primarySelectedField.rect;
                            const step = width / count;
                            const cells: PdfRect[] = Array.from({ length: count }, (_, idx) => ({
                              x: roundPt(x + idx * step),
                              y,
                              width: roundPt(Math.max(4, step - 0.5)),
                              height,
                            }));
                            updateSelectedField({
                              maxLength: count,
                              cellRects: cells,
                            });
                          }}
                          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Split into Grid
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Default Value
                    </label>
                    <input
                      type="text"
                      disabled={!canEdit}
                      value={primarySelectedField.defaultValue}
                      onChange={(e) => updateSelectedField({ defaultValue: e.target.value })}
                      className="w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Max Length
                    </label>
                    <input
                      type="number"
                      min={1}
                      disabled={!canEdit}
                      value={primarySelectedField.maxLength ?? ""}
                      onChange={(e) =>
                        updateSelectedField({
                          maxLength: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      className="w-full rounded border border-slate-300 px-2 py-1 tabular-nums text-slate-900"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Alignment
                    </label>
                    <select
                      disabled={!canEdit}
                      value={primarySelectedField.alignment || "left"}
                      onChange={(e) =>
                        updateSelectedField({
                          alignment: e.target.value as "left" | "center" | "right",
                        })
                      }
                      className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-900"
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Regex / Format
                    </label>
                    <input
                      type="text"
                      disabled={!canEdit}
                      value={primarySelectedField.validation?.pattern || ""}
                      onChange={(e) =>
                        updateSelectedField({
                          validation: {
                            ...primarySelectedField.validation,
                            pattern: e.target.value || undefined,
                          },
                        })
                      }
                      placeholder="^[0-9]{13}$"
                      className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <label className="inline-flex items-center gap-1.5 text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={primarySelectedField.required}
                      onChange={(e) => updateSelectedField({ required: e.target.checked })}
                    />
                    <span>Required</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-slate-700">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={primarySelectedField.multiline}
                      onChange={(e) => updateSelectedField({ multiline: e.target.checked })}
                    />
                    <span>Multiline</span>
                  </label>
                  {canEdit && primarySelectedField.reviewStatus !== "accepted" && (
                    <button
                      type="button"
                      onClick={() => updateSelectedField({ reviewStatus: "accepted" })}
                      className="ml-auto inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-900 hover:bg-emerald-100"
                    >
                      <Check className="h-3 w-3" />
                      Mark Accepted
                    </button>
                  )}
                </div>

                {primarySelectedField.confidenceEvidence?.length > 0 && (
                  <div className="border-t border-slate-100 pt-2">
                    <p className="font-medium text-slate-700 mb-1">Detection Evidence</p>
                    <ul className="space-y-0.5 text-[11px] text-slate-500 list-disc pl-4">
                      {primarySelectedField.confidenceEvidence.map((ev, idx) => (
                        <li key={idx}>{ev}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Field Inventory List */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-900">
                Detected Fields ({fields.length})
              </h4>
              <span className="text-[11px] text-slate-500">Click to select</span>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
              {fields.map((f) => {
                const active = selectedIds.includes(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      setCurrentPage(f.page);
                      setSelectedIds([f.id]);
                    }}
                    className={`w-full text-left px-3.5 py-2 flex items-center justify-between gap-2 hover:bg-slate-50 ${
                      active ? "bg-emerald-50/70" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-900 truncate">{f.label}</p>
                      <p className="text-[11px] text-slate-500 font-mono truncate">
                        {f.name} · {f.type} · p.{f.page + 1}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] font-medium tabular-nums shrink-0 ${
                        f.confidenceTier === "high"
                          ? "text-emerald-700"
                          : f.confidenceTier === "medium"
                          ? "text-amber-700"
                          : "text-rose-700"
                      }`}
                    >
                      {(f.confidence * 100).toFixed(0)}%
                    </span>
                  </button>
                );
              })}
              {fields.length === 0 && (
                <p className="p-4 text-xs text-slate-500 text-center">
                  No fields detected yet. Use Draw Field to add one manually.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

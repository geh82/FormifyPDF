import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FolderArchive,
  Image as ImageIcon,
  Layers,
  Palette,
  Save,
  Search,
  Server,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  auditWorkspaceFiles,
  classifyZipFile,
  formatArchiveBytes,
  isMacOsClutter,
  sanitizeClientZipPath,
  type WorkspaceZipEntry,
  type ZipFileCategory,
} from "../lib/brandAudit.ts";

interface ServerZipArchive {
  id: string;
  originalFilename: string;
  uploadedAt: string;
  archiveSize: number;
  fileCount: number;
  totalUncompressedBytes: number;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    mimeType: string;
  }>;
}

type FilterTab = "all" | "visual" | "code" | "docs" | "flagged";
type PreviewBg = "checkerboard" | "light" | "dark";

const MAX_BROWSER_ZIP_BYTES = 50 * 1024 * 1024;

export function ZipInspectorSection() {
  const zipInputRef = useRef<HTMLInputElement>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);

  const [archiveName, setArchiveName] = useState<string>("");
  const [entries, setEntries] = useState<WorkspaceZipEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [previewBg, setPreviewBg] = useState<PreviewBg>("checkerboard");
  const [svgViewMode, setSvgViewMode] = useState<"preview" | "source">("preview");
  const [editorText, setEditorText] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);

  const [dragActive, setDragActive] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [newFilePathInput, setNewFilePathInput] = useState("");
  const [showNewFileRow, setShowNewFileRow] = useState(false);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);

  const [serverArchives, setServerArchives] = useState<ServerZipArchive[]>([]);
  const [activeServerArchiveId, setActiveServerArchiveId] = useState<string | null>(null);
  const [loadingServerList, setLoadingServerList] = useState(false);

  const audit = useMemo(() => auditWorkspaceFiles(entries), [entries]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.path === selectedPath) || null,
    [entries, selectedPath]
  );

  // Maintain object URL for image/SVG/PDF previews
  const previewObjectUrl = useMemo(() => {
    if (!selectedEntry) return null;
    if (
      selectedEntry.category !== "image" &&
      selectedEntry.category !== "svg" &&
      selectedEntry.category !== "pdf"
    ) {
      return null;
    }
    const mime =
      selectedEntry.category === "svg"
        ? "image/svg+xml"
        : selectedEntry.category === "pdf"
        ? "application/pdf"
        : undefined;
    const copy = new Uint8Array(selectedEntry.bytes);
    const blob = new Blob([copy], mime ? { type: mime } : undefined);
    return URL.createObjectURL(blob);
  }, [selectedEntry]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
      }
    };
  }, [previewObjectUrl]);

  // Sync text editor when selecting a text/code/SVG/CSS/JSON entry
  useEffect(() => {
    if (!selectedEntry || !selectedEntry.isTextEditable) {
      setEditorText("");
      setEditorDirty(false);
      return;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
      selectedEntry.bytes
    );
    setEditorText(decoded);
    setEditorDirty(false);
  }, [selectedEntry]);

  // Fetch saved server archives on mount
  const fetchServerArchives = async () => {
    setLoadingServerList(true);
    try {
      const res = await fetch("/api/zip-uploads");
      const data = await res.json();
      if (res.ok && data.ok && Array.isArray(data.archives)) {
        setServerArchives(data.archives);
      }
    } catch {
      // Non-fatal on initial load
    } finally {
      setLoadingServerList(false);
    }
  };

  useEffect(() => {
    fetchServerArchives();
  }, []);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (q && !entry.path.toLowerCase().includes(q)) return false;
      if (filterTab === "visual") {
        return entry.category === "image" || entry.category === "svg";
      }
      if (filterTab === "code") {
        return (
          entry.category === "code" ||
          entry.category === "css" ||
          entry.category === "svg"
        );
      }
      if (filterTab === "docs") {
        return entry.category === "json" || entry.category === "pdf";
      }
      if (filterTab === "flagged") {
        return entry.size === 0 || isMacOsClutter(entry.path);
      }
      return true;
    });
  }, [entries, searchQuery, filterTab]);

  const unpackBrowserZip = async (file: File, alsoPersistToServer: boolean) => {
    setErrorMessage(null);
    setStatusMessage(null);

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setErrorMessage("Please select a valid .zip archive file.");
      return;
    }
    if (file.size === 0) {
      setErrorMessage("The selected .zip file is empty (0 bytes).");
      return;
    }
    if (file.size > MAX_BROWSER_ZIP_BYTES) {
      setErrorMessage("The selected .zip exceeds the 50 MB workspace limit.");
      return;
    }

    setBusyMessage("Unpacking ZIP archive in browser...");
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 4));
      if (head[0] !== 0x50 || head[1] !== 0x4b) {
        setErrorMessage("File failed PK ZIP signature verification.");
        setBusyMessage(null);
        return;
      }

      const zip = await JSZip.loadAsync(buf);
      const nextEntries: WorkspaceZipEntry[] = [];

      for (const zipObj of Object.values(zip.files)) {
        if (zipObj.dir) continue;
        const rawEntryName =
          (zipObj as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ||
          zipObj.name;
        const safePath = sanitizeClientZipPath(rawEntryName);
        if (!safePath) continue;

        const bytes = await zipObj.async("uint8array");
        const { category, isTextEditable } = classifyZipFile(safePath);
        nextEntries.push({
          path: safePath,
          size: bytes.length,
          bytes,
          category,
          isTextEditable,
        });
      }

      nextEntries.sort((a, b) => a.path.localeCompare(b.path));
      setEntries(nextEntries);
      setArchiveName(file.name);
      setSelectedPath(nextEntries[0]?.path || null);
      setActiveServerArchiveId(null);

      if (alsoPersistToServer) {
        await uploadZipBufferToServer(new Blob([buf], { type: "application/zip" }), file.name);
      } else {
        setStatusMessage(
          `Loaded ${nextEntries.length} file(s) from ${file.name} in-browser.`
        );
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Could not unpack ZIP: ${err.message}`
          : "Could not unpack ZIP archive."
      );
    } finally {
      setBusyMessage(null);
    }
  };

  const uploadZipBufferToServer = async (blob: Blob, filename: string) => {
    setBusyMessage("Persisting archive to server (uploaded-zips/)...");
    setErrorMessage(null);
    try {
      const form = new FormData();
      form.append("file", blob, filename.endsWith(".zip") ? filename : `${filename}.zip`);
      const res = await fetch("/api/zip-uploads", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMessage(data.error || "Server rejected ZIP archive upload.");
        return;
      }
      setActiveServerArchiveId(data.archive.id);
      setStatusMessage(
        `Persisted ${data.archive.fileCount} file(s) to uploaded-zips/${data.archive.id}/files/.`
      );
      await fetchServerArchives();
    } catch {
      setErrorMessage("Network error while persisting ZIP archive to server.");
    } finally {
      setBusyMessage(null);
    }
  };

  const buildRepackagedBlob = async (): Promise<Blob> => {
    const zip = new JSZip();
    for (const entry of entries) {
      zip.file(entry.path, entry.bytes);
    }
    return zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  };

  const handlePersistCurrentWorkspace = async () => {
    if (entries.length === 0) return;
    setErrorMessage(null);
    const blob = await buildRepackagedBlob();
    await uploadZipBufferToServer(blob, archiveName || "workspace-repackaged.zip");
  };

  const handleDownloadRepackaged = async () => {
    if (entries.length === 0) return;
    setBusyMessage("Generating repackaged .zip download...");
    setErrorMessage(null);
    try {
      const blob = await buildRepackagedBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const baseName = (archiveName || "workspace").replace(/\.zip$/i, "");
      a.href = url;
      a.download = `${baseName}-repackaged.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatusMessage(`Downloaded ${baseName}-repackaged.zip (${entries.length} files).`);
    } catch {
      setErrorMessage("Failed to generate repackaged .zip archive.");
    } finally {
      setBusyMessage(null);
    }
  };

  const handleLoadServerArchive = async (archive: ServerZipArchive) => {
    setBusyMessage(`Loading ${archive.originalFilename} from uploaded-zips/...`);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const loaded: WorkspaceZipEntry[] = [];
      for (const f of archive.files) {
        const res = await fetch(
          `/api/zip-uploads/${archive.id}/file?path=${encodeURIComponent(f.path)}`
        );
        if (!res.ok) {
          throw new Error(`Failed to fetch ${f.path}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const { category, isTextEditable } = classifyZipFile(f.path);
        loaded.push({
          path: f.path,
          size: bytes.length,
          bytes,
          category,
          isTextEditable,
        });
      }
      loaded.sort((a, b) => a.path.localeCompare(b.path));
      setEntries(loaded);
      setArchiveName(archive.originalFilename);
      setSelectedPath(loaded[0]?.path || null);
      setActiveServerArchiveId(archive.id);
      setStatusMessage(
        `Loaded persisted archive ${archive.originalFilename} (${loaded.length} files).`
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load persisted archive."
      );
    } finally {
      setBusyMessage(null);
    }
  };

  const handleDeleteServerArchive = async (id: string) => {
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/zip-uploads/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErrorMessage(data.error || "Failed to delete server archive.");
        return;
      }
      if (activeServerArchiveId === id) {
        setActiveServerArchiveId(null);
      }
      setStatusMessage(`Deleted persisted archive ${id.slice(0, 8)} from server.`);
      await fetchServerArchives();
    } catch {
      setErrorMessage("Network error while deleting server archive.");
    }
  };

  const handleApplyTextEdit = () => {
    if (!selectedEntry || !selectedEntry.isTextEditable) return;
    const encoded = new TextEncoder().encode(editorText);
    setEntries((prev) =>
      prev.map((item) =>
        item.path === selectedEntry.path
          ? { ...item, bytes: encoded, size: encoded.length }
          : item
      )
    );
    setEditorDirty(false);
    setStatusMessage(`Saved changes to ${selectedEntry.path} (${encoded.length} B).`);
  };

  const handleRemoveFile = (targetPath: string) => {
    setEntries((prev) => {
      const next = prev.filter((item) => item.path !== targetPath);
      if (selectedPath === targetPath) {
        setSelectedPath(next[0]?.path || null);
      }
      return next;
    });
    setStatusMessage(`Removed ${targetPath} from workspace.`);
  };

  const handleStripMacOsClutter = () => {
    if (audit.macOsClutterFiles.length === 0) return;
    const count = audit.macOsClutterFiles.length;
    setEntries((prev) => {
      const next = prev.filter((item) => !isMacOsClutter(item.path));
      if (selectedPath && isMacOsClutter(selectedPath)) {
        setSelectedPath(next[0]?.path || null);
      }
      return next;
    });
    setStatusMessage(`Stripped ${count} macOS clutter file(s) from workspace.`);
  };

  const handleAddOrReplaceFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMessage(null);
    const additions: WorkspaceZipEntry[] = [];

    for (const file of Array.from(fileList)) {
      const targetRaw =
        fileList.length === 1 && newFilePathInput.trim()
          ? newFilePathInput.trim()
          : file.name;
      const safePath = sanitizeClientZipPath(targetRaw);
      if (!safePath) {
        setErrorMessage(`Invalid file path '${targetRaw}'.`);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { category, isTextEditable } = classifyZipFile(safePath);
      additions.push({
        path: safePath,
        size: bytes.length,
        bytes,
        category,
        isTextEditable,
      });
    }

    setEntries((prev) => {
      const map = new Map(prev.map((e) => [e.path, e]));
      for (const add of additions) {
        map.set(add.path, add);
      }
      return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    });

    if (!archiveName) setArchiveName("custom-workspace.zip");
    setSelectedPath(additions[0].path);
    setNewFilePathInput("");
    setShowNewFileRow(false);
    setStatusMessage(`Added or replaced ${additions.length} file(s) in workspace.`);
  };

  const handleCreateBlankTextFile = () => {
    const safePath = sanitizeClientZipPath(newFilePathInput.trim());
    if (!safePath) {
      setErrorMessage("Enter a valid relative file path (e.g. styles/brand.css).");
      return;
    }
    const { category, isTextEditable } = classifyZipFile(safePath);
    const starterText =
      category === "json"
        ? "{\n  \"name\": \"brand-tokens\"\n}\n"
        : category === "css"
        ? ":root {\n  --brand-primary: #0f3d2e;\n}\n"
        : category === "svg"
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect width="64" height="64" rx="8" fill="#0f3d2e"/>\n</svg>\n'
        : "";
    const bytes = new TextEncoder().encode(starterText);
    const newEntry: WorkspaceZipEntry = {
      path: safePath,
      size: bytes.length,
      bytes,
      category: isTextEditable ? category : "code",
      isTextEditable: true,
    };
    setEntries((prev) => {
      const map = new Map(prev.map((e) => [e.path, e]));
      map.set(safePath, newEntry);
      return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    });
    if (!archiveName) setArchiveName("custom-workspace.zip");
    setSelectedPath(safePath);
    setNewFilePathInput("");
    setShowNewFileRow(false);
    setErrorMessage(null);
    setStatusMessage(`Created ${safePath} in workspace.`);
  };

  const handleCopyHex = async (hex: string) => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopiedHex(hex);
      setTimeout(() => setCopiedHex(null), 1500);
    } catch {
      // Clipboard unavailable
    }
  };

  const categoryIcon = (cat: ZipFileCategory) => {
    if (cat === "image" || cat === "svg") {
      return <ImageIcon className="h-3.5 w-3.5 text-slate-500 shrink-0" aria-hidden="true" />;
    }
    if (cat === "css" || cat === "code" || cat === "json") {
      return <FileCode2 className="h-3.5 w-3.5 text-slate-500 shrink-0" aria-hidden="true" />;
    }
    return <FileText className="h-3.5 w-3.5 text-slate-500 shrink-0" aria-hidden="true" />;
  };

  const previewBgClass =
    previewBg === "dark"
      ? "bg-slate-900"
      : previewBg === "light"
      ? "bg-white"
      : "bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%),linear-gradient(-45deg,#e2e8f0_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e2e8f0_75%),linear-gradient(-45deg,transparent_75%,#e2e8f0_75%)] bg-[length:16px_16px] bg-[position:0_0,0_8px,8px_-8px,-8px_0px] bg-slate-50";

  return (
    <div className="space-y-6">
      {/* Upload Dropzone & Top Action Bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-xl font-semibold text-slate-900 tracking-tight">
              ZIP Workspace Inspector, Brand Auditor & Repackager
            </h2>
            <p className="mt-1 text-sm text-slate-600 max-w-2xl">
              Upload a <code className="font-mono text-xs">.zip</code> package from your computer to unpack in-browser, inspect images/SVGs/code/PDFs, audit macOS clutter, zero-byte files, and hex colour tokens, edit or replace files, and download or persist clean archives.
            </p>
          </div>
          {entries.length > 0 && (
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handlePersistCurrentWorkspace}
                disabled={Boolean(busyMessage)}
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
              >
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Persist to Server</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadRepackaged}
                disabled={Boolean(busyMessage)}
                className="inline-flex items-center gap-2 rounded-md bg-emerald-900 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 min-h-[38px] whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download Repackaged .zip</span>
              </button>
            </div>
          )}
        </div>

        {/* Drag and Drop Area */}
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
            if (dropped) unpackBrowserZip(dropped, true);
          }}
          className={`mt-5 rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragActive
              ? "border-emerald-700 bg-emerald-50/70"
              : "border-slate-300 bg-slate-50/50"
          }`}
        >
          <input
            ref={zipInputRef}
            id="zip-archive-upload-input"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) unpackBrowserZip(f, true);
              e.target.value = "";
            }}
          />
          <FolderArchive className="mx-auto h-8 w-8 text-slate-500 mb-2" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-900">
            Drop a <code className="font-mono text-xs">.zip</code> archive here, or choose one from your laptop
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Verified with PK magic-byte inspection & ZIP-slip path confinement · Max 50 MB
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => zipInputRef.current?.click()}
              disabled={Boolean(busyMessage)}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-900 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-800 min-h-[38px] whitespace-nowrap"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Select & Upload .zip</span>
            </button>
            <button
              type="button"
              onClick={() => setShowNewFileRow((v) => !v)}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 min-h-[38px] whitespace-nowrap"
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add / Create File</span>
            </button>
          </div>
        </div>

        {/* Optional Add / Create File Bar */}
        {showNewFileRow && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <input
              ref={addFileInputRef}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                handleAddOrReplaceFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              type="text"
              value={newFilePathInput}
              onChange={(e) => setNewFilePathInput(e.target.value)}
              placeholder="Relative path (e.g. assets/logo.svg or styles/tokens.css)"
              className="flex-1 min-w-[220px] rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            />
            <button
              type="button"
              onClick={handleCreateBlankTextFile}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap"
            >
              Create Text/Code File
            </button>
            <button
              type="button"
              onClick={() => addFileInputRef.current?.click()}
              className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap"
            >
              Upload File from Device
            </button>
          </div>
        )}

        {/* Status & Error Banners */}
        {busyMessage && (
          <p className="mt-3 text-xs font-medium text-slate-600">{busyMessage}</p>
        )}
        {statusMessage && (
          <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-emerald-800">
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{statusMessage}</span>
          </p>
        )}
        {errorMessage && (
          <div
            role="alert"
            className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800"
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* Workspace Inspector Grid */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: File List + Brand Audit Summary */}
          <div className="lg:col-span-5 space-y-5">
            {/* File Explorer */}
            <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 truncate">
                    {archiveName || "Workspace Files"}
                  </h3>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    {audit.totalFiles} files · {formatArchiveBytes(audit.totalBytes)}
                    {activeServerArchiveId ? ` · Saved (${activeServerArchiveId.slice(0, 8)})` : ""}
                  </p>
                </div>
                {audit.macOsClutterFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={handleStripMacOsClutter}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 whitespace-nowrap shrink-0"
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    <span>Strip macOS ({audit.macOsClutterFiles.length})</span>
                  </button>
                )}
              </div>

              <div className="p-3 border-b border-slate-200 space-y-2.5 bg-slate-50/60">
                <div className="relative">
                  <Search
                    className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter files by path..."
                    className="w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 py-1.5 text-xs text-slate-900"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      ["all", `All (${entries.length})`],
                      ["visual", "Images & SVG"],
                      ["code", "Code & CSS"],
                      ["docs", "JSON & PDF"],
                      ["flagged", `Flags (${audit.cleanablePaths.length})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilterTab(key)}
                      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                        filterTab === key
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-600 border border-slate-200 hover:text-slate-900"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <ul className="max-h-[380px] overflow-y-auto divide-y divide-slate-100">
                {filteredEntries.length === 0 ? (
                  <li className="px-4 py-6 text-center text-xs text-slate-500">
                    No files match the current filter.
                  </li>
                ) : (
                  filteredEntries.map((entry) => {
                    const isSelected = entry.path === selectedPath;
                    const flagged = entry.size === 0 || isMacOsClutter(entry.path);
                    return (
                      <li
                        key={entry.path}
                        className={`flex items-center justify-between gap-2 px-3 py-2 text-xs ${
                          isSelected ? "bg-emerald-50/80" : "hover:bg-slate-50"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedPath(entry.path)}
                          className="flex-1 min-w-0 flex items-center gap-2 text-left"
                        >
                          {categoryIcon(entry.category)}
                          <span
                            className={`truncate font-mono ${
                              isSelected ? "font-semibold text-emerald-950" : "text-slate-800"
                            }`}
                            title={entry.path}
                          >
                            {entry.path}
                          </span>
                          {flagged && (
                            <span className="text-[11px] font-medium text-amber-700 shrink-0">
                              {entry.size === 0 ? "0 B" : "macOS"}
                            </span>
                          )}
                        </button>
                        <span className="font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                          {formatArchiveBytes(entry.size)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(entry.path)}
                          title={`Remove ${entry.path}`}
                          className="p-1 text-slate-400 hover:text-red-700 rounded shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </section>

            {/* Brand & Hygiene Auditor */}
            <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Palette className="h-4 w-4 text-emerald-800" aria-hidden="true" />
                  <span>Brand & Hygiene Audit</span>
                </h3>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {audit.colorTokens.length} hex tokens
                </span>
              </div>

              {/* Zero-Byte & macOS Clutter Checks */}
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-700">Zero-byte files</span>
                  <span
                    className={`font-mono tabular-nums font-medium ${
                      audit.zeroByteFiles.length > 0 ? "text-amber-700" : "text-emerald-800"
                    }`}
                  >
                    {audit.zeroByteFiles.length}
                  </span>
                </div>
                <div className="flex items-center justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-700">macOS clutter (__MACOSX / .DS_Store)</span>
                  <span
                    className={`font-mono tabular-nums font-medium ${
                      audit.macOsClutterFiles.length > 0 ? "text-amber-700" : "text-emerald-800"
                    }`}
                  >
                    {audit.macOsClutterFiles.length}
                  </span>
                </div>
              </div>

              {/* Extracted Hex Colour Swatches */}
              {audit.colorTokens.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-700">
                    Extracted Colour Hex Tokens
                  </p>
                  <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
                    {audit.colorTokens.map((token) => (
                      <div
                        key={token.normalizedHex}
                        className="flex items-center justify-between gap-2 rounded border border-slate-200 px-2.5 py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="h-4 w-4 rounded border border-slate-300 shrink-0"
                            style={{ backgroundColor: token.normalizedHex }}
                          />
                          <span className="font-mono font-medium text-slate-900">
                            {token.normalizedHex}
                          </span>
                          <span className="text-slate-500 truncate" title={token.files.join(", ")}>
                            {token.files.length} file(s)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-mono tabular-nums text-[11px] text-slate-500">
                            {token.count}×
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyHex(token.normalizedHex)}
                            className="text-slate-400 hover:text-slate-900"
                            title={`Copy ${token.normalizedHex}`}
                          >
                            {copiedHex === token.normalizedHex ? (
                              <Check className="h-3.5 w-3.5 text-emerald-700" aria-hidden="true" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No hex colour tokens detected in text, CSS, SVG, or JSON entries.
                </p>
              )}
            </section>
          </div>

          {/* Right Column: File Preview & Editor */}
          <div className="lg:col-span-7">
            <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              {selectedEntry ? (
                <>
                  <div className="border-b border-slate-200 px-5 py-3 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-semibold text-slate-900 truncate">
                        {selectedEntry.path}
                      </p>
                      <p className="text-[11px] font-mono tabular-nums text-slate-500">
                        {selectedEntry.category.toUpperCase()} · {formatArchiveBytes(selectedEntry.size)}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {(selectedEntry.category === "image" ||
                        selectedEntry.category === "svg") && (
                        <div className="flex items-center rounded-md border border-slate-200 bg-white p-0.5">
                          {(["checkerboard", "light", "dark"] as const).map((bg) => (
                            <button
                              key={bg}
                              type="button"
                              onClick={() => setPreviewBg(bg)}
                              className={`px-2 py-1 text-[11px] font-medium rounded capitalize ${
                                previewBg === bg
                                  ? "bg-slate-900 text-white"
                                  : "text-slate-600 hover:text-slate-900"
                              }`}
                            >
                              {bg}
                            </button>
                          ))}
                        </div>
                      )}

                      {selectedEntry.category === "svg" && (
                        <div className="flex items-center rounded-md border border-slate-200 bg-white p-0.5">
                          <button
                            type="button"
                            onClick={() => setSvgViewMode("preview")}
                            className={`px-2 py-1 text-[11px] font-medium rounded ${
                              svgViewMode === "preview"
                                ? "bg-emerald-900 text-white"
                                : "text-slate-600"
                            }`}
                          >
                            Visual
                          </button>
                          <button
                            type="button"
                            onClick={() => setSvgViewMode("source")}
                            className={`px-2 py-1 text-[11px] font-medium rounded ${
                              svgViewMode === "source"
                                ? "bg-emerald-900 text-white"
                                : "text-slate-600"
                            }`}
                          >
                            Source
                          </button>
                        </div>
                      )}

                      {selectedEntry.isTextEditable &&
                        (selectedEntry.category !== "svg" || svgViewMode === "source") && (
                          <button
                            type="button"
                            onClick={handleApplyTextEdit}
                            disabled={!editorDirty}
                            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-40 whitespace-nowrap"
                          >
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Save Edit</span>
                          </button>
                        )}
                    </div>
                  </div>

                  {/* Preview / Edit Body */}
                  <div className="p-5">
                    {(selectedEntry.category === "image" ||
                      (selectedEntry.category === "svg" && svgViewMode === "preview")) &&
                      previewObjectUrl && (
                        <div
                          className={`rounded-md border border-slate-200 p-6 flex items-center justify-center min-h-[340px] max-h-[520px] overflow-auto ${previewBgClass}`}
                        >
                          <img
                            src={previewObjectUrl}
                            alt={selectedEntry.path}
                            className="max-w-full max-h-[460px] object-contain"
                          />
                        </div>
                      )}

                    {selectedEntry.category === "pdf" && previewObjectUrl && (
                      <iframe
                        src={previewObjectUrl}
                        title={selectedEntry.path}
                        className="w-full h-[520px] rounded-md border border-slate-200 bg-slate-100"
                      />
                    )}

                    {selectedEntry.isTextEditable &&
                      (selectedEntry.category !== "svg" || svgViewMode === "source") && (
                        <div className="space-y-2">
                          <textarea
                            value={editorText}
                            onChange={(e) => {
                              setEditorText(e.target.value);
                              setEditorDirty(true);
                            }}
                            spellCheck={false}
                            aria-label={`Edit ${selectedEntry.path}`}
                            className="w-full h-[460px] rounded-md border border-slate-300 bg-slate-950 text-slate-100 font-mono text-xs p-4 leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-800"
                          />
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500">
                            <span>{editorText.split("\n").length} lines · {editorText.length} chars</span>
                            <span>{editorDirty ? "Unsaved edits in editor" : "Synced with workspace"}</span>
                          </div>
                        </div>
                      )}

                    {!selectedEntry.isTextEditable &&
                      selectedEntry.category === "other" && (
                        <div className="rounded-md border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-600">
                          Binary file ({formatArchiveBytes(selectedEntry.size)}). You can replace or remove this file from the workspace or repackage it into your download.
                        </div>
                      )}
                  </div>
                </>
              ) : (
                <div className="p-10 text-center text-sm text-slate-500">
                  Select a file from the left to inspect or edit it.
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* Persisted Server Archives Section */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Layers className="h-4 w-4 text-slate-600" aria-hidden="true" />
            <span>Persisted Server Archives (uploaded-zips/)</span>
          </h3>
          <button
            type="button"
            onClick={fetchServerArchives}
            disabled={loadingServerList}
            className="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap"
          >
            {loadingServerList ? "Refreshing..." : "Refresh List"}
          </button>
        </div>

        {serverArchives.length === 0 ? (
          <p className="text-xs text-slate-500">
            No persisted ZIP archives stored on the server yet. Upload a .zip above to unpack and store it in <code className="font-mono">uploaded-zips/&lt;id&gt;/files/</code>.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
            {serverArchives.map((arch) => (
              <div
                key={arch.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 truncate">
                    {arch.originalFilename}
                  </p>
                  <p className="font-mono tabular-nums text-[11px] text-slate-500">
                    ID: {arch.id.slice(0, 12)} · {arch.fileCount} files ·{" "}
                    {formatArchiveBytes(arch.archiveSize)} ·{" "}
                    {new Date(arch.uploadedAt).toISOString().slice(0, 19).replace("T", " ")} UTC
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleLoadServerArchive(arch)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap"
                  >
                    Inspect in Workspace
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteServerArchive(arch.id)}
                    className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 whitespace-nowrap"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

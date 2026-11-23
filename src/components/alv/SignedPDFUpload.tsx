import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileUp, Upload } from "lucide-react";
import type { SignedUploadConfirmation } from "./types.ts";

interface SignedPDFUploadProps {
  documentId: string;
  onSuccess: (confirmation: SignedUploadConfirmation) => void;
}

const MAX_CLIENT_BYTES = 10 * 1024 * 1024; // 10 MB

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function SignedPDFUpload({ documentId, onSuccess }: SignedPDFUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const selectFile = (file: File | null) => {
    setError(null);
    setProgress(0);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setSelectedFile(null);
      setError("Only PDF (.pdf) documents are accepted. Please scan or save your signed ALV form as a PDF.");
      return;
    }
    if (file.size === 0) {
      setSelectedFile(null);
      setError("The selected PDF file is empty (0 bytes).");
      return;
    }
    if (file.size > MAX_CLIENT_BYTES) {
      setSelectedFile(null);
      setError("File exceeds the 10 MB upload limit. Compress or re-scan at 150–200 DPI.");
      return;
    }
    setSelectedFile(file);
  };

  const handleUpload = () => {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setProgress(0);
    setError(null);

    const formData = new FormData();
    formData.append("documentId", documentId);
    formData.append("file", selectedFile);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload-signed", true);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const pct = Math.min(99, Math.round((evt.loaded / evt.total) * 100));
        setProgress(pct);
      }
    };

    xhr.onload = () => {
      setUploading(false);
      try {
        const parsed = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300 && parsed.ok) {
          setProgress(100);
          onSuccess({
            documentId: parsed.documentId,
            reference: parsed.reference,
            byteSize: parsed.byteSize,
            sha256: parsed.sha256,
            uploadedAt: parsed.uploadedAt,
          });
        } else {
          setError(
            parsed.error ||
              "Upload could not be verified. Confirm the file is a valid signed PDF and try again."
          );
        }
      } catch {
        setError("Unexpected response from upload server. Please try again.");
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setError("Network error while uploading the signed PDF. Check your connection and retry.");
    };

    xhr.send(formData);
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const dropped = e.dataTransfer.files?.[0] || null;
          selectFile(dropped);
        }}
        className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          dragActive
            ? "border-emerald-700 bg-emerald-50/70"
            : "border-slate-300 bg-slate-50/50"
        }`}
      >
        <input
          ref={inputRef}
          id="signed-pdf-input"
          type="file"
          accept=".pdf,application/pdf"
          className="sr-only"
          onChange={(e) => selectFile(e.target.files?.[0] || null)}
        />
        <FileUp className="mx-auto h-8 w-8 text-slate-500 mb-2" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-900">
          Drop your signed ALV PDF here, or select a file from your device
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Accepted format: PDF only · Maximum size: 10 MB
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="mt-4 inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 min-h-[40px] whitespace-nowrap"
        >
          Choose Signed PDF
        </button>
      </div>

      {selectedFile && (
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900 truncate">
                {selectedFile.name}
              </p>
              <p className="text-xs font-mono tabular-nums text-slate-500">
                {formatBytes(selectedFile.size)} · Ready to upload
              </p>
            </div>
            <button
              type="button"
              onClick={handleUpload}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60 min-h-[40px] whitespace-nowrap shrink-0"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              <span>{uploading ? `Uploading (${progress}%)` : "Upload Signed PDF"}</span>
            </button>
          </div>

          {uploading && (
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
              <div
                className="bg-emerald-800 h-2 transition-all duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-medium">Signed PDF upload failed</p>
            <p className="text-xs mt-0.5 text-red-700">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function SignedUploadSuccessCard({
  confirmation,
  generatedFilename,
  downloadUrl,
  onStartNew,
}: {
  confirmation: SignedUploadConfirmation;
  generatedFilename: string;
  downloadUrl: string;
  onStartNew: () => void;
}) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-white p-6 md:p-8 space-y-6">
      <div className="flex items-start gap-4">
        <div className="rounded-full bg-emerald-100 p-2.5 text-emerald-800 shrink-0">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Signed ALV Document Uploaded Successfully
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Your physically signed ALV application has passed PDF integrity verification and has been securely stored.
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-md border border-slate-200 bg-slate-50/70 p-4">
        <div>
          <dt className="text-xs font-medium text-slate-500">Submission reference</dt>
          <dd className="text-sm font-semibold font-mono tabular-nums text-slate-900 mt-0.5">
            {confirmation.reference}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Uploaded file size</dt>
          <dd className="text-sm font-mono tabular-nums text-slate-900 mt-0.5">
            {formatBytes(confirmation.byteSize)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">Upload timestamp (UTC)</dt>
          <dd className="text-sm font-mono tabular-nums text-slate-900 mt-0.5">
            {new Date(confirmation.uploadedAt).toISOString().replace("T", " ").slice(0, 19)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500">SHA-256 verification</dt>
          <dd className="text-xs font-mono text-slate-700 mt-0.5 truncate" title={confirmation.sha256}>
            {confirmation.sha256}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
        <a
          href={downloadUrl}
          download={generatedFilename}
          className="text-sm font-medium text-emerald-800 hover:underline whitespace-nowrap"
        >
          Download copy of generated ALV PDF
        </a>
        <button
          type="button"
          onClick={onStartNew}
          className="inline-flex items-center justify-center rounded-md bg-emerald-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 min-h-[42px] whitespace-nowrap"
        >
          Start New ALV Application
        </button>
      </div>
    </div>
  );
}

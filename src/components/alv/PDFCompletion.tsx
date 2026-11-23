import { useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  Printer,
} from "lucide-react";
import {
  SignedPDFUpload,
  SignedUploadSuccessCard,
} from "./SignedPDFUpload.tsx";
import type {
  GeneratedDocumentInfo,
  SignedUploadConfirmation,
} from "./types.ts";

interface PDFCompletionProps {
  docInfo: GeneratedDocumentInfo;
  signedConfirmation: SignedUploadConfirmation | null;
  onSignedUploadSuccess: (conf: SignedUploadConfirmation) => void;
  onBackToReview: () => void;
  onStartNew: () => void;
}

export function PDFCompletion({
  docInfo,
  signedConfirmation,
  onSignedUploadSuccess,
  onBackToReview,
  onStartNew,
}: PDFCompletionProps) {
  const [showInlinePreview, setShowInlinePreview] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  if (signedConfirmation) {
    return (
      <SignedUploadSuccessCard
        confirmation={signedConfirmation}
        generatedFilename={docInfo.filename}
        downloadUrl={docInfo.downloadUrl}
        onStartNew={onStartNew}
      />
    );
  }

  const handlePrintIframe = () => {
    if (!showInlinePreview) {
      setShowInlinePreview(true);
      return;
    }
    try {
      iframeRef.current?.contentWindow?.focus();
      iframeRef.current?.contentWindow?.print();
    } catch {
      // Fallback: user can print directly from the embedded PDF viewer toolbar
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-6 w-6 text-emerald-800 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Official ALV PDF Generated
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Document reference{" "}
              <span className="font-mono font-medium text-slate-900 tabular-nums">
                ALV-{docInfo.id.slice(0, 8).toUpperCase()}
              </span>
              {" · "}
              Generated from official form ALV(9)(2011/07)
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onBackToReview}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 min-h-[40px] whitespace-nowrap"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Edit Form Details</span>
        </button>
      </div>

      {/* Three Clearly Explained Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Action 1: Download PDF */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-500">Step 1 of 3</p>
            <h3 className="text-base font-semibold text-slate-900 mt-1">
              Download Completed PDF
            </h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              Save a copy of your populated official ALV form ({docInfo.filename}) to your computer or mobile device.
            </p>
          </div>
          <a
            href={docInfo.downloadUrl}
            download={docInfo.filename}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 min-h-[42px] whitespace-nowrap"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            <span>Download PDF</span>
          </a>
        </section>

        {/* Action 2: Open and Print */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-500">Step 2 of 3</p>
            <h3 className="text-base font-semibold text-slate-900 mt-1">
              Open, Print & Sign in Ink
            </h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              Open the PDF directly in your browser to inspect every field and print it. Physically sign the <strong>Signature / Handtekening</strong> line on Page 2.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowInlinePreview((prev) => !prev)}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 min-h-[42px] whitespace-nowrap"
            >
              <Eye className="h-4 w-4" aria-hidden="true" />
              <span>{showInlinePreview ? "Hide Preview" : "Open & Print"}</span>
            </button>
            <a
              href={docInfo.inlineUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 min-h-[42px] whitespace-nowrap"
              title="Open inline PDF in a new browser tab"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              <span>New Tab</span>
            </a>
          </div>
        </section>

        {/* Action 3: Upload Signed PDF */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-500">Step 3 of 3</p>
            <h3 className="text-base font-semibold text-slate-900 mt-1">
              Upload Signed PDF
            </h3>
            <p className="text-sm text-slate-600 mt-2 leading-relaxed">
              Once printed and signed by hand, scan or save the signed document as a PDF and upload it below to complete your submission.
            </p>
          </div>
          <a
            href="#upload-signed-section"
            className="inline-flex items-center justify-center rounded-md border border-emerald-800 bg-emerald-50/60 px-4 py-2.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100/70 min-h-[42px] whitespace-nowrap"
          >
            Go to Upload Below
          </a>
        </section>
      </div>

      {/* Inline PDF Viewer for Opening and Printing */}
      {showInlinePreview && (
        <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Inline Official ALV PDF Preview
            </h3>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrintIframe}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 min-h-[36px] whitespace-nowrap"
              >
                <Printer className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Print PDF</span>
              </button>
              <a
                href={docInfo.inlineUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 min-h-[36px] whitespace-nowrap"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Open Full Window</span>
              </a>
            </div>
          </div>
          <div className="bg-slate-100 p-3">
            <iframe
              ref={iframeRef}
              src={docInfo.inlineUrl}
              title="Generated Official ALV PDF"
              className="w-full h-[680px] rounded border border-slate-300 bg-white"
            />
          </div>
        </section>
      )}

      {/* Upload Signed PDF Section */}
      <section
        id="upload-signed-section"
        className="rounded-lg border border-slate-200 bg-white p-6 space-y-4"
      >
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Upload Physically Signed ALV PDF
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            Only valid PDF files signed by the declared signatory are accepted. Your file is verified server-side and stored separately from generated drafts.
          </p>
        </div>
        <SignedPDFUpload
          documentId={docInfo.id}
          onSuccess={onSignedUploadSuccess}
        />
      </section>
    </div>
  );
}

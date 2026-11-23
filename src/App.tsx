import { useState } from "react";
import { ALVWizard, type InfoModalTopic } from "./components/alv/ALVWizard.tsx";
import { ZipInspectorSection } from "./components/ZipInspectorSection.tsx";
import { FormForgeStudio } from "./components/studio/FormForgeStudio.tsx";

type WorkspaceMode = "alv" | "studio" | "zip";

export default function App() {
  const [activeModal, setActiveModal] = useState<InfoModalTopic>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("alv");

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Three-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Brand Wordmark */}
          <a
            href="#top"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            {workspaceMode === "studio" ? "FormForge AI" : "ALV Form Online"}
          </a>

          {/* Zone 2: Single-line Nav Links */}
          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
          >
            <button
              type="button"
              onClick={() => setWorkspaceMode("alv")}
              className={`hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0 ${
                workspaceMode === "alv" ? "text-slate-900 font-semibold" : ""
              }`}
            >
              Application Form
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode("studio")}
              className={`hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0 ${
                workspaceMode === "studio" ? "text-slate-900 font-semibold" : ""
              }`}
            >
              FormForge Studio
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceMode("zip")}
              className={`hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0 ${
                workspaceMode === "zip" ? "text-slate-900 font-semibold" : ""
              }`}
            >
              ZIP Inspector
            </button>
            <button
              type="button"
              onClick={() => setActiveModal("documents")}
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              Required Documents
            </button>
            <button
              type="button"
              onClick={() => setActiveModal("popia")}
              className="hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0"
            >
              POPIA Privacy
            </button>
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setWorkspaceMode("alv");
                setResetSignal((n) => n + 1);
              }}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-800 hover:bg-slate-50 min-h-[38px] whitespace-nowrap shrink-0"
            >
              Reset Form
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8">
        {/* Service Context Header & Workspace Switcher */}
        <section className="mb-8 flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-3xl">
            <p className="text-xs font-medium text-slate-500">
              {workspaceMode === "studio"
                ? "FormForge AI · Universal PDF Intelligence, OCR/CV Field Detection & AcroForm Automation"
                : workspaceMode === "zip"
                ? "Asset Toolkit · Archive Inspection, Brand Token Audit & Safe Repackaging"
                : "Republic of South Africa · National Road Traffic Act, 1996 · Official Form ALV(9)(2011/07)"}
            </p>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              {workspaceMode === "alv"
                ? "Application for Licensing of Motor Vehicle"
                : workspaceMode === "studio"
                ? "FormForge AI Conversion Studio"
                : "ZIP Package Inspector & Brand Auditor"}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-slate-600 leading-relaxed">
              {workspaceMode === "alv"
                ? "Complete your official ALV particulars online, review every character box, generate the official printable PDF, sign it physically in ink, and upload the signed document."
                : workspaceMode === "studio"
                ? "Convert any digital or scanned PDF into calibrated AcroForm templates, visually adjust bounding boxes, approve locked versions, and generate flattened customer documents."
                : "Inspect, audit, edit, clean, and repackage ZIP asset bundles safely with server-side path confinement."}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="Workspace mode"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1 shrink-0"
          >
            <button
              type="button"
              role="tab"
              aria-selected={workspaceMode === "alv"}
              onClick={() => setWorkspaceMode("alv")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                workspaceMode === "alv"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              ALV Form Wizard
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceMode === "studio"}
              onClick={() => setWorkspaceMode("studio")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                workspaceMode === "studio"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              FormForge AI Studio
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceMode === "zip"}
              onClick={() => setWorkspaceMode("zip")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                workspaceMode === "zip"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              ZIP Workspace & Auditor
            </button>
          </div>
        </section>

        {/* Main Workspace */}
        <section id="wizard-workspace">
          {workspaceMode === "alv" ? (
            <ALVWizard
              activeModal={activeModal}
              onCloseModal={() => setActiveModal(null)}
              resetSignal={resetSignal}
            />
          ) : workspaceMode === "studio" ? (
            <FormForgeStudio onOpenAlvPortal={() => setWorkspaceMode("alv")} />
          ) : (
            <ZipInspectorSection />
          )}
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white mt-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-5 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <p>
            ALV Form Online · Official Form ALV(9)(2011/07) Population & Submission Portal
          </p>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveModal("popia")}
              className="hover:text-slate-900 hover:underline whitespace-nowrap"
            >
              POPIA Notice
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveModal("documents")}
              className="hover:text-slate-900 hover:underline whitespace-nowrap"
            >
              Checklist
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveModal("guide")}
              className="hover:text-slate-900 hover:underline whitespace-nowrap"
            >
              Signing Guide
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

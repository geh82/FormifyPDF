import { useEffect, useState } from "react";
import { BrandWordmark } from "./components/BrandMark.tsx";
import { PublicLandingConverter } from "./components/PublicLandingConverter.tsx";
import { ZipInspectorSection } from "./components/ZipInspectorSection.tsx";
import { FormifyPdfStudio } from "./components/studio/FormifyPdfStudio.tsx";

type WorkspaceMode = "studio" | "zip";

function isAdminPath(): boolean {
  if (typeof window === "undefined") return false;
  const normalized = window.location.pathname.replace(/\/+$/, "") || "/";
  return normalized === "/admin";
}

function AdminWorkspace() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("studio");

  return (
    <div id="top" className="min-h-screen flex flex-col bg-[#F7F8F7] text-slate-900">
      <header className="border-t-2 border-t-emerald-900 border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            aria-label="FormifyPDF home"
            className="whitespace-nowrap shrink-0"
          >
            <BrandWordmark size={26} />
          </a>

          <nav
            aria-label="Admin workspace navigation"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
          >
            <button
              type="button"
              onClick={() => setWorkspaceMode("studio")}
              className={`hover:text-slate-900 hover:underline underline-offset-4 whitespace-nowrap shrink-0 ${
                workspaceMode === "studio" ? "text-slate-900 font-semibold" : ""
              }`}
            >
              Conversion Studio
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
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8">
        <section className="mb-8 flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-3xl">
            <p className="text-xs font-medium text-slate-500">
              {workspaceMode === "studio"
                ? "FormifyPDF - PDF Field Detection, AcroForm Generation & Template Studio"
                : "Asset Toolkit - Archive Inspection, Brand Token Audit & Safe Repackaging"}
            </p>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
              {workspaceMode === "studio"
                ? "Non-Fillable to Fillable PDF Studio"
                : "ZIP Package Inspector & Brand Auditor"}
            </h1>
            <p className="mt-2 text-sm sm:text-base text-slate-600 leading-relaxed">
              {workspaceMode === "studio"
                ? "Analyze digital or scanned PDFs, detect form fields and character grids, generate AcroForm templates, and manage feature toggles and pricing."
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
              aria-selected={workspaceMode === "studio"}
              onClick={() => setWorkspaceMode("studio")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                workspaceMode === "studio"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              Conversion Studio
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

        <section id="wizard-workspace">
          {workspaceMode === "studio" ? <FormifyPdfStudio /> : <ZipInspectorSection />}
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const [adminRoute, setAdminRoute] = useState<boolean>(() => isAdminPath());

  useEffect(() => {
    const syncRoute = () => setAdminRoute(isAdminPath());
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  if (adminRoute) {
    return <AdminWorkspace />;
  }

  return <PublicLandingConverter />;
}
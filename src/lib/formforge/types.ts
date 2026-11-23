export type FormForgeFieldType =
  | "text"
  | "multiline"
  | "numeric"
  | "currency"
  | "date"
  | "email"
  | "phone"
  | "address"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "signature"
  | "initials"
  | "table_cell"
  | "char_cells"
  | "repeating_group";

export type ConfidenceTier = "high" | "medium" | "low";
export type ReviewStatus = "pending" | "accepted" | "edited" | "rejected";
export type DetectionSource =
  | "vector_underline"
  | "vector_box"
  | "vector_char_cells"
  | "vector_checkbox"
  | "vector_radio"
  | "table_cell"
  | "existing_acroform"
  | "cv_contour"
  | "ocr_region"
  | "manual";

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentPageInfo {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  rotation: 0 | 90 | 180 | 270;
  orientation: "portrait" | "landscape";
  paperSize: "A4" | "A3" | "A5" | "Letter" | "Legal" | "Custom";
  mediaBox: PdfPageBox;
  cropBox: PdfPageBox;
  textSpanCount: number;
  wordCount: number;
  drawingCount: number;
  existingWidgetCount: number;
  needsOcr: boolean;
  ocrApplied: boolean;
  deskewAngle?: number;
}

export interface FieldValidationRule {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  dateFormat?: string;
}

export interface DetectedFormField {
  id: string;
  name: string;
  label: string;
  type: FormForgeFieldType;
  page: number;
  rect: PdfRect;
  /** Optional individual character-cell bounding boxes in PDF points when type === "char_cells" */
  cellRects?: PdfRect[];
  /** Optional per-option bounding boxes in PDF points for radio/selection groups */
  optionRects?: Record<string, PdfRect>;
  coordinateSpace: "top_left_pdf_pt";
  originalLabelText: string;
  detectionSource: DetectionSource;
  confidence: number;
  confidenceTier: ConfidenceTier;
  confidenceEvidence: string[];
  required: boolean;
  defaultValue: string;
  maxLength?: number;
  multiline: boolean;
  options: string[];
  validation: FieldValidationRule;
  groupId?: string;
  radioGroupName?: string;
  relatedFieldIds?: string[];
  tooltip?: string;
  fontSize?: number;
  alignment?: "left" | "center" | "right";
  reviewStatus: ReviewStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface FieldManifest {
  documentId: string;
  schemaVersion: "1.0";
  templateName?: string;
  totalPages: number;
  pages: DocumentPageInfo[];
  fields: DetectedFormField[];
  generatedAt: string;
  engineVersion: string;
  hasExistingAcroForm: boolean;
  isScanned: boolean;
  securityFlags: {
    hasEmbeddedJavaScript: boolean;
    wasEncrypted: boolean;
    sanitizedActions: boolean;
  };
}

export type RoleName =
  | "administrator"
  | "template_manager"
  | "editor"
  | "reviewer"
  | "api_integration_user"
  | "read_only_user";

export type OutputPolicy = "flattened" | "fillable" | "both";
export type TemplateStatus = "draft" | "in_review" | "approved" | "archived";

export type JobStage =
  | "queued"
  | "uploading"
  | "inspecting_pdf"
  | "extracting_content"
  | "running_ocr"
  | "analysing_layout"
  | "detecting_fields"
  | "classifying_fields"
  | "generating_manifest"
  | "generating_acroform"
  | "validating_output"
  | "completed"
  | "failed";

export interface AcroFormValidationReport {
  validPdf: boolean;
  hasAcroFormDict: boolean;
  widgetCount: number;
  expectedFieldCount: number;
  missingFields: string[];
  appearanceStreamsVerified: boolean;
  roundTripWriteReadOk: boolean;
  pageCount: number;
  warnings: string[];
}

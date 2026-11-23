import { z } from "zod";

export const PdfRectSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const FormForgeFieldTypeSchema = z.enum([
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
  "listbox",
  "signature",
  "initials",
  "table_cell",
  "char_cells",
  "repeating_group",
]);

export const DetectionSourceSchema = z.enum([
  "pdf_structural",
  "vector_underline",
  "vector_box",
  "vector_char_cells",
  "vector_comb_grid",
  "vector_checkbox",
  "vector_radio",
  "glyph_symbol",
  "table_cell",
  "existing_acroform",
  "cv_contour",
  "cv_circle",
  "ocr_region",
  "paddleocr",
  "ai_semantic_fusion",
  "manual",
]);

export const CharGridMetadataSchema = z.object({
  cellCount: z.number().int().min(1).max(200),
  cellWidthPt: z.number().finite().positive(),
  cellHeightPt: z.number().finite().positive(),
  spacingPt: z.number().finite(),
  readingDirection: z.enum(["ltr", "rtl"]).default("ltr"),
  acroformStrategy: z.enum(["comb", "individual_cells"]).default("comb"),
});

export const DetectedFormFieldSchema = z.object({
  id: z.string().min(1).max(80),
  name: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Field name may only contain letters, digits, _, ., -"),
  label: z.string().min(1).max(200),
  type: FormForgeFieldTypeSchema,
  page: z.number().int().min(0),
  rect: PdfRectSchema,
  originalDetectedRect: PdfRectSchema.nullish().transform((v) => v ?? undefined),
  pdfBottomLeftRect: z
    .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
    .nullish()
    .transform((v) => v ?? undefined),
  cellRects: z
    .array(PdfRectSchema)
    .nullish()
    .transform((v) => v ?? undefined),
  charGridMeta: CharGridMetadataSchema.nullish().transform((v) => v ?? undefined),
  optionRects: z
    .record(z.string(), PdfRectSchema)
    .nullish()
    .transform((v) => v ?? undefined),
  coordinateSpace: z.literal("top_left_pdf_pt").default("top_left_pdf_pt"),
  originalLabelText: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? ""),
  detectionSource: DetectionSourceSchema.default("manual"),
  detectionSources: z
    .array(DetectionSourceSchema)
    .nullish()
    .transform((v) => v ?? undefined),
  confidence: z.number().min(0).max(1),
  confidenceTier: z.enum(["high", "medium", "low"]),
  confidenceEvidence: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  required: z.boolean().default(false),
  defaultValue: z
    .string()
    .max(1000)
    .nullish()
    .transform((v) => v ?? ""),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .nullish()
    .transform((v) => v ?? undefined),
  multiline: z.boolean().default(false),
  options: z
    .array(z.string().max(200))
    .nullish()
    .transform((v) => v ?? []),
  validation: z
    .object({
      pattern: z
        .string()
        .max(300)
        .nullish()
        .transform((v) => v ?? undefined),
      minLength: z
        .number()
        .int()
        .min(0)
        .nullish()
        .transform((v) => v ?? undefined),
      maxLength: z
        .number()
        .int()
        .min(1)
        .nullish()
        .transform((v) => v ?? undefined),
      min: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
      max: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
      dateFormat: z
        .string()
        .max(40)
        .nullish()
        .transform((v) => v ?? undefined),
    })
    .nullish()
    .transform((v) => v ?? {}),
  groupId: z
    .string()
    .max(80)
    .nullish()
    .transform((v) => v ?? undefined),
  radioGroupName: z
    .string()
    .max(80)
    .nullish()
    .transform((v) => v ?? undefined),
  relatedFieldIds: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? undefined),
  tooltip: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? undefined),
  fontSize: z
    .number()
    .min(5)
    .max(36)
    .nullish()
    .transform((v) => v ?? undefined),
  alignment: z
    .enum(["left", "center", "right"])
    .nullish()
    .transform((v) => v ?? undefined),
  reviewStatus: z.enum(["pending", "accepted", "edited", "rejected"]).default("pending"),
  reviewFlagReason: z
    .string()
    .max(300)
    .nullish()
    .transform((v) => v ?? undefined),
  createdAt: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
  updatedAt: z
    .string()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const FieldManifestUpdateSchema = z.object({
  fields: z.array(DetectedFormFieldSchema).max(2000),
  templateName: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? undefined),
});

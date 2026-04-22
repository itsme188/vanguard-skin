/**
 * Logical identifiers for every AI-calling feature in the app.
 *
 * Each feature maps to a concrete provider + model via FEATURE_MODELS in
 * lib/ai/models.ts. Swapping a model is a one-line config change, never a
 * code edit at the call site.
 *
 * When adding a new AI-calling feature:
 *   1. Add its key here.
 *   2. Add its entry to FEATURE_MODELS.
 *   3. Use getModelForFeature("<key>") at the call site.
 */
export type FeatureKey =
  | "chat"
  | "briefing"
  | "tradeReviewMain"
  // Used in place of tradeReviewMain when a review has >20 trades — Opus would
  // run long enough to risk timeouts, so Sonnet takes over. Keeping it as a
  // distinct key lets us swap the large-review model independently.
  | "tradeReviewMainLarge"
  | "tradeReviewQA"
  | "pdfParsing"
  | "alertSuggestion"
  | "newsletterLevelExtraction"
  | "newsletterProcessing"
  | "factorClassification"
  | "macroEnrichment"
  | "scheduleVerification"
  | "filingSectionExtraction"
  | "researchDocumentExtraction";

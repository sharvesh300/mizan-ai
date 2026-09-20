// Barrel export — this is the entry point drizzle-kit reads (see
// drizzle.config.ts `schema`) and the module app code imports from.

export * from "./enums";
export * from "./identity";
export * from "./application";
export * from "./catalogue";
export * from "./assessment";
export * from "./quote-recommendation";
export * from "./review";
export * from "./policy-ledger";
export * from "./plan-fit";
export * from "./views";

// v2 · AI & conversation layer (additive)
export * from "./channels";
export * from "./conversation";
export * from "./questions";
export * from "./ai-decision";
export * from "./actions";
export * from "./extraction";
export * from "./preference";
export * from "./ai-views";

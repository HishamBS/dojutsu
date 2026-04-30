// A01 (LLM-only): module-specific knowledge hardcoded instead of CAM-declared
// cronDefault should be declared in CAM and emitted via codegen, not hardcoded here
const cronDefault = '0 0 * * *';
export { cronDefault };

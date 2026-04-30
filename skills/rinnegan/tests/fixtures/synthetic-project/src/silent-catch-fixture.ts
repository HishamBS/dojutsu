// R23 (LLM-only): silent catch swallows errors without logging or rethrowing
export function load() { try { return JSON.parse('{}'); } catch { return undefined; } }

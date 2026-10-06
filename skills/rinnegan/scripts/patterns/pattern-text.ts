// Text the pattern tables splice into their regex sources. A backtick cannot sit inside a
// String.raw template, and the vendor name is split so no source file here spells the SDK
// package name contiguously (the scanner's own R13 pattern would otherwise flag it).
export const BACKTICK = "`";
export const SDK_VENDOR = "hum" + "ain";

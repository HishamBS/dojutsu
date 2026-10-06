// ESLint for the quality-skills package: the JS recommended set, typescript-eslint's
// type-checked set, and the rules this repo's gates lean on (R07: no non-null assertion; a
// swallowed error must say why). Fixtures hold deliberately bad projects and stay out of
// every glob.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["eslint.config.ts", "**/fixtures/**", "**/node_modules/**", "**/*.mjs", "**/*.js", "**/*.tsx", "ui-ux-pro-max/**", "unlazy/**"] },
  js.configs.recommended,
  {
    files: ["rinnegan/**/*.ts", "byakugan/**/*.ts", "rasengan/**/*.ts", "dojutsu/**/*.ts", "setup-quality-gates/**/*.ts", "handoff/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/require-await": "off",
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
);

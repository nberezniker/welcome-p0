import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescriptConfig from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".runtime/**",
      "out/**",
      "next-env.d.ts",
      // protected baselines — not part of this app build
      "spec/**",
      "reference-landing/**",
    ],
  },
  // eslint-config-next@16 ships native flat config (FlatCompat no longer works)
  ...coreWebVitals,
  ...typescriptConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default eslintConfig;

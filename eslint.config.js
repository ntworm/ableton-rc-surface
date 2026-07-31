import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "static/phone-v3/vendor/**",
      "vendor/**",
      "*.ablx",
    ],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      sourceType: "module",
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "warn",
      "no-console": "off",
      "no-var": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "warn",
    },
  },
];

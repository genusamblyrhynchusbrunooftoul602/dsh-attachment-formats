import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "temp/**", ".venv/**", "vendor/**", "dist/**", "build/**"]
  },
  {
    files: ["lib/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    plugins: {},
    rules: {
      ...js.configs.recommended.rules,
      // 核心正确性规则（useCallback 这类未定义引用在此被拦下）
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-useless-catch": "warn",
      "no-constant-binary-expression": "error"
    }
  }
];

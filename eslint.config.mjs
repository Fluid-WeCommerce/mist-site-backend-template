import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", ".vercel/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally-unused args prefixed with _.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);

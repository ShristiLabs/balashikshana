import expoConfig from "eslint-config-expo/flat.js";

export default [
  {
    ignores: [
      "public/**",
      "server.mjs",
      "dist/**",
      ".expo/**",
      "node_modules/**",
      "package-lock.json",
    ],
  },
  ...expoConfig,
  {
    // node: builtins resolve differently between local installs and CI's
    // fresh npm ci (TS program changes made import/no-unresolved stop
    // firing there, turning the old suppressions into "unused directive"
    // warnings). Declaring them core modules makes lint deterministic in
    // every environment.
    settings: {
      "import/core-modules": ["node:sqlite"],
    },
  },
];

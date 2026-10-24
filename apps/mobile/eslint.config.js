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
];

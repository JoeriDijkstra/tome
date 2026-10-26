// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    // zod convention: a schema and its inferred type share one name
    rules: { '@typescript-eslint/no-redeclare': 'off' },
  },
]);

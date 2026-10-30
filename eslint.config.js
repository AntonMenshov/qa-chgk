// Lint rules: ESLint's recommended set plus the parts of the Google JavaScript Style Guide
// a linter can check (https://google.github.io/styleguide/jsguide.html). Layout is
// Prettier's job (.prettierrc, Google's layout at 120 columns), so layout rules are off.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import {createRequire} from 'node:module';

// Code.js and logic.js share one global scope in Apps Script (`chgk backend bundle`).
const logicExports = Object.keys(createRequire(import.meta.url)('./apps_script/logic.js'));
const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

const google = {
  eqeqeq: ['error', 'always', {null: 'ignore'}],
  camelcase: ['error', {properties: 'never', ignoreDestructuring: true}], // JSON fields stay snake_case
  'guard-for-in': 'error',
  'new-cap': ['error', {capIsNew: false}],
  'no-array-constructor': 'error',
  'no-new-wrappers': 'error',
  'no-throw-literal': 'error',
  'no-var': 'error',
  'one-var': ['error', 'never'],
  'prefer-const': ['error', {destructuring: 'all'}],
  'prefer-promise-reject-errors': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'no-unused-vars': ['error', {args: 'none'}],
};

export default [
  {ignores: ['node_modules/', 'out/', '.venv/', 'spikes/', 'web/s/vendor/']},
  js.configs.recommended,
  {rules: google},
  {
    files: ['apps_script/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...readonly([
          'SpreadsheetApp',
          'DriveApp',
          'PropertiesService',
          'ContentService',
          'Session',
          'LockService',
          'ScriptApp',
          'Utilities',
          'Logger',
          'Sheets',
        ]),
        module: 'readonly', // logic.js exports itself to Node for the tests
      },
    },
    // Top-level functions are Apps Script entry points or used by the other file.
    rules: {'no-unused-vars': ['error', {args: 'none', vars: 'local'}]},
  },
  {files: ['apps_script/Code.js'], languageOptions: {globals: readonly(logicExports)}},
  {files: ['web/**/*.js'], languageOptions: {globals: globals.browser}},
  {files: ['web/s/sw.js'], languageOptions: {globals: globals.serviceworker}},
  {files: ['tests/js/**/*.mjs', 'eslint.config.js'], languageOptions: {globals: globals.node}},
  prettier,
  // After eslint-config-prettier, which turns `curly` off; 'all' is safe with Prettier.
  // Google: braces for every control statement (its one-line exception can't be linted).
  {rules: {curly: ['error', 'all']}},
];

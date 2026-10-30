// Lint rules: ESLint's recommended set plus the parts of the Google JavaScript Style Guide
// a linter can check (https://google.github.io/styleguide/jsguide.html). Layout is
// Prettier's job (.prettierrc, Google's layout at 120 columns), so layout rules are off.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import {readFileSync} from 'node:fs';

// The backend's files share one global scope in Apps Script (`chgk backend bundle` joins
// them): each may use the top-level functions and constants of the others.
const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));
const backendFiles = JSON.parse(readFileSync(new URL('./apps_script/bundle.json', import.meta.url), 'utf8')).files;
const topLevel = (file) => {
  const source = readFileSync(new URL(`./apps_script/${file}`, import.meta.url), 'utf8');
  return [...source.matchAll(/^(?:export )?(?:function (\w+)\(|(?:const|let) (\w+) =|class (\w+) )/gm)].map(
    (m) => m[1] || m[2] || m[3],
  );
};
const sharedGlobals = (file) => readonly(backendFiles.filter((f) => f !== file).flatMap(topLevel));

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
  {ignores: ['node_modules/', 'out/', '.venv/', 'web/s/vendor/', 'web/b/vendor/']},
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
      },
    },
    // Top-level functions are Apps Script entry points or used by the other files.
    rules: {'no-unused-vars': ['error', {args: 'none', vars: 'local'}]},
  },
  ...backendFiles.map((file) => ({files: [`apps_script/${file}`], languageOptions: {globals: sharedGlobals(file)}})),
  // logic.js is an ES module (the web pages import it as ../shared/logic.js); the bundler
  // drops its `export`s for Apps Script.
  {files: ['apps_script/logic.js'], languageOptions: {sourceType: 'module'}},
  {files: ['web/**/*.js'], languageOptions: {globals: globals.browser}},
  {files: ['web/s/sw.js'], languageOptions: {globals: globals.serviceworker}},
  {files: ['tests/js/**/*.mjs', 'eslint.config.js'], languageOptions: {globals: globals.node}},
  prettier,
  // After eslint-config-prettier, which turns `curly` off; 'all' is safe with Prettier.
  // Google: braces for every control statement (its one-line exception can't be linted).
  {rules: {curly: ['error', 'all']}},
];

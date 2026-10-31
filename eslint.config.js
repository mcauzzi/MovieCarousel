import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Output di build delle altre parti (Android/Gradle, .NET) e report generati:
  // mai sorgenti da analizzare. Il sito vive in src/ e non ha cartelle build/.
  {
    ignores: [
      'dist/**', 'node_modules/**', 'assets/**', 'Localfiles/**', '*.tc', '*.tc~',
      'android/**', 'api/**/bin/**', 'api/**/obj/**', '**/build/**', 'a11y-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // L'app sfrutta `unknown` + cast espliciti sui campi XML dinamici (Movie):
      // teniamo l'avviso ma non blocchiamo, e permettiamo le _-prefixed inutilizzate.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  // Config a livello di repo (eslint.config.js) e script in scripts/ girano in Node, non nel browser.
  {
    files: ['*.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);

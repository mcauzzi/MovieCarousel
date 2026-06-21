import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'assets/**', 'Localfiles/**', '*.tc', '*.tc~'] },
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
  // Config a livello di repo (eslint.config.js) gira in Node, non nel browser.
  {
    files: ['*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);

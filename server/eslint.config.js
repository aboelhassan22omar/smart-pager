import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.serviceworker },
  },
];

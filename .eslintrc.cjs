module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
    browser: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  overrides: [
    {
      files: ['static/**/*.js', 'static/**/*.mjs', '*.mjs'],
      env: {
        browser: true,
        node: true,
      },
      extends: ['eslint:recommended'],
      parserOptions: {
        sourceType: 'module',
      },
      rules: {
        'no-unused-vars': 'off',
        'no-empty': 'off',
        'no-undef': 'off',
        'no-prototype-builtins': 'off',
        'no-redeclare': 'off',
        'no-constant-condition': 'off',
        'no-mixed-spaces-and-tabs': 'off',
        'no-extra-semi': 'off',
        'no-useless-escape': 'off',
        'no-inner-declarations': 'off',
        'no-case-declarations': 'off',
        'no-unused-expressions': 'off',
      }
    }
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-this-alias': 'off',
    '@typescript-eslint/no-unused-expressions': 'off',
    'no-unused-vars': 'off',
    'no-empty': 'off',
    'no-undef': 'off',
    'no-prototype-builtins': 'off',
    'no-control-regex': 'off',
    'no-redeclare': 'off',
    'no-constant-condition': 'off',
    'no-mixed-spaces-and-tabs': 'off',
    'no-extra-semi': 'off',
    'no-useless-escape': 'off',
    'no-inner-declarations': 'off',
    'no-case-declarations': 'off',
    'no-unused-expressions': 'off',
  },
};

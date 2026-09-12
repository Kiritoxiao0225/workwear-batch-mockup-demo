import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs}'],
    ignores: ['**/*.test.{ts,tsx}', 'lib/server/catalog-oss.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'ali-oss', message: 'Use lib/server/catalog-oss so object transfers, browser signing and bucket management share the central endpoint policy.' }] }],
      'no-restricted-syntax': ['error',
        { selector: "ImportExpression[source.value='ali-oss']", message: 'Load OSS only through lib/server/catalog-oss.' },
        { selector: "CallExpression[callee.name='require'][arguments.0.value='ali-oss']", message: 'Load OSS only through lib/server/catalog-oss.' },
      ],
    },
  },
  globalIgnores(['.next*/**', '.tmp/**', 'data/**', 'output/**', '.workbuddy/**', 'coverage/**', 'public/uploads/**']),
]);

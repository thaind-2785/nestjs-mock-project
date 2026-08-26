#!/usr/bin/env bash
set -euo pipefail

npx prettier --check \
  "src/**/*.ts" \
  "test/**/*.ts" \
  "docs/**/*.md" \
  ".agents/skills/**/*.md" \
  "*.md"
npx eslint --max-warnings=0 "{src,apps,libs,test}/**/*.ts"
npm test -- --runInBand
npm run test:integration
npm run test:e2e -- --runInBand
npm run build

# Kenter API Tester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Lambda-backed Kenter Meetdata API tester for the IKEHU GitHub Pages frontend.

**Architecture:** Amplify Gen 2 defines one Lambda function and one HTTP API. The static Vite frontend reads `custom.kenter_api_url` from Amplify outputs, calls the Lambda routes, and renders JSON responses.

**Tech Stack:** Amplify Gen 2, AWS CDK HTTP API, Node.js Lambda, TypeScript, Vite.

## Global Constraints

- Do not commit Kenter client secrets.
- Keep the browser credential-free.
- Allow only Kenter Meetdata API paths in the Lambda proxy.
- Preserve a static frontend suitable for GitHub Pages.

---

### Task 1: Lambda Route Handler

**Files:**
- Create: `ikehu_app/amplify/functions/kenter-api/resource.ts`
- Create: `ikehu_app/amplify/functions/kenter-api/handler.ts`
- Create: `ikehu_app/amplify/functions/kenter-api/handler.test.ts`

**Interfaces:**
- Produces: `handler(event)` Lambda entrypoint.
- Produces: route helpers that support `GET /health`, `GET /meters`, `GET /modified`, and `POST /fetch-url`.

- [x] Write failing tests for config checks and URL allowlist.
- [x] Run tests and confirm failure before implementation.
- [x] Implement the minimal Lambda handler.
- [x] Run tests and confirm pass.

### Task 2: Amplify HTTP API

**Files:**
- Modify: `ikehu_app/amplify/backend.ts`

**Interfaces:**
- Consumes: `kenterApi.resources.lambda`.
- Produces: `custom.kenter_api_url` in Amplify outputs.

- [x] Add Lambda to `defineBackend`.
- [x] Create HTTP API Gateway integration.
- [x] Add CORS and custom output.

### Task 3: Static Frontend Tester

**Files:**
- Modify: `ikehu_app/index.html`
- Modify: `ikehu_app/src/main.ts`
- Modify: `ikehu_app/src/style.css`

**Interfaces:**
- Consumes: `outputs.custom.kenter_api_url`.
- Produces: browser UI for health, meters, modified, and one manual URL fetch.

- [x] Replace starter Todo UI.
- [x] Implement API calls with formatted JSON output.
- [x] Add manual API URL override.

### Task 4: Verification

**Files:**
- No additional files.

- [x] Run Lambda tests.
- [x] Run production build.
- [x] Report deployment secret setup commands.


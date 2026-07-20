# Kenter API Tester Design

## Goal

Build a GitHub Pages-compatible Kenter Meetdata API tester for the IKEHU webapp, backed by AWS Lambda so Kenter credentials stay server-side.

## Architecture

The static frontend calls an Amplify Gen 2 HTTP API. The HTTP API invokes a Lambda function that obtains a Kenter JWT with the client credentials flow, forwards only approved Kenter API paths, and returns JSON responses to the browser. The frontend replaces the starter Todo UI with a focused test console for health, meters, modified data, and one manual measurement URL.

## Backend

Create an Amplify function named `kenterApi` with secrets/environment values:

- `KENTER_CLIENT_ID`
- `KENTER_CLIENT_SECRET`
- `ALLOWED_ORIGIN`

Expose it through an API Gateway HTTP API and add the API base URL to Amplify custom outputs as `custom.kenter_api_url`.

Lambda routes:

- `GET /health`: reports whether required environment values are configured.
- `GET /meters`: calls `GET https://api.kenter.nu/meetdata/v2/meters?updates_days=0`.
- `GET /modified`: calls `GET https://api.kenter.nu/meetdata/v2/measurements/modified`.
- `POST /fetch-url`: accepts `{ "url": "/meetdata/v2/measurements/..." }` and fetches one allowed relative Kenter URL.

The Lambda must reject full external URLs and any relative path outside `/meetdata/v2/measurements/`.

## Frontend

The page should show:

- API base URL, with manual override for local testing before outputs are regenerated.
- Health/config status.
- Buttons for meters and modified data.
- A text field for one Kenter relative measurement URL.
- Response status, elapsed time, and formatted JSON output.

The browser never asks for or stores Kenter client credentials.

## Testing

Use Node's test runner through `tsx` for Lambda route behavior. Build with `npm run build` to type-check backend/frontend code.


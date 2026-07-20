import './style.css';
import outputs from '../amplify_outputs.json';

type ApiResult = {
  label: string;
  status: number | 'network-error';
  elapsedMs: number;
  body: unknown;
};

const outputConfig = outputs as {
  custom?: {
    kenter_api_url?: string;
  };
};

const deployedKenterApiUrl =
  'https://wajwor7bzb2gqxowzan2fy7idi0hfbtd.lambda-url.eu-central-1.on.aws/';
const defaultApiUrl = outputConfig.custom?.kenter_api_url ?? deployedKenterApiUrl;

const apiUrlInput = document.querySelector<HTMLInputElement>('#api-url');
const healthButton = document.querySelector<HTMLButtonElement>('#test-health');
const metersButton = document.querySelector<HTMLButtonElement>('#get-meters');
const modifiedButton = document.querySelector<HTMLButtonElement>('#get-modified');
const fetchUrlButton = document.querySelector<HTMLButtonElement>('#fetch-url');
const measurementUrlInput = document.querySelector<HTMLInputElement>('#measurement-url');
const statusText = document.querySelector<HTMLElement>('#status-text');
const output = document.querySelector<HTMLPreElement>('#json-output');
const copyButton = document.querySelector<HTMLButtonElement>('#copy-json');
const downloadButton = document.querySelector<HTMLButtonElement>('#download-json');

let latestResult: ApiResult | undefined;

if (apiUrlInput) {
  apiUrlInput.value = localStorage.getItem('kenterApiUrl') || defaultApiUrl;
  apiUrlInput.addEventListener('change', () => {
    localStorage.setItem('kenterApiUrl', apiUrlInput.value.trim());
  });
}

function getApiBaseUrl(): string {
  const value = apiUrlInput?.value.trim() ?? '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function setBusy(label: string): number {
  const startedAt = performance.now();
  if (statusText) {
    statusText.textContent = `${label}...`;
  }
  document.body.dataset.loading = 'true';
  return startedAt;
}

function renderResult(result: ApiResult): void {
  latestResult = result;

  if (statusText) {
    statusText.textContent = `${result.label}: ${result.status} in ${Math.round(result.elapsedMs)} ms`;
  }

  if (output) {
    output.textContent = JSON.stringify(result.body, null, 2);
  }

  document.body.dataset.loading = 'false';
}

function renderError(label: string, startedAt: number, error: unknown): void {
  renderResult({
    label,
    status: 'network-error',
    elapsedMs: performance.now() - startedAt,
    body: {
      error: error instanceof Error ? error.message : 'Unknown browser error.',
    },
  });
}

async function callApi(label: string, path: string, init?: RequestInit): Promise<void> {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    renderResult({
      label,
      status: 'network-error',
      elapsedMs: 0,
      body: {
        error: 'Set the Lambda API URL first. Deploy Amplify or paste the HTTP API URL manually.',
      },
    });
    return;
  }

  const startedAt = setBusy(label);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: unknown = text;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    renderResult({
      label,
      status: response.status,
      elapsedMs: performance.now() - startedAt,
      body,
    });
  } catch (error) {
    renderError(label, startedAt, error);
  }
}

healthButton?.addEventListener('click', () => {
  void callApi('Health check', '/health');
});

metersButton?.addEventListener('click', () => {
  void callApi('Meter list', '/meters');
});

modifiedButton?.addEventListener('click', () => {
  void callApi('Modified data', '/modified');
});

fetchUrlButton?.addEventListener('click', () => {
  const url = measurementUrlInput?.value.trim() ?? '';
  void callApi('Measurement URL', '/fetch-url', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
});

copyButton?.addEventListener('click', async () => {
  if (!latestResult) {
    return;
  }

  await navigator.clipboard.writeText(JSON.stringify(latestResult.body, null, 2));
  if (statusText) {
    statusText.textContent = 'Copied latest JSON response.';
  }
});

downloadButton?.addEventListener('click', () => {
  if (!latestResult) {
    return;
  }

  const blob = new Blob([JSON.stringify(latestResult.body, null, 2)], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `kenter-${latestResult.label.toLowerCase().replaceAll(' ', '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

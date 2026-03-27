type TelegramCallApiOptions = {
  signal?: AbortSignal;
};

type TelegramApiRequestOptions = {
  botToken: string;
  apiRoot: string;
  apiMode: string;
  testEnv: boolean;
  proxyUrl: string;
};

function replacer(_key: string, value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  return value;
}

export function canUseBunFetchTelegramProxy(proxyUrl?: string): boolean {
  if (!process.versions.bun || !proxyUrl?.trim()) {
    return false;
  }

  const parsed = new URL(proxyUrl);
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function createBunTelegramCallApi(options: TelegramApiRequestOptions) {
  return async function callApi(method: string, payload: Record<string, unknown>, apiOptions: TelegramCallApiOptions = {}) {
    const apiUrl = new URL(
      `./${options.apiMode}${options.botToken}${options.testEnv ? "/test" : ""}/${method}`,
      options.apiRoot,
    );

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body: JSON.stringify(payload, replacer),
      signal: apiOptions.signal,
      proxy: options.proxyUrl,
    });

    if (response.status >= 500) {
      throw new Error(`Telegram API request failed with HTTP ${response.status} ${response.statusText}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `Telegram API returned a non-JSON response for ${method}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!data?.ok) {
      const description =
        typeof data?.description === "string"
          ? data.description
          : `Telegram API request failed for ${method}`;
      throw new Error(description);
    }

    return data.result;
  };
}

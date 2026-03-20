const GSM_7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ`¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_7_EXTENSION = "^{}\\[~]|€";

export type SmsEncoding = "gsm7" | "ucs2";

export type SmsSegmentEstimate = {
  encoding: SmsEncoding;
  segments: number;
  units: number;
};

export function isGsm7Encodable(text: string): boolean {
  for (const character of text) {
    if (!GSM_7_BASIC.includes(character) && !GSM_7_EXTENSION.includes(character)) {
      return false;
    }
  }

  return true;
}

export function estimateSmsSegments(text: string): SmsSegmentEstimate {
  if (text.length === 0) {
    return {
      encoding: "gsm7",
      segments: 1,
      units: 0,
    };
  }

  if (isGsm7Encodable(text)) {
    let units = 0;
    for (const character of text) {
      units += GSM_7_EXTENSION.includes(character) ? 2 : 1;
    }

    return {
      encoding: "gsm7",
      units,
      segments: units <= 160 ? 1 : Math.ceil(units / 153),
    };
  }

  const units = [...text].length;
  return {
    encoding: "ucs2",
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

export type ConcatenatedSmsPart = {
  reference: string;
  partNumber: number;
  totalParts: number;
  remoteNumber: string;
  receivedAt: string;
  body: string;
};

export class ConcatenatedSmsAssembler {
  #parts = new Map<string, Map<number, ConcatenatedSmsPart>>();

  addPart(part: ConcatenatedSmsPart): { completed: boolean; body?: string } {
    const key = `${part.remoteNumber}:${part.reference}:${part.totalParts}`;
    const existing = this.#parts.get(key) ?? new Map<number, ConcatenatedSmsPart>();
    existing.set(part.partNumber, part);
    this.#parts.set(key, existing);

    if (existing.size < part.totalParts) {
      return { completed: false };
    }

    const ordered = Array.from(existing.values()).sort((left, right) => left.partNumber - right.partNumber);
    this.#parts.delete(key);
    return {
      completed: true,
      body: ordered.map((item) => item.body).join(""),
    };
  }
}

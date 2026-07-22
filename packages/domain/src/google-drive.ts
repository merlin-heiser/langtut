/** Cross-platform Google Drive appDataFolder client. OAuth and local persistence deliberately stay outside. */
export type DriveFile = { id: string; name: string; appProperties?: Record<string, string> };
export interface DrivePayloadCodec { extension: string; mimeType: string; encode(value: string): Uint8Array; decode(value: Uint8Array): string; }
export const plainTextCodec: DrivePayloadCodec = {
  extension: "ndjson", mimeType: "application/x-ndjson", encode: (value) => new TextEncoder().encode(value), decode: (value) => new TextDecoder().decode(value),
};

const filesUrl = "https://www.googleapis.com/drive/v3/files";
const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

export class GoogleDriveAppDataClient {
  constructor(private readonly accessToken: () => string | undefined) {}
  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.accessToken(); if (!token) throw new Error("Google Drive ist nicht verbunden.");
    const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    if (!response.ok) throw new Error(`Google Drive: ${response.status} ${await response.text()}`);
    return response;
  }
  async listFiles(): Promise<DriveFile[]> {
    const q = encodeURIComponent("'appDataFolder' in parents and trashed = false"); const fields = encodeURIComponent("files(id,name,appProperties)");
    const body = await (await this.request(`${filesUrl}?spaces=appDataFolder&q=${q}&fields=${fields}`)).json() as { files?: DriveFile[] };
    return body.files ?? [];
  }
  async upload(name: string, appProperties: Record<string, string>, content: Uint8Array, mimeType: string): Promise<void> {
    const boundary = `langtut-${crypto.randomUUID()}`;
    const metadata = { name, parents: ["appDataFolder"], mimeType, appProperties };
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const suffix = encoder.encode(`\r\n--${boundary}--`); const body = concatBytes([prefix, content, suffix]);
    await this.request(uploadUrl, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: new Blob([body.buffer as ArrayBuffer]) });
  }
  async download(id: string): Promise<Uint8Array> { return new Uint8Array(await (await this.request(`${filesUrl}/${id}?alt=media`)).arrayBuffer()); }
  async delete(id: string): Promise<void> { await this.request(`${filesUrl}/${id}`, { method: "DELETE" }); }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(length); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}

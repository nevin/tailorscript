const fileBytes = 2_000_000;
const totalBytes = 8_000_000;

export function toBase64(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

export async function download(url, limit = fileBytes) {
  let response;
  try {
    response = await fetch(url, { cache: "no-cache", credentials: "omit" });
  } catch (error) {
    throw new Error(`Couldn’t download ${url}. Check the address, or allow Tailorscript to access that site.`, { cause: error });
  }
  if (!response.ok) throw new Error(`Couldn’t download ${url} (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url} is larger than ${Math.round(limit / 1_000_000)} MB.`);
  return { bytes, contentType: response.headers.get("content-type") ?? "" };
}

export async function downloadText(url) {
  return new TextDecoder().decode((await download(url)).bytes);
}

// Reuses files already downloaded for the same URL, so saving a script only fetches new @require and @resource entries.
export async function resolveDeps(metadata, previous = {}) {
  const requires = [];
  const resources = [];
  let total = 0;
  for (const url of metadata.requires) {
    const entry = previous.requires?.find(item => item.url === url) ?? { url, code: await downloadText(url) };
    total += entry.code.length;
    requires.push(entry);
  }
  for (const { name, url } of metadata.resources) {
    let dataUrl = previous.resources?.find(item => item.url === url)?.dataUrl ?? (url.startsWith("data:") ? url : null);
    if (!dataUrl) {
      const { bytes, contentType } = await download(url);
      dataUrl = `data:${contentType.split(";")[0] || "application/octet-stream"};base64,${toBase64(bytes)}`;
    }
    total += dataUrl.length;
    resources.push({ name, url, dataUrl });
  }
  if (total > totalBytes) throw new Error("This script’s @require and @resource files add up to more than 8 MB.");
  return { requires, resources };
}

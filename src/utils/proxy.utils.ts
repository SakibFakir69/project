
export function getProxyArgs(): string[] {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = process.env.PROXY_USERNAME;
  const pass = process.env.PROXY_PASSWORD;

  if (!host || !port || !user || !pass) {
    console.warn("[proxy] not fully configured — skipping proxy");
    return [];
  }

  const proxyUrl = `http://${user}:${pass}@${host}:${port}`;
  console.log(`[proxy] using: ${host}:${port}`);
  return ["--proxy", proxyUrl];
}
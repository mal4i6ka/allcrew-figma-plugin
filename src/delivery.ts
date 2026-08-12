/**
 * Shared delivery — POSTs the generated package to a user-configured receiver endpoint.
 * Ported from altery-figma-ds code.js:1092-1109 + altery-figma-django delivery.
 */

export interface DeliveryConfig {
  endpoint: string
  secret: string
  target: 'folder' | 'git' | 'pr' | 'npm'
  route: {
    repo: string
    branch: string
    path: string
    package: string
  }
  onChange: boolean
  onOpen: boolean
}

export interface DeliveryResult {
  ok: boolean
  status?: number
  message?: string
}

export async function deliverPackage(
  zipBytes: Uint8Array,
  config: DeliveryConfig
): Promise<DeliveryResult> {
  if (!config.endpoint) {
    return { ok: false, message: 'No delivery endpoint configured.' }
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Altery-Secret': config.secret,
        'X-Altery-Target': config.target,
        'X-Altery-Route-Repo': config.route.repo,
        'X-Altery-Route-Branch': config.route.branch,
        'X-Altery-Route-Path': config.route.path,
        'X-Altery-Route-Package': config.route.package,
      },
      body: zipBytes,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, message: text || response.statusText }
    }

    return { ok: true, status: response.status }
  } catch (err) {
    return { ok: false, message: String((err as Error)?.message || err) }
  }
}

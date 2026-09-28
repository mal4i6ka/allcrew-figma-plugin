/**
 * Shared delivery — POSTs the generated package to a user-configured receiver endpoint.
 * Ported from allcrew-channel code.js:1092-1109 + allcrew-channel-django delivery.
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
        'X-AllCrew-Channel-Secret': config.secret,
        'X-AllCrew-Channel-Target': config.target,
        'X-AllCrew-Channel-Route-Repo': config.route.repo,
        'X-AllCrew-Channel-Route-Branch': config.route.branch,
        'X-AllCrew-Channel-Route-Path': config.route.path,
        'X-AllCrew-Channel-Route-Package': config.route.package,
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

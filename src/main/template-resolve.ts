import { getTemplate, logoAssetPath, packVideoPath } from './templates-store'
import { validateJobConfig } from './validation'
import { captionPresetIds, safeZoneMargin, type BrandTemplate } from '../shared/templates'
import type { ClipJobRequest } from '../shared/jobs'
import type { ClipJobConfig } from './pipeline-runner'

/**
 * Snapshot a pack into a job request: formats, caption preset and overlays are
 * materialized here, so a queued job carries its brand even if the pack is
 * edited or deleted afterwards. `templateId` stays as provenance only.
 * Faza C: manual edits win. The wizard applies a pack's fields to the draft
 * when the pack is selected, so any field the request already carries is the
 * user's choice (template-derived or hand-edited); the pack only fills fields
 * the request leaves unset.
 */
export function materializeTemplate(template: BrandTemplate, request: ClipJobRequest): ClipJobRequest {
  if (!(captionPresetIds as readonly string[]).includes(template.captionPresetId)) {
    // Save validates this, so an unknown preset means a bug, not user input.
    throw new Error(`Unknown caption preset in brand template: ${template.captionPresetId}`)
  }
  const given = request as Partial<ClipJobRequest>
  const [primary, ...rest] = template.formats
  const next: ClipJobRequest = { ...request, templateId: template.id }
  if (given.captionPreset === undefined) next.captionPreset = template.captionPresetId
  if (template.captionStyle && given.captionStyle === undefined) next.captionStyle = template.captionStyle
  if (given.aspectRatio === undefined && !given.aspectRatios?.length) {
    next.aspectRatio = primary
    next.aspectRatios = [primary, ...rest]
  } else if (given.aspectRatio === undefined && given.aspectRatios?.length) {
    next.aspectRatio = given.aspectRatios[0]
  }
  if (template.logo && given.logo === undefined) {
    // The watermark materializes only when main owns a logo asset for the pack.
    const path = logoAssetPath(template.id)
    if (path) {
      const margin = safeZoneMargin(template, template.logo.position)
      next.logo = { path, position: template.logo.position, scale: template.logo.scale, opacity: template.logo.opacity, ...(margin !== undefined ? { margin } : {}) }
    }
  }
  if (template.badge && given.ctaBadges === undefined) {
    const margin = safeZoneMargin(template, template.badge.position)
    next.ctaBadges = [{ kind: template.badge.kind, position: template.badge.position, ...(margin !== undefined ? { margin } : {}) }]
  }
  // The pack's intro/outro videos materialize only when main owns the uploaded
  // file; a display name without an asset appends nothing.
  if (template.intro && given.intro === undefined) {
    const path = packVideoPath(template.id, 'intro')
    if (path) next.intro = { path }
  }
  if (template.outro && given.outro === undefined) {
    const path = packVideoPath(template.id, 'outro')
    if (path) next.outro = { path }
  }
  if (template.includeTitle !== undefined && given.includeTitle === undefined) next.includeTitle = template.includeTitle
  if (template.pacing && given.pacing === undefined) next.pacing = template.pacing
  if (template.layoutStyle && given.layoutStyle === undefined) next.layoutStyle = template.layoutStyle
  // The wizard always sends the banner pair (null when untouched) and offers no banner editor,
  // so a null — like an absent — value means "unset" here; a real choice from any path wins.
  if (template.banner && given.bannerPlatform == null && given.bannerChannelUrl == null) {
    next.bannerPlatform = template.banner.platform
    next.bannerChannelUrl = template.banner.channelUrl
  }
  // Correction runs last: even the pack's own layoutStyle must fit its allowedFraming.
  if (template.allowedFraming?.length && !template.allowedFraming.includes(next.layoutStyle)) next.layoutStyle = template.allowedFraming[0]
  return next
}

/** Job-creation hook: replace a request's templateId with the pack's snapshot, then revalidate. */
export function applyTemplateSnapshot(config: ClipJobConfig): ClipJobConfig {
  if (config.templateId === undefined) return config
  const template = getTemplate(config.templateId)
  if (!template) throw new Error('Brand template not found. Choose another template, or save this pack again.')
  return validateJobConfig(materializeTemplate(template, config))
}

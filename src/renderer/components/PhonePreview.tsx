/** Phone-view emulation of the Output monitor: an iPhone-style shell plus a
 * semi-transparent social app skin, so the user sees the clip exactly as the
 * platform's interface frames it. Layouts mirror real 2026 phone screenshots
 * of TikTok / Reels / Shorts; blocked-area numbers follow the public safe-zone guides. */
import { Bookmark, Camera, Ellipsis, Heart, MessageCircle, Music2, Play, Plus, Repeat, Search, Share2, ThumbsUp, UserRound } from 'lucide-react'
import { cn } from '../lib/utils'
import type { OverlayPosition } from '../../shared/clip-editor'

export type PhoneSkin = 'tiktok' | 'reels' | 'shorts'
export const phoneSkins: { value: PhoneSkin; label: string }[] = [
  { value: 'tiktok', label: 'TikTok' }, { value: 'reels', label: 'Reels' }, { value: 'shorts', label: 'Shorts' }]

interface Zone { top: number; right: number; bottom: number }
const zones: Record<PhoneSkin, Zone> = {
  tiktok: { top: .10, right: .16, bottom: .18 },
  reels: { top: .12, right: .14, bottom: .20 },
  shorts: { top: .10, right: .15, bottom: .22 }
}

export interface PhoneRect { x: number; y: number; w: number; h: number }

/** Normalized footprint of a corner/center-anchored overlay (x/y/w/h as fractions of the frame). */
export function overlayRect(position: OverlayPosition, w: number, h: number): PhoneRect {
  const m = .03
  const x = position === 'top-left' || position === 'bottom-left' ? m : position === 'top-right' || position === 'bottom-right' ? 1 - m - w : (1 - w) / 2
  const y = position === 'top-left' || position === 'top-right' ? m : position === 'bottom-left' || position === 'bottom-right' ? 1 - m - h : (1 - h) / 2
  return { x, y, w, h }
}

// Warn when the platform chrome would cover a fifth or more of the element.
export function phoneSafeZoneWarnings(skin: PhoneSkin, items: { label: string; rect: PhoneRect }[]): string[] {
  const zone = zones[skin]
  const blocks: PhoneRect[] = [
    { x: 0, y: 0, w: 1, h: zone.top },
    { x: 1 - zone.right, y: 0, w: zone.right, h: 1 },
    { x: 0, y: 1 - zone.bottom, w: 1, h: zone.bottom }]
  const label = phoneSkins.find((s) => s.value === skin)?.label ?? skin
  return items.filter((item) => {
    const covered = blocks.reduce((sum, b) => sum + Math.max(0, Math.min(item.rect.x + item.rect.w, b.x + b.w) - Math.max(item.rect.x, b.x))
      * Math.max(0, Math.min(item.rect.y + item.rect.h, b.y + b.h) - Math.max(item.rect.y, b.y)), 0)
    return covered > .2 * item.rect.w * item.rect.h
  }).map((item) => `${item.label} is covered by ${label}'s interface. Move it out of the blocked area before baking.`)
}

// Per-platform right rail, top bar and footer as the real apps draw them.
const rails: Record<PhoneSkin, { icon: typeof Heart; count: string }[]> = {
  tiktok: [{ icon: Heart, count: '24.1K' }, { icon: MessageCircle, count: '382' }, { icon: Bookmark, count: '1.2K' }, { icon: Share2, count: '596' }],
  reels: [{ icon: ThumbsUp, count: '21.6K' }, { icon: MessageCircle, count: '475' }, { icon: Share2, count: '1.7K' }, { icon: Bookmark, count: '2.7K' }, { icon: Ellipsis, count: '' }],
  shorts: [{ icon: Heart, count: '1.9K' }, { icon: MessageCircle, count: '74' }, { icon: Bookmark, count: '512' }, { icon: Share2, count: '203' }, { icon: Repeat, count: 'Remix' }]
}

export function PhoneAppSkin({ skin, title }: { skin: PhoneSkin; title: string }) {
  const description = title || 'Your clip title appears here'
  return <div className={cn('phone-skin', `phone-skin-${skin}`)} aria-hidden="true">
    <div className="phone-statusbar"><span>9:41</span><span className="phone-status-icons">5G ▮▮</span></div>
    {skin === 'tiktok' && <div className="phone-tabs"><span>Following</span><span className="phone-tab-active">For You</span></div>}
    {skin === 'reels' && <div className="phone-topline"><span className="phone-brand">Reels</span><span className="phone-top-icons"><Search size={13} /><Camera size={13} /></span></div>}
    {skin === 'shorts' && <div className="phone-topline phone-topline-end"><span className="phone-top-icons"><Search size={13} /><Ellipsis size={13} /></span></div>}
    <div className="phone-side">
      {skin === 'tiktok' && <div className="phone-avatar"><UserRound size={14} /><span className="phone-avatar-plus"><Plus size={8} /></span></div>}
      {rails[skin].map((a) => <div key={a.count || 'more'} className="phone-action"><a.icon size={16} />{a.count && <span>{a.count}</span>}</div>)}
      {skin === 'tiktok' && <div className="phone-disc"><Music2 size={10} /></div>}
      {skin === 'shorts' && <div className="phone-avatar phone-avatar-square"><UserRound size={12} /></div>}
    </div>
    <div className="phone-caption">
      {skin === 'reels'
        ? <div className="phone-handle-row"><span className="phone-avatar phone-avatar-inline"><UserRound size={11} /></span><strong>your.handle</strong><span className="phone-follow">Follow</span></div>
        : <strong>@your.handle</strong>}
      <p className="phone-description">{description}</p>
      {skin === 'shorts'
        ? <p className="phone-pill"><Play size={9} /> {description.split(' ').slice(0, 5).join(' ')}…</p>
        : <p className="phone-sound">♪ original sound{skin === 'reels' ? ' · trending audio' : ''}</p>}
    </div>
    <div className="phone-progress" />
  </div>
}

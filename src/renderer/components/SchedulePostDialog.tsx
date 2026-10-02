import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, ExternalLink, Loader2, Lock, Plus, Search, Upload, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import { cn, errorMessage, localFileUrl } from '../lib/utils'
import { parseJobOutput, type ClipArtifact } from '../../shared/job-output'
import { formatClipDuration } from '../../shared/zernio-posts'
import { usePostableAccounts, ensureAccountsLoaded } from '../store/use-accounts-store'
import { accountHandle, type PostableClip } from './PostDialog'
import { PlatformIcon } from './PlatformIcon'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { TextArea, TextInput, WELL } from './ui/Field'
import type { ZernioAccount } from '../../shared/zernio'

/** What the calendar's Schedule Post dialog collects before the full post dialog takes over. */
export interface ScheduleDraft {
  clip: PostableClip
  description: string
  accountIds: string[]
  /** The slot the "+" was clicked on, as a datetime-local value; null when none was picked. */
  scheduleValue: string | null
}

interface LibraryChoice {
  outputDir: string
  runTitle: string
  clip: ClipArtifact
}

interface ClipOption {
  key: string
  title: string
  runTitle: string
  durationMs: number
  library: LibraryChoice
}

/** One Library run (source video) shown in the picker's first stage. */
interface ProjectOption {
  outputDir: string
  title: string
  /** Source length in ms; null when the history entry didn't record it. */
  durationMs: number | null
  /** File of the run's first clip, used for the row's thumbnail. */
  thumbPath: string | null
  clips: ClipOption[]
}

/** Reading every run folder on open would stall on large libraries; the newest runs cover most picks. */
const MAX_RUNS_SCANNED = 30
/** The upload zone's advertised cap, matching the mock. Zernio itself takes more; platforms may take less. */
const UPLOAD_MAX_BYTES = 250 * 1024 * 1024

function slotToInput(slot: { key: string; hour: number }): string {
  return `${slot.key}T${String(slot.hour).padStart(2, '0')}:00`
}

function fileNameOf(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? path
  return last.replace(/\.[^.]+$/, '')
}

/** What Zernio actually takes; authorizeMedia is broader (images included) so the dialog must gate. */
const UPLOAD_EXTENSIONS = /\.(mp4|mov|m4v|webm)$/i

/** What the calendar's pencil opens the same dialog with: a scheduled post, its video locked. */
export interface ScheduledPostEdit {
  postId: string
  clipTitle: string
  /** Local video file for the locked card's thumbnail; null when BridgeClip has no record of it. */
  clipPath: string | null
  caption: string
  accountIds: string[]
}

/**
 * The calendar's "Schedule Post" dialog: pick a clip (from the Library or a
 * file on disk), give it a title and description, choose the accounts, then
 * continue in the regular post dialog with everything prefilled. With
 * `editing` it becomes the scheduled post's editor instead: same form, the
 * video locked, and Next saving through Zernio directly.
 */
export function SchedulePostDialog({ slot, editing, onClose, onConnect, onNext, onSaved }: {
  slot: { key: string; hour: number } | null
  editing?: ScheduledPostEdit
  onClose: () => void
  /** Closes this dialog and opens the Accounts page to connect another platform. */
  onConnect: () => void
  onNext?: (draft: ScheduleDraft) => void
  /** Called after an edited scheduled post was saved. */
  onSaved?: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<'clips' | 'upload'>('clips')
  const [projects, setProjects] = useState<ProjectOption[] | null>(null)
  const [optionsError, setOptionsError] = useState<string | null>(null)
  /** The project whose clips the picker is showing; null shows the project list. */
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [choice, setChoice] = useState<ClipOption | { title: string; path: string; durationMs: number } | null>(null)
  const [probing, setProbing] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [clipOpen, setClipOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState(editing ? editing.clipTitle : '')
  const [description, setDescription] = useState(editing?.caption ?? '')
  const [accountIds, setAccountIds] = useState<string[]>(editing ? [...editing.accountIds] : [])
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [runTitle, setRunTitle] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const accounts = usePostableAccounts()
  const clipFieldRef = useRef<HTMLDivElement>(null)
  const accountsFieldRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void ensureAccountsLoaded()
  }, [])

  // Ids carried over from the post may name an account that is gone or offline;
  // drop them once the real list arrives, keeping the rest of the prefill.
  const prefilled = useRef(false)
  useEffect(() => {
    if (!editing || prefilled.current || accounts.length === 0) return
    prefilled.current = true
    setAccountIds((current) => current.filter((id) => accounts.some((account) => account.id === id)))
  }, [accounts, editing])

  // The locked clip card's "From {source}" subtitle, from the run that made it.
  const editingClipPath = editing?.clipPath ?? null
  useEffect(() => {
    if (!editingClipPath) return
    let active = true
    void getApi().history.list()
      .then((entries) => {
        const dir = editingClipPath.split(/[\\/]/).slice(0, -1).join('/')
        const run = entries.find((entry) => dir.startsWith(entry.outputDir))
        if (active && run) setRunTitle(run.videoTitle)
      })
      .catch(() => { /* the card simply stays without the subtitle */ })
    return () => { active = false }
  }, [editingClipPath])

  useEffect(() => {
    if (editing) return
    let active = true
    void (async () => {
      try {
        const entries = (await getApi().history.list())
          .filter((entry) => entry.status === 'completed')
          .slice(0, MAX_RUNS_SCANNED)
        const runs = await Promise.all(entries.map(async (entry): Promise<ProjectOption | null> => {
          const raw = await getApi().history.getJob(entry.outputDir).catch(() => null)
          const output = raw ? parseJobOutput(raw) : null
          if (!output || output.clips.length === 0) return null
          const clips = output.clips.map((clip) => ({
            key: `${entry.outputDir}:${clip.clip_index}`,
            title: clip.summary || `Clip ${clip.clip_index + 1}`,
            runTitle: entry.videoTitle,
            durationMs: clip.duration_ms,
            library: { outputDir: entry.outputDir, runTitle: entry.videoTitle, clip },
          } satisfies ClipOption))
          return {
            outputDir: entry.outputDir,
            title: entry.videoTitle,
            durationMs: entry.durationMs ?? null,
            thumbPath: clipFilePath(output.clips[0].s3_url),
            clips,
          } satisfies ProjectOption
        }))
        if (active) setProjects(runs.filter((run): run is ProjectOption => run !== null))
      } catch (err) {
        if (active) setOptionsError(errorMessage(err, 'Could not read your library.'))
      }
    })()
    return () => { active = false }
  }, [editing])

  // A click outside an open dropdown closes it without also toggling it back open.
  useEffect(() => {
    if (!clipOpen && !accountsOpen) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (clipOpen && !clipFieldRef.current?.contains(target)) setClipOpen(false)
      if (accountsOpen && !accountsFieldRef.current?.contains(target)) setAccountsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [clipOpen, accountsOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (clipOpen || accountsOpen) {
        setClipOpen(false)
        setAccountsOpen(false)
      } else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipOpen, accountsOpen, onClose])

  const search = query.trim().toLowerCase()
  const filteredProjects = useMemo(() => (projects ?? []).filter((project) =>
    !search || project.title.toLowerCase().includes(search)), [projects, search])
  const openProject = useMemo(() => (projects ?? []).find((project) => project.outputDir === openRun) ?? null, [projects, openRun])

  // The grids hide past slots; if the slot aged out meanwhile, fall through to the
  // next step's own default rather than a pre-filled time that cannot validate.
  const scheduled = useMemo(() => {
    if (!slot) return null
    const value = slotToInput(slot)
    return new Date(value).getTime() > Date.now() + 5 * 60_000 ? value : null
  }, [slot])

  /** Takes a path the main process already authorized (picker or drop) and makes it the upload choice. */
  const useUploadedVideo = async (path: string): Promise<void> => {
    setProbing(true)
    setUploadError(null)
    // The old upload is being replaced whichever way this one goes; keeping it
    // visible next to an error would be a trap.
    setChoice((current) => (current && !('library' in current) ? null : current))
    if (!UPLOAD_EXTENSIONS.test(path)) {
      setUploadError('That is not a supported video file. Use MP4, MOV, M4V or WebM.')
      setProbing(false)
      return
    }
    try {
      const media = await getApi().zernio.posts.probe(path, null)
      if (media.sizeBytes > UPLOAD_MAX_BYTES) {
        setUploadError('That file is larger than 250 MB. Pick a lighter clip or render a shorter one.')
        return
      }
      const name = fileNameOf(path)
      setChoice({ title: name, path, durationMs: media.durationMs ?? 0 })
      setTitle((current) => current || name)
    } catch (err) {
      setUploadError(errorMessage(err, 'Could not read that video.'))
    } finally {
      setProbing(false)
    }
  }

  const pickUpload = async (): Promise<void> => {
    const path = await getApi().dialog.selectVideo()
    if (path) await useUploadedVideo(path)
  }

  const dropUpload = async (event: React.DragEvent): Promise<void> => {
    const file = event.dataTransfer.files[0]
    if (!file) return
    const path = await getApi().dialog.authorizeDrop(file)
    if (!path) {
      setUploadError('That is not a supported video file.')
      return
    }
    await useUploadedVideo(path)
  }

  const toggleAccount = (id: string): void => {
    setAccountIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }

  // A choice made on one tab must not be posted while the other tab is shown.
  const switchTab = (id: 'clips' | 'upload'): void => {
    setTab(id)
    setChoice((current) => !current ? null : ('library' in current) === (id === 'clips') ? current : null)
  }

  const ready = accountIds.length > 0 && !probing && !saving && (editing !== undefined || choice !== null)

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    setSaving(true)
    setSaveError(null)
    try {
      await getApi().zernio.posts.edit(editing.postId, {
        title: title.trim(),
        content: description.trim(),
        targets: accountIds.flatMap((id) => {
          const account = accounts.find((a) => a.id === id)
          return account ? [{ platform: account.platform, accountId: id }] : []
        }),
      })
      onSaved?.()
    } catch (err) {
      setSaveError(errorMessage(err, 'Could not update the post.'))
      setSaving(false)
    }
  }

  const next = (): void => {
    if (editing) {
      if (ready) void saveEdit()
      return
    }
    if (!choice || !ready) return
    const clip: PostableClip = 'library' in choice
      ? {
        path: clipFilePath(choice.library.clip.s3_url),
        title: title.trim() || choice.title,
        tags: choice.library.clip.tags,
        durationMs: choice.durationMs,
        library: { outputDir: choice.library.outputDir, clipIndex: choice.library.clip.clip_index },
      }
      : { path: choice.path, title: title.trim() || choice.title, tags: [], durationMs: choice.durationMs }
    onNext?.({ clip, description: description.trim(), accountIds, scheduleValue: scheduled })
  }

  return (
    <Dialog onBackdropMouseDown={onClose} panelClassName="mx-auto max-w-[680px]" aria-label="Schedule Post">
      <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
        <h2 className="text-[15px] font-semibold text-ink">Schedule Post</h2>
        <Button size="sm" variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X className="h-4 w-4" />} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {!editing && (<>
        <div className="grid grid-cols-2 gap-1 rounded-full bg-black/25 p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.35),inset_0_0_0_1px_rgb(255_255_255/0.07)]">
          {([['clips', 'Pick from my clips'], ['upload', 'Upload new']] as const).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={tab === id} onClick={() => switchTab(id)}
              className={cn('flex h-9 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-[background,color,box-shadow] duration-200',
                tab === id
                  ? 'bg-white/[0.12] text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.2),inset_0_0_0_1px_rgb(255_255_255/0.1),0_2px_8px_-2px_rgb(0_0_0/0.5)]'
                  : 'text-ink-muted hover:text-ink')}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'clips' ? (
          <div ref={clipFieldRef} className="relative mt-4">
            <button type="button" onClick={() => { if (!clipOpen) { setOpenRun(null); setQuery('') } setClipOpen((open) => !open) }}
              className={cn('flex h-12 w-full items-center gap-3 rounded-2xl px-4 text-left', WELL)}>
              <Search aria-hidden className="h-4 w-4 shrink-0 text-ink-subtle" />
              <span className={cn('min-w-0 flex-1 truncate text-sm', choice ? 'text-ink' : 'text-ink-faint')}>
                {choice ? choice.title : 'Pick a clip from your projects'}
              </span>
              {choice && <span className="shrink-0 font-mono text-2xs tabular text-ink-subtle">{formatClipDuration(choice.durationMs / 1000)}</span>}
              <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-ink-subtle transition-transform duration-150', clipOpen && 'rotate-180')} />
            </button>

            {clipOpen && (
              <div className={cn('absolute inset-x-0 top-[calc(100%+6px)] z-20 rounded-2xl p-2', 'glass-thick')}>
                {openProject === null ? (
                  <>
                    <p className="px-1.5 pb-1.5 pt-0.5 text-[13px] font-medium text-ink">Pick a project</p>
                    <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects"
                      inputSize="sm" leading={<Search aria-hidden className="h-3.5 w-3.5" />} />
                    <div className="mt-1 max-h-72 overflow-y-auto">
                      {projects === null && !optionsError && <p role="status" className="px-2 py-3 text-xs text-ink-subtle">Loading your projects…</p>}
                      {optionsError && <p role="alert" className="px-2 py-3 text-xs text-danger">{optionsError}</p>}
                      {projects !== null && filteredProjects.length === 0 && (
                        <p className="px-2 py-3 text-xs text-ink-subtle">{projects.length === 0 ? 'No clips in your library yet. Render one first, or upload a video.' : 'No project matches that search.'}</p>
                      )}
                      {filteredProjects.map((project) => (
                        <button key={project.outputDir} type="button"
                          onClick={() => { setOpenRun(project.outputDir); setQuery('') }}
                          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06]">
                          <ClipThumb path={project.thumbPath} durationMs={project.durationMs} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-ink">{project.title}</span>
                            <span className="mt-1 inline-block rounded-md bg-accent/20 px-1.5 py-px text-[10px] font-semibold text-accent">{project.clips.length} Clips</span>
                          </span>
                          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => { setOpenRun(null); setQuery('') }}
                      className="flex w-full items-center gap-2 px-1.5 pb-1.5 pt-0.5 text-left hover:text-ink-muted">
                      <ChevronLeft aria-hidden className="h-4 w-4 shrink-0 text-ink-subtle" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-ink">{openProject.title}</span>
                        <span className="block truncate text-2xs text-ink-subtle">Pick a clip to schedule</span>
                      </span>
                    </button>
                    <div className="mt-1 max-h-72 overflow-y-auto">
                      {openProject.clips.length === 0 && <p className="px-2 py-3 text-xs text-ink-subtle">This project has no clips.</p>}
                      {openProject.clips.map((option) => (
                        <button key={option.key} type="button"
                          onClick={() => {
                            const previous = choice && 'library' in choice ? choice.title : null
                            setChoice(option)
                            // Fill an empty or auto-filled Title, but never overwrite what the user typed.
                            setTitle((current) => !current || current === previous ? option.title : current)
                            setClipOpen(false)
                          }}
                          className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06]',
                            choice && 'library' in choice && choice.key === option.key && 'bg-white/[0.06]')}>
                          <ClipThumb path={clipFilePath(option.library.clip.s3_url)} durationMs={option.durationMs} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-ink">{option.title}</span>
                            <span className="mt-1 inline-block rounded-md bg-success/15 px-1.5 py-px text-[10px] font-semibold text-success">Completed</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <div role="button" tabIndex={0} aria-label="Click to upload or drag and drop a video"
              onClick={() => void pickUpload()}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void pickUpload() } }}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); void dropUpload(event) }}
              className={cn('flex min-h-[132px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed px-4 py-6 text-center transition-colors duration-150',
                dragging ? 'border-accent/70 bg-black/30' : 'border-white/[0.16] hover:border-white/[0.28] hover:bg-black/20',
                probing && 'pointer-events-none opacity-60')}>
              {probing
                ? <Loader2 aria-hidden className="h-5 w-5 animate-spin text-ink-subtle" />
                : <Upload aria-hidden className="h-5 w-5 text-ink-subtle" />}
              {choice && !('library' in choice) ? (
                <>
                  <p className="max-w-full truncate text-sm font-medium text-ink">{choice.title}</p>
                  <p className="font-mono text-2xs tabular text-ink-subtle">{formatClipDuration(choice.durationMs / 1000)} · click or drop a file to replace it</p>
                </>
              ) : (
                <>
                  <p className="text-sm"><span className="font-medium text-ink">Click to upload</span><span className="text-ink-muted"> or drag and drop</span></p>
                  <p className="text-xs text-ink-subtle">Max. File Size: 250MB</p>
                </>
              )}
            </div>
            {uploadError && <p role="alert" className="mt-1.5 text-xs text-danger">{uploadError}</p>}
          </div>
        )}
        </>)}
        {editing && (
          <div className="mt-4">
            <div className={cn('flex items-center gap-3 rounded-2xl px-3 py-2.5', WELL)}>
              {editing.clipPath ? <ClipThumb path={editing.clipPath} durationMs={null} /> : (
                <span aria-hidden className="glass-tile flex h-[42px] w-[62px] shrink-0 items-center justify-center rounded-lg text-ink-subtle">
                  <Clapperboard className="h-3.5 w-3.5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{editing.clipTitle}</span>
                {runTitle && <span className="mt-0.5 block truncate text-xs text-ink-subtle">From {runTitle}</span>}
              </span>
              {editing.clipPath && (
                <button type="button" aria-label="Show the video file" title="Show the video file"
                  onClick={() => { void getApi().shell.showItemInFolder(editing.clipPath!) }}
                  className="shrink-0 text-ink-subtle hover:text-ink">
                  <ExternalLink aria-hidden className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-subtle">
              <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
              The video can't be changed on a scheduled post.
            </p>
          </div>
        )}

        <div className="mt-4 space-y-1.5">
          <label htmlFor="schedule-post-title" className="text-sm font-medium text-ink">Title</label>
          <TextInput id="schedule-post-title" value={title} onChange={(event) => setTitle(event.target.value)}
            placeholder="Enter title" className="rounded-2xl" inputSize="lg" />
        </div>

        <div className="mt-4 space-y-1.5">
          <label htmlFor="schedule-post-description" className="text-sm font-medium text-ink">Description</label>
          <TextArea id="schedule-post-description" value={description} onChange={(event) => setDescription(event.target.value)}
            placeholder="Description goes here..." rows={5} className="min-h-[120px] rounded-2xl" />
        </div>

        <div ref={accountsFieldRef} className="relative mt-4 space-y-1.5">
          <span className="text-sm font-medium text-ink">Publish on</span>
          <div className={cn('flex min-h-12 items-center gap-2 rounded-2xl px-3 py-2', WELL)}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {accountIds.length === 0 && <span className="truncate text-sm text-ink-faint">Choose the accounts to post to</span>}
              {accounts.filter((account) => accountIds.includes(account.id)).map((account) => (
                <span key={account.id} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white/[0.07] pl-1 pr-1 text-[13px] text-ink">
                  <PlatformIcon platform={account.platform} className="h-5 w-5 rounded-full [&_svg]:h-2.5 [&_svg]:w-2.5" />
                  <span className="max-w-[160px] truncate uppercase">{accountHandle(account).replace('@', '')}</span>
                  <button type="button" aria-label={`Remove ${accountHandle(account)}`} onClick={() => toggleAccount(account.id)}
                    className="text-ink-subtle hover:text-ink">
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
            {accountIds.length > 0 && (
              <Button size="sm" variant="ghost" iconOnly aria-label="Clear accounts" onClick={() => setAccountIds([])} icon={<X className="h-3.5 w-3.5" />} />
            )}
            <button type="button" aria-label="Choose accounts" aria-expanded={accountsOpen} onClick={() => setAccountsOpen((open) => !open)}
              className="shrink-0 text-ink-subtle hover:text-ink">
              <ChevronDown aria-hidden className={cn('h-4 w-4 transition-transform duration-150', accountsOpen && 'rotate-180')} />
            </button>
          </div>

          {accountsOpen && (
            <div className="glass-thick absolute left-0 top-[calc(100%+6px)] z-20 max-h-64 w-[280px] overflow-y-auto rounded-2xl p-1.5">
              <button type="button" onClick={onConnect}
                className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-[13px] text-ink-muted hover:bg-white/[0.06] hover:text-ink">
                <Plus aria-hidden className="h-3.5 w-3.5 shrink-0" />
                Connect Socials
              </button>
              <div aria-hidden className="my-1 border-t border-white/[0.07]" />
              {accounts.length === 0 && <p className="px-2 py-3 text-xs text-ink-subtle">No postable accounts yet. Connect one first.</p>}
              {accounts.map((account) => (
                <AccountOption key={account.id} account={account} checked={accountIds.includes(account.id)} onToggle={() => toggleAccount(account.id)} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          {editing ? (
            saveError
              ? <p role="alert" className="text-xs text-danger">{saveError}</p>
              : <p className="text-2xs text-ink-subtle">The video stays as it is; only the text and the accounts change.</p>
          ) : (
            <p className="text-2xs text-ink-subtle">
              {scheduled ? `Scheduled for ${scheduled.replace('T', ' at ')} — adjust it in the next step.` : 'The next step confirms accounts, options and time.'}
            </p>
          )}
          <Button variant="primary" disabled={!ready} onClick={next}
            trailingIcon={saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}>
            Next
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Picker row thumbnail: a frame of the video with its length badge. */
function ClipThumb({ path, durationMs }: { path: string | null; durationMs: number | null }): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    if (!path) return
    let active = true
    void loadThumbnail(path).then((result) => { if (active) setThumb(result) })
    return () => { active = false }
  }, [path])
  return (
    <span className="relative shrink-0">
      {thumb ? (
        <img src={localFileUrl(thumb)} alt="" draggable={false} className="h-[42px] w-[62px] rounded-lg object-cover ring-1 ring-white/[0.12]" />
      ) : (
        <span aria-hidden className="glass-tile flex h-[42px] w-[62px] items-center justify-center rounded-lg text-ink-subtle">
          <Clapperboard className="h-3.5 w-3.5" />
        </span>
      )}
      {durationMs != null && (
        <span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 font-mono text-[9px] tabular text-ink">
          {formatClipDuration(durationMs / 1000)}
        </span>
      )}
    </span>
  )
}

function AccountOption({ account, checked, onToggle }: {
  account: ZernioAccount
  checked: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button type="button" role="checkbox" aria-checked={checked} onClick={onToggle}
      className={cn('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06]')}>
      <PlatformIcon platform={account.platform} className="h-6 w-6 rounded-full [&_svg]:h-3 [&_svg]:w-3" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{accountHandle(account).replace(/^@/, '')}</span>
      {checked && <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
    </button>
  )
}

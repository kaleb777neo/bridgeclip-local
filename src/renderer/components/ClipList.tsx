import { SavedStageTimings } from './StageBreakdown'
import { parseJobOutput } from '../../shared/job-output'
import { editorImportStatus, editorNeedsMaterial, editorProgress, EDITOR_NEEDS_MATERIAL, EDITOR_NEEDS_SOURCE, type EditorOperation, type EditorProgress } from '../../shared/clip-editor'
import { ClipEditor } from './ClipEditor'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CalendarClock,  ArrowLeft, Check, ChevronDown, Clapperboard, Download, FileCode, FolderOpen, ListPlus, Plus, Scissors, Search, Send, Trash2, Youtube } from 'lucide-react'
import { basename, cn, errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath } from '../lib/thumbnails'
import type { ApiCosts, ClipArtifact, JobOutput } from '../store/use-job-store'
import type { EditorCandidate } from '../../shared/clip-editor'
import { ClipCard } from './ClipCard'
import { EditInspector } from './EditInspector'
import { EditorialWeights } from './EditorialWeights'
import { defaultWeights, editorialScore } from '../../shared/editorial'
import { youtubeSourceUrl } from '../../shared/video-source'
import { RunStats } from './RunStats'
import { AddToAutomationDialog } from './AddToAutomationDialog'
import { PostDialog, formatScheduled, type PostableClip } from './PostDialog'
import { BulkScheduleDialog } from './BulkScheduleDialog'
import { Page } from './ui/Page'
import { PageHeader } from './ui/PageHeader'
import { Button } from './ui/Button'
import { ProgressBar } from './ui/ProgressBar'
import { ConfirmDialog, type ConfirmRequest } from './ui/ConfirmDialog'
import { TextInput } from './ui/Field'
import { Checkbox } from './ui/Checkbox'
import { BulkDownloadDialog } from './BulkDownloadDialog'
import { EmptyState } from './ui/EmptyState'
import { Callout } from './ui/Callout'
import { Segmented } from './ui/Segmented'
import { usePostsStore } from '../store/use-posts-store'
import { useSettingsStore } from '../store/use-settings-store'
import type { LibraryClipPostingStatus } from '../../shared/library-posting'
import type { Page as AppPage } from './Sidebar'

type Sort = 'score' | 'timeline' | 'editorial'

interface ClipListProps {
  output: JobOutput
  /** The directory containing job_output.json, available for Library runs without clips. */
  outputDir?: string
  /** Exact clip linked from an automation bank; independent of editable titles. */
  initialClipIndex?: number
  /** Shown above the title, e.g. a back link from the Library. */
  leading?: ReactNode
  onNewClip?: () => void
  /** Lets the post dialog send the user to Accounts to connect a platform. */
  onNavigate?: (page: AppPage) => void
}

/** Clips the post dialog handles in one go; each is still its own upload and post. */
const MAX_POST_BATCH = 10
const MAX_BANK_BATCH = 30

function toPostable(clip: ClipArtifact): PostableClip {
  return { path: clipFilePath(clip.s3_url), title: clip.summary || `Clip ${clip.clip_index + 1}`, tags: clip.tags, durationMs: clip.duration_ms }
}

export function ClipList(props: ClipListProps): React.JSX.Element {
  return <ClipRun key={`${props.outputDir ?? ''}:${props.output.job_id}`} {...props} />
}

function ClipRun(props: ClipListProps): React.JSX.Element {
  const [imported, setImported] = useState(false)
  const hasEditor = (props.output.editor_project === true || imported) && !!props.outputDir
  // An automatic run has finished clips but no editor project yet; it can be imported by re-attaching its source.
  const importable = !!props.outputDir && !hasEditor && props.output.clips.length > 0
  const [editing, setEditing] = useState(false)
  const [opening, setOpening] = useState(hasEditor)
  const [importing, setImporting] = useState(false)
  /** Live download/preview progress for the import waiting screen. */
  const [importProgress, setImportProgress] = useState<EditorProgress | null>(null)
  /** The reel whose original video is missing: the import stopped and asked instead of downloading. */
  const [needsMaterial, setNeedsMaterial] = useState<number | null>(null)
  /** An editor operation main is running on this run (scan, preview rebuild, import from elsewhere). */
  const [operation, setOperation] = useState<EditorOperation | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  /** clip index → editor candidate that baked it, so each reel can open its own edit. */
  const [clipCandidates, setClipCandidates] = useState<Map<number, string>>(new Map())
  const [focusCandidate, setFocusCandidate] = useState<string | null>(null)
  const [output, setOutput] = useState(props.output)
  useEffect(() => {
    // Review runs land here on mount; freshly imported runs are populated by runImport instead.
    if (!hasEditor || imported || !props.outputDir) return
    let active = true
    void getApi().editor.open(props.outputDir).then((session) => {
      if (!active) return
      const { remaining } = editorProgress(session.project.candidates)
      setRemaining(remaining)
      setOperation(session.operation ?? null)
      setClipCandidates(candidateIdsByClip(session.project.candidates))
      setEditing(props.initialClipIndex === undefined && props.output.clips.length === 0 && remaining > 0)
    }).catch((cause) => {
      if (active) setEditorError(errorMessage(cause, 'Could not read editor progress. Open the editor to retry.'))
    }).finally(() => { if (active) setOpening(false) })
    return () => { active = false }
  // Choose the landing view once per run, without interrupting active edits.
  }, [hasEditor, imported, props.outputDir])
  // The import's worker state lives in main before editor-project.json exists.
  useEffect(() => {
    if (!importing || !props.outputDir) return
    let pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void getApi().editor.operationProgress(props.outputDir!).then((state) => {
        if (state.progress) setImportProgress(state.progress)
      }).catch(() => {}).finally(() => { pending = false })
    }, 1000)
    return () => { window.clearInterval(timer) }
  }, [importing, props.outputDir])
  // Re-attach the run's source, then open the editor focused on the clicked clip.
  const runImport = async (clipIndex: number, choice: { download?: boolean; file?: string } = {}): Promise<void> => {
    if (!props.outputDir || importing) return
    const run = props.outputDir
    setImporting(true)
    setImportProgress(null)
    setEditorError(null)
    setNeedsMaterial(null)
    try {
      let session
      if (choice.file) {
        session = await getApi().editor.createProject(run, choice.file, clipIndex)
      } else {
        try {
          // The focused clip index makes the engine preview only that reel's window first.
          // Without his yes, the engine reads the Library and never the network.
          session = await getApi().editor.createProject(run, undefined, clipIndex, choice.download === true)
        } catch (cause) {
          const message = errorMessage(cause, '')
          if (message === EDITOR_NEEDS_MATERIAL) { setNeedsMaterial(clipIndex); return }
          // No downloadable URL, or the download he allowed failed: fall back to the picker.
          if (message !== EDITOR_NEEDS_SOURCE) throw cause
          const picked = await getApi().dialog.selectVideo()
          if (!picked) return
          session = await getApi().editor.createProject(run, picked, clipIndex)
        }
      }
      setClipCandidates(candidateIdsByClip(session.project.candidates))
      setRemaining(editorProgress(session.project.candidates).remaining)
      setOperation(session.operation ?? null)
      setImported(true)
      setFocusCandidate(`candidate-${clipIndex + 1}`)
      setEditing(true)
    } catch (cause) {
      setEditorError(errorMessage(cause, 'Could not prepare the editable copy. Try again.'))
    } finally {
      setImporting(false)
    }
  }
  if (opening || importing) {
    const status = importing ? editorImportStatus(importProgress) : null
    return <Page width="wide">{props.leading}
      <div className="mt-4 max-w-md space-y-3">
        <p className="text-sm text-ink-muted" role="status">{status ? status.label : 'Opening clips…'}</p>
        {status && status.percent !== null && <ProgressBar value={status.percent} />}
        {importing && props.outputDir && <div>
          <Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(props.outputDir!) }}>Cancel</Button>
        </div>}
      </div>
    </Page>
  }
  // The original video is nowhere on this PC: ask, and only then move bytes.
  if (needsMaterial !== null) {
    const clipIndex = needsMaterial
    return <Page width="wide">{props.leading}
      <div className="mt-4 max-w-lg space-y-3">
        <h2 className="text-base font-semibold text-ink">The original video is not in your Library</h2>
        <p className="text-sm text-ink-muted">{editorNeedsMaterial(output.source_video_title, output.source_video_duration_seconds)}</p>
        <p className="text-xs text-ink-muted">Whichever you pick stays in this run, so the next "Edit this" of this video opens from disk with no download.</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" onClick={() => { void runImport(clipIndex, { download: true }) }}>
            <Download size={14} className="mr-1.5" /> Download it again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {
            void (async () => {
              const picked = await getApi().dialog.selectVideo()
              if (picked) await runImport(clipIndex, { file: picked })
            })()
          }}>Choose a video file</Button>
          <Button size="sm" variant="ghost" onClick={() => setNeedsMaterial(null)}>Cancel</Button>
        </div>
      </div>
    </Page>
  }
  if (editing && props.outputDir) return <ClipEditor outputDir={props.outputDir} focusCandidateId={focusCandidate} leading={props.leading} onExports={async () => {
    const [raw, session] = await Promise.all([getApi().history.getJob(props.outputDir!), getApi().editor.open(props.outputDir!)])
    const fresh = parseJobOutput(raw)
    if (!fresh) throw new Error('Could not load the exported clips. Reopen this Library item to retry.')
    setOutput(fresh); setRemaining(editorProgress(session.project.candidates).remaining)
    setClipCandidates(candidateIdsByClip(session.project.candidates))
    setOperation(session.operation ?? null)
    setEditorError(null); setFocusCandidate(null); setEditing(false)
  }} />
  const editable = hasEditor ? clipCandidates : new Map(output.clips.map((clip) => [clip.clip_index, `candidate-${clip.clip_index + 1}`]))
  const firstClip = output.clips[0]?.clip_index ?? 0
  return <GeneratedClipList {...props} output={output} onOutputChanged={(fresh) => {
    setOutput(fresh)
    if (hasEditor) void getApi().editor.open(props.outputDir!).then((session) => {
      setRemaining(editorProgress(session.project.candidates).remaining)
      setClipCandidates(candidateIdsByClip(session.project.candidates))
    }).catch((cause) => setEditorError(errorMessage(cause)))
  }} editor={hasEditor || importable ? { remaining: hasEditor ? remaining : null, error: editorError, editable,
    busy: importing || operation !== null,
    onOpen: () => { if (hasEditor) { setFocusCandidate(null); setEditing(true) } else void runImport(firstClip) },
    // Every reel is editable: a fresh import focuses it positionally when no candidate exported it (yet).
    onEditClip: (clipIndex) => { if (hasEditor) { setFocusCandidate(clipCandidates.get(clipIndex) ?? `candidate-${clipIndex + 1}`); setEditing(true) } else void runImport(clipIndex) } } : undefined} />
}

/** Map each baked clip index to the candidate that produced it (first wins). */
export function candidateIdsByClip(candidates: EditorCandidate[]): Map<number, string> {
  const map = new Map<number, string>()
  for (const candidate of candidates) for (const index of candidate.exports) if (!map.has(index)) map.set(index, candidate.id)
  return map
}

function GeneratedClipList({ output, outputDir: runDirectory, leading, onNewClip, onNavigate, initialClipIndex, editor, onOutputChanged }: ClipListProps & {
  editor?: { remaining: number | null; error: string | null; editable: Map<number, string>; busy: boolean; onOpen: () => void; onEditClip: (clipIndex: number) => void }
  onOutputChanged: (output: JobOutput) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [focusedClip, setFocusedClip] = useState(initialClipIndex)
  const search = query.trim().toLowerCase()
  const filtering = focusedClip !== undefined || search.length > 0
  const sourceUrl = youtubeSourceUrl(output.source_video_url)
  const postRecords = usePostsStore((state) => state.posts)
  const refreshError = usePostsStore((state) => state.error)
  const configured = useSettingsStore((state) => state.zernioConfigured)
  const [postingStatus, setPostingStatus] = useState<LibraryClipPostingStatus[] | null>(null)
  const [postingError, setPostingError] = useState<string | null>(null)
  const [postedExpanded, setPostedExpanded] = useState(false)
  const [unpostedExpanded, setUnpostedExpanded] = useState(true)
  const [statusRetry, setStatusRetry] = useState(0)
  const [sort, setSort] = useState<Sort>('score')
  const [weights, setWeights] = useState({ ...defaultWeights })
  const hasEditorial = output.clips.some((c) => c.editorial?.status === 'success')
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [downloadTargets, setDownloadTargets] = useState<ClipArtifact[] | null>(null)
  const [xmlExporting, setXmlExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const deletingRef = useRef(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const closeConfirm = useCallback(() => setConfirm(null), [])
  const [posting, setPosting] = useState<PostableClip[] | null>(null)
  const [bulkSchedule, setBulkSchedule] = useState<PostableClip[] | null>(null)
  const [bulkStarts, setBulkStarts] = useState<string[] | null>(null)
  const [bankClips, setBankClips] = useState<number[] | null>(null)
  const [addedToBank, setAddedToBank] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exportingRef = useRef(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Older BridgeClip engine runs do not record output format; use the first thumbnail for those.
  const [aspect, setAspect] = useState<number | null>(null)
  const settings = output.metrics?.requested_settings
  const requestedAspect = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).aspect_ratio : null
  const videoSpeed = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).video_speed : null
  const vertical = requestedAspect === '9:16' ? true : requestedAspect === '16:9' ? false : aspect == null ? true : aspect < 1

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setSelection(new Set())
    setInspectEdits(false)
    setAspect(null)
    setPosting(null)
    setBankClips(null)
    setAddedToBank(false)
    setExportError(null)
    setNotice(null)
  }, [output])

  const [inspectEdits, setInspectEdits] = useState(false)
  const firstClip = output.clips[0]
  const outputDir = runDirectory ?? (firstClip ? clipFilePath(firstClip.s3_url).replace(/[\\/][^\\/]+$/, '') : '')

  const asPostable = (clip: ClipArtifact): PostableClip => ({ ...toPostable(clip), library: { outputDir, clipIndex: clip.clip_index } })

  useEffect(() => {
    if (!configured) return
    void usePostsStore.getState().refresh()
    const timer = window.setInterval(() => { void usePostsStore.getState().refresh() }, 30000)
    return () => window.clearInterval(timer)
  }, [configured])

  useEffect(() => {
    let active = true
    setPostingError(null)
    if (!outputDir) { setPostingStatus(null); return }
    void getApi().history.postingStatus(outputDir).then((statuses) => { if (active) setPostingStatus(statuses) })
      .catch((cause) => { if (active) { setPostingStatus(null); setPostingError(errorMessage(cause, 'Could not read posting history.')) } })
    return () => { active = false }
  }, [outputDir, postRecords, statusRetry])

  useEffect(() => { setPostingStatus(null); setPostedExpanded(false); setUnpostedExpanded(true) }, [outputDir])

  const topIndex = useMemo(() => {
    let best: ClipArtifact | null = null
    for (const clip of output.clips) if (!best || clip.virality_score > best.virality_score) best = clip
    return best?.clip_index ?? null
  }, [output.clips])

  const clips = useMemo(() => {
    const list = output.clips.filter((clip) => {
      if (focusedClip !== undefined && clip.clip_index !== focusedClip) return false
      return !search || [clip.summary, `Clip ${clip.clip_index + 1}`, ...(clip.tags ?? [])].join(' ').toLowerCase().includes(search)
    })
    if (sort === 'editorial') return list.sort((a, b) => (editorialScore(b.editorial, weights) ?? -1) - (editorialScore(a.editorial, weights) ?? -1))
    return sort === 'score'
      ? list.sort((a, b) => b.virality_score - a.virality_score)
      : list.sort((a, b) => a.start_time_ms - b.start_time_ms)
  }, [output.clips, sort, weights, focusedClip, search])

  const statusByClip = new Map(postingStatus?.map((status) => [status.clipIndex, status]))
  const unposted = clips.filter((clip) => statusByClip.get(clip.clip_index)?.state !== 'posted')
  const posted = clips.filter((clip) => statusByClip.get(clip.clip_index)?.state === 'posted')
  const visibleClips = filtering ? clips : [...(unpostedExpanded ? unposted : []), ...(postedExpanded ? posted : [])]
  const visibleIds = visibleClips.map((clip) => clip.clip_index).join(',')
  const visible = new Set(visibleIds ? visibleIds.split(',').map(Number) : [])
  // Prune the selection during render, not from an effect: for the frame between a
  // filter change and that effect the toolbar still counted - and posted, banked,
  // downloaded and deleted - clips that were no longer on screen.
  const selected = new Set([...selection].filter((index) => visible.has(index)))
  if (selected.size !== selection.size) setSelection(selected)
  const allSelected = visibleClips.length > 0 && visibleClips.every((clip) => selected.has(clip.clip_index))

  const toggle = (index: number): void => {
    if (deletingRef.current) return
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const deleteSelected = async (indices: number[]): Promise<void> => {
    if (deletingRef.current || exportingRef.current) return
    deletingRef.current = true; setDeleting(true); setDeleteError(null)
    try {
      if (typeof getApi().history.deleteClips !== 'function') throw new Error('Restart BridgeClip to enable deleting selected clips.')
      const fresh = await getApi().history.deleteClips(outputDir, indices)
      onOutputChanged(fresh)
      setSelection(new Set()); setStatusRetry((value) => value + 1)
    } catch (cause) {
      // A cleanup failure can happen after the manifest was committed. Refresh
      // from disk so removed clips are never left available for posting/export.
      try {
        const fresh = parseJobOutput(await getApi().history.getJob(outputDir))
        if (fresh && JSON.stringify(fresh.clips) !== JSON.stringify(output.clips)) onOutputChanged(fresh)
      } catch { /* Keep the original deletion error visible. */ }
      setDeleteError(errorMessage(cause, 'Could not delete the selected clips. Please try again.'))
    } finally { deletingRef.current = false; setDeleting(false) }
  }
  const duplicateSelected = async (indices: number[]): Promise<void> => {
    if (deletingRef.current || exportingRef.current) return
    try {
      if (typeof getApi().history.duplicateClips !== 'function') throw new Error('Restart BridgeClip to enable duplicating clips.')
      const fresh = await getApi().history.duplicateClips(outputDir, indices)
      onOutputChanged(fresh)
      setStatusRetry((value) => value + 1)
      setNotice(`Clip duplicated — a safe, independent copy is ready at the end of the run.`)
    } catch (cause) {
      setDeleteError(errorMessage(cause, 'Could not duplicate the clip. Please try again.'))
    }
  }
  const confirmDelete = (indices: number[]): void => {
    const targets = output.clips.filter((clip) => indices.includes(clip.clip_index))
    const picked = targets.map((clip) => clip.clip_index)
    if (!picked.length || deletingRef.current || exportingRef.current) return
    setConfirm({
      title: `Delete ${picked.length === 1 ? 'this clip' : `these ${picked.length} clips`}?`,
      body: <>Permanently delete {picked.length === 1 ? `“${targets[0].summary || `Clip ${targets[0].clip_index + 1}`}” and its local video file` : `the ${picked.length} selected clips and their local video files`}? This cannot be undone. Your source video, transcript and editor edits will be kept. Published posts and copies in automation banks or other folders will remain.</>,
      confirmLabel: picked.length === 1 ? 'Delete clip' : 'Delete clips',
      onConfirm: () => { void deleteSelected(picked) }
    })
  }

  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3500)
  }

  const exportXml = async (): Promise<void> => {
    if (!outputDir || xmlExporting || exportingRef.current || deletingRef.current) return
    setXmlExporting(true)
    setExportError(null)
    try {
      const picked = clips.filter((c) => selected.has(c.clip_index)).map((c) => c.clip_index)
      const result = await getApi().clips.exportFcpXml(outputDir, picked.length ? picked : null)
      if (result.canceled) return
      if (result.success) {
        showNotice(`Exported ${result.clipCount} clip${result.clipCount === 1 ? '' : 's'} as ${result.fileName}` +
          `${result.srtCount ? ` with ${result.srtCount} caption file${result.srtCount === 1 ? '' : 's'}` : ''}` +
          `${result.failedCount ? `; ${result.failedCount} could not be read` : ''}`)
      } else if (result.failedCount) {
        setExportError('No clips could be exported to XML.')
      }
    } catch (err) {
      setExportError(errorMessage(err, 'Could not export XML. Please try again.'))
    } finally {
      setXmlExporting(false)
    }
  }

  const costs = readCosts(output.metrics?.api_costs)
  const framingNotice = framingProblem(output, vertical)
  const analysisNotice = sourceAnalysisNotice(output)

  const renderGrid = (items: ClipArtifact[]): React.JSX.Element => (
        <div
          className={cn(
            'mt-4 grid gap-5',
            vertical
              ? 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'
              : 'grid-cols-[repeat(auto-fill,minmax(280px,1fr))]'
          )}
        >
          {items.map((clip) => (
            <ClipCard
              key={clip.clip_index}
              clip={clip}
              postingStatus={statusByClip.get(clip.clip_index)}
              vertical={vertical}
              topPick={clip.clip_index === topIndex && clips.length > 1}
              selected={selected.has(clip.clip_index)}
              selecting={selected.size > 0}
              onToggleSelect={() => toggle(clip.clip_index)}
              onAspect={aspect == null ? setAspect : undefined}
              onPost={() => setPosting([asPostable(clip)])}
              onEdit={editor ? () => editor.onEditClip(clip.clip_index) : undefined}
              editDisabled={editor?.busy}
              onAddToAutomation={outputDir ? () => setBankClips([clip.clip_index]) : undefined}
              onDelete={outputDir ? () => confirmDelete([clip.clip_index]) : undefined}
              onDuplicate={outputDir ? () => { void duplicateSelected([clip.clip_index]) } : undefined}
              actionsDisabled={deleting || exporting}
              onSetPosted={outputDir ? async (posted) => {
                if (!getApi().history.setPosted) throw new Error('Restart BridgeClip to enable manual posted marks.')
                await getApi().history.setPosted(outputDir, clip.clip_index, posted)
                setStatusRetry((value) => value + 1)
                if (posted) setPostedExpanded(true)
                else setUnpostedExpanded(true)
              } : undefined}
            />
          ))}
        </div>
  )

  return (
    <Page width="wide">
      <PageHeader
        leading={leading}
        eyebrow={leading ? undefined : 'Your clips'}
        title={output.source_video_title || 'Untitled video'}
        description={editor?.remaining ? `${editor.remaining} clip${editor.remaining === 1 ? '' : 's'} left to finish` : undefined}
        actions={
          <>
            {editor && <Button disabled={deleting || editor.busy} title={editor.busy ? 'Another editor operation is running for this video. Wait for it to finish.' : undefined} variant={editor.remaining ? 'primary' : 'ghost'} icon={<Scissors className="h-4 w-4" />} onClick={editor.onOpen}>
              {editor.remaining ? 'Continue editing' : 'Open editor'}
            </Button>}
            {outputDir && <Button onClick={() => setInspectEdits(true)}>Inspect transcript & edits</Button>}
            {sourceUrl && <Button iconOnly icon={<Youtube className="h-4 w-4" />} aria-label="Open original video on YouTube" title="Open original video on YouTube"
              onClick={() => { setExportError(null); void getApi().shell.openPath(sourceUrl).catch(() => setExportError('Could not open the original video in your browser.')) }} />}
            {outputDir && (
              <Button icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => getApi().shell.openPath(outputDir)}>
                Open folder
              </Button>
            )}
            {outputDir && output.clips.length > 0 && (
              <Button icon={<FileCode className="h-3.5 w-3.5" />} loading={xmlExporting} disabled={deleting || exporting}
                title="Export an FCPXML timeline for Premiere Pro or DaVinci Resolve" onClick={() => { void exportXml() }}>
                Export XML
              </Button>
            )}
            {onNewClip && (
              <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={onNewClip}>
                New clip
              </Button>
            )}
          </>
        }
      />

      {editor?.error && <Callout tone="warning" className="mt-3">{editor.error}</Callout>}

      {typeof videoSpeed === 'number' && videoSpeed > 1 && (
        <p className="mt-3 text-xs text-ink-muted">All clips exported at {videoSpeed}× speed · Original voice pitch</p>
      )}

      {(deleteError || exportError) && (
        <Callout tone="danger" className="mt-3" onDismiss={() => { setExportError(null); setDeleteError(null) }}>
          {deleteError || exportError}
        </Callout>
      )}

      <div className="mt-4">
        <RunStats key={output.job_id} output={output} costs={costs} videoSpeed={typeof videoSpeed === 'number' && videoSpeed > 1 ? videoSpeed : null} />
      </div>

      <SavedStageTimings stages={output.metrics?.pipeline_stages} diagnostics={output.metrics?.diagnostics} />
      {framingNotice && (
        <Callout tone="warning" className="mt-3">
          <span className="text-ink-muted">{framingNotice}</span>
        </Callout>
      )}

      {analysisNotice && (
        <Callout tone="warning" className="mt-3">
          <span className="text-ink-muted">{analysisNotice}</span>
        </Callout>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <TextInput className="w-full max-w-sm" aria-label="Search clips" placeholder="Search clips by title, tag or number"
          value={query} onChange={(event) => { setQuery(event.target.value); setFocusedClip(undefined) }}
          leading={<Search className="h-3.5 w-3.5" />} />
        {focusedClip !== undefined && <span className="text-sm text-ink-muted">From content bank · Clip {focusedClip + 1}</span>}
        {filtering && <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setFocusedClip(undefined) }}>Show all clips</Button>}
      </div>

      {/* Floating glass toolbar; sticks just below the 40px title-bar strip. */}
      <div className="glass-thick sticky top-0 z-20 mt-4 flex items-center justify-between gap-3 rounded-2xl py-1.5 pl-3 pr-1.5">
        <div className="flex min-w-0 items-center gap-3">
          <Checkbox
            disabled={deleting}
            checked={allSelected}
            indeterminate={selected.size > 0 && !allSelected}
            onChange={() => setSelection(allSelected ? new Set() : new Set(visibleClips.map((c) => c.clip_index)))}
            label="Select all clips"
          />
          <span className="whitespace-nowrap text-sm text-ink-muted">
            {selected.size > 0 ? (
              <>
                <span className="font-medium text-ink">{selected.size}</span> selected
              </>
            ) : (
              filtering ? `${clips.length} of ${output.clips.length} clips` : `${clips.length} clips`
            )}
          </span>
          {notice && (
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-full bg-success/[0.1] px-2.5 py-1 text-xs text-success shadow-[inset_0_0_0_1px_rgb(var(--success)/0.25)] animate-fade-in">
              <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />
              <span className="truncate">{notice}</span>
              {addedToBank && onNavigate && <button className="shrink-0 font-semibold underline underline-offset-2" onClick={() => onNavigate('automations')}>View bank</button>}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.size > 0 && (
            <div className="flex items-center gap-1.5 animate-fade-in">
              <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setSelection(new Set())}>
                Clear
              </Button>
              <Button
                size="sm"
                icon={<Send className="h-3.5 w-3.5" />}
                disabled={deleting || selected.size > MAX_POST_BATCH}
                title={selected.size > MAX_POST_BATCH ? `Post up to ${MAX_POST_BATCH} clips at a time` : undefined}
                onClick={() => setPosting(clips.filter((c) => selected.has(c.clip_index)).map(asPostable))}
              >
                Post {selected.size}
              </Button>
              <Button
                size="sm"
                icon={<CalendarClock className="h-3.5 w-3.5" />}
                disabled={deleting || selected.size < 2 || selected.size > MAX_POST_BATCH}
                title={selected.size < 2 ? 'Select at least 2 clips for batch scheduling' : selected.size > MAX_POST_BATCH ? `Schedule up to ${MAX_POST_BATCH} clips at a time` : 'Schedule the selected clips with a start time and spacing'}
                onClick={() => setBulkSchedule(clips.filter((c) => selected.has(c.clip_index)).map(asPostable))}
              >
                Schedule batch
              </Button>
              {outputDir && <Button
                size="sm"
                icon={<ListPlus className="h-3.5 w-3.5" />}
                disabled={deleting || selected.size > MAX_BANK_BATCH}
                title={selected.size > MAX_BANK_BATCH ? `Add up to ${MAX_BANK_BATCH} clips at a time` : 'Copy selected clips to an automation content bank'}
                onClick={() => setBankClips(clips.filter((clip) => selected.has(clip.clip_index)).map((clip) => clip.clip_index))}
              >
                Add {selected.size} to automation
              </Button>}
              <Button
                size="sm"
                variant="primary"
                loading={exporting}
                disabled={deleting}
                icon={<Download className="h-3.5 w-3.5" />}
                onClick={() => setDownloadTargets(clips.filter((clip) => selected.has(clip.clip_index)))}
              >
                Download {selected.size}
              </Button>
              {outputDir && <Button variant="danger" size="sm" iconOnly aria-label="Delete selected clips" title="Delete selected clips"
                icon={<Trash2 className="h-3.5 w-3.5" />} loading={deleting} disabled={exporting} onClick={() => confirmDelete(clips.filter((clip) => selected.has(clip.clip_index)).map((clip) => clip.clip_index))} />}
              <span aria-hidden className="mx-1 h-5 w-px bg-white/10" />
            </div>
          )}
          <Segmented<Sort>
            label="Sort clips"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'score', label: 'Best first' },
              ...(hasEditorial ? [{ value: 'editorial' as const, label: 'Editorial' }] : []),
              { value: 'timeline', label: 'Timeline' }
            ]}
          />
        </div>
      </div>

      {hasEditorial && <EditorialWeights value={weights} onChange={setWeights} />}
      {filtering ? (
        clips.length ? renderGrid(clips) : <EmptyState className="mt-4" icon={<Search />}
          title={focusedClip !== undefined ? 'This clip is no longer in this run' : 'No clips match your search'}
          description={focusedClip !== undefined ? 'Show all clips to browse the remaining exports.' : 'Try another title, tag or clip number.'} />
      ) : clips.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<Clapperboard />}
          title="No clips in this run"
          description={editor ? 'No saved exports remain. Open the editor to bake more clips.' : 'There are no saved clips in this run.'}
        />
      ) : (
        <>
          <div className="mt-4 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => { void usePostsStore.getState().refresh(true); setStatusRetry((value) => value + 1) }}>Refresh post status</Button>
          </div>
          {postingError && <Callout tone="warning" className="mt-3">{postingError} Clips are listed together below.</Callout>}
          {configured && refreshError && !postingError && <Callout tone="warning" className="mt-3">{refreshError} Showing saved posting status.</Callout>}
          {!postingStatus && !postingError && <p role="status" className="mt-2 text-xs text-ink-muted">Checking posting history…</p>}
          <ClipGroup title={postingStatus ? 'Not Posted' : 'Clips'} count={unposted.length} expanded={unpostedExpanded} onToggle={() => setUnpostedExpanded((value) => !value)}>
            {unposted.length ? renderGrid(unposted) : <p className="mt-3 text-sm text-ink-muted">All clips in this run have been posted.</p>}
          </ClipGroup>
          {postingStatus && <ClipGroup title="Posted" count={posted.length} expanded={postedExpanded} onToggle={() => setPostedExpanded((value) => !value)}>
            {posted.length ? renderGrid(posted) : <p className="mt-3 text-sm text-ink-muted">No clips in this run have been posted yet.</p>}
          </ClipGroup>}
        </>
      )}

      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
      {downloadTargets && <BulkDownloadDialog clips={downloadTargets} onClose={() => setDownloadTargets(null)} />}
      {bulkSchedule && <BulkScheduleDialog
        clips={bulkSchedule}
        timeZone={localTimeZone()}
        onCancel={() => setBulkSchedule(null)}
        onStart={(startISO: string, intervalMinutes: number, order: PostableClip[]) => {
          const start = Date.parse(startISO)
          const starts = order.map((_, i) => new Date(start + i * intervalMinutes * 60_000).toISOString())
          setBulkSchedule(null)
          setPosting(order)
          setBulkStarts(starts)
        }}
      />}
      {posting && <PostDialog clips={posting} onClose={() => { setPosting(null); setBulkStarts(null) }} onNavigate={onNavigate}
        initial={bulkStarts ? { bulkStarts } : undefined} />}
      {inspectEdits && <EditInspector outputDir={outputDir} onClose={() => setInspectEdits(false)} />}
      {bankClips && outputDir && <AddToAutomationDialog
        outputDir={outputDir}
        clipIndices={bankClips}
        onClose={() => setBankClips(null)}
        onAdded={(name) => {
          setBankClips(null)
          setSelection(new Set())
          setAddedToBank(true)
          setNotice(`Added ${bankClips.length} clip${bankClips.length === 1 ? '' : 's'} to ${name}.`)
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
          noticeTimer.current = setTimeout(() => setNotice(null), 6000)
        }}
      />}
    </Page>
  )
}

function ClipGroup({ title, count, expanded, onToggle, children }: { title: string; count: number; expanded: boolean; onToggle: () => void; children: ReactNode }): React.JSX.Element {
  const id = useId()
  return <section className="mt-4">
    <h2>
      <button type="button" id={`${id}-heading`} aria-expanded={expanded} aria-controls={`${id}-content`} onClick={onToggle}
        className="glass-well flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-base font-semibold text-ink transition-colors hover:bg-white/[0.06]">
        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', !expanded && '-rotate-90')} />
        <span>{title}</span><span className="ml-auto font-mono text-sm font-normal tabular text-ink-muted">{count}</span>
      </button>
    </h2>
    <div id={`${id}-content`} role="region" aria-labelledby={`${id}-heading`} hidden={!expanded}>{expanded && children}</div>
  </section>
}

/** Quiet link that returns from a run to the list it was opened from (ClipList's `leading`). */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="-ml-2 inline-flex h-6 items-center gap-1 rounded-full pl-1.5 pr-2.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-ink"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

/** Persisted runs may contain incomplete cost data; only display complete sections. */
function readCosts(value: unknown): ApiCosts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const amount = raw.total_estimated_cost_usd
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null
  const section = (name: string): Record<string, unknown> | null => {
    const part = raw[name]
    return part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null
  }
  const validMoney = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const result: ApiCosts = { total_estimated_cost_usd: amount, ...(raw.cost_incomplete === true ? { cost_incomplete: true } : {}) }
  const transcription = section('transcription')
  if (transcription && typeof transcription.provider === 'string' && typeof transcription.model === 'string' &&
      validMoney(transcription.audio_duration_seconds) && validMoney(transcription.estimated_cost_usd)) {
    result.transcription = transcription as unknown as NonNullable<ApiCosts['transcription']>
  }
  const planning = section('planning')
  if (planning && typeof planning.model === 'string' && validMoney(planning.total_tokens) &&
      validMoney(planning.attempts) && validMoney(planning.estimated_cost_usd)) {
    result.planning = planning as unknown as NonNullable<ApiCosts['planning']>
  }
  const layoutVision = section('layout_vision')
  if (layoutVision && typeof layoutVision.model === 'string' && validMoney(layoutVision.estimated_cost_usd)) {
    result.layout_vision = layoutVision as unknown as NonNullable<ApiCosts['layout_vision']>
  }
  for (const key of ['source_context', 'editorial', 'editorial_vision', 'editorial_repair'] as const) {
    const part = section(key)
    if (part && typeof part.provider === 'string' && typeof part.model === 'string' && validMoney(part.estimated_cost_usd)) {
      result[key] = { provider: part.provider, model: part.model, estimated_cost_usd: part.estimated_cost_usd }
    }
  }
  return result
}

/** Explain when a vertical clip kept its whole frame or fell back during rendering. */
export function framingProblem(output: JobOutput, vertical: boolean): string | null {
  if (!vertical || output.clips.length === 0) return null
  const requested = output.metrics?.requested_settings
  const requestedClassic = requested && typeof requested === 'object' && !Array.isArray(requested) &&
    (requested as Record<string, unknown>).layout_style !== 'auto'
  if (requestedClassic) return null
  if (output.metrics?.smart_framing_available === false) {
    return 'Smart framing was unavailable, so every clip used the classic whole-frame layout. OpenCV or the face model is missing from the engine; run Settings → System check.'
  }
  const fallbacks = output.clips.filter((clip) => clip.render_fallback).length
  const notices: string[] = []
  if (fallbacks > 0) {
    notices.push(`${fallbacks} of ${output.clips.length} clips couldn't render with smart framing and used the classic whole-frame layout instead. The log has the details.`)
  }
  const clipIndices = new Set(output.clips.map((clip) => clip.clip_index))
  const wholeFrame = new Set<number>()
  const layouts = output.metrics?.clip_layouts
  if (Array.isArray(layouts)) {
    for (const layout of layouts) {
      if (layout && typeof layout === 'object' && layout.framing_status === 'whole_frame_auto' &&
        Number.isSafeInteger(layout.clip_index) && clipIndices.has(layout.clip_index)) {
        wholeFrame.add(layout.clip_index)
      }
    }
  }
  if (wholeFrame.size > 0) {
    const sorted = [...wholeFrame].sort((a, b) => a - b)
    const shown = sorted.slice(0, 5).map((index) => index + 1).join(', ')
    const more = sorted.length > 5 ? ` and ${sorted.length - 5} more` : ''
    notices.push(`Smart framing kept the whole frame for clip${sorted.length === 1 ? '' : 's'} ${shown}${more}. Review the framing if you expected a closer crop.`)
  }
  return notices.join(' ') || null
}

export function sourceAnalysisNotice(output: JobOutput): string | null {
  if (output.metrics?.planning_source !== 'visual') return null
  if (output.metrics.transcription_status === 'no_speech') {
    return 'No speech was detected. Clips were selected from sampled video frames, and spoken-word captions are unavailable for this run.'
  }
  if (output.metrics.transcription_status === 'failed') {
    return 'Transcription failed. Clips were selected from sampled video frames, and spoken-word captions are unavailable for this run.'
  }
  return null
}

function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

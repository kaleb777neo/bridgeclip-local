import { useEffect, useRef, useState } from 'react'
import { Check, Download, FolderOpen, Loader2, RotateCw, X } from 'lucide-react'
import { cn, errorMessage, formatTimecode, localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import type { BulkExportProgress, ClipArtifact } from '../../shared/job-output'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'

type RowStatus = 'idle' | 'copying' | 'done' | 'failed'

interface DownloadRow {
  clip: ClipArtifact
  path: string
  name: string
  checked: boolean
  status: RowStatus
  percent: number
}

/**
 * Bulk download: pick the checked clips, choose a folder once, and watch each
 * row copy with live progress. Failed rows offer a one-click retry that
 * re-exports just the failed subset. Canceling the folder picker resets the
 * submitted rows to idle.
 */
export function BulkDownloadDialog({ clips, onClose }: {
  clips: ClipArtifact[]
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<DownloadRow[]>(() => clips.map((clip) => ({
    clip,
    path: clipFilePath(clip.s3_url),
    name: clip.summary || `Clip ${clip.clip_index + 1}`,
    checked: true,
    status: 'idle' as RowStatus,
    percent: 0
  })))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [destDir, setDestDir] = useState<string | null>(null)
  // Full-list row indices in the order they were submitted; main reports the
  // position inside that submission, which is a subset of the rows whenever
  // some are unchecked or a failed subset is retried.
  const sentIndicesRef = useRef<number[]>([])

  const checked = rows.filter((row) => row.checked)
  const done = rows.filter((row) => row.status === 'done').length
  const failed = rows.filter((row) => row.status === 'failed')
  const allChecked = checked.length === rows.length
  const busy = running

  useEffect(() => {
    const unsubscribe = getApi().clips.onBulkExportProgress((progress: BulkExportProgress) => {
      const rowIndex = sentIndicesRef.current[progress.index]
      if (rowIndex === undefined) return
      setRows((current) => current.map((row, index) => index === rowIndex
        ? { ...row, status: progress.status, percent: progress.status === 'done' ? 100 : progress.percent }
        : row))
    })
    return unsubscribe
  }, [])

  const toggle = (index: number): void => setRows((current) => current.map((row, i) => i === index ? { ...row, checked: !row.checked } : row))
  const toggleAll = (): void => setRows((current) => {
    const next = !allChecked
    return current.map((row) => ({ ...row, checked: next }))
  })

  const start = async (subset?: DownloadRow[]): Promise<void> => {
    const targets = (subset ?? checked).filter((row) => row.status !== 'done')
    if (!targets.length || busy) return
    const chosen = new Set(targets)
    const indices = rows.map((row, index) => chosen.has(row) ? index : -1).filter((index) => index >= 0)
    sentIndicesRef.current = indices
    setRunning(true)
    setError(null)
    setRows((current) => current.map((row, index) => indices.includes(index) ? { ...row, status: 'copying', percent: 0 } : row))
    try {
      const result = await getApi().clips.bulkExport(targets.map((row) => ({ path: row.path, name: row.name })))
      if (result.destDir) setDestDir(result.destDir)
      // No folder picked: nothing ran, put the rows back to idle.
      if (!result.destDir && !result.count && !result.failedCount) {
        setRows((current) => current.map((row, index) => indices.includes(index) && row.status === 'copying' ? { ...row, status: 'idle', percent: 0 } : row))
        return
      }
      if (result.failures?.length) setError(`${result.failures.length} clip${result.failures.length === 1 ? '' : 's'} could not be copied.`)
    } catch (err) {
      setError(errorMessage(err, 'Could not export clips. Please try again.'))
      setRows((current) => current.map((row) => row.status === 'copying' ? { ...row, status: 'failed', percent: 0 } : row))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Bulk download"
      onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="glass-thick flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <p className="text-sm font-semibold text-ink">
            {running || done > 0 ? `Download (${done}/${rows.length})` : `Download ${rows.length} clip${rows.length === 1 ? '' : 's'}`}
          </p>
          <Button size="sm" variant="ghost" iconOnly icon={<X className="h-3.5 w-3.5" />} aria-label="Close bulk download" disabled={busy} onClick={onClose} />
        </div>

        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
          <Checkbox label="Select all" checked={allChecked} indeterminate={!allChecked && checked.length > 0} disabled={busy} onChange={toggleAll} />
          <span className="text-2xs text-ink-subtle">{checked.length} of {rows.length} selected</span>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
          {rows.map((row, index) => (
            <div key={`${row.clip.clip_index}-${index}`} className={cn('flex items-center gap-2.5 rounded-xl border border-white/[0.06] p-2', row.status === 'failed' && 'border-red-400/40')}>
              <Checkbox label={`Include ${row.name}`} checked={row.checked} disabled={busy || row.status === 'done'} onChange={() => toggle(index)} />
              <ThumbCell row={row} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink" title={row.name}>{row.name}</p>
                <p className="text-2xs text-ink-subtle">{formatTimecode(row.clip.duration_ms)}</p>
              </div>
              <StatusCell row={row} />
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t border-white/10 px-4 py-3">
          {error && <p className="text-2xs text-red-300" role="alert">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            {destDir && <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />}
              onClick={() => { void getApi().shell.showItemInFolder(destDir) }}>Show in folder</Button>}
            {failed.length > 0 && !running && <Button size="sm" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => { void start(failed) }}>
              Retry {failed.length} failed
            </Button>}
            <Button size="sm" variant="primary" icon={<Download className="h-3.5 w-3.5" />} loading={running}
              disabled={busy || !checked.length || checked.every((row) => row.status === 'done')}
              onClick={() => { void start() }}>
              {running ? 'Downloading…' : `Download ${checked.length}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Small cover frame, resolved lazily through the shared thumbnail queue. */
function ThumbCell({ row }: { row: DownloadRow }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void loadThumbnail(row.path, Math.min(row.clip.duration_ms / 2000, 3)).then((result) => { if (active) setSrc(result) })
    return () => { active = false }
  }, [row.path, row.clip.duration_ms])
  return (
    <span className="h-9 w-14 shrink-0 overflow-hidden rounded-md bg-black/40" aria-hidden="true">
      {src ? <img src={localFileUrl(src)} alt="" className="h-full w-full object-cover" /> : null}
    </span>
  )
}

function StatusCell({ row }: { row: DownloadRow }): React.JSX.Element | null {
  if (row.status === 'done') return <Check className="h-4 w-4 shrink-0 text-emerald-400" aria-label="Downloaded" />
  if (row.status === 'failed') return <span className="shrink-0 text-2xs text-red-300" role="status">Failed</span>
  if (row.status === 'copying' && row.percent > 0) return <span className="shrink-0 font-mono text-2xs text-ink-subtle" role="status">{row.percent}%</span>
  if (row.status === 'copying') return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-subtle" aria-label="Copying" />
  return null
}

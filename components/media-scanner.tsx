"use client"

import { useState, useRef, useEffect } from "react"
import {
  Camera,
  Upload,
  Play,
  RefreshCcw,
  ShieldCheck,
  ShieldAlert,
  Fingerprint,
  Zap,
  MessageSquare,
  AlertTriangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { apiService, type ScanResult } from "@/lib/api"
import { useAuth } from "@/contexts/auth-context"
import { initializeSocket, subscribeToScan, unsubscribeFromScan, getSocket, disconnectSocket } from "@/lib/socket"


export function MediaScanner({ onScanResult }: { onScanResult?: (result: ScanResult | null) => void }) {
  const { isAuthenticated, user, token } = useAuth()
  const [scanning, setScanning] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [scanProgress, setScanProgress] = useState(0)
  const [scanStage, setScanStage] = useState("")
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "complete" | "error">("idle")
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [currentScanId, setCurrentScanId] = useState<string | null>(null)
  const [mediaPreview, setMediaPreview] = useState<string | null>(null)
  const [mediaType, setMediaType] = useState<"image" | "video" | "audio" | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [batchResults, setBatchResults] = useState<Array<{ fileName: string; scanId?: string; status?: string; error?: string; mediaType?: string }>>([])
  const [batchId, setBatchId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const socketInitialized = useRef(false)

  // Initialize Socket.IO when authenticated
  useEffect(() => {
    if (isAuthenticated && user && token && !socketInitialized.current) {
      initializeSocket(token, user.id)
      socketInitialized.current = true
    }

    return () => {
      // Cleanup on unmount - but don't disconnect as other components may use it
      if (currentScanId) {
        unsubscribeFromScan(currentScanId)
      }
      if (mediaPreview) {
        URL.revokeObjectURL(mediaPreview)
      }
    }
  }, [isAuthenticated, user, token])

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (mediaPreview) {
        URL.revokeObjectURL(mediaPreview)
      }
    }
  }, [mediaPreview])

  const detectMediaType = (file: File): "image" | "video" | "audio" | null => {
    const mime = (file.type || "").toLowerCase()
    const ext = (file.name.substring(file.name.lastIndexOf('.')) || '').toLowerCase()

    if (
      mime.startsWith('image/') ||
      ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.heic', '.heif'].includes(ext)
    ) {
      return 'image'
    }
    if (
      mime.startsWith('video/') ||
      ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.3gp', '.flv', '.wmv'].includes(ext)
    ) {
      return 'video'
    }
    if (
      mime.startsWith('audio/') ||
      ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus'].includes(ext)
    ) {
      return 'audio'
    }
    return null
  }

  const processSelectedFiles = async (files: File[]) => {
    if (files.length === 0) return

    if (!isAuthenticated) {
      setError("Please log in to upload files")
      return
    }

    if (batchMode || files.length > 1) {
      // Batch upload mode
      setSelectedFiles(files)
      await handleBatchUpload(files)
    } else {
      // Single file upload mode
      const file = files[0]
      const previewUrl = URL.createObjectURL(file)
      setMediaPreview(previewUrl)
      setMediaType(detectMediaType(file))
      await uploadAndScan(file)
    }
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    await processSelectedFiles(files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (status === "idle") {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (status !== "idle") return

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) {
      await processSelectedFiles(files)
    }
  }

  const handleBatchUpload = async (files: File[]) => {
    try {
      setError(null)
      setStatus("uploading")
      setScanning(true)
      setUploadProgress(0)
      setBatchResults([])

      // Limit batch size
      if (files.length > 50) {
        throw new Error("Maximum 50 files allowed per batch")
      }

      // Upload batch
      const batchResponse = await apiService.batchUploadScan(files, (progress) => {
        setUploadProgress(progress)
      })

      if (!batchResponse.success) {
        throw new Error("Batch upload failed")
      }

      setBatchId(batchResponse.data.batchId)
      setStatus("processing")
      setUploadProgress(100)

      // Set batch results
      setBatchResults(batchResponse.data.scans || [])

      // Note: Individual scan progress will be updated via WebSocket
      // For now, we'll show batch status
      setTimeout(() => {
        setStatus("complete")
        setScanning(false)
      }, 1000)

    } catch (err) {
      console.error("Batch upload error:", err)
      setError(err instanceof Error ? err.message : "Batch upload failed")
      setStatus("error")
      setScanning(false)
      setUploadProgress(0)
    }
  }

  const uploadAndScan = async (file: File) => {
    try {
      setError(null)
      setStatus("uploading")
      setScanning(true)
      setUploadProgress(0)
      setScanProgress(0)
      setScanStage("Uploading")

      // Upload file
      const uploadResponse = await apiService.uploadScan(file, (progress) => {
        setUploadProgress(progress)
      })

      if (!uploadResponse.success) {
        throw new Error("Upload failed")
      }

      const scanId = uploadResponse.data.scanId
      setCurrentScanId(scanId)
      setStatus("processing")
      setUploadProgress(100)
      setScanProgress(10)
      setScanStage("Initializing")

      // Dual Hybrid Tracking: Real-time WebSocket + fast polling safety net
      await new Promise<void>((resolve, reject) => {
        let timeoutId: NodeJS.Timeout | null = null
        let pollInterval: NodeJS.Timeout | null = null
        let completed = false

        const finishWithResult = (finalResult: any) => {
          if (completed) return
          completed = true
          if (timeoutId) clearTimeout(timeoutId)
          if (pollInterval) clearInterval(pollInterval)
          unsubscribeFn()

          setScanProgress(100)
          setStatus("complete")
          setScanning(false)
          setResult(finalResult)
          if (onScanResult) {
            onScanResult(finalResult)
          }
          resolve()
        }

        const finishWithError = (errMessage: string) => {
          if (completed) return
          completed = true
          if (timeoutId) clearTimeout(timeoutId)
          if (pollInterval) clearInterval(pollInterval)
          unsubscribeFn()

          setStatus("error")
          setScanning(false)
          setError(errMessage)
          reject(new Error(errMessage))
        }

        const handleUpdate = (data: any) => {
          if (completed) return

          console.log('[MEDIA_SCANNER] Received scan update:', data)

          if (data.type === 'progress') {
            setScanProgress((prev) => Math.max(prev, data.progress || 50))
            if (data.stage) setScanStage(data.stage)
          } else if (data.type === 'complete') {
            apiService.getScan(scanId).then((response) => {
              if (response.success && response.data) {
                finishWithResult(response.data)
              }
            }).catch(() => {})
          } else if (data.type === 'failed') {
            finishWithError(data.error?.message || "Scan failed")
          }
        }

        // Subscribe to scan via WebSocket
        const unsubscribeFn = subscribeToScan(scanId, handleUpdate)

        // Immediate check & polling heartbeat:
        // Catches fast scans that completed before WebSocket subscription
        const checkStatus = async () => {
          if (completed) return
          try {
            const resp = await apiService.getScan(scanId)
            if (resp.success && resp.data) {
              if (resp.data.status === 'COMPLETED') {
                finishWithResult(resp.data)
              } else if (resp.data.status === 'FAILED') {
                finishWithError(resp.data.error || 'Scan processing failed')
              } else if (resp.data.status === 'PROCESSING') {
                setScanProgress((prev) => Math.max(prev, 50))
              }
            }
          } catch {
            // Ignore temporary network quirks during polling
          }
        }

        // Check immediately after subscribe (fast-path for images)
        checkStatus()

        // Heartbeat poll every 1.5 seconds in parallel with WebSocket
        pollInterval = setInterval(checkStatus, 1500)

        // Model warm-up and CPU inference can take several minutes on Render free tier.
        timeoutId = setTimeout(() => {
          finishWithError("Scan timeout - please refresh scan status")
        }, 12 * 60 * 1000)
      })
    } catch (err) {
      console.error("Scan error:", err)
      setError(err instanceof Error ? err.message : "Scan failed")
      setStatus("error")
      setScanning(false)
      setUploadProgress(0)
      setScanProgress(0)
      setScanStage("")
    }
  }

  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const reset = () => {
    setStatus("idle")
    setUploadProgress(0)
    setScanProgress(0)
    setScanStage("")
    setResult(null)
    setError(null)
    setCurrentScanId(null)
    setSelectedFiles([])
    setBatchResults([])
    setBatchId(null)
    if (mediaPreview) {
      URL.revokeObjectURL(mediaPreview)
      setMediaPreview(null)
    }
    setMediaType(null)
    if (onScanResult) {
      onScanResult(null)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const overallProgress = status === "uploading"
    ? uploadProgress * 0.3
    : status === "processing"
      ? 30 + (scanProgress * 0.7)
      : 0

  return (
    <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
      {/* Primary Scanner View */}
      <div className="xl:col-span-3 space-y-6">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={!mediaPreview && status === "idle" ? handleUploadClick : undefined}
          className={cn(
            "relative aspect-video bg-black border rounded-sm overflow-hidden group transition-all",
            isDragging
              ? "border-primary ring-2 ring-primary/50 bg-primary/10 cursor-copy"
              : !mediaPreview && status === "idle"
              ? "border-primary/20 hover:border-primary/50 cursor-pointer"
              : "border-primary/20"
          )}
        >
          {/* Corner Brackets */}
          <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-white/40 z-10" />
          <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-white/40 z-10" />
          <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-white/40 z-10" />
          <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-white/40 z-10" />

          {/* Drag Overlay Feedback */}
          {isDragging && (
            <div className="absolute inset-0 bg-primary/20 backdrop-blur-xs z-20 flex flex-col items-center justify-center pointer-events-none">
              <Upload className="w-12 h-12 text-primary animate-bounce mb-2" />
              <p className="font-mono text-xs uppercase tracking-widest text-primary font-bold">
                DROP_MEDIA_SIGNAL_TO_SCAN
              </p>
            </div>
          )}

          {/* Media Display */}
          {mediaPreview && mediaType === "image" && (
            <img
              src={mediaPreview}
              alt="Media preview"
              className="w-full h-full object-contain"
            />
          )}

          {mediaPreview && mediaType === "video" && (
            <video
              ref={videoRef}
              src={mediaPreview}
              className="w-full h-full object-contain"
              controls
              autoPlay
              loop
            />
          )}

          {mediaPreview && mediaType === "audio" && (
            <div className="w-full h-full flex items-center justify-center">
              <div className="text-center space-y-4">
                <Zap size={48} className="mx-auto text-primary/40" />
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">AUDIO_FILE_DETECTED</p>
                <audio src={mediaPreview} controls className="w-full max-w-md" />
              </div>
            </div>
          )}

          {/* Default State */}
          {!mediaPreview && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-3 text-muted-foreground group-hover:text-primary/70 transition-colors">
                <Camera size={48} className="opacity-20 group-hover:opacity-40 transition-opacity" />
                <p className="font-mono text-[10px] uppercase tracking-widest font-semibold">
                  {isDragging ? "DROP_MEDIA_SIGNAL_HERE" : "CLICK_OR_DRAG_MEDIA_TO_SCAN"}
                </p>
                <span className="text-[9px] font-mono text-muted-foreground/60 tracking-wider">
                  MP4 · MOV · WEBM · MKV · JPG · PNG · WEBP · HEIC · WAV · MP3 · M4A
                </span>
              </div>
            </div>
          )}

          {/* Overlay Effects */}
          {mediaPreview && status !== "idle" && (
            <>
              <div className="absolute inset-0 bg-primary/5 mix-blend-overlay pointer-events-none" />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.2)_100%)] pointer-events-none" />
            </>
          )}

          {/* HUD Overlay Components */}
          <div className="absolute top-4 left-4 space-y-2">
            <div className="bg-black/60 border border-primary/40 px-3 py-1 text-[10px] font-mono text-primary flex items-center gap-2 backdrop-blur-md">
              <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
              REC: LIVE_FEED_ALPHA
            </div>
            <div className="bg-black/60 border border-primary/20 px-3 py-1 text-[10px] font-mono text-muted-foreground">
              BITRATE: 14.2 MBPS
            </div>
          </div>

          <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="text-[10px] font-mono text-primary uppercase">Agent_Confidence</div>
                <div className="text-[10px] font-mono text-white">
                  {result ? `${result.confidence}%` : status !== "idle" ? `${Math.round(overallProgress)}%` : '0%'}
                </div>
              </div>
              <div className="w-48 h-1 bg-primary/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${result ? result.confidence : overallProgress}%` }}
                />
              </div>
            </div>

            {status !== "idle" && (
              <div className="flex flex-col items-end">
                <div className="text-[10px] font-mono text-muted-foreground mb-1">FPS: 60.02</div>
                <div className="text-[10px] font-mono text-muted-foreground uppercase">ISO: 800</div>
              </div>
            )}
          </div>
        </div>

        {/* Cognitive Assistance Panel */}
        {result && (
          <div className="bg-card/40 border border-primary/20 rounded-sm p-4 backdrop-blur-sm animate-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between mb-4 border-b border-primary/10 pb-2">
              <h3 className="text-xs font-bold text-primary flex items-center gap-2 uppercase tracking-widest">
                <MessageSquare size={14} />
                Cognitive_Analysis_Report
              </h3>
              <div className="text-[10px] font-mono text-muted-foreground">REF: VERITRACE_COGNITIVE_V2</div>
            </div>

            <div className="space-y-3">
              {result.explanations.map((text, i) => (
                <div key={i} className="flex gap-3 text-[11px] font-mono leading-relaxed p-2 bg-primary/5 rounded-sm">
                  <div className="text-primary font-bold">{i + 1}.</div>
                  <div className="text-foreground">{text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 text-destructive p-4 rounded-sm flex items-center gap-2">
            <AlertTriangle size={16} />
            <span className="text-[11px] font-mono uppercase">{error}</span>
          </div>
        )}

        {/* Controls */}
        <div className="space-y-4">
          <div className="flex gap-2 items-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBatchMode(!batchMode)}
              disabled={status !== "idle"}
              className={cn(
                "border-primary/20 text-primary text-[10px] font-bold h-8",
                batchMode && "bg-primary/20 border-primary/40"
              )}
            >
              {batchMode ? "BATCH MODE" : "SINGLE MODE"}
            </Button>
            {batchMode && (
              <span className="text-[10px] font-mono text-muted-foreground">
                Select multiple files (max 50)
              </span>
            )}
          </div>
          <div className="flex gap-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*,audio/*,image/*,.mp4,.mov,.avi,.webm,.mkv,.m4v,.3gp,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tiff,.heic,.heif,.wav,.mp3,.m4a,.aac,.flac,.ogg"
              onChange={handleFileSelect}
              className="hidden"
              disabled={status !== "idle"}
              multiple={batchMode}
            />
            <Button
              onClick={handleUploadClick}
              disabled={status !== "idle" || !isAuthenticated}
              className="flex-1 bg-primary text-primary-foreground font-black uppercase tracking-widest h-14 rounded-sm"
            >
              {status === "idle" ? (
                <>
                  <Upload className="mr-2" size={18} />
                  {batchMode ? "Upload & Scan Batch" : "Upload & Scan Media"}
                </>
              ) : status === "uploading" ? (
                <>
                  <Upload className="mr-2 animate-pulse" size={18} />
                  Uploading... {Math.round(uploadProgress)}%
                </>
              ) : status === "processing" ? (
                <>
                  <Play className="mr-2 animate-pulse" size={18} />
                  {batchMode ? `Processing ${batchResults.length} files...` : `${scanStage || "Processing"}... ${Math.round(scanProgress)}%`}
                </>
              ) : (
                <>
                  <Play className="mr-2" size={18} />
                  {batchMode ? "Batch Complete" : "Scan Complete"}
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={reset}
              disabled={status === "idle"}
              className="border-primary/20 hover:bg-primary/5 text-primary font-bold uppercase tracking-widest h-14 rounded-sm px-6 bg-transparent"
            >
              <RefreshCcw size={18} />
            </Button>
          </div>

          {/* Batch File List */}
          {batchMode && selectedFiles.length > 0 && (
            <div className="bg-card/30 border border-primary/10 rounded-sm p-4 backdrop-blur-sm max-h-40 overflow-y-auto">
              <div className="text-[10px] font-mono text-primary uppercase mb-2">SELECTED FILES ({selectedFiles.length})</div>
              <div className="space-y-1">
                {selectedFiles.map((file, index) => (
                  <div key={index} className="text-[10px] font-mono text-muted-foreground truncate">
                    {index + 1}. {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Batch Results */}
          {batchMode && batchResults.length > 0 && (
            <div className="bg-card/30 border border-primary/10 rounded-sm p-4 backdrop-blur-sm max-h-60 overflow-y-auto">
              <div className="text-[10px] font-mono text-primary uppercase mb-2">BATCH RESULTS ({batchResults.length})</div>
              <div className="space-y-2">
                {batchResults.map((result, index) => (
                  <div key={index} className={cn(
                    "text-[10px] font-mono p-2 rounded border",
                    result.scanId ? "border-success/20 bg-success/10 text-success" : "border-destructive/20 bg-destructive/10 text-destructive"
                  )}>
                    {result.fileName}: {result.scanId ? `Scan ID: ${result.scanId}` : `Error: ${result.error || 'Failed'}`}
                  </div>
                ))}
              </div>
              {batchId && (
                <div className="text-[9px] font-mono text-muted-foreground mt-2 pt-2 border-t border-primary/10">
                  Batch ID: {batchId}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Real-time Analysis Panel */}
      <div className="space-y-6">
        <div className="bg-card/30 border border-primary/10 rounded-sm p-4 backdrop-blur-sm h-full flex flex-col">
          <h2 className="text-xs font-bold text-primary mb-4 border-b border-primary/10 pb-2 uppercase tracking-tighter">
            Real_Time_Inference
          </h2>

          <div className="flex-1 space-y-6">
            {/* Verdict Display */}
            {result ? (
              <div
                className={cn(
                  "p-4 border rounded-sm text-center space-y-2 animate-in fade-in zoom-in duration-500",
                  result.verdict.includes("DEEPFAKE") || result.verdict.includes("SUSPICIOUS")
                    ? "bg-destructive/10 border-destructive/20 text-destructive"
                    : "bg-success/10 border-success/20 text-success",
                )}
              >
                <div className="mx-auto w-10 h-10 border border-current flex items-center justify-center rounded-sm rotate-45 mb-4">
                  {result.verdict.includes("DEEPFAKE") || result.verdict.includes("SUSPICIOUS") ? (
                    <ShieldAlert className="-rotate-45" />
                  ) : (
                    <ShieldCheck className="-rotate-45" />
                  )}
                </div>
                <div className="text-[10px] font-mono uppercase opacity-70 tracking-[0.2em]">Final Verdict</div>
                <div className="text-lg font-black tracking-tighter uppercase">{result.verdict}</div>
                <div className="text-[10px] font-mono">CONFIDENCE: {result.confidence}%</div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 py-12">
                <Fingerprint className="w-12 h-12 text-primary/10 animate-pulse" />
                <p className="text-[10px] font-mono text-muted-foreground uppercase leading-relaxed max-w-[150px]">
                  Awaiting analysis payload for agentic evaluation...
                </p>
              </div>
            )}

            {/* Analysis Metrics */}
            {status !== "idle" && result && (
              <div className="space-y-4">
                <AnalysisMetric label="FACIAL_BIOMETRICS" value={result.metadata?.facialMatch ?? 0} />
                {result.metadata?.audioMatch !== null && result.metadata?.audioMatch !== undefined && result.mediaType !== "IMAGE" && (
                  <AnalysisMetric label="AUDIO_PHONETIC_MATCH" value={result.metadata.audioMatch} />
                )}
                <AnalysisMetric label="GAN_FINGERPRINT" value={result.metadata?.ganFingerprint ?? 0} />
                {result.metadata?.temporalConsistency !== null && result.metadata?.temporalConsistency !== undefined && result.mediaType !== "IMAGE" && (
                  <AnalysisMetric label="TEMPORAL_CONSISTENCY" value={result.metadata.temporalConsistency} />
                )}
                {result.metadata?.peakRisk !== undefined && (
                  <AnalysisMetric label="PEAK_RISK_SEGMENT" value={result.metadata.peakRisk} />
                )}
                {result.metadata?.meanRisk !== undefined && (
                  <AnalysisMetric label="MEAN_RISK_LEVEL" value={result.metadata.meanRisk} />
                )}
              </div>
            )}
          </div>

          <div className="mt-6 pt-4 border-t border-primary/10">
            <div className="flex items-center gap-2 text-primary">
              <Zap size={14} className="animate-pulse" />
              <span className="text-[9px] font-mono uppercase font-bold">Edge_Inference_Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AnalysisMetric({ label, value }: { label: string; value: number }) {
  const clampedValue = Math.min(100, Math.max(0, value))
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[9px] font-mono">
        <span className="text-muted-foreground uppercase tracking-widest">{label}</span>
        <span className="text-primary font-bold">{Math.round(clampedValue)}%</span>
      </div>
      <div className="h-0.5 bg-primary/5 rounded-full overflow-hidden">
        <div className="h-full bg-primary/60 transition-all duration-300" style={{ width: `${clampedValue}%` }} />
      </div>
    </div>
  )
}

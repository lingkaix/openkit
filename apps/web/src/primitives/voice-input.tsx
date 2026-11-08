import { useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Icon } from './Icon';

/** Client recording cap. The server enforces bytes, not this duration. */
export const VOICE_INPUT_LIMIT_MS = 60_000;

const DOCUMENT_LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** One in-memory clip. Dismissing an error drops it. */
interface VoiceClip {
  readonly audioBase64: string;
  readonly mimeType: 'audio/webm' | 'audio/webm;codecs=opus' | 'audio/mp4';
}

/** Dictation callback. The composer appends the text and never sends it. */
export type VoiceTranscribe = (input: {
  audioBase64: string;
  mimeType: string;
  language?: string;
  signal: AbortSignal;
}) => Promise<{ text: string }>;

/** Composer voice control. Hidden unless capture and a usable route are both available. */
export function VoiceInputControl({
  transcribe,
  unavailableReason,
  onText,
  onBusyChange,
}: {
  transcribe?: VoiceTranscribe;
  unavailableReason?: string | null;
  onText: (text: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const clipRef = useRef<VoiceClip | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const submitOnStop = useRef(false);
  const epoch = useRef(0);
  const timer = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const transcribeRef = useRef(transcribe);
  transcribeRef.current = transcribe;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const busy = phase === 'recording' || phase === 'transcribing';
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(
    () => () => {
      mounted.current = false;
      epoch.current += 1;
      abortRef.current?.abort();
      clearTimer(timer);
      stopTracks(streamRef.current);
    },
    []
  );
  const mime = supportedAudioMime();
  const showMic = Boolean(transcribe) && mime !== null && canCaptureAudio();
  if (!showMic && !unavailableReason) return null;

  async function start() {
    const selected = supportedAudioMime();
    const request = transcribeRef.current;
    if (!selected || !request) return;
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stopTracks(stream);
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (recorderRef.current?.state === 'recording') {
            submitOnStop.current = false;
            setMessage('Voice input stopped.');
            setPhase('error');
            recorderRef.current.stop();
          }
        });
      }
      const recorder = new MediaRecorder(stream, { mimeType: selected });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        clearTimer(timer);
        stopTracks(streamRef.current);
        streamRef.current = null;
        recorderRef.current = null;
        const submit = submitOnStop.current;
        submitOnStop.current = false;
        if (!mounted.current) return;
        if (!submit) {
          setPhase((current) => (current === 'error' ? current : 'idle'));
          return;
        }
        const blob = new Blob(chunks, { type: selected });
        void submitClip(blob, selected);
      };
      recorderRef.current = recorder;
      recorder.start();
      setPhase('recording');
      timer.current = window.setTimeout(() => finish(true), VOICE_INPUT_LIMIT_MS);
    } catch {
      setMessage('Voice input is unavailable.');
      setPhase('error');
      clipRef.current = null;
    }
  }

  function finish(submit: boolean) {
    clearTimer(timer);
    submitOnStop.current = submit;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    stopTracks(streamRef.current);
    streamRef.current = null;
    if (!submit) setPhase('idle');
  }

  async function submitClip(blob: Blob, mimeType: VoiceClip['mimeType']) {
    const request = transcribeRef.current;
    if (!request) {
      setPhase('idle');
      return;
    }
    const current = epoch.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('transcribing');
    try {
      const audioBase64 = await blobToBase64(blob);
      const clip = { audioBase64, mimeType };
      clipRef.current = clip;
      const language = documentLanguage();
      const result = await request({
        audioBase64,
        mimeType,
        ...(language ? { language } : {}),
        signal: controller.signal,
      });
      if (current !== epoch.current) return;
      onTextRef.current(result.text);
      clipRef.current = null;
      setPhase('idle');
      setMessage(null);
    } catch {
      if (current !== epoch.current) return;
      setMessage('Transcription failed.');
      setPhase('error');
    }
  }

  function abortTranscription() {
    epoch.current += 1;
    abortRef.current?.abort();
    setPhase('idle');
    setMessage(null);
  }

  async function retry() {
    const clip = clipRef.current;
    const request = transcribeRef.current;
    if (!clip || !request) return;
    const current = epoch.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('transcribing');
    setMessage(null);
    try {
      const language = documentLanguage();
      const result = await request({
        ...clip,
        ...(language ? { language } : {}),
        signal: controller.signal,
      });
      if (current !== epoch.current) return;
      onTextRef.current(result.text);
      clipRef.current = null;
      setPhase('idle');
    } catch {
      if (current !== epoch.current) return;
      setMessage('Transcription failed.');
      setPhase('error');
    }
  }

  if (!showMic) {
    return (
      <p className="max-w-40 text-xs text-fg-muted" role="status">
        {unavailableReason}
      </p>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {phase === 'idle' ? (
        <AriaButton
          type="button"
          aria-label="Voice input"
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onPress={() => void start()}
          className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full border border-border text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon name="mic" />
        </AriaButton>
      ) : null}
      {phase === 'recording' ? (
        <>
          <AriaButton
            type="button"
            aria-label="Stop voice input"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onPress={() => finish(true)}
            className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full bg-accent text-on-accent outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="check" />
          </AriaButton>
          <AriaButton
            type="button"
            aria-label="Cancel voice input"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onPress={() => finish(false)}
            className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="close" />
          </AriaButton>
        </>
      ) : null}
      {phase === 'transcribing' ? (
        <AriaButton
          type="button"
          aria-label="Abort voice input"
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onPress={abortTranscription}
          className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Icon name="spinner" />
        </AriaButton>
      ) : null}
      {phase === 'error' ? (
        <div className="flex items-center gap-1" role="alert">
          <span className="max-w-40 text-xs text-negative-fg">{message}</span>
          {clipRef.current ? (
            <AriaButton
              type="button"
              aria-label="Retry voice input"
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.preventDefault()}
              onPress={() => void retry()}
              className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name="retry" />
            </AriaButton>
          ) : null}
          <AriaButton
            type="button"
            aria-label="Dismiss voice input"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onPress={() => {
              epoch.current += 1;
              clipRef.current = null;
              setMessage(null);
              setPhase('idle');
            }}
            className="flex size-11 min-h-11 min-w-11 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Icon name="close" />
          </AriaButton>
        </div>
      ) : null}
    </div>
  );
}

/** Appends a transcript, with one leading space when the draft does not already end in whitespace. */
export function appendTranscript(draft: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return draft;
  if (draft.length === 0 || /\s$/.test(draft)) return `${draft}${trimmed}`;
  return `${draft} ${trimmed}`;
}

function canCaptureAudio(): boolean {
  return (
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

function supportedAudioMime(): VoiceClip['mimeType'] | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function')
    return null;
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  return null;
}

function documentLanguage(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const lang = document.documentElement.lang;
  return DOCUMENT_LANGUAGE.test(lang) ? lang : undefined;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function clearTimer(timer: { current: number | null }) {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}

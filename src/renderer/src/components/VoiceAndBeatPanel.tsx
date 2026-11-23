import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, FolderOpen, Trash2, Music } from 'lucide-react';
import type { AudioFileInfo } from '../../../types';
import { notifyError } from '../services/notifications';

export interface VoiceTrack {
  id: string;
  file: AudioFileInfo;
  /** Where in the video it starts (seconds). */
  startSec: number;
  volume: number;
}

interface VoiceAndBeatPanelProps {
  tracks: VoiceTrack[];
  onChange: (tracks: VoiceTrack[]) => void;
  videoLengthSec: number;
  /** A music track has been chosen (cut-on-the-beat needs one). */
  hasMusic: boolean;
  /** "Cut on the beat" is switched on, and the tempo found. */
  beat: { bpm: number } | null;
  beatBusy: boolean;
  onBeatToggle: (on: boolean) => void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Step 4 extras: voice-over (record with the microphone or pick a file, placed anywhere on the timeline) and "cut on the beat". */
export const VoiceAndBeatPanel: React.FC<VoiceAndBeatPanelProps> = ({ tracks, onChange, videoLengthSec, hasMusic, beat, beatBusy, onBeatToggle }) => {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  // Stop the microphone if the panel goes away mid-recording.
  useEffect(() => () => { try { recorderRef.current?.stop(); } catch {} streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAtRef.current) / 1000), 200);
    return () => clearInterval(id);
  }, [recording]);

  const add = (file: AudioFileInfo, startSec = 0) => onChange([...tracksRef.current, { id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, file, startSec, volume: 1 }]);

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        try {
          const saved = await window.electronAPI?.saveVoiceRecording?.(await blob.arrayBuffer());
          if (saved) add(saved, 0);
          else setError('The recording could not be saved.');
        } catch (err) { notifyError('Save voice-over', err); }
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setElapsed(0);
      rec.start();
      setRecording(true);
    } catch (err) {
      setError('The microphone could not be used. Check that it is plugged in and that Windows lets desktop apps use it.');
    }
  };
  const stopRecording = () => { try { recorderRef.current?.stop(); } catch {} setRecording(false); };

  const chooseFile = async () => {
    const f = await window.electronAPI?.chooseAudioFile?.();
    if (f) add(f, 0);
  };

  const update = (id: string, patch: Partial<VoiceTrack>) => onChange(tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  return (
    <div data-testid="voice-beat-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '22px', paddingTop: '18px', borderTop: '1px solid var(--border-subtle)' }}>
      <div>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Cut on the beat</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', opacity: hasMusic ? 1 : 0.5 }}>
          <input type="checkbox" data-testid="beat-toggle" disabled={!hasMusic || beatBusy} checked={!!beat} onChange={(e) => onBeatToggle(e.target.checked)} />
          <Music size={14} /> Change slides on the beat of the music
        </label>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }}>
          {!hasMusic ? 'Choose music above first.' : beatBusy ? 'Listening to the music…' : beat ? `About ${beat.bpm} beats per minute. Slides now last a whole number of beats and the music starts on a beat.` : 'Sets how long each slide stays so every cut lands on the beat.'}
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>Voice-over &amp; extra sounds</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {!recording ? (
            <button className="btn btn-secondary" data-testid="voice-record" onClick={startRecording} style={{ gap: '6px' }}><Mic size={15} /> Record voice-over</button>
          ) : (
            <button className="btn btn-primary" data-testid="voice-stop" onClick={stopRecording} style={{ gap: '6px' }}><Square size={15} /> Stop ({fmt(elapsed)})</button>
          )}
          <button className="btn btn-secondary" onClick={chooseFile} disabled={recording} style={{ gap: '6px' }}><FolderOpen size={15} /> Add a sound file</button>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>The music gets quieter while a voice-over speaks.</span>
        </div>
        {error && <div style={{ color: '#f87171', fontSize: '0.8rem', marginTop: '6px' }}>{error}</div>}
        {tracks.map((t) => (
          <div key={t.id} data-testid="voice-track" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginTop: '10px', padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', fontSize: '0.82rem' }}>
            <span style={{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.file.name}{t.file.durationSec ? ` · ${fmt(t.file.durationSec)}` : ''}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>Starts at
              <input type="number" aria-label="Voice-over start (seconds)" className="input" min={0} max={Math.max(0, Math.floor(videoLengthSec))} step={0.5} value={t.startSec} onChange={(e) => update(t.id, { startSec: Math.max(0, parseFloat(e.target.value) || 0) })} style={{ height: '32px', width: '70px' }} /> s
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>Volume
              <input type="range" aria-label="Voice-over volume" min={0.2} max={2} step={0.1} value={t.volume} onChange={(e) => update(t.id, { volume: parseFloat(e.target.value) })} style={{ width: '100px' }} />
            </label>
            <button className="btn btn-ghost btn-icon" aria-label="Remove this sound" onClick={() => onChange(tracks.filter((x) => x.id !== t.id))}><Trash2 size={15} color="#f43f5e" /></button>
          </div>
        ))}
      </div>
    </div>
  );
};

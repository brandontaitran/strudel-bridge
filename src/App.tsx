import { useState, useRef } from 'react';
import { AudioRecorder } from './components/AudioRecorder';
import { midiToStrudel } from './utils/midiToStrudel';
import { Loader2, Copy, Play } from 'lucide-react';
import { type NoteEventTime } from '@spotify/basic-pitch';

function App() {
  const [, setAudioBlob] = useState<Blob | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [strudelCode, setStrudelCode] = useState('');
  const [progress, setProgress] = useState(0);

  // Metronome State
  const [bpm, setBpm] = useState(120);
  const [isMetronomeOn, setIsMetronomeOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);

  // Transcription Settings
  const [threshold, setThreshold] = useState(0.5);
  const [minNoteLen] = useState(0.05);
  const [melodySpeed] = useState(0.15);

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextNoteTimeRef = useRef<number>(0);
  const timerIDRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const beatCountRef = useRef(0);

  // Helper to filter for melody (keep loudest note in time window)
  const filterMelody = (notes: NoteEventTime[]): NoteEventTime[] => {
    const sorted = notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    const result: NoteEventTime[] = [];
    const TIME_WINDOW = melodySpeed;

    for (const note of sorted) {
      if (note.durationSeconds < minNoteLen) continue;

      if (result.length === 0) {
        result.push(note);
        continue;
      }

      const lastNote = result[result.length - 1];

      if (note.startTimeSeconds > lastNote.startTimeSeconds + TIME_WINDOW) {
        result.push(note);
      } else {
        if (note.amplitude > lastNote.amplitude) {
          result[result.length - 1] = note;
        }
      }
    }
    return result;
  };

  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  };

  // Metronome
  const scheduleNote = (beatNumber: number, time: number) => {
    const osc = getAudioContext().createOscillator();
    const envelope = getAudioContext().createGain();

    osc.frequency.value = (beatNumber % 4 === 0) ? 1000 : 800;
    envelope.gain.value = 1;
    envelope.gain.exponentialRampToValueAtTime(1, time + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

    osc.connect(envelope);
    envelope.connect(getAudioContext().destination);

    osc.start(time);
    osc.stop(time + 0.03);
  };

  const scheduler = () => {
    const secondsPerBeat = 60.0 / bpm;
    const ctx = getAudioContext();

    while (nextNoteTimeRef.current < ctx.currentTime + 0.1) {
      scheduleNote(beatCountRef.current, nextNoteTimeRef.current);
      nextNoteTimeRef.current += secondsPerBeat;
      beatCountRef.current++;
    }

    if (isRecordingRef.current) {
      timerIDRef.current = window.setTimeout(scheduler, 25);
    }
  };

  const stopMetronome = () => {
    if (timerIDRef.current) {
      clearTimeout(timerIDRef.current);
      timerIDRef.current = null;
    }
  };

  const handlePrepareRecording = async () => {
    if (!isMetronomeOn) return;

    const ctx = getAudioContext();
    await ctx.resume();

    const secondsPerBeat = 60.0 / bpm;
    const now = ctx.currentTime;

    for (let i = 0; i < 4; i++) {
      scheduleNote(0, now + i * secondsPerBeat);
    }

    return new Promise<void>((resolve) => {
      setTimeout(resolve, secondsPerBeat * 4 * 1000);
    });
  };

  const handleStartRecording = () => {
    setIsRecording(true);
    isRecordingRef.current = true;
    if (isMetronomeOn) {
      const ctx = getAudioContext();
      nextNoteTimeRef.current = ctx.currentTime;
      beatCountRef.current = 0;
      scheduler();
    }
  };

  const handleRecordingComplete = (blob: Blob) => {
    setIsRecording(false);
    isRecordingRef.current = false;
    stopMetronome();
    setAudioBlob(blob);
    transcribeAudio(blob);
  };

  const handleMidiUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const { Midi } = await import('@tonejs/midi');
      const midi = new Midi(arrayBuffer);

      const track = midi.tracks.find(t => t.notes.length > 0);

      if (!track) {
        setStrudelCode("// no notes found in midi file");
        return;
      }

      const midiBytes = midi.toArray();
      const code = midiToStrudel(midiBytes, undefined, bpm);
      setStrudelCode(`// converted from: ${file.name}\n` + code);

    } catch (err) {
      console.error(err);
      setStrudelCode("// error parsing midi file");
    }
  };

  // Helper to resample audio
  const resampleBuffer = async (audioBuffer: AudioBuffer, targetSampleRate: number): Promise<AudioBuffer> => {
    const offlineContext = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      audioBuffer.duration * targetSampleRate,
      targetSampleRate
    );
    const bufferSource = offlineContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offlineContext.destination);
    bufferSource.start();
    return offlineContext.startRendering();
  };

  // Convert AudioBuffer to WAV Blob
  const audioBufferToWav = async (buffer: AudioBuffer): Promise<Blob> => {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const data = buffer.getChannelData(0);
    const dataLength = data.length * bytesPerSample;
    const bufferLength = 44 + dataLength;

    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < data.length; i++) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };

  const transcribeAudio = async (blob: Blob) => {
    setIsTranscribing(true);
    setProgress(0);
    setStrudelCode('');

    try {
      const audioContext = new AudioContext();
      const arrayBuffer = await blob.arrayBuffer();
      const originalBuffer = await audioContext.decodeAudioData(arrayBuffer);

      let audioBuffer = originalBuffer;
      if (originalBuffer.sampleRate !== 22050) {
        audioBuffer = await resampleBuffer(originalBuffer, 22050);
      }

      let notes: NoteEventTime[] = [];

      // MT3 — send to Python backend
      console.log("sending audio to mt3 server...");

      const wavBlob = await audioBufferToWav(audioBuffer);
      const formData = new FormData();
      formData.append('audio', wavBlob, 'recording.wav');

      try {
        const response = await fetch('http://localhost:5001/transcribe', {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error(`mt3 server error: ${response.statusText}`);
        }

        const data = await response.json();

        notes = data.notes.map((note: any) => ({
          startTimeSeconds: note.start,
          durationSeconds: note.end - note.start,
          pitchMidi: note.pitch,
          amplitude: note.velocity || 0.8
        }));

        console.log(`mt3 returned ${notes.length} notes`);

      } catch (error: any) {
        console.error("mt3 error:", error);
        setStrudelCode(`// error: ${error.message}\n// make sure the python server is running:\n//   source venv/bin/activate && python3 mt3_server.py`);
        setIsTranscribing(false);
        setProgress(0);
        return;
      }

      setProgress(100);

      // Post-processing
      notes.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

      // Always apply melody filter
      notes = filterMelody(notes);

      console.log('processed notes:', notes);

      // Convert to MIDI
      const { Midi } = await import('@tonejs/midi');
      const midi = new Midi();
      const track = midi.addTrack();

      notes.forEach((note: NoteEventTime) => {
        track.addNote({
          midi: note.pitchMidi,
          time: note.startTimeSeconds,
          duration: note.durationSeconds,
          velocity: note.amplitude
        });
      });

      const midiBytes = midi.toArray();
      const code = midiToStrudel(midiBytes, undefined, bpm);

      if (notes.length === 0) {
        setStrudelCode("// no notes detected. try playing louder or adjusting threshold.");
      } else {
        const debugInfo = notes.slice(0, 5).map(n =>
          `[midi: ${n.pitchMidi}, t: ${n.startTimeSeconds.toFixed(2)}s]`
        ).join(', ');

        setStrudelCode(
          `// detected ${notes.length} notes (thresh: ${threshold})\n` +
          `// ${debugInfo}...\n` +
          code
        );
      }

    } catch (err: any) {
      console.error("transcription error:", err);
      setStrudelCode(`// error: ${err.message || JSON.stringify(err)}`);
    } finally {
      setIsTranscribing(false);
      setProgress(0);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(strudelCode);
  };

  const openInStrudel = () => {
    const b64 = btoa(unescape(encodeURIComponent(strudelCode)));
    window.open("https://strudel.cc/#" + b64, "_blank");
  };

  return (
    <div className="container">
      <div className="header">
        <h1>strudel bridge</h1>
        <p>audio to live code transcription</p>
      </div>

      {/* Settings */}
      <div>
        <div className="settings-row">
          <span className="section-label">metronome</span>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              bpm
              <input
                type="number"
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                style={{ width: '55px' }}
                disabled={isRecording}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={isMetronomeOn}
                onChange={(e) => setIsMetronomeOn(e.target.checked)}
                disabled={isRecording}
              />
              click
            </label>
          </div>
        </div>

        <div className="settings-row">
          <span className="section-label">detection</span>
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}
              title="lower = more notes, higher = fewer notes"
            >
              threshold: {threshold}
              <input
                type="range"
                min="0.1"
                max="0.9"
                step="0.05"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                disabled={isRecording}
              />
            </label>
          </div>
        </div>

        <div className="settings-row">
          <span className="section-label">upload</span>
          <label className="btn btn-secondary" style={{ cursor: 'pointer', fontSize: '0.75rem' }}>
            <input type="file" accept=".mid,.midi" onChange={handleMidiUpload} style={{ display: 'none' }} />
            upload midi
          </label>
        </div>
      </div>

      {/* Recorder */}
      <AudioRecorder
        onRecordingComplete={handleRecordingComplete}
        prepareRecording={handlePrepareRecording}
        onStartRecording={handleStartRecording}
      />

      {/* Output */}
      {(isTranscribing || strudelCode) && (
        <div>
          {isTranscribing ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '2rem' }}>
              <Loader2 className="animate-spin" size={24} color="var(--primary-color)" />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                transcribing... {Math.round(progress)}%
              </span>
            </div>
          ) : (
            <>
              <div className="code-block" style={{ marginBottom: '1rem' }}>
                {strudelCode}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <button className="btn btn-secondary" onClick={copyToClipboard}>
                  <Copy size={14} /> copy
                </button>
                <button className="btn btn-primary" onClick={openInStrudel}>
                  <Play size={14} /> play in strudel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;

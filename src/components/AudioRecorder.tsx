import { useState, useRef, useEffect } from 'react';
import { Mic, Square } from 'lucide-react';

interface AudioRecorderProps {
    onRecordingComplete: (audioBlob: Blob) => void;
    prepareRecording?: () => Promise<void>;
    onStartRecording?: () => void;
}

export function AudioRecorder({ onRecordingComplete, prepareRecording, onStartRecording }: AudioRecorderProps) {
    const [isRecording, setIsRecording] = useState(false);
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
    const [duration, setDuration] = useState(0);
    const chunksRef = useRef<Blob[]>([]);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            if (prepareRecording) {
                await prepareRecording();
            }

            const recorder = new MediaRecorder(stream);

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    chunksRef.current.push(e.data);
                }
            };

            recorder.onstop = () => {
                const blob = new Blob(chunksRef.current, { type: 'audio/wav' });
                onRecordingComplete(blob);
                chunksRef.current = [];
                stream.getTracks().forEach(track => track.stop());
            };

            recorder.start();
            setMediaRecorder(recorder);
            setIsRecording(true);
            setDuration(0);

            if (onStartRecording) {
                onStartRecording();
            }

            timerRef.current = window.setInterval(() => {
                setDuration(d => d + 1);
            }, 1000);

        } catch (err) {
            console.error("error accessing microphone:", err);
        }
    };

    const stopRecording = () => {
        if (mediaRecorder && isRecording) {
            mediaRecorder.stop();
            setIsRecording(false);
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    return (
        <div>
            <div className={`visualizer ${isRecording ? 'recording' : ''}`}>
                {isRecording ? (
                    <div style={{
                        color: 'var(--primary-color)',
                        fontSize: '0.9rem',
                        fontWeight: 500,
                        letterSpacing: '0.1em',
                        animation: 'pulse 1.5s ease-in-out infinite'
                    }}>
                        recording {formatTime(duration)}
                    </div>
                ) : (
                    <div style={{
                        color: 'var(--text-dim)',
                        fontSize: '0.8rem',
                        letterSpacing: '0.08em'
                    }}>
                        click to start recording
                    </div>
                )}
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1rem' }}>
                {!isRecording ? (
                    <button className="btn btn-primary" onClick={startRecording}>
                        <Mic size={14} />
                        record
                    </button>
                ) : (
                    <button className="btn" onClick={stopRecording} style={{
                        borderColor: 'var(--error-color)',
                        color: 'var(--error-color)'
                    }}>
                        <Square size={14} fill="currentColor" />
                        stop
                    </button>
                )}
            </div>
        </div>
    );
}

import * as Pitchfinder from 'pitchfinder';
import type { NoteEventTime } from '@spotify/basic-pitch';

export function transcribeWithYIN(audioBuffer: AudioBuffer, params: { threshold: number, minNoteLen: number }): NoteEventTime[] {
    const detectPitch = Pitchfinder.YIN({ sampleRate: audioBuffer.sampleRate, threshold: params.threshold });

    const channelData = audioBuffer.getChannelData(0);
    const bufferSize = 2048; // Increased window size for better bass detection
    const hopSize = bufferSize / 4; // 75% overlap for smoother tracking

    const notes: NoteEventTime[] = [];
    let currentNote: { midi: number, startTime: number, amplitude: number } | null = null;

    // Helper: Hz to MIDI
    const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));

    for (let i = 0; i < channelData.length - bufferSize; i += hopSize) {
        const chunk = channelData.slice(i, i + bufferSize);
        const frequency = detectPitch(chunk);
        const currentTime = i / audioBuffer.sampleRate;
        const amplitude = Math.max(...chunk); // Simple peak amplitude

        if (frequency && frequency > 0) {
            const midi = hzToMidi(frequency);

            if (currentNote) {
                if (midi === currentNote.midi) {
                    // Same note, continue (do nothing, waiting for end)
                } else {
                    // Pitch changed -> End current note
                    const duration = currentTime - currentNote.startTime;
                    if (duration >= params.minNoteLen) {
                        notes.push({
                            startTimeSeconds: currentNote.startTime,
                            durationSeconds: duration,
                            pitchMidi: currentNote.midi,
                            amplitude: currentNote.amplitude
                        });
                    }
                    // Start new note
                    currentNote = { midi, startTime: currentTime, amplitude };
                }
            } else {
                // No current note -> Start new note
                currentNote = { midi, startTime: currentTime, amplitude };
            }
        } else {
            // Silence / No Pitch -> End current note
            if (currentNote) {
                const duration = currentTime - currentNote.startTime;
                if (duration >= params.minNoteLen) {
                    notes.push({
                        startTimeSeconds: currentNote.startTime,
                        durationSeconds: duration,
                        pitchMidi: currentNote.midi,
                        amplitude: currentNote.amplitude
                    });
                }
                currentNote = null;
            }
        }
    }

    return notes;
}

export async function transcribeWithCrepe(audioBuffer: AudioBuffer, params: { minNoteLen: number }): Promise<NoteEventTime[]> {
    console.log("Starting SPICE (Pro AI Pitch) Transcription...");

    // Load TensorFlow.js
    const tf = await import('@tensorflow/tfjs');
    await tf.ready();

    console.log("Loading SPICE model from TensorFlow Hub...");

    try {
        // Load the SPICE model from TensorFlow Hub
        // SPICE model URL from tfhub.dev
        const modelUrl = 'https://tfhub.dev/google/tfjs-model/spice/2/default/1';
        const model = await tf.loadGraphModel(modelUrl, { fromTFHub: true });

        console.log("SPICE Model loaded successfully");

        // SPICE expects mono audio at 16kHz, normalized to [-1, 1]
        // Our audio is at 22050Hz, so we need to resample

        // 1. Get audio data
        const channelData = audioBuffer.getChannelData(0);

        // 2. Resample from 22050Hz to 16000Hz
        const originalSampleRate = audioBuffer.sampleRate;
        const targetSampleRate = 16000;
        const resampleRatio = targetSampleRate / originalSampleRate;
        const resampledLength = Math.floor(channelData.length * resampleRatio);
        const resampledData = new Float32Array(resampledLength);

        for (let i = 0; i < resampledLength; i++) {
            const originalIndex = i / resampleRatio;
            const lowerIndex = Math.floor(originalIndex);
            const upperIndex = Math.min(lowerIndex + 1, channelData.length - 1);
            const fraction = originalIndex - lowerIndex;

            // Linear interpolation
            resampledData[i] = channelData[lowerIndex] * (1 - fraction) + channelData[upperIndex] * fraction;
        }

        // 3. Process audio in chunks (SPICE expects chunks of audio)
        // SPICE model typically works with 16000 samples at a time (1 second)
        const chunkSize = 16000; // 1 second at 16kHz
        const hopSize = chunkSize / 2; // 50% overlap

        const notes: NoteEventTime[] = [];
        let currentNote: { midi: number, startTime: number } | null = null;

        for (let i = 0; i < resampledData.length - chunkSize; i += hopSize) {
            const chunk = resampledData.slice(i, i + chunkSize);

            // Create tensor from chunk (SPICE expects 1D tensor, not batched)
            const inputTensor = tf.tensor1d(chunk);

            // Run inference - SPICE returns a dictionary with 'pitch' and 'uncertainty' tensors
            const output = model.predict(inputTensor) as any;

            // SPICE model outputs a dictionary: { pitch: Tensor, uncertainty: Tensor }
            // We need to access the tensors by name or index
            let pitchTensor: any;
            let uncertaintyTensor: any;

            if (Array.isArray(output)) {
                // If output is an array: [pitch, uncertainty]
                pitchTensor = output[0];
                uncertaintyTensor = output[1];
            } else if (output.pitch) {
                // If output is a dictionary with named outputs
                pitchTensor = output.pitch;
                uncertaintyTensor = output.uncertainty;
            } else {
                // Fallback: assume output is directly the pitch tensor
                pitchTensor = output;
                uncertaintyTensor = tf.scalar(0); // Default uncertainty
            }

            const pitchData = await pitchTensor.data();
            const uncertaintyData = await uncertaintyTensor.data();


            const pitchValue = pitchData[0]; // Normalized pitch output from SPICE
            const uncertainty = uncertaintyData[0];
            const confidence = 1 - uncertainty;

            // Convert SPICE pitch output to Hz using official formula
            // Source: https://www.tensorflow.org/hub/tutorials/spice
            const PT_OFFSET = 25.58;
            const PT_SLOPE = 63.07;
            const FMIN = 10.0;
            const BINS_PER_OCTAVE = 12.0;

            // Step 1: Convert to pitch in cents
            const pitchInCents = pitchValue * PT_SLOPE + PT_OFFSET;

            // Step 2: Convert cents to Hz
            const frequencyHz = FMIN * Math.pow(2, pitchInCents / (BINS_PER_OCTAVE * 100.0));

            // Clean up tensors
            inputTensor.dispose();
            if (pitchTensor) pitchTensor.dispose();
            if (uncertaintyTensor) uncertaintyTensor.dispose();

            const currentTime = i / targetSampleRate;

            // Lower confidence threshold and broader frequency range for better detection
            if (frequencyHz > 20 && frequencyHz < 2000 && confidence > 0.3) {
                const midi = Math.round(69 + 12 * Math.log2(frequencyHz / 440));

                if (currentNote) {
                    if (midi === currentNote.midi) {
                        // Continue current note
                    } else {
                        // Pitch changed
                        const duration = currentTime - currentNote.startTime;
                        if (duration >= params.minNoteLen) {
                            notes.push({
                                startTimeSeconds: currentNote.startTime,
                                durationSeconds: duration,
                                pitchMidi: currentNote.midi,
                                amplitude: confidence
                            });
                        }
                        currentNote = { midi, startTime: currentTime };
                    }
                } else {
                    currentNote = { midi, startTime: currentTime };
                }
            } else {
                // Silence or low confidence
                if (currentNote) {
                    const duration = currentTime - currentNote.startTime;
                    if (duration >= params.minNoteLen) {
                        notes.push({
                            startTimeSeconds: currentNote.startTime,
                            durationSeconds: duration,
                            pitchMidi: currentNote.midi,
                            amplitude: 0.8
                        });
                    }
                    currentNote = null;
                }
            }
        }

        // Finalize last note
        if (currentNote) {
            const duration = (resampledData.length / targetSampleRate) - currentNote.startTime;
            if (duration >= params.minNoteLen) {
                notes.push({
                    startTimeSeconds: currentNote.startTime,
                    durationSeconds: duration,
                    pitchMidi: currentNote.midi,
                    amplitude: 0.8
                });
            }
        }

        console.log(`SPICE finished. Detected ${notes.length} notes.`);
        return notes;

    } catch (err: any) {
        console.error("SPICE Error:", err);
        throw new Error(`SPICE model failed: ${err.message}`);
    }
}

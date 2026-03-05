import { Midi } from "@tonejs/midi";

export interface ConversionOptions {
    barLimit: number;
    notesPerBar: number;
    flat: boolean;
    tabSize: number;
}

const NOTE_NAMES = [
    "c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"
];

function noteNumToStr(n: number): string {
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function quantizeTime(t: number, cycleStart: number, cycleLen: number, notesPerBar: number): number {
    const rel = (t - cycleStart) / cycleLen;
    const q = Math.round(rel * notesPerBar) / notesPerBar;
    return Math.min(q, 1 - 1e-9);
}

function simplifySubdivisions(arr: string[]): string[] {
    let cur = arr;
    while (cur.length > 0 && cur.length % 2 === 0) {
        const ok = cur.every((_, i) => (i % 2 === 1 ? cur[i] === "-" : true));
        if (!ok) break;
        cur = cur.filter((_, i) => i % 2 === 0);
    }
    return cur;
}

export function midiToStrudel(arrayBuffer: ArrayBuffer | Uint8Array, opts: ConversionOptions = { barLimit: 0, notesPerBar: 64, flat: false, tabSize: 2 }, overrideBpm?: number): string {
    const midi = new Midi(arrayBuffer);
    // const ppq = midi.header.ppq;
    const bpm = overrideBpm || (midi.header.tempos.length ? midi.header.tempos[0].bpm : 120);
    const cycleLen = (60 / bpm) * 4; // 1 cycle = 4 beats assumption (4/4)

    /* collect note_on events */
    interface NoteEvent {
        time: number;
        note: string;
        instrument: any;
    }

    const events: Record<number, NoteEvent[]> = {}; // trackIndex -> [{time,note},...]

    midi.tracks.forEach((track, idx) => {
        if (!track.notes.length) return;
        events[idx] = track.notes.map((n) => ({
            time: n.time,
            note: noteNumToStr(n.midi),
            instrument: track.instrument,
        }));
    });

    /* build bars */
    const tracks: string[][] = [];

    Object.keys(events)
        .sort((a, b) => Number(a) - Number(b))
        .forEach((trackIdxKey) => {
            const trackIdx = Number(trackIdxKey);
            const evs = events[trackIdx];

            /* push notes >95% into next cycle */
            const adj = evs.map((e) => {
                const rel = (e.time % cycleLen) / cycleLen;
                return rel > 0.95
                    ? { ...e, time: Math.ceil(e.time / cycleLen) * cycleLen }
                    : e;
            });

            if (adj.length === 0) return;

            const maxT = Math.max(...adj.map((e) => e.time));
            const numCycles =
                opts.barLimit > 0
                    ? Math.min(Math.floor(maxT / cycleLen) + 1, opts.barLimit)
                    : Math.floor(maxT / cycleLen) + 1;

            const bars: string[] = [];

            for (let c = 0; c < numCycles; c++) {
                const start = c * cycleLen,
                    end = start + cycleLen;
                const inCycle = adj.filter((e) => e.time >= start && e.time < end);

                if (!inCycle.length) {
                    bars.push("-");
                    continue;
                }

                if (opts.flat) {
                    const notes = inCycle.map((e) => e.note);
                    bars.push(notes.length === 1 ? notes[0] : `[${notes.join(" ")}]`);
                } else {
                    const groups: Record<string, string[]> = {}; // pos -> [notes]

                    inCycle.forEach((e) => {
                        const pos = quantizeTime(e.time, start, cycleLen, opts.notesPerBar);
                        // key needs to be string for object key, but quantized logic relies on numerical comparison usually
                        // Here we just use the string approx
                        const key = (Math.round(pos * opts.notesPerBar) / opts.notesPerBar).toString();
                        (groups[key] || (groups[key] = [])).push(e.note);
                    });

                    const subdiv = Array(opts.notesPerBar).fill("-");

                    Object.keys(groups)
                        .sort((a, b) => parseFloat(a) - parseFloat(b))
                        .forEach((k) => {
                            const idx = Math.round(parseFloat(k) * opts.notesPerBar);
                            if (idx < opts.notesPerBar) {
                                const g = groups[k];
                                subdiv[idx] = g.length === 1 ? g[0] : `[${g.join(",")}]`;
                            }
                        });

                    const simp = simplifySubdivisions(subdiv);
                    const bar = simp.length === 1 ? simp[0] : `[${simp.join(" ")}]`;

                    // If the bar effectively became empty/rest after simplification (shouldn't really happen if inCycle > 0 but logic from source)
                    bars.push(
                        bar === "[" + Array(opts.notesPerBar).fill("-").join(" ") + "]" // Check this comparison logic
                            ? "-"
                            : bar
                    );
                }
            }
            if (bars.length) tracks.push(bars);
        });

    /* build text */
    const indent = (n: number) => " ".repeat(n);

    const getInstrumentName = (track: any) => {
        return track.instrument?.family || "piano";
    };

    const out = [`setcpm(${Math.round(bpm)}/4)`];

    tracks.forEach((bars, idx) => {
        // Find the original track index to get instrument name? 
        // The `tracks` array order matches `Object.keys(events).sort()`.
        // So we need to map back to midi tracks.
        // However, `events` keys might skip tracks without notes.
        // Let's reconstruct the mapping or just look up events keys again.

        // Actually, `tracks` is pushed in the order of `sorted(events)`.
        // So `idx` here corresponds to the `idx` in the sorted keys logic.
        const sortedTrackIndices = Object.keys(events).sort((a, b) => Number(a) - Number(b));
        const originalTrackIdx = Number(sortedTrackIndices[idx]);
        const _track = midi.tracks[originalTrackIdx];

        out.push("$: note(`<");
        for (let i = 0; i < bars.length; i += 4) {
            const chunk = bars.slice(i, i + 4).join(" ");
            out.push(`${indent(opts.tabSize * 2)}${chunk}`);
        }
        // Only modify last line to close
        out[out.length - 1] += ">`)";

        out.push(`.s("${getInstrumentName(_track).toLowerCase().replace(/ /g, "_")}")`);
        out.push("");
    });

    return out.join("\n");
}

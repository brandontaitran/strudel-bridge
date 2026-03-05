# MT3 "God Mode" Backend Setup

This directory contains a Python server that runs Google's MT3 model for high-accuracy music transcription.

## Prerequisites

- Python 3.9 or higher
- macOS (M-series Macs optimized with Metal GPU acceleration)

## Installation

1. **Create a virtual environment** (recommended):
```bash
python3 -m venv venv
source venv/bin/activate  # On macOS/Linux
```

2. **Install dependencies**:
```bash
pip install -r requirements.txt
```

This will install:
- Flask (web server)
- TensorFlow (with Metal GPU support for M-series Macs)
- note-seq (MT3 model)
- librosa (audio processing)

⏱️ Installation may take 5-10 minutes (TensorFlow is large).

## Running the Server

```bash
python3 mt3_server.py
```

The server will start on `http://localhost:5001`.

You should see:
```
Loading MT3 model...
MT3 model loaded successfully!
Server ready on http://localhost:5001
```

## Testing

### Health Check
```bash
curl http://localhost:5001/health
```

### Transcribe Audio
The web frontend will automatically send audio to this server when you select "MT3 (God Mode)" engine.

## Troubleshooting

### TensorFlow Installation Issues
If you encounter errors with tensorflow-metal:
```bash
# Try installing without Metal (CPU only)
pip install tensorflow==2.15.0 --no-deps
pip install note-seq librosa
```

### Port Already in Use
If port 5001 is taken, edit `mt3_server.py` and change the port number.

## Performance

- **First run**: ~30-60 seconds to load model
- **Transcription**: ~5-15 seconds for a 10-second clip (M5 Mac)
- **GPU Acceleration**: Automatically uses Metal on M-series Macs

## Architecture

```
Browser (Strudel Bridge) → Python Server (MT3) → MIDI Notes → Strudel Code
```

"""System audio capture (WASAPI loopback) reduced to a few reactive numbers.

We tap whatever the default output device is playing, so this reacts to the
actual sound leaving the machine rather than guessing from track metadata.
"""
import threading
import time

import numpy as np

try:
    import pyaudiowpatch as pyaudio
except Exception:  # pragma: no cover - only on non-Windows / broken installs
    pyaudio = None

CHUNK = 512
FFT_SIZE = 2048
SPECTRUM_BINS = 64
SPECTRUM_LO_HZ = 30.0
SPECTRUM_HI_HZ = 16000.0

# (low_hz, high_hz) for bass, low-mid, mid, high, air
BANDS = ((30, 140), (140, 400), (400, 1600), (1600, 5000), (5000, 14000))

BEAT_HISTORY = 90          # ~1s of frames
BEAT_SENSITIVITY = 1.6     # how far above the running average a hit must sit
BEAT_FLOOR = 0.09          # normalised bass energy needed at all
BEAT_COOLDOWN = 0.40       # seconds; caps the ring rate at ~2.5/s

# The auto-gain divides by a peak that bottoms out at 0.004, so during silence
# it amplifies the noise floor by ~250x and the bass band happily crosses
# BEAT_FLOOR. Gate on the true, un-normalised level so quiet passages stay calm.
SILENCE_RMS = 0.006

# Payload layout the renderer expects, as float32:
#   0 level, 1 bass, 2 lowMid, 3 mid, 4 high, 5 air, 6 beat, 7 ok
#   8.. spectrum bins
HEADER = 8
PAYLOAD_LEN = HEADER + SPECTRUM_BINS


class AudioEngine(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True, name="audio-engine")
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._payload = np.zeros(PAYLOAD_LEN, dtype=np.float32)
        self._bands = np.zeros(len(BANDS), dtype=np.float64)
        self._spectrum = np.zeros(SPECTRUM_BINS, dtype=np.float64)
        self._level = 0.0

        self._ring = np.zeros(FFT_SIZE, dtype=np.float32)
        self._window = np.hanning(FFT_SIZE).astype(np.float32)
        self._bass_history: list[float] = []
        self._last_beat = 0.0
        self._gain_ref = 0.02
        self.rms = 0.0             # raw, un-normalised; used for the silence gate

        self._bin_edges = None
        self._band_slices = None
        self._rate = 48000

        self.ok = False
        self.error = "starting"
        self.device_name = ""

    # ---- public -------------------------------------------------------

    def snapshot(self) -> np.ndarray:
        """Latest frame. The beat flag is latched, so a hit is never missed
        or double-counted when capture (~94 Hz) outruns the wire (60 Hz)."""
        with self._lock:
            payload = self._payload.copy()
            self._payload[6] = 0.0
        return payload

    def status(self) -> dict:
        return {"ok": self.ok, "error": self.error, "device": self.device_name}

    def stop(self):
        self._stop.set()

    # ---- internals ----------------------------------------------------

    def _prepare_maps(self, rate: int):
        """Precompute log-spaced spectrum bins and the band bin ranges."""
        self._rate = rate
        freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / rate)
        edges = np.geomspace(SPECTRUM_LO_HZ, min(SPECTRUM_HI_HZ, rate / 2 - 1),
                             SPECTRUM_BINS + 1)
        self._bin_edges = [
            (int(np.searchsorted(freqs, edges[i])),
             max(int(np.searchsorted(freqs, edges[i + 1])),
                 int(np.searchsorted(freqs, edges[i])) + 1))
            for i in range(SPECTRUM_BINS)
        ]
        self._band_slices = [
            (int(np.searchsorted(freqs, lo)),
             max(int(np.searchsorted(freqs, hi)), int(np.searchsorted(freqs, lo)) + 1))
            for lo, hi in BANDS
        ]

    def _open_stream(self, pa):
        wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
        device = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
        if not device.get("isLoopbackDevice"):
            for candidate in pa.get_loopback_device_info_generator():
                if device["name"] in candidate["name"]:
                    device = candidate
                    break
            else:
                raise RuntimeError(
                    "No WASAPI loopback device matches the default output."
                )
        rate = int(device["defaultSampleRate"])
        channels = max(1, int(device["maxInputChannels"]))
        stream = pa.open(
            format=pyaudio.paFloat32,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=int(device["index"]),
            frames_per_buffer=CHUNK,
        )
        self.device_name = str(device["name"])
        self._prepare_maps(rate)
        return stream, channels

    def run(self):
        if pyaudio is None:
            self.ok = False
            self.error = "PyAudioWPatch is not installed."
            return

        while not self._stop.is_set():
            pa = stream = None
            try:
                pa = pyaudio.PyAudio()
                stream, channels = self._open_stream(pa)
                self.ok = True
                self.error = ""
                while not self._stop.is_set():
                    raw = stream.read(CHUNK, exception_on_overflow=False)
                    samples = np.frombuffer(raw, dtype=np.float32)
                    if channels > 1:
                        usable = (samples.size // channels) * channels
                        samples = samples[:usable].reshape(-1, channels).mean(axis=1)
                    self._analyse(samples)
            except Exception as exc:
                self.ok = False
                self.error = str(exc)[:180] or "audio capture failed"
                with self._lock:
                    self._payload[:] = 0.0
                self._stop.wait(1.5)
            finally:
                try:
                    if stream is not None:
                        stream.stop_stream()
                        stream.close()
                except Exception:
                    pass
                try:
                    if pa is not None:
                        pa.terminate()
                except Exception:
                    pass

    def _analyse(self, mono: np.ndarray):
        if mono.size == 0:
            return
        n = min(mono.size, FFT_SIZE)
        self._ring = np.roll(self._ring, -n)
        self._ring[-n:] = mono[-n:]

        rms = float(np.sqrt(np.mean(np.square(self._ring[-CHUNK * 2:])) + 1e-12))

        # Auto gain: rise quickly to a new peak, fall back slowly, so quiet
        # passages still animate and loud ones do not clip the visuals.
        self._gain_ref = max(rms, self._gain_ref * 0.9992, 0.004)
        norm = 1.0 / self._gain_ref

        spectrum = np.abs(np.fft.rfft(self._ring * self._window)) / (FFT_SIZE * 0.5)
        spectrum *= norm

        raw_bins = np.empty(SPECTRUM_BINS, dtype=np.float64)
        for i, (lo, hi) in enumerate(self._bin_edges):
            raw_bins[i] = spectrum[lo:hi].max() if hi > lo else 0.0
        # Perceptual compression, then asymmetric smoothing for a springy feel.
        raw_bins = np.clip(np.power(raw_bins * 0.55, 0.45), 0.0, 1.0)
        rising = raw_bins > self._spectrum
        self._spectrum = np.where(
            rising,
            self._spectrum + (raw_bins - self._spectrum) * 0.55,
            self._spectrum + (raw_bins - self._spectrum) * 0.14,
        )

        raw_bands = np.empty(len(BANDS), dtype=np.float64)
        for i, (lo, hi) in enumerate(self._band_slices):
            raw_bands[i] = float(np.sqrt(np.mean(np.square(spectrum[lo:hi]))))
        raw_bands = np.clip(np.power(raw_bands * 2.4, 0.5), 0.0, 1.0)
        rising = raw_bands > self._bands
        self._bands = np.where(
            rising,
            self._bands + (raw_bands - self._bands) * 0.5,
            self._bands + (raw_bands - self._bands) * 0.11,
        )

        level = min(1.0, rms * norm * 0.7)
        self._level += (level - self._level) * (0.5 if level > self._level else 0.12)

        self.rms = rms
        beat = self._detect_beat(float(raw_bands[0]), rms)

        with self._lock:
            self._payload[0] = self._level
            self._payload[1:6] = self._bands
            if beat:
                self._payload[6] = 1.0
            self._payload[7] = 1.0
            self._payload[HEADER:] = self._spectrum

    def _detect_beat(self, bass: float, rms: float) -> float:
        history = self._bass_history
        if rms < SILENCE_RMS:
            # Nothing is really playing. Drop the history too, so the first
            # bars after silence are measured against real music.
            history.clear()
            return 0.0
        history.append(bass)
        if len(history) > BEAT_HISTORY:
            del history[0]
        if len(history) < 12:
            return 0.0
        average = sum(history) / len(history)
        now = time.monotonic()
        if (bass > average * BEAT_SENSITIVITY
                and bass > BEAT_FLOOR
                and now - self._last_beat > BEAT_COOLDOWN):
            self._last_beat = now
            return 1.0
        return 0.0

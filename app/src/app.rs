use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

const SAMPLE_PROMPT: &str =
    "A red fox trots through fresh snow in a birch forest at golden hour, cinematic";
// Wan's `sample_neg_prompt` (wan/configs/shared_config.py): the negative prompt when none is
// given.
const DEFAULT_NEGATIVE: &str = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，\
整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，\
画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，\
三条腿，背景人很多，倒着走";
const DEFAULT_STEPS: f64 = 20.0;
const DEFAULT_GUIDANCE: f64 = 5.0;
const DEFAULT_SHIFT: f64 = 5.0;
const DEFAULT_FRAMES: f64 = 17.0;
const DEFAULT_SEED: &str = "42";
const DEFAULT_SIZE: &str = "320x192";

/// The sizes the page offers: id, label, width, height.
const SIZES: [(&str, &str, u32, u32); 4] = [
    ("320x192", "Landscape", 320, 192),
    ("192x320", "Portrait", 192, 320),
    ("256x256", "Square", 256, 256),
    ("160x96", "Small", 160, 96),
];

#[derive(Clone, PartialEq)]
struct Size {
    id: String,
    label: String,
    dimensions: String,
}

// The runtime build and the bundles, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part of both bundles came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {:.0} MB bundles · {source} in {:.1} s",
            self.build,
            self.bundle_bytes / 1e6,
            self.load_ms / 1000.0
        )
    }
}

// One generation as `web/app.js` measures it, live while it runs: `wall_ms` on the page from the
// click (for a queued request, from the model being ready), `text_ms` (the text encoder),
// `compute_ms` (time inside the video runtime's `start` and `step`, summed) and `decode_ms` (the
// part of it spent decoding) inside the engine workers, and the network requests made since the
// model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    wall_ms: f64,
    text_ms: f64,
    compute_ms: f64,
    decode_ms: f64,
    step: u32,
    steps: u32,
    decoded: u32,
    frames: u32,
    fps: u32,
    width: u32,
    height: u32,
    requests: u32,
}

impl Metrics {
    fn time(&self) -> String {
        format!("{:.1} s", self.wall_ms / 1000.0)
    }

    fn compute(&self) -> String {
        format!(
            "{:.1} s computing, prompt {:.1} s",
            self.compute_ms / 1000.0,
            self.text_ms / 1000.0
        )
    }

    fn per_step(&self) -> String {
        if self.step == 0 {
            return "–".into();
        }
        let denoising = self.compute_ms - self.decode_ms;
        format!("{:.2} s", denoising / 1000.0 / f64::from(self.step))
    }

    fn decode(&self) -> String {
        format!("decoded in {:.1} s", self.decode_ms / 1000.0)
    }

    fn steps(&self) -> String {
        format!("{} / {}", self.step, self.steps)
    }

    fn video(&self) -> String {
        if self.width == 0 {
            return "–".into();
        }
        format!("{}×{} · {} frames", self.width, self.height, self.frames)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    Progress {
        status: String,
        metrics: Metrics,
    },
    // The clip plays; `index` is the frame on show.
    Frame {
        index: u32,
    },
    // The frames are decoded; `video` is the WebM's blob URL.
    Done {
        status: String,
        video: Option<String>,
        metrics: Metrics,
    },
    // A generation failed; the engine can run the next one.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

// The video engine's request (`wan2_1::session::Request` in the runtime), as `web/app.js` posts
// it.
#[derive(Serialize)]
struct Request {
    width: u32,
    height: u32,
    frames: u32,
    steps: u32,
    guidance: f32,
    shift: f32,
    seed: u64,
}

// What the text encoder reads, as `web/app.js` posts it.
#[derive(Serialize)]
struct Prompts {
    prompt: String,
    negative: String,
}

// One generation as JSON: the request and the prompts.
struct Job {
    request: String,
    prompts: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Generating,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Generating => "generating",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    prompt: Signal<String>,
    negative: Signal<String>,
    size: Signal<String>,
    frames: Signal<f64>,
    steps: Signal<f64>,
    guidance: Signal<f64>,
    shift: Signal<f64>,
    seed: Signal<String>,
    // `web/app.js` acts on every new count: `starts` runs `request` on `prompts`, `stops` stops
    // the generation.
    #[js]
    request: Signal<String>,
    #[js]
    prompts: Signal<String>,
    #[js]
    starts: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    // The finished clip plays in a loop while `playing`; otherwise `frame` is on show.
    #[js]
    playing: Signal<bool>,
    #[js]
    frame: Signal<f64>,
    phase: Signal<Phase>,
    // Generate was clicked while the model loaded: it runs as soon as the model is ready.
    queued: Signal<bool>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    video: Signal<Option<String>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            prompt: signal(SAMPLE_PROMPT.into()),
            negative: signal(DEFAULT_NEGATIVE.into()),
            size: signal(DEFAULT_SIZE.into()),
            frames: signal(DEFAULT_FRAMES),
            steps: signal(DEFAULT_STEPS),
            guidance: signal(DEFAULT_GUIDANCE),
            shift: signal(DEFAULT_SHIFT),
            seed: signal(DEFAULT_SEED.into()),
            request: signal(String::new()),
            prompts: signal(String::new()),
            starts: signal(0),
            stops: signal(0),
            playing: signal(false),
            frame: signal(0.0),
            phase: signal(Phase::Loading),
            queued: signal(false),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal(String::new()),
            video: signal(None),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn sizes(&self) -> Vec<Size> {
        let sizes = SIZES.iter().map(|&(id, label, width, height)| Size {
            id: id.into(),
            label: label.into(),
            dimensions: format!("{width}×{height}"),
        });
        sizes.collect()
    }

    fn generate(&self) {
        let Some(job) = self.job() else {
            return;
        };
        if self.phase.get() == Phase::Loading {
            self.queued.set(true);
            self.status
                .set("Queued: it starts the moment the model is ready.".into());
        } else {
            self.begin(job);
        }
    }

    // The generation for the form's settings, or `None` after telling what is wrong.
    fn job(&self) -> Option<Job> {
        let prompt = self.prompt.get().trim().to_string();
        if prompt.is_empty() {
            self.status.set("Describe the video first.".into());
            return None;
        }
        let Ok(seed) = self.seed.get().trim().parse::<u64>() else {
            self.status
                .set("The seed is a whole number from 0 to 18446744073709551615.".into());
            return None;
        };
        let (width, height) = self.dimensions();
        let request = Request {
            width,
            height,
            frames: self.frames.get() as u32,
            steps: self.steps.get() as u32,
            guidance: self.guidance.get() as f32,
            shift: self.shift.get() as f32,
            seed,
        };
        let negative = self.negative.get().trim().to_string();
        let prompts = Prompts {
            prompt,
            negative: if negative.is_empty() {
                DEFAULT_NEGATIVE.into()
            } else {
                negative
            },
        };
        Some(Job {
            request: serde_json::to_string(&request).expect("plain data serializes"),
            prompts: serde_json::to_string(&prompts).expect("plain data serializes"),
        })
    }

    fn begin(&self, job: Job) {
        self.request.set(job.request);
        self.prompts.set(job.prompts);
        self.phase.set(Phase::Generating);
        self.measured.set(true);
        self.video.set(None);
        self.playing.set(false);
        self.frame.set(0.0);
        self.metrics.set(Metrics::default());
        self.status.set("Reading the prompt…".into());
        self.starts.update(|count| *count += 1);
    }

    fn stop(&self) {
        if self.queued.get() {
            self.queued.set(false);
            self.status.set("Cancelled.".into());
            return;
        }
        self.stops.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.ready(loaded),
            Report::Progress { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Frame { index } => self.frame.set(f64::from(index)),
            Report::Done {
                status,
                video,
                metrics,
            } => {
                self.status.set(status);
                self.playing.set(video.is_some());
                self.video.set(video);
                self.metrics.set(metrics);
                self.phase.set(Phase::Ready);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Ready);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn ready(&self, loaded: Loaded) {
        self.loaded.set(Some(loaded));
        self.phase.set(Phase::Ready);
        let queued = self.queued.get();
        self.queued.set(false);
        if queued && let Some(job) = self.job() {
            self.begin(job);
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn generate_label(&self) -> &'static str {
        match (self.phase.get(), self.queued.get()) {
            (Phase::Loading, true) => "Queued",
            (Phase::Loading, false) => "Generate when ready",
            _ => "Generate",
        }
    }

    fn can_stop(&self) -> bool {
        self.phase.get() == Phase::Generating || self.queued.get()
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn can_generate(&self) -> bool {
        match self.phase.get() {
            Phase::Loading => !self.queued.get(),
            Phase::Ready => true,
            Phase::Generating | Phase::Broken => false,
        }
    }

    fn toggle_playing(&self) {
        self.playing.update(|playing| *playing = !*playing);
    }

    // The viewer took the slider: the clip stops where they put it.
    fn scrub(&self) {
        self.playing.set(false);
    }

    fn play_label(&self) -> &'static str {
        if self.playing.get() { "Pause" } else { "Play" }
    }

    fn last_frame(&self) -> u32 {
        self.metrics.get().decoded.saturating_sub(1)
    }

    fn dimensions(&self) -> (u32, u32) {
        let size = self.size.get();
        let &(_, _, width, height) = SIZES
            .iter()
            .find(|(id, ..)| *id == size)
            .expect("the size radio's values are the ids of SIZES");
        (width, height)
    }

    // The frame's aspect ratio, from the chosen size, so it keeps its shape before the first
    // preview.
    fn aspect(&self) -> String {
        let (width, height) = self.dimensions();
        format!("aspect-ratio: {width} / {height}")
    }
}

fusor::template!("web/index.html");

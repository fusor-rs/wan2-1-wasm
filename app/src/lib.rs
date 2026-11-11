//! The Wan2.1 page. The form, the model's loading and each generation's live measurements are
//! signals here; `web/app.js` runs the two engine workers, draws the frames and plays the clip,
//! and reports back through `engine` events.

mod app;
